/**
 * Agent authentication.
 *
 * An agent is not a user: it has no session, no workspace picker and no role.
 * It presents one bearer token that was issued to one machine, and everything
 * it may see or do is bounded by the workspace that token belongs to. Nothing
 * downstream reads a workspace id off the request - it comes from the device
 * row, so an agent cannot ask about a workspace it was not enrolled into.
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '@mail/database';
import { hashDeviceToken } from '@mail/core';
import { AppError } from '../lib/http.js';

export interface DeviceContext {
  deviceId: string;
  workspaceId: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      device?: DeviceContext;
    }
  }
}

/**
 * Requires a live device token. Sets `req.device`.
 *
 * A revoked device is refused with the same 401 as a bad token, and the agent
 * treats that as "wipe the token and stop" - which is why revocation takes
 * effect within one long-poll rather than needing anything pushed to it.
 */
export async function withDevice(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw AppError.unauthorized('This endpoint is for enrolled agents', 'DEVICE_TOKEN_REQUIRED');
    }

    const device = await prisma.device.findUnique({
      where: { tokenHash: hashDeviceToken(header.slice(7).trim()) },
      select: { id: true, workspaceId: true, name: true, revokedAt: true },
    });

    if (!device || device.revokedAt) {
      throw AppError.unauthorized('This device is no longer enrolled', 'DEVICE_REVOKED');
    }

    req.device = { deviceId: device.id, workspaceId: device.workspaceId, name: device.name };
    next();
  } catch (error) {
    next(error);
  }
}

/** The device context, or a 401 - so handlers never carry a null check. */
export function deviceOf(req: Request): DeviceContext {
  if (!req.device) throw AppError.unauthorized('This endpoint is for enrolled agents');
  return req.device;
}
