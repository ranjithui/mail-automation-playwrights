/**
 * Operational surfaces: the job queue, activity logs, automation runs,
 * bounces, suppression and notifications.
 */
import { Router } from 'express';
import { prisma } from '@mail/database';
import { driverName, enqueue } from '@mail/queue';
import { addSuppression, removeSuppression } from '@mail/core';
import { parseJson, suppressionSchema } from '@mail/shared';
import { AppError, handler, ok, paginate } from '../lib/http.js';
import { authenticate, requireManage, requireWrite, withWorkspace } from '../middleware/context.js';

// ------------------------------------------------------------------- jobs

export const jobRouter = Router();
jobRouter.use(authenticate, withWorkspace);

jobRouter.get(
  '/',
  handler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Number(req.query.pageSize ?? 25));
    const where: Record<string, unknown> = { workspaceId: req.ctx.workspaceId };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.queue) where.queue = String(req.query.queue);
    if (req.query.campaignId) where.campaignId = String(req.query.campaignId);

    const [rows, total] = await Promise.all([
      prisma.scheduledJob.findMany({
        where,
        include: { campaign: { select: { name: true } } },
        orderBy: [{ runAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.scheduledJob.count({ where }),
    ]);

    return ok(
      res,
      paginate(
        rows.map((j) => ({
          id: j.id,
          queue: j.queue,
          name: j.name,
          status: j.status,
          attempts: j.attempts,
          maxAttempts: j.maxAttempts,
          runAt: j.runAt.toISOString(),
          startedAt: j.startedAt?.toISOString() ?? null,
          completedAt: j.completedAt?.toISOString() ?? null,
          errorCode: j.errorCode,
          error: j.error,
          campaignId: j.campaignId,
          campaignName: j.campaign?.name ?? null,
          payload: parseJson<Record<string, unknown>>(j.payloadJson, {}),
        })),
        total,
        page,
        pageSize,
      ),
    );
  }),
);

jobRouter.get(
  '/stats',
  handler(async (req, res) => {
    const grouped = await prisma.scheduledJob.groupBy({
      by: ['queue', 'status'],
      where: { workspaceId: req.ctx.workspaceId },
      _count: { _all: true },
    });

    const queues: Record<string, Record<string, number>> = {};
    for (const row of grouped) {
      queues[row.queue] ??= {};
      queues[row.queue][row.status] = row._count._all;
    }

    const totals = grouped.reduce<Record<string, number>>((acc, row) => {
      acc[row.status] = (acc[row.status] ?? 0) + row._count._all;
      return acc;
    }, {});

    return ok(res, { driver: driverName(), queues, totals });
  }),
);

jobRouter.post(
  '/:id/retry',
  requireWrite,
  handler(async (req, res) => {
    const job = await prisma.scheduledJob.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!job) throw AppError.notFound('Job');
    if (job.status === 'ACTIVE') throw AppError.badRequest('That job is currently running');

    const updated = await prisma.scheduledJob.update({
      where: { id: job.id },
      data: {
        status: 'PENDING',
        runAt: new Date(),
        attempts: 0,
        error: null,
        errorCode: null,
        completedAt: null,
        lockedBy: null,
        lockedAt: null,
      },
    });

    // Re-dispatch so the Redis driver picks it up too.
    const { getDispatcher } = await import('@mail/queue');
    await getDispatcher().dispatch(job.id, job.queue as never, new Date());

    return ok(res, updated);
  }),
);

jobRouter.post(
  '/:id/cancel',
  requireWrite,
  handler(async (req, res) => {
    const cancelled = await prisma.scheduledJob.updateMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId, status: { in: ['PENDING', 'DELAYED'] } },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    if (!cancelled.count) throw AppError.badRequest('That job can no longer be cancelled');
    return ok(res, { cancelled: true });
  }),
);

jobRouter.get(
  '/runs',
  handler(async (req, res) => {
    const runs = await prisma.automationRun.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      include: { campaign: { select: { name: true } } },
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    return ok(res, runs);
  }),
);

// ------------------------------------------------------------------- logs

export const logRouter = Router();
logRouter.use(authenticate, withWorkspace);

logRouter.get(
  '/',
  handler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Number(req.query.pageSize ?? 50));
    const where: Record<string, unknown> = { workspaceId: req.ctx.workspaceId };
    if (req.query.status) where.status = String(req.query.status);
    if (req.query.campaignId) where.campaignId = String(req.query.campaignId);
    if (req.query.q) where.action = { contains: String(req.query.q) };

    const [rows, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        include: { campaign: { select: { name: true } }, user: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.activityLog.count({ where }),
    ]);

    return ok(
      res,
      paginate(
        rows.map((l) => ({
          id: l.id,
          action: l.action,
          status: l.status,
          message: l.message,
          errorCode: l.errorCode,
          durationMs: l.durationMs,
          retryCount: l.retryCount,
          workerId: l.workerId,
          campaignId: l.campaignId,
          campaignName: l.campaign?.name ?? null,
          contactId: l.contactId,
          user: l.user ? `${l.user.firstName} ${l.user.lastName}` : null,
          meta: parseJson<Record<string, unknown>>(l.metaJson, {}),
          createdAt: l.createdAt.toISOString(),
        })),
        total,
        page,
        pageSize,
      ),
    );
  }),
);

// --------------------------------------------------------- bounces & safety

export const safetyRouter = Router();
safetyRouter.use(authenticate, withWorkspace);

safetyRouter.get(
  '/bounces',
  handler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(100, Number(req.query.pageSize ?? 25));
    const where: Record<string, unknown> = { workspaceId: req.ctx.workspaceId };
    if (req.query.type) where.type = String(req.query.type);
    if (req.query.q) where.email = { contains: String(req.query.q) };

    const [rows, total, stats] = await Promise.all([
      prisma.bounce.findMany({
        where,
        include: { contact: { select: { id: true, firstName: true, lastName: true, companyName: true } } },
        orderBy: { detectedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.bounce.count({ where }),
      prisma.bounce.groupBy({
        by: ['type'],
        where: { workspaceId: req.ctx.workspaceId },
        _count: { _all: true },
      }),
    ]);

    return ok(res, {
      ...paginate(rows, total, page, pageSize),
      stats: Object.fromEntries(stats.map((s) => [s.type, s._count._all])),
    });
  }),
);

safetyRouter.get(
  '/suppression',
  handler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.min(200, Number(req.query.pageSize ?? 50));
    const where: Record<string, unknown> = { workspaceId: req.ctx.workspaceId };
    if (req.query.type) where.type = String(req.query.type);
    if (req.query.q) where.value = { contains: String(req.query.q) };

    const [rows, total, stats] = await Promise.all([
      prisma.suppressionList.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.suppressionList.count({ where }),
      prisma.suppressionList.groupBy({
        by: ['type'],
        where: { workspaceId: req.ctx.workspaceId },
        _count: { _all: true },
      }),
    ]);

    return ok(res, {
      ...paginate(rows, total, page, pageSize),
      stats: Object.fromEntries(stats.map((s) => [s.type, s._count._all])),
    });
  }),
);

safetyRouter.post(
  '/suppression',
  requireWrite,
  handler(async (req, res) => {
    const input = suppressionSchema.parse(req.body);
    const entry = await addSuppression({
      workspaceId: req.ctx.workspaceId,
      value: input.value,
      scope: input.scope,
      type: input.type,
      reason: input.reason,
    });
    return ok(res, entry, undefined, 201);
  }),
);

safetyRouter.delete(
  '/suppression/:id',
  requireManage,
  handler(async (req, res) => {
    const entry = await prisma.suppressionList.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!entry) throw AppError.notFound('Suppression entry');
    await removeSuppression(req.ctx.workspaceId, entry.value);
    return ok(res, { removed: true });
  }),
);

safetyRouter.get(
  '/unsubscribes',
  handler(async (req, res) => {
    const rows = await prisma.unsubscribe.findMany({
      where: { workspaceId: req.ctx.workspaceId },
      include: { contact: { select: { id: true, firstName: true, lastName: true, companyName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return ok(res, rows);
  }),
);

// ---------------------------------------------------------- notifications

export const notificationRouter = Router();
notificationRouter.use(authenticate, withWorkspace);

notificationRouter.get(
  '/',
  handler(async (req, res) => {
    const [rows, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { workspaceId: req.ctx.workspaceId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(100, Number(req.query.limit ?? 50)),
      }),
      prisma.notification.count({ where: { workspaceId: req.ctx.workspaceId, isRead: false } }),
    ]);
    return ok(res, { items: rows, unread });
  }),
);

notificationRouter.post(
  '/:id/read',
  handler(async (req, res) => {
    await prisma.notification.updateMany({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      data: { isRead: true },
    });
    return ok(res, { read: true });
  }),
);

notificationRouter.post(
  '/read-all',
  handler(async (req, res) => {
    const updated = await prisma.notification.updateMany({
      where: { workspaceId: req.ctx.workspaceId, isRead: false },
      data: { isRead: true },
    });
    return ok(res, { read: updated.count });
  }),
);

notificationRouter.post(
  '/digest',
  requireWrite,
  handler(async (req, res) => {
    await enqueue({
      workspaceId: req.ctx.workspaceId,
      queue: 'notification',
      name: 'daily-digest',
      payload: { workspaceId: req.ctx.workspaceId, kind: 'DAILY_DIGEST' },
      maxAttempts: 1,
    });
    return ok(res, { queued: true });
  }),
);
