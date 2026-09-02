/**
 * Authentication primitives.
 *
 * Access tokens are short-lived JWTs; refresh tokens are opaque random strings
 * stored only as SHA-256 hashes. Both travel in httpOnly, sameSite cookies so
 * no token is ever readable by page scripts.
 */
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';
import { env } from '@mail/config';
import { randomToken, sha256 } from '@mail/config/crypto';
import { prisma } from '@mail/database';

export const ACCESS_COOKIE = 'mf_access';
export const REFRESH_COOKIE = 'mf_refresh';
export const WORKSPACE_COOKIE = 'mf_workspace';

export interface AccessTokenPayload {
  sub: string;
  email: string;
}

export const hashPassword = (plain: string) => bcrypt.hash(plain, env.BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AccessTokenPayload;
  } catch {
    return null;
  }
}

function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return 30 * 86_400_000;
  const value = Number(match[1]);
  const unit = match[2];
  const factor = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 86_400_000;
  return value * factor;
}

export async function issueRefreshToken(userId: string, meta: { userAgent?: string; ip?: string }) {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + ttlToMs(env.REFRESH_TOKEN_TTL));
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ip: meta.ip ?? null,
      expiresAt,
    },
  });
  return { token, expiresAt };
}

export async function consumeRefreshToken(token: string) {
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!record || record.revokedAt || record.expiresAt < new Date()) return null;
  // Rotation: the presented token is retired the moment it is accepted.
  await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
  return record;
}

export async function revokeAllRefreshTokens(userId: string) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

const cookieBase = {
  httpOnly: true as const,
  sameSite: 'lax' as const,
  secure: env.isProduction,
  path: '/',
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, expiresAt: Date) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...cookieBase, maxAge: ttlToMs(env.ACCESS_TOKEN_TTL) });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...cookieBase, expires: expiresAt });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, cookieBase);
  res.clearCookie(REFRESH_COOKIE, cookieBase);
  res.clearCookie(WORKSPACE_COOKIE, { ...cookieBase, httpOnly: false });
}

export function setWorkspaceCookie(res: Response, workspaceId: string) {
  // Readable by the client so a reload restores the last active workspace.
  res.cookie(WORKSPACE_COOKIE, workspaceId, { ...cookieBase, httpOnly: false, maxAge: 365 * 86_400_000 });
}
