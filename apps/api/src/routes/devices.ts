/**
 * Device management, from the dashboard side.
 *
 * Everything an operator does about agents happens here: mint a pairing code,
 * see which machines are alive, bind a mailbox to the machine that holds its
 * browser profile, and cut a machine off.
 *
 * The agent's own endpoints live in `agent.ts` and share nothing with these -
 * different credential, different middleware, deliberately no overlap.
 */
import { Router } from 'express';
import { z } from 'zod';
import { env } from '@mail/config';
import { prisma } from '@mail/database';
import { generatePairingCode, logActivity } from '@mail/core';
import { AppError, handler, ok } from '../lib/http.js';
import { authenticate, requireWrite, withWorkspace } from '../middleware/context.js';

export const deviceRouter = Router();
deviceRouter.use(authenticate, withWorkspace);

/**
 * How long a code is worth typing.
 *
 * Long enough to walk to another machine, short enough that a code left on a
 * screen is not a way in tomorrow.
 */
const CODE_TTL_MS = 10 * 60_000;

/** A device is "online" if it has polled recently - one hold plus slack. */
const ONLINE_WINDOW_MS = 90_000;

deviceRouter.post(
  '/pairing-code',
  requireWrite,
  handler(async (req, res) => {
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);

    // Retried rather than assumed unique: the alphabet is small on purpose, so
    // a collision with a live code is unlikely but not impossible.
    let code = generatePairingCode();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const clash = await prisma.pairingCode.findUnique({ where: { code } });
      if (!clash) break;
      code = generatePairingCode();
    }

    await prisma.pairingCode.create({
      data: { code, workspaceId: req.ctx.workspaceId, createdById: req.ctx.userId, expiresAt },
    });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: 'device.pairing_code_created',
      message: 'A pairing code was generated',
    });

    return ok(res, { code, expiresAt: expiresAt.toISOString(), expiresInSeconds: CODE_TTL_MS / 1000 }, undefined, 201);
  }),
);

/**
 * What a new machine needs to know, so the dashboard can walk somebody through
 * setting one up without them reading any documentation.
 *
 * Declared before '/:id' routes would be, since a literal path and a parameter
 * that both match '/agent-info' resolve in declaration order.
 */
deviceRouter.get(
  '/agent-info',
  handler(async (_req, res) =>
    ok(res, {
      downloadUrl: env.AGENT_DOWNLOAD_URL || null,
      // The address the agent is asked for on its first run. Taken from the
      // server's own configuration so it cannot drift from what actually works.
      serverUrl: env.APP_URL,
    }),
  ),
);

deviceRouter.get(
  '/',
  handler(async (req, res) => {
    const devices = await prisma.device.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        platform: true,
        agentVersion: true,
        lastSeenAt: true,
        revokedAt: true,
        createdAt: true,
        emailAccounts: { select: { id: true, email: true, connection: true } },
      },
    });

    const now = Date.now();
    return ok(
      res,
      devices.map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        agentVersion: d.agentVersion,
        createdAt: d.createdAt.toISOString(),
        lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
        revoked: Boolean(d.revokedAt),
        online: Boolean(d.lastSeenAt && !d.revokedAt && now - d.lastSeenAt.getTime() < ONLINE_WINDOW_MS),
        mailboxes: d.emailAccounts,
      })),
    );
  }),
);

/** Cuts a machine off. Reversible only by enrolling it again. */
deviceRouter.post(
  '/:id/revoke',
  requireWrite,
  handler(async (req, res) => {
    const device = await prisma.device.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!device) throw AppError.notFound('Device');

    await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });

    // Its mailboxes come home to the in-process worker rather than being left
    // pointing at a machine that can no longer answer for them.
    await prisma.emailAccount.updateMany({ where: { deviceId: device.id }, data: { deviceId: null } });

    // Anything queued for it would now wait for the full timeout and fail one
    // at a time; failing them here makes the reason legible instead.
    await prisma.agentTask.updateMany({
      where: { deviceId: device.id, status: { in: ['PENDING', 'LEASED'] } },
      data: {
        status: 'FAILED',
        errorCode: 'DEVICE_REVOKED',
        error: 'the device was revoked while this was queued',
        completedAt: new Date(),
      },
    });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: 'device.revoked',
      message: `Device "${device.name}" was revoked`,
    });

    return ok(res, { revoked: true });
  }),
);

deviceRouter.delete(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const device = await prisma.device.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!device) throw AppError.notFound('Device');

    await prisma.emailAccount.updateMany({ where: { deviceId: device.id }, data: { deviceId: null } });
    await prisma.device.delete({ where: { id: device.id } });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: 'device.deleted',
      message: `Device "${device.name}" was removed`,
    });

    return ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------ mailbox binding

const bindSchema = z.object({ emailAccountId: z.string().trim().min(1) });

/**
 * Hands a mailbox to a machine.
 *
 * This is the switch that decides where a mailbox is driven, and it is
 * per-mailbox on purpose: an install can move one mailbox to an agent, watch
 * it send, and leave everything else exactly as it was.
 */
deviceRouter.post(
  '/:id/mailboxes',
  requireWrite,
  handler(async (req, res) => {
    const input = bindSchema.parse(req.body);

    const device = await prisma.device.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!device) throw AppError.notFound('Device');
    if (device.revokedAt) throw AppError.badRequest('That device has been revoked', 'DEVICE_REVOKED');

    const account = await prisma.emailAccount.findFirst({
      where: { id: input.emailAccountId, workspaceId: req.ctx.workspaceId },
    });
    if (!account) throw AppError.notFound('Email account');

    await prisma.emailAccount.update({
      where: { id: account.id },
      data: {
        deviceId: device.id,
        // The new machine has its own browser profile, or none yet - either
        // way the old connection state describes a session somewhere else.
        connection: 'DISCONNECTED',
        lastError: null,
        lastErrorCode: null,
      },
    });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      emailAccountId: account.id,
      action: 'device.mailbox_bound',
      message: `${account.email} is now driven by "${device.name}"`,
    });

    return ok(res, { bound: true, emailAccountId: account.id, deviceId: device.id });
  }),
);

deviceRouter.delete(
  '/:id/mailboxes/:emailAccountId',
  requireWrite,
  handler(async (req, res) => {
    const account = await prisma.emailAccount.findFirst({
      where: {
        id: req.params.emailAccountId,
        workspaceId: req.ctx.workspaceId,
        deviceId: req.params.id,
      },
    });
    if (!account) throw AppError.notFound('Email account');

    await prisma.emailAccount.update({
      where: { id: account.id },
      data: { deviceId: null, connection: 'DISCONNECTED' },
    });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      emailAccountId: account.id,
      action: 'device.mailbox_unbound',
      message: `${account.email} returned to the local worker`,
    });

    return ok(res, { unbound: true });
  }),
);
