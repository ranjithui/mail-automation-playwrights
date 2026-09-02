/**
 * Worker process.
 *
 * Consumes every queue, owns all browser sessions, and is the only place in
 * the platform that touches a mailbox. Runs independently of the API so a
 * crashed browser can never take the web app down - and, because the job
 * ledger lives in the database, a restart resumes exactly where it stopped.
 */
import { createLogger, env } from '@mail/config';
import { prisma } from '@mail/database';
import { driverName, enqueue, recoverStaleJobs, startWorkers, stopWorkers } from '@mail/queue';
import type { JobHandler, JobRecord } from '@mail/queue';
import { releaseAll, workerId } from '@mail/core';
import type { QueueName } from '@mail/shared';
import { processSend } from './processors/email-send.js';
import { bootstrapSchedulers, processScheduler } from './processors/scheduler.js';
import { processBounceCheck, processBrowserAction, processInboxSync } from './processors/inbox.js';
import { processAIAnalysis, processAIReply } from './processors/ai.js';
import { processAnalytics, processNotification } from './processors/notifications.js';

const log = createLogger('worker');

const handlers: Partial<Record<QueueName, JobHandler>> = {
  'email-send': processSend,
  'email-followup': processSend,
  'campaign-scheduler': processScheduler,
  'browser-worker': processBrowserAction,
  'inbox-sync': processInboxSync,
  'bounce-check': processBounceCheck,
  'ai-analysis': processAIAnalysis,
  'ai-reply': processAIReply,
  notification: processNotification,
  analytics: processAnalytics,
};

/** Wraps each handler so a thrown error is always logged with its job name. */
function instrument(name: QueueName, handler: JobHandler): JobHandler {
  return async (job: JobRecord) => {
    const started = Date.now();
    log.debug(`-> ${name} ${job.name}`);
    try {
      const result = await handler(job);
      log.debug(`<- ${name} ${job.name} in ${Date.now() - started}ms`);
      return result ?? undefined;
    } catch (error) {
      log.warn(`x  ${name} ${job.name}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  };
}

/**
 * Housekeeping cadence. These jobs are self-rescheduling via the ledger, so
 * they survive restarts without an external cron.
 */
async function scheduleMaintenance() {
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  const now = Date.now();

  // Automatic polling is opt-in. When it is off, a mailbox is only ever opened
  // because a person pressed Sync or a campaign needs to send - which is what
  // makes the browser driver predictable to sit next to.
  if (env.INBOX_SYNC_INTERVAL_MS > 0) {
    const mailboxes = await prisma.emailAccount.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, workspaceId: true, email: true },
    });

    for (const mailbox of mailboxes) {
      // Circuit breaker: a mailbox that keeps failing is left alone rather
      // than retried forever. Nothing here should ever loop indefinitely.
      const recent = await prisma.scheduledJob.findMany({
        where: { queue: 'inbox-sync', name: `sync:${mailbox.email}` },
        orderBy: { createdAt: 'desc' },
        take: env.INBOX_SYNC_FAILURE_LIMIT,
        select: { status: true },
      });
      const tripped =
        recent.length >= env.INBOX_SYNC_FAILURE_LIMIT && recent.every((j) => j.status === 'FAILED');

      if (tripped) {
        log.warn(
          `auto-sync paused for ${mailbox.email}: ${recent.length} consecutive failures. Fix the cause, then press Sync manually.`,
        );
        continue;
      }

      await enqueue({
        workspaceId: mailbox.workspaceId,
        queue: 'inbox-sync',
        name: `sync:${mailbox.email}`,
        payload: { emailAccountId: mailbox.id, limit: 25 },
        dedupeKey: `inbox-sync:${mailbox.id}:${Math.floor(now / env.INBOX_SYNC_INTERVAL_MS)}`,
        maxAttempts: 1,
      });
    }
  }

  for (const workspace of workspaces) {
    await enqueue({
      workspaceId: workspace.id,
      queue: 'analytics',
      name: 'housekeeping',
      payload: {},
      runAt: new Date(now + 30_000),
      dedupeKey: `analytics:${workspace.id}:${Math.floor(now / 3_600_000)}`,
      maxAttempts: 1,
    });

    await enqueue({
      workspaceId: workspace.id,
      queue: 'bounce-check',
      name: 'bounce-sweep',
      payload: {},
      runAt: new Date(now + 120_000),
      dedupeKey: `bounce-check:${workspace.id}:${Math.floor(now / 1_800_000)}`,
      maxAttempts: 1,
    });
  }
}

async function main() {
  log.info(`worker ${workerId} starting`);
  log.info(`queue=${driverName()}  mailbox=${env.GMAIL_DRIVER}  ai=${env.AI_PROVIDER}  db=${env.DATABASE_PROVIDER}`);

  if (env.GMAIL_DRIVER === 'simulation') {
    log.info('simulation mailbox driver active - no real email is sent. Set GMAIL_DRIVER=playwright to drive Gmail.');
  }
  log.info(
    env.INBOX_SYNC_INTERVAL_MS > 0
      ? `automatic inbox sync every ${env.INBOX_SYNC_INTERVAL_MS / 1000}s`
      : 'automatic inbox sync is OFF - mailboxes open only on a manual sync or a campaign send',
  );

  // Anything a previous worker was holding when it died is released here.
  await recoverStaleJobs();
  await bootstrapSchedulers();
  await scheduleMaintenance();

  const instrumented = Object.fromEntries(
    Object.entries(handlers).map(([queue, handler]) => [queue, instrument(queue as QueueName, handler!)]),
  ) as Partial<Record<QueueName, JobHandler>>;

  await startWorkers(instrumented, workerId);

  const maintenance = setInterval(() => void scheduleMaintenance().catch(() => undefined), 60_000);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, closing browser sessions and workers`);
    clearInterval(maintenance);
    await stopWorkers().catch(() => undefined);
    await releaseAll().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  log.info('worker ready');
}

main().catch((error) => {
  log.error('worker failed to start', error);
  process.exit(1);
});
