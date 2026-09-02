import { Router } from 'express';
import { prisma } from '@mail/database';
import { logActivity } from '@mail/core';
import {
  createWorkspaceSchema,
  inviteMemberSchema,
  parseJson,
  slugify,
  stringifyJson,
  updateMemberRoleSchema,
  workspaceSettingsSchema,
} from '@mail/shared';
import { AppError, handler, ok } from '../lib/http.js';
import { hashPassword, setWorkspaceCookie } from '../lib/auth.js';
import { authenticate, requireAdmin, requireRole, withWorkspace } from '../middleware/context.js';

export const workspaceRouter = Router();
workspaceRouter.use(authenticate);

workspaceRouter.get(
  '/',
  handler(async (req, res) => {
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.userId! },
      include: {
        workspace: {
          include: {
            _count: { select: { contacts: true, campaigns: true, emailAccounts: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return ok(
      res,
      memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        slug: m.workspace.slug,
        timezone: m.workspace.timezone,
        role: m.role,
        counts: m.workspace._count,
      })),
    );
  }),
);

workspaceRouter.post(
  '/',
  handler(async (req, res) => {
    const input = createWorkspaceSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (!user.organizationId) throw AppError.badRequest('Your account has no organization');

    const base = slugify(input.name);
    let slug = base;
    for (
      let i = 1;
      await prisma.workspace.findUnique({
        where: { organizationId_slug: { organizationId: user.organizationId, slug } },
      });
      i += 1
    ) {
      slug = `${base}-${i}`;
    }

    const workspace = await prisma.workspace.create({
      data: {
        organizationId: user.organizationId,
        name: input.name,
        slug,
        timezone: input.timezone,
        members: { create: { userId: user.id, role: 'OWNER' } },
      },
    });

    return ok(res, workspace, undefined, 201);
  }),
);

workspaceRouter.post(
  '/:id/activate',
  handler(async (req, res) => {
    const membership = await prisma.workspaceMember.findFirst({
      where: { userId: req.userId!, workspaceId: req.params.id },
    });
    if (!membership) throw AppError.forbidden('You are not a member of that workspace');
    setWorkspaceCookie(res, req.params.id);
    return ok(res, { activeWorkspaceId: req.params.id });
  }),
);

// --------------------------------------------------------- current workspace

workspaceRouter.use(withWorkspace);

workspaceRouter.get(
  '/current/settings',
  handler(async (req, res) => {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: req.ctx.workspaceId } });
    return ok(res, {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      timezone: workspace.timezone,
      role: req.ctx.role,
      ...parseJson<Record<string, unknown>>(workspace.settingsJson, {}),
    });
  }),
);

workspaceRouter.patch(
  '/current/settings',
  requireAdmin,
  handler(async (req, res) => {
    const input = workspaceSettingsSchema.parse(req.body);
    const { name, timezone, ...rest } = input;

    const current = await prisma.workspace.findUniqueOrThrow({ where: { id: req.ctx.workspaceId } });
    const merged = { ...parseJson<Record<string, unknown>>(current.settingsJson, {}), ...rest };

    const workspace = await prisma.workspace.update({
      where: { id: req.ctx.workspaceId },
      data: {
        ...(name ? { name } : {}),
        ...(timezone ? { timezone } : {}),
        settingsJson: stringifyJson(merged),
      },
    });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: 'workspace.settings_updated',
      message: 'Workspace settings updated',
      status: 'INFO',
    });

    return ok(res, { ...workspace, ...merged });
  }),
);

workspaceRouter.get(
  '/current/members',
  handler(async (req, res) => {
    const members = await prisma.workspaceMember.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      include: {
        user: {
          select: { id: true, email: true, firstName: true, lastName: true, lastLoginAt: true, isActive: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return ok(
      res,
      members.map((m) => ({
        ...m.user,
        // The membership id is what the role/remove endpoints address, so it
        // must win over the user id spread above.
        id: m.id,
        userId: m.user.id,
        role: m.role,
        joinedAt: m.createdAt,
      })),
    );
  }),
);

workspaceRouter.post(
  '/current/members',
  requireAdmin,
  handler(async (req, res) => {
    const input = inviteMemberSchema.parse(req.body);
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: req.ctx.workspaceId } });

    // No mail provider is assumed, so a member is created with a password the
    // admin sets and communicates. Swap this for an emailed invite token once a
    // transactional provider is configured.
    let user = await prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          email: input.email,
          firstName: input.firstName,
          lastName: input.lastName,
          passwordHash: await hashPassword(input.password),
          organizationId: workspace.organizationId,
        },
      });
    }

    const existing = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: req.ctx.workspaceId, userId: user.id } },
    });
    if (existing) throw AppError.conflict('That user is already a member of this workspace');

    const member = await prisma.workspaceMember.create({
      data: { workspaceId: req.ctx.workspaceId, userId: user.id, role: input.role },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: 'workspace.member_added',
      message: `${input.email} added as ${input.role}`,
    });

    return ok(res, member, undefined, 201);
  }),
);

workspaceRouter.patch(
  '/current/members/:memberId',
  requireAdmin,
  handler(async (req, res) => {
    const input = updateMemberRoleSchema.parse(req.body);
    const member = await prisma.workspaceMember.findFirst({
      where: { id: req.params.memberId, workspaceId: req.ctx.workspaceId },
    });
    if (!member) throw AppError.notFound('Member');

    if (member.role === 'OWNER' && input.role !== 'OWNER') {
      const owners = await prisma.workspaceMember.count({
        where: { workspaceId: req.ctx.workspaceId, role: 'OWNER' },
      });
      if (owners <= 1) throw AppError.badRequest('A workspace must always keep at least one owner');
    }

    const updated = await prisma.workspaceMember.update({
      where: { id: member.id },
      data: { role: input.role },
    });
    return ok(res, updated);
  }),
);

workspaceRouter.delete(
  '/current/members/:memberId',
  requireRole('ADMIN'),
  handler(async (req, res) => {
    const member = await prisma.workspaceMember.findFirst({
      where: { id: req.params.memberId, workspaceId: req.ctx.workspaceId },
    });
    if (!member) throw AppError.notFound('Member');
    if (member.userId === req.ctx.userId) throw AppError.badRequest('You cannot remove yourself');
    if (member.role === 'OWNER') throw AppError.badRequest('Transfer ownership before removing an owner');

    await prisma.workspaceMember.delete({ where: { id: member.id } });
    return ok(res, { removed: true });
  }),
);
