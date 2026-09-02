/**
 * Request context: authentication, workspace resolution and RBAC.
 *
 * Workspace isolation is enforced here rather than in each route. Every
 * workspace-scoped handler reads `req.ctx.workspaceId`, which is only ever set
 * to a workspace the authenticated user is actually a member of.
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '@mail/database';
import { ROLE_RANK, type Role } from '@mail/shared';
import { AppError } from '../lib/http.js';
import { ACCESS_COOKIE, WORKSPACE_COOKIE, verifyAccessToken } from '../lib/auth.js';

export interface RequestContext {
  userId: string;
  email: string;
  workspaceId: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
      userId?: string;
    }
  }
}

function bearerFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  const cookie = (req.cookies ?? {})[ACCESS_COOKIE];
  return typeof cookie === 'string' && cookie ? cookie : null;
}

/** Requires a valid access token. Sets `req.userId`. */
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = bearerFrom(req);
  if (!token) return next(AppError.unauthorized());
  const payload = verifyAccessToken(token);
  if (!payload) return next(AppError.unauthorized('Session expired', 'TOKEN_EXPIRED'));
  req.userId = payload.sub;
  next();
}

/**
 * Resolves the active workspace from the `x-workspace-id` header, the
 * workspace cookie, or the user's first membership - and verifies membership
 * before anything else runs.
 */
export async function withWorkspace(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.userId) throw AppError.unauthorized();

    const requested =
      (req.headers['x-workspace-id'] as string | undefined) ||
      (req.query.workspaceId as string | undefined) ||
      (req.cookies ?? {})[WORKSPACE_COOKIE];

    const memberships = await prisma.workspaceMember.findMany({
      where: { userId: req.userId },
      include: { workspace: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (!memberships.length) throw AppError.forbidden('You are not a member of any workspace');

    const membership =
      memberships.find((m) => m.workspaceId === requested) ?? memberships[0];

    if (requested && membership.workspaceId !== requested) {
      throw AppError.forbidden('You do not have access to that workspace');
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { email: true, isActive: true } });
    if (!user?.isActive) throw AppError.forbidden('This account is disabled');

    req.ctx = {
      userId: req.userId,
      email: user.email,
      workspaceId: membership.workspaceId,
      role: membership.role as Role,
    };
    next();
  } catch (error) {
    next(error);
  }
}

/** RBAC gate: `requireRole('MANAGER')` allows MANAGER, ADMIN and OWNER. */
export function requireRole(minimum: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.ctx) return next(AppError.unauthorized());
    if (ROLE_RANK[req.ctx.role] < ROLE_RANK[minimum]) {
      return next(AppError.forbidden(`This action requires the ${minimum} role or higher`));
    }
    next();
  };
}

/** Convenience: everything below VIEWER-level write access. */
export const requireWrite = requireRole('USER');
export const requireManage = requireRole('MANAGER');
export const requireAdmin = requireRole('ADMIN');
