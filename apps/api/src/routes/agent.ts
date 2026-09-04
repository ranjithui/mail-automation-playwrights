/**
 * The agent protocol.
 *
 * Four endpoints carry everything a machine running browsers needs, and none
 * of them hands out a database credential:
 *
 *   POST /api/agent/enrol      pairing code  ->  device token
 *   GET  /api/agent/work       long-poll for the next operation
 *   POST /api/agent/work/:id   report it done or failed
 *   POST /api/agent/heartbeat  liveness and mailbox status
 *
 * Plus `GET /api/agent/files/:name`, which is how an agent reads an attachment
 * it is about to send - the file lives in this service's storage directory and
 * the agent has no filesystem in common with it.
 *
 * The operation set is deliberately not part of the protocol. A task carries
 * the driver method name and its arguments, so adding an operation to
 * MailboxDriver needs no change here.
 */
import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import { createLogger } from '@mail/config';
import { prisma } from '@mail/database';
import { generateDeviceToken, publish, storage } from '@mail/core';
import { AppError, handler, ok } from '../lib/http.js';
import { deviceOf, withDevice } from '../middleware/device.js';

const log = createLogger('agent');

export const agentRouter = Router();

/**
 * How long a poll is held open before answering "nothing yet".
 *
 * Long enough that an idle agent is nearly silent, short enough to sit well
 * inside the sixty seconds a proxy will usually allow, and to make a revoked
 * device notice within half a minute.
 */
const POLL_HOLD_MS = 25_000;
const POLL_TICK_MS = 1_000;

/** A leased operation must fail before the queue's own job watchdog fires. */
const LEASE_MS: Record<string, number> = { connect: 15 * 60_000, fetchThreads: 8 * 60_000 };
const DEFAULT_LEASE_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ enrolment

const enrolSchema = z.object({
  code: z.string().trim().min(4).max(32),
  machineName: z.string().trim().min(1).max(80).default('unnamed machine'),
  platform: z.string().trim().max(40).default('unknown'),
  agentVersion: z.string().trim().max(40).optional(),
});

agentRouter.post(
  '/enrol',
  handler(async (req, res) => {
    const input = enrolSchema.parse(req.body);
    const code = input.code.toUpperCase().replace(/\s+/g, '');

    const pairing = await prisma.pairingCode.findUnique({ where: { code } });

    // One message for every failure mode. A code that does not exist, one that
    // expired and one already used are all "that code will not work", and
    // saying which would help somebody working through the keyspace.
    const unusable =
      !pairing || pairing.usedAt || pairing.expiresAt.getTime() < Date.now() || pairing.attempts >= 5;

    if (unusable) {
      if (pairing) {
        await prisma.pairingCode.update({
          where: { id: pairing.id },
          data: { attempts: { increment: 1 } },
        });
      }
      throw AppError.badRequest('That pairing code is not valid. Generate a new one.', 'PAIRING_CODE_INVALID');
    }

    const { token, hash } = generateDeviceToken();

    const device = await prisma.device.create({
      data: {
        workspaceId: pairing.workspaceId,
        name: input.machineName,
        platform: input.platform,
        agentVersion: input.agentVersion,
        tokenHash: hash,
        lastSeenAt: new Date(),
      },
      select: { id: true, name: true, workspaceId: true },
    });

    // Single use, and consumed only once a device actually exists - a crash
    // between the two would otherwise burn the code and strand the operator.
    await prisma.pairingCode.update({ where: { id: pairing.id }, data: { usedAt: new Date() } });

    log.info(`device ${device.name} (${device.id}) enrolled into workspace ${device.workspaceId}`);
    await publish(device.workspaceId, 'worker.status', { deviceId: device.id, enrolled: true });

    const mailboxes = await prisma.emailAccount.findMany({
      where: { deviceId: device.id },
      select: { id: true, email: true },
    });

    // The only time the token exists in a response body.
    return ok(res, { deviceToken: token, deviceId: device.id, workspaceId: device.workspaceId, mailboxes }, undefined, 201);
  }),
);

// ----------------------------------------------------------------------- work

/**
 * Claims one pending operation for this device.
 *
 * The update is conditional on the row still being PENDING, so two agents
 * sharing a token - or one that retried a poll it had already answered - can
 * never both be handed the same operation.
 */
async function leaseOne(deviceId: string) {
  const candidate = await prisma.agentTask.findFirst({
    where: { deviceId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, op: true, emailAccountId: true },
  });
  if (!candidate) return null;

  const leaseMs = LEASE_MS[candidate.op] ?? DEFAULT_LEASE_MS;
  const claimed = await prisma.agentTask.updateMany({
    where: { id: candidate.id, status: 'PENDING' },
    data: {
      status: 'LEASED',
      startedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + leaseMs),
    },
  });
  if (claimed.count === 0) return null;

  const task = await prisma.agentTask.findUnique({
    where: { id: candidate.id },
    select: {
      id: true,
      op: true,
      argsJson: true,
      leaseExpiresAt: true,
      emailAccount: { select: { id: true, email: true, displayName: true } },
    },
  });
  if (!task) return null;

  return {
    id: task.id,
    op: task.op,
    args: JSON.parse(task.argsJson) as Record<string, unknown>,
    leaseExpiresAt: task.leaseExpiresAt,
    mailbox: task.emailAccount,
  };
}

agentRouter.get(
  '/work',
  withDevice,
  handler(async (req, res) => {
    const { deviceId } = deviceOf(req);
    const deadline = Date.now() + POLL_HOLD_MS;

    // Held open rather than answered immediately, so an idle agent makes one
    // request every 25 seconds instead of one every second, and a busy one
    // starts work within a second of it being queued.
    for (;;) {
      const task = await leaseOne(deviceId);
      if (task) {
        await prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
        return ok(res, task);
      }
      if (Date.now() >= deadline) break;
      // A client that hung up mid-hold should not keep this loop alive.
      if (req.destroyed || res.writableEnded) return;
      await sleep(POLL_TICK_MS);
    }

    return res.status(204).end();
  }),
);

const resultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    code: z.string().trim().max(60).default('UNKNOWN_ERROR'),
    message: z.string().trim().max(2000).default('the agent reported a failure'),
    /** A PNG of whatever the browser was showing when it went wrong. */
    screenshotBase64: z.string().max(8_000_000).optional(),
  }),
]);

agentRouter.post(
  '/work/:id',
  withDevice,
  handler(async (req, res) => {
    const { deviceId } = deviceOf(req);
    const input = resultSchema.parse(req.body);

    let screenshotId: string | undefined;
    if (!input.ok && input.screenshotBase64) {
      try {
        const saved = await storage.save(Buffer.from(input.screenshotBase64, 'base64'), 'agent-failure.png');
        screenshotId = saved.storagePath;
      } catch (error) {
        // A screenshot that will not save must never turn a reported failure
        // into a lost one - the error itself is the thing worth keeping.
        log.warn(`could not store an agent screenshot: ${String(error)}`);
      }
    }

    // Conditional on LEASED: a task the caller already gave up on has been
    // moved to FAILED, and a late answer to it must not overwrite that - the
    // send it describes may well have been retried by now.
    const updated = await prisma.agentTask.updateMany({
      where: { id: req.params.id, deviceId, status: 'LEASED' },
      data: input.ok
        ? {
            status: 'DONE',
            resultJson: JSON.stringify(input.result ?? null),
            completedAt: new Date(),
          }
        : {
            status: 'FAILED',
            errorCode: input.code,
            error: input.message.slice(0, 1000),
            screenshotId,
            completedAt: new Date(),
          },
    });

    if (updated.count === 0) {
      throw AppError.conflict('That operation is no longer waiting for an answer', 'TASK_NOT_LEASED');
    }

    await prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    return ok(res, { recorded: true });
  }),
);

// ------------------------------------------------------------------ heartbeat

const heartbeatSchema = z.object({
  agentVersion: z.string().trim().max(40).optional(),
  mailboxes: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        browserStatus: z.string().trim().max(20).default('STOPPED'),
        sessionStatus: z.string().trim().max(20).default('NONE'),
      }),
    )
    .max(50)
    .default([]),
});

agentRouter.post(
  '/heartbeat',
  withDevice,
  handler(async (req, res) => {
    const { deviceId, workspaceId } = deviceOf(req);
    const input = heartbeatSchema.parse(req.body);

    await prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date(), agentVersion: input.agentVersion },
    });

    // Only mailboxes this device actually owns. An agent reporting on somebody
    // else's mailbox is either confused or hostile; either way it is ignored.
    const owned = await prisma.emailAccount.findMany({
      where: { deviceId, id: { in: input.mailboxes.map((m) => m.id) } },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((m) => m.id));

    for (const mailbox of input.mailboxes) {
      if (!ownedIds.has(mailbox.id)) continue;
      const existing = await prisma.emailSession.findFirst({ where: { emailAccountId: mailbox.id } });
      const data = {
        browserStatus: mailbox.browserStatus,
        sessionStatus: mailbox.sessionStatus,
        workerId: `agent-${deviceId}`,
        lastActivityAt: new Date(),
      };
      if (existing) await prisma.emailSession.update({ where: { id: existing.id }, data });
      else await prisma.emailSession.create({ data: { emailAccountId: mailbox.id, ...data } });

      await publish(workspaceId, 'worker.status', {
        accountId: mailbox.id,
        browserStatus: mailbox.browserStatus,
      });
    }

    return ok(res, { ok: true });
  }),
);

// ---------------------------------------------------------------------- files

agentRouter.get(
  '/files/:name',
  withDevice,
  handler(async (req, res) => {
    const { workspaceId } = deviceOf(req);

    // Ownership is checked against the attachment table, not the filesystem:
    // the storage directory is shared by every workspace, and a stored name is
    // the only thing an agent is ever told.
    const attachment = await prisma.attachment.findFirst({
      where: { workspaceId, storagePath: req.params.name },
      select: { originalName: true, mimeType: true, storagePath: true },
    });
    if (!attachment) throw AppError.notFound('Attachment');

    const resolved = storage.resolve(attachment.storagePath);
    if (!fs.existsSync(resolved)) {
      throw AppError.notFound('The attachment file', 'ATTACHMENT_FILE_MISSING');
    }

    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.originalName)}"`);
    return res.sendFile(resolved);
  }),
);
