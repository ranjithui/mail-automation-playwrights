import { Router } from 'express';
import { prisma } from '@mail/database';
import { env } from '@mail/config';
import { enqueue } from '@mail/queue';
import { logActivity } from '@mail/core';
import { createEmailAccountSchema, updateEmailAccountSchema } from '@mail/shared';
import type { EmailAccountSummary } from '@mail/shared';
import { AppError, handler, ok } from '../lib/http.js';
import { authenticate, requireManage, requireWrite, withWorkspace } from '../middleware/context.js';

export const emailAccountRouter = Router();
emailAccountRouter.use(authenticate, withWorkspace);

/**
 * Projection helper. Note what is NOT selected: `secretsJson` never leaves the
 * backend, and neither do cookies, storage state or browser profile paths.
 */
async function summarise(workspaceId: string, id?: string): Promise<EmailAccountSummary[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { workspaceId, ...(id ? { id } : {}) },
    include: {
      sessions: { orderBy: { updatedAt: 'desc' }, take: 1 },
      _count: { select: { campaigns: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  const active = await prisma.campaign.groupBy({
    by: ['emailAccountId'],
    where: { workspaceId, status: { in: ['RUNNING', 'SCHEDULED'] } },
    _count: { _all: true },
  });

  const today = new Date().toISOString().slice(0, 10);

  return accounts.map((a) => {
    const session = a.sessions[0];
    return {
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      status: a.status,
      connection: a.connection as EmailAccountSummary['connection'],
      browserStatus: (session?.browserStatus ?? 'STOPPED') as EmailAccountSummary['browserStatus'],
      sessionStatus: (session?.sessionStatus ?? 'NONE') as EmailAccountSummary['sessionStatus'],
      dailyLimit: a.dailyLimit,
      hourlyLimit: a.hourlyLimit,
      sentToday: a.sentTodayDate === today ? a.sentToday : 0,
      activeCampaigns: active.find((c) => c.emailAccountId === a.id)?._count._all ?? 0,
      lastConnectedAt: a.lastConnectedAt?.toISOString() ?? null,
      lastActivityAt: session?.lastActivityAt?.toISOString() ?? null,
      lastError: a.lastError,
      lastErrorCode: a.lastErrorCode,
      signatureHtml: a.signatureHtml,
    };
  });
}

emailAccountRouter.get(
  '/',
  handler(async (req, res) => ok(res, await summarise(req.ctx.workspaceId))),
);

emailAccountRouter.get(
  '/driver',
  handler(async (_req, res) =>
    ok(res, {
      driver: env.GMAIL_DRIVER,
      headless: env.PLAYWRIGHT_HEADLESS,
      description:
        env.GMAIL_DRIVER === 'simulation'
          ? 'Simulation driver: the full send / reply / inbox pipeline runs against an in-process mailbox. No real email is sent.'
          : 'Playwright driver: a real Chromium session drives mail.google.com. Sign in once interactively to establish the session.',
    }),
  ),
);

emailAccountRouter.get(
  '/:id',
  handler(async (req, res) => {
    const [account] = await summarise(req.ctx.workspaceId, req.params.id);
    if (!account) throw AppError.notFound('Email account');

    const [session, campaigns, recentLogs] = await Promise.all([
      prisma.emailSession.findFirst({
        where: { emailAccountId: req.params.id },
        orderBy: { updatedAt: 'desc' },
        select: {
          browserStatus: true,
          sessionStatus: true,
          workerId: true,
          currentJobId: true,
          currentCampaignId: true,
          lastActivityAt: true,
          lastError: true,
        },
      }),
      prisma.campaign.findMany({
        where: { emailAccountId: req.params.id },
        select: { id: true, name: true, status: true },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      prisma.activityLog.findMany({
        where: { emailAccountId: req.params.id },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
    ]);

    return ok(res, { ...account, session, campaigns, recentLogs });
  }),
);

emailAccountRouter.post(
  '/',
  requireWrite,
  handler(async (req, res) => {
    const input = createEmailAccountSchema.parse(req.body);
    const account = await prisma.emailAccount.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        email: input.email,
        displayName: input.displayName,
        dailyLimit: input.dailyLimit,
        hourlyLimit: input.hourlyLimit,
        signatureHtml: input.signatureHtml ?? null,
      },
    });
    await prisma.emailSession.create({ data: { emailAccountId: account.id } });

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      emailAccountId: account.id,
      action: 'mailbox.added',
      message: `Mailbox ${account.email} added`,
    });

    const [summary] = await summarise(req.ctx.workspaceId, account.id);
    return ok(res, summary, undefined, 201);
  }),
);

emailAccountRouter.patch(
  '/:id',
  requireWrite,
  handler(async (req, res) => {
    const input = updateEmailAccountSchema.parse(req.body);
    const updated = await prisma.emailAccount.updateMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      data: input,
    });
    if (!updated.count) throw AppError.notFound('Email account');
    const [summary] = await summarise(req.ctx.workspaceId, req.params.id);
    return ok(res, summary);
  }),
);

emailAccountRouter.delete(
  '/:id',
  requireManage,
  handler(async (req, res) => {
    const running = await prisma.campaign.count({
      where: { emailAccountId: req.params.id, status: 'RUNNING' },
    });
    if (running) throw AppError.badRequest('Stop the campaigns using this mailbox first');

    const deleted = await prisma.emailAccount.deleteMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!deleted.count) throw AppError.notFound('Email account');
    return ok(res, { deleted: true });
  }),
);

/** Browser session control (spec section 88): connect / test / restart / stop. */
async function queueBrowserAction(req: { ctx: { workspaceId: string; userId: string } }, id: string, action: string) {
  const account = await prisma.emailAccount.findFirst({
    where: { id, workspaceId: req.ctx.workspaceId },
  });
  if (!account) throw AppError.notFound('Email account');

  await enqueue({
    workspaceId: req.ctx.workspaceId,
    queue: 'browser-worker',
    name: `${action}:${account.email}`,
    payload: { emailAccountId: account.id, action },
    maxAttempts: 1,
  });

  await logActivity({
    workspaceId: req.ctx.workspaceId,
    userId: req.ctx.userId,
    emailAccountId: account.id,
    action: `mailbox.${action}`,
    message: `${action} requested for ${account.email}`,
    status: 'INFO',
  });

  return { queued: true, action, emailAccountId: account.id };
}

for (const action of ['connect', 'reconnect', 'test', 'disconnect', 'restart'] as const) {
  emailAccountRouter.post(
    `/:id/${action}`,
    requireWrite,
    handler(async (req, res) => ok(res, await queueBrowserAction(req as never, req.params.id, action))),
  );
}

emailAccountRouter.post(
  '/:id/sync',
  requireWrite,
  handler(async (req, res) => {
    const account = await prisma.emailAccount.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!account) throw AppError.notFound('Email account');

    await enqueue({
      workspaceId: req.ctx.workspaceId,
      queue: 'inbox-sync',
      name: `sync:${account.email}`,
      payload: { emailAccountId: account.id, limit: 50 },
      maxAttempts: 2,
    });
    return ok(res, { queued: true });
  }),
);
