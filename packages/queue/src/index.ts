/**
 * Durable job queue.
 *
 * Two interchangeable drivers behind one API:
 *
 *   REDIS_URL set   -> Redis + BullMQ dispatches, PostgreSQL/SQLite keeps the
 *                      authoritative ScheduledJob ledger.
 *   REDIS_URL empty -> the same ledger is polled directly, so a developer can
 *                      run the whole platform with nothing installed.
 *
 * The ledger is the source of truth in BOTH modes. That is what makes worker
 * recovery, the Running Jobs screen and campaign resume behave identically no
 * matter how the platform is deployed.
 */
import { prisma } from '@mail/database';
import { createLogger, env } from '@mail/config';
import { backoffDelayMs, parseJson, stringifyJson } from '@mail/shared';
import type { QueueName } from '@mail/shared';

const log = createLogger('queue');

export interface EnqueueOptions {
  workspaceId: string;
  queue: QueueName;
  name: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Unique key; a second enqueue with the same key is silently ignored. */
  dedupeKey?: string;
  campaignId?: string | null;
  stepId?: string | null;
}

export interface JobRecord {
  id: string;
  workspaceId: string;
  queue: string;
  name: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  campaignId: string | null;
  stepId: string | null;
}

export type JobHandler = (job: JobRecord) => Promise<Record<string, unknown> | void>;

export class JobError extends Error {
  constructor(
    message: string,
    readonly code: string = 'UNKNOWN_ERROR',
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'JobError';
  }
}

/**
 * How long a claimed job may hold its lock before another worker assumes the
 * owner died. Must stay above the longest legitimate job - an interactive
 * mailbox sign-in waits up to five minutes for a human - so recovery can never
 * re-run work that is still in progress.
 */
const STALE_LOCK_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- producer

/**
 * Default priority per queue. Sends outrank everything: a bounce sweep or an
 * analytics roll-up sitting in front of a campaign send is only ever a delay,
 * never the other way round.
 */
const QUEUE_PRIORITY: Record<string, number> = {
  'email-send': 20,
  'email-followup': 20,
  'campaign-scheduler': 10,
  'browser-worker': 5,
  'inbox-sync': 0,
  'ai-analysis': 0,
  'ai-reply': 0,
  notification: 0,
  'bounce-check': -10,
  analytics: -10,
};

export async function enqueue(options: EnqueueOptions): Promise<string | null> {
  const runAt = options.runAt ?? new Date();

  if (options.dedupeKey) {
    const existing = await prisma.scheduledJob.findUnique({
      where: { dedupeKey: options.dedupeKey },
      select: { id: true, status: true },
    });
    if (existing) {
      log.debug(`dedupe hit for ${options.dedupeKey} (job ${existing.id})`);
      return existing.id;
    }
  }

  const job = await prisma.scheduledJob.create({
    data: {
      workspaceId: options.workspaceId,
      queue: options.queue,
      name: options.name,
      status: runAt.getTime() > Date.now() + 1000 ? 'DELAYED' : 'PENDING',
      payloadJson: stringifyJson(options.payload ?? {}),
      priority: options.priority ?? QUEUE_PRIORITY[options.queue] ?? 0,
      runAt,
      maxAttempts: options.maxAttempts ?? 3,
      dedupeKey: options.dedupeKey ?? null,
      campaignId: options.campaignId ?? null,
      stepId: options.stepId ?? null,
    },
  });

  await getDispatcher().dispatch(job.id, options.queue, runAt);
  return job.id;
}

export async function cancelJobs(where: {
  workspaceId?: string;
  campaignId?: string;
  queue?: QueueName;
  dedupeKeyPrefix?: string;
}): Promise<number> {
  const result = await prisma.scheduledJob.updateMany({
    where: {
      status: { in: ['PENDING', 'DELAYED'] },
      ...(where.workspaceId ? { workspaceId: where.workspaceId } : {}),
      ...(where.campaignId ? { campaignId: where.campaignId } : {}),
      ...(where.queue ? { queue: where.queue } : {}),
      ...(where.dedupeKeyPrefix ? { dedupeKey: { startsWith: where.dedupeKeyPrefix } } : {}),
    },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  if (result.count) log.info(`cancelled ${result.count} pending job(s)`, where);
  return result.count;
}

// ---------------------------------------------------------------- consumer

/** Atomically claims a job. Returns null if another worker won the race. */
async function claim(jobId: string, workerId: string): Promise<JobRecord | null> {
  const claimed = await prisma.scheduledJob.updateMany({
    where: { id: jobId, status: { in: ['PENDING', 'DELAYED'] } },
    data: { status: 'ACTIVE', lockedBy: workerId, lockedAt: new Date(), startedAt: new Date() },
  });
  if (claimed.count === 0) return null;

  const job = await prisma.scheduledJob.findUnique({ where: { id: jobId } });
  if (!job) return null;

  return {
    id: job.id,
    workspaceId: job.workspaceId,
    queue: job.queue,
    name: job.name,
    payload: parseJson<Record<string, unknown>>(job.payloadJson, {}),
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    campaignId: job.campaignId,
    stepId: job.stepId,
  };
}

async function complete(jobId: string, result: Record<string, unknown> | void) {
  await prisma.scheduledJob.update({
    where: { id: jobId },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      errorCode: null,
      error: null,
      resultJson: result ? stringifyJson(result) : null,
    },
  });
}

/**
 * Puts a job back on the clock without consuming an attempt.
 *
 * A handler that declines to do the work *yet* - outside the sending window,
 * daily quota spent - is not finished and must not be completed. Marking it
 * COMPLETED stranded the contact for good: `enqueue` dedupes on the step's
 * idempotency key, so once a job row exists it is never recreated, and the
 * campaign sat at "running, 0 sent" with nothing left to run it.
 */
async function defer(job: JobRecord, runAt: Date, reason: string) {
  await prisma.scheduledJob.update({
    where: { id: job.id },
    data: {
      status: runAt.getTime() > Date.now() + 1000 ? 'DELAYED' : 'PENDING',
      runAt,
      lockedBy: null,
      lockedAt: null,
      startedAt: null,
      errorCode: null,
      error: null,
    },
  });
  log.info(`job ${job.name} deferred to ${runAt.toISOString()}: ${reason}`);
  await getDispatcher().dispatch(job.id, job.queue as QueueName, runAt);
}

async function fail(job: JobRecord, error: unknown) {
  const attempts = job.attempts + 1;
  const code = error instanceof JobError ? error.code : 'UNKNOWN_ERROR';
  const retryable = error instanceof JobError ? error.retryable : true;
  const message = error instanceof Error ? error.message : String(error);
  const willRetry = retryable && attempts < job.maxAttempts;

  const runAt = willRetry ? new Date(Date.now() + backoffDelayMs(attempts - 1)) : undefined;

  await prisma.scheduledJob.update({
    where: { id: job.id },
    data: {
      status: willRetry ? 'PENDING' : 'FAILED',
      attempts,
      errorCode: code,
      error: message.slice(0, 1000),
      lockedBy: null,
      lockedAt: null,
      ...(runAt ? { runAt } : { completedAt: new Date() }),
    },
  });

  if (willRetry && runAt) {
    log.warn(`job ${job.name} failed (${code}), retry ${attempts}/${job.maxAttempts} at ${runAt.toISOString()}`);
    await getDispatcher().dispatch(job.id, job.queue as QueueName, runAt);
  } else {
    log.error(`job ${job.name} failed permanently (${code}): ${message}`);
  }
}

/**
 * Runs one job under a watchdog and keeps its lock warm while it does.
 *
 * The watchdog is what stops a handler that never returns - a browser sweep
 * over dozens of threads, say - from holding a concurrency slot for the rest
 * of the worker's life. The heartbeat is the other half: without it a job that
 * legitimately runs longer than the stale-lock window gets "recovered" and run
 * a second time, which for a send means a second email.
 */
async function runToCompletion(handler: JobHandler, job: JobRecord): Promise<void> {
  const heartbeat = setInterval(() => {
    void prisma.scheduledJob
      .updateMany({ where: { id: job.id, status: 'ACTIVE' }, data: { lockedAt: new Date() } })
      .catch(() => undefined);
  }, Math.max(30_000, Math.floor(STALE_LOCK_MS / 4)));

  let watchdog: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      handler(job),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new JobError(`job exceeded ${env.JOB_TIMEOUT_MS}ms`, 'TIMEOUT', true)),
          env.JOB_TIMEOUT_MS,
        );
      }),
    ]);

    // A handler may hand back a date instead of a result: it is not done, it
    // is waiting for a window, a quota or a mailbox. Reschedule, do not
    // complete, and do not spend one of its attempts.
    const deferUntil = (result as { deferUntil?: unknown } | undefined)?.deferUntil;
    if (deferUntil instanceof Date && !Number.isNaN(deferUntil.getTime())) {
      const reason = String((result as { reason?: unknown }).reason ?? 'not ready');
      await defer(job, deferUntil, reason);
      return;
    }

    await complete(job.id, result ?? undefined);
  } catch (error) {
    await fail(job, error);
  } finally {
    clearInterval(heartbeat);
    if (watchdog) clearTimeout(watchdog);
  }
}

/** Releases jobs whose worker died mid-flight so another worker can retry. */
export async function recoverStaleJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_LOCK_MS);
  const result = await prisma.scheduledJob.updateMany({
    where: { status: 'ACTIVE', lockedAt: { lt: cutoff } },
    data: { status: 'PENDING', lockedBy: null, lockedAt: null },
  });
  if (result.count) log.warn(`recovered ${result.count} stale job(s) from a crashed worker`);
  return result.count;
}

// ---------------------------------------------------------------- drivers

interface Dispatcher {
  dispatch(jobId: string, queue: QueueName, runAt: Date): Promise<void>;
  start(handlers: Partial<Record<QueueName, JobHandler>>, workerId: string): Promise<void>;
  stop(): Promise<void>;
}

class DatabaseDispatcher implements Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = false;
  /** Jobs this worker is running right now, keyed by job id. */
  private inFlight = new Set<string>();

  async dispatch(): Promise<void> {
    /* nothing to do: the polling loop discovers rows by runAt */
  }

  async start(handlers: Partial<Record<QueueName, JobHandler>>, workerId: string) {
    const queues = Object.keys(handlers) as QueueName[];
    log.info(`database queue driver polling every ${env.QUEUE_POLL_INTERVAL_MS}ms`, { queues });

    /**
     * Fills free concurrency slots and returns. It deliberately does NOT wait
     * for the jobs it starts: awaiting them meant one slow handler - a bounce
     * sweep walking two dozen Gmail threads - blocked the next poll entirely,
     * so a campaign queued behind it never started and no mail went out. The
     * poll now only ever hands out whatever capacity is genuinely free.
     */
    const tick = async () => {
      if (this.polling || this.stopped) return;
      this.polling = true;
      try {
        await recoverStaleJobs();

        const free = env.QUEUE_CONCURRENCY - this.inFlight.size;
        if (free <= 0) return;

        const due = await prisma.scheduledJob.findMany({
          where: {
            status: { in: ['PENDING', 'DELAYED'] },
            queue: { in: queues },
            runAt: { lte: new Date() },
            // Never re-claim something this worker is already running.
            id: { notIn: [...this.inFlight] },
          },
          orderBy: [{ priority: 'desc' }, { runAt: 'asc' }],
          take: free,
          select: { id: true, queue: true },
        });

        for (const row of due) {
          const handler = handlers[row.queue as QueueName];
          if (!handler) continue;
          const job = await claim(row.id, workerId);
          if (!job) continue;

          this.inFlight.add(job.id);
          void runToCompletion(handler, job).finally(() => this.inFlight.delete(job.id));
        }
      } catch (error) {
        log.error('queue tick failed', error);
      } finally {
        this.polling = false;
      }
    };

    this.timer = setInterval(() => void tick(), env.QUEUE_POLL_INTERVAL_MS);
    void tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}

class BullMqDispatcher implements Dispatcher {
  private queues = new Map<string, any>();
  private workers: any[] = [];
  private connection: any = null;

  private async lib() {
    // Imported lazily so a Redis-less install never has to load ioredis.
    const bullmq = await import('bullmq');
    if (!this.connection) {
      const { default: IORedis } = await import('ioredis');
      this.connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    }
    return bullmq;
  }

  private async queueFor(name: string) {
    const bullmq = await this.lib();
    let q = this.queues.get(name);
    if (!q) {
      q = new bullmq.Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async dispatch(jobId: string, queue: QueueName, runAt: Date) {
    const q = await this.queueFor(queue);
    const delay = Math.max(0, runAt.getTime() - Date.now());
    await q.add(queue, { jobId }, { delay, removeOnComplete: 500, removeOnFail: 1000, jobId });
  }

  async start(handlers: Partial<Record<QueueName, JobHandler>>, workerId: string) {
    const bullmq = await this.lib();
    log.info('redis + bullmq queue driver active', { queues: Object.keys(handlers) });

    for (const [queue, handler] of Object.entries(handlers) as Array<[QueueName, JobHandler]>) {
      const worker = new bullmq.Worker(
        queue,
        async (bullJob: any) => {
          const jobId = bullJob.data?.jobId as string | undefined;
          if (!jobId) return;
          const job = await claim(jobId, workerId);
          if (!job) return;
          try {
            const result = await handler(job);
            await complete(job.id, result ?? undefined);
          } catch (error) {
            await fail(job, error);
          }
        },
        { connection: this.connection, concurrency: env.QUEUE_CONCURRENCY },
      );
      worker.on('error', (e: Error) => log.error(`bullmq worker error on ${queue}`, e.message));
      this.workers.push(worker);
    }

    // Requeue anything the ledger says is still owed (e.g. produced while the
    // worker was down, or written directly by a migration).
    const orphans = await prisma.scheduledJob.findMany({
      where: { status: { in: ['PENDING', 'DELAYED'] }, queue: { in: Object.keys(handlers) } },
      select: { id: true, queue: true, runAt: true },
      take: 1000,
    });
    for (const o of orphans) await this.dispatch(o.id, o.queue as QueueName, o.runAt);
    if (orphans.length) log.info(`re-dispatched ${orphans.length} pending job(s) from the ledger`);
  }

  async stop() {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    if (this.connection) await this.connection.quit();
  }
}

let dispatcher: Dispatcher | null = null;

export function getDispatcher(): Dispatcher {
  if (!dispatcher) dispatcher = env.useRedis ? new BullMqDispatcher() : new DatabaseDispatcher();
  return dispatcher;
}

export async function startWorkers(handlers: Partial<Record<QueueName, JobHandler>>, workerId: string) {
  await getDispatcher().start(handlers, workerId);
}

export async function stopWorkers() {
  if (dispatcher) await dispatcher.stop();
}

export const driverName = () => (env.useRedis ? 'redis+bullmq' : 'database');
