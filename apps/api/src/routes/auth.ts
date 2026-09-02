import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '@mail/database';
import { createLogger, env } from '@mail/config';
import { randomToken, sha256 } from '@mail/config/crypto';
import { logActivity } from '@mail/core';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  slugify,
  updateProfileSchema,
} from '@mail/shared';
import type { Role, SessionUser } from '@mail/shared';
import { AppError, handler, ok } from '../lib/http.js';
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  consumeRefreshToken,
  hashPassword,
  issueRefreshToken,
  revokeAllRefreshTokens,
  setAuthCookies,
  setWorkspaceCookie,
  signAccessToken,
  verifyPassword,
} from '../lib/auth.js';
import { authenticate } from '../middleware/context.js';

const log = createLogger('auth');
export const authRouter = Router();

// Brute-force protection on the credential endpoints only.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: env.isProduction ? 20 : 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again shortly.' } },
});

export async function buildSessionUser(userId: string, activeWorkspaceId?: string | null): Promise<SessionUser> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      organization: { select: { id: true, name: true } },
      memberships: {
        include: { workspace: { select: { id: true, name: true, slug: true, timezone: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!user) throw AppError.notFound('User');

  const workspaces = user.memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    role: m.role as Role,
    timezone: m.workspace.timezone,
  }));

  const active =
    workspaces.find((w) => w.id === activeWorkspaceId)?.id ?? workspaces[0]?.id ?? null;

  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    avatarUrl: user.avatarUrl,
    timezone: user.timezone,
    organizationId: user.organizationId,
    organizationName: user.organization?.name ?? null,
    workspaces,
    activeWorkspaceId: active,
  };
}

authRouter.post(
  '/register',
  authLimiter,
  handler(async (req, res) => {
    const input = registerSchema.parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw AppError.conflict('An account with that email already exists', 'EMAIL_TAKEN');

    // A registration creates the whole tenant: organization, first workspace
    // and an OWNER membership.
    const passwordHash = await hashPassword(input.password);
    const baseSlug = slugify(input.organizationName);
    let slug = baseSlug;
    for (let i = 1; await prisma.organization.findUnique({ where: { slug } }); i += 1) {
      slug = `${baseSlug}-${i}`;
    }

    const user = await prisma.$transaction(async (tx) => {
      const organization = await tx.organization.create({
        data: { name: input.organizationName, slug },
      });
      const created = await tx.user.create({
        data: {
          email: input.email,
          passwordHash,
          firstName: input.firstName,
          lastName: input.lastName,
          organizationId: organization.id,
        },
      });
      const workspace = await tx.workspace.create({
        data: { organizationId: organization.id, name: 'Default workspace', slug: 'default' },
      });
      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: created.id, role: 'OWNER' },
      });
      return created;
    });

    const accessToken = signAccessToken({ sub: user.id, email: user.email });
    const refresh = await issueRefreshToken(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setAuthCookies(res, accessToken, refresh.token, refresh.expiresAt);

    const session = await buildSessionUser(user.id);
    if (session.activeWorkspaceId) setWorkspaceCookie(res, session.activeWorkspaceId);

    log.info(`registered ${user.email}`);
    return ok(res, { user: session, accessToken }, undefined, 201);
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  handler(async (req, res) => {
    const input = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    // Same error for unknown account and wrong password: never disclose which.
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw AppError.unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
    }
    if (!user.isActive) throw AppError.forbidden('This account is disabled');

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const accessToken = signAccessToken({ sub: user.id, email: user.email });
    const refresh = await issueRefreshToken(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setAuthCookies(res, accessToken, refresh.token, refresh.expiresAt);

    const session = await buildSessionUser(user.id);
    if (session.activeWorkspaceId) {
      setWorkspaceCookie(res, session.activeWorkspaceId);
      await logActivity({
        workspaceId: session.activeWorkspaceId,
        userId: user.id,
        action: 'auth.login',
        message: `${user.email} signed in`,
        status: 'INFO',
      });
    }

    return ok(res, { user: session, accessToken });
  }),
);

authRouter.post(
  '/refresh',
  handler(async (req, res) => {
    const token = (req.cookies ?? {})[REFRESH_COOKIE] ?? req.body?.refreshToken;
    if (!token) throw AppError.unauthorized('No refresh token supplied');

    const record = await consumeRefreshToken(token);
    if (!record) throw AppError.unauthorized('Refresh token is invalid or expired');

    const user = await prisma.user.findUnique({ where: { id: record.userId } });
    if (!user?.isActive) throw AppError.unauthorized('Account unavailable');

    const accessToken = signAccessToken({ sub: user.id, email: user.email });
    const refresh = await issueRefreshToken(user.id, { userAgent: req.headers['user-agent'], ip: req.ip });
    setAuthCookies(res, accessToken, refresh.token, refresh.expiresAt);

    return ok(res, { user: await buildSessionUser(user.id), accessToken });
  }),
);

authRouter.post(
  '/logout',
  handler(async (req, res) => {
    const token = (req.cookies ?? {})[REFRESH_COOKIE];
    if (token) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: sha256(token), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    clearAuthCookies(res);
    return ok(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  handler(async (req, res) => {
    const workspaceId = (req.headers['x-workspace-id'] as string | undefined) ?? null;
    return ok(res, await buildSessionUser(req.userId!, workspaceId));
  }),
);

authRouter.patch(
  '/me',
  authenticate,
  handler(async (req, res) => {
    const input = updateProfileSchema.parse(req.body);
    await prisma.user.update({ where: { id: req.userId! }, data: input });
    return ok(res, await buildSessionUser(req.userId!));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  authLimiter,
  handler(async (req, res) => {
    const input = changePasswordSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });

    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw AppError.badRequest('Current password is incorrect', 'INVALID_CREDENTIALS');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.newPassword) },
    });
    // Changing a password invalidates every other session.
    await revokeAllRefreshTokens(user.id);
    clearAuthCookies(res);
    return ok(res, { changed: true });
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  handler(async (req, res) => {
    const input = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: input.email } });

    // Always report success so the endpoint cannot be used to enumerate accounts.
    if (!user) return ok(res, { sent: true });

    const token = randomToken(32);
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const resetUrl = `${env.APP_URL}/reset-password?token=${token}`;
    log.info(`password reset requested for ${user.email}`);

    // Outside production the link is returned directly so a self-hosted
    // install works before any transactional mail provider is configured.
    return ok(res, env.isProduction ? { sent: true } : { sent: true, resetUrl });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  handler(async (req, res) => {
    const input = resetPasswordSchema.parse(req.body);
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(input.token) } });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw AppError.badRequest('This reset link is invalid or has expired', 'INVALID_TOKEN');
    }

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await hashPassword(input.password) },
      }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return ok(res, { reset: true });
  }),
);
