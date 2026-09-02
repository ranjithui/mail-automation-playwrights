/**
 * Browser session manager.
 *
 * One isolated driver per mailbox, pooled for the lifetime of the worker
 * process, with its state mirrored into EmailSession so the Browser Sessions
 * screen can show what is happening. Cookies, storage state and profiles stay
 * inside the worker: nothing here is ever serialised towards the frontend.
 */
import { createLogger, env } from '@mail/config';
import { prisma } from '@mail/database';
import { GmailAutomationService, SimulationGmailService } from '@mail/playwright';
import type { MailboxDriver, MailboxIdentity } from '@mail/playwright';
import { publish } from './realtime.js';

const log = createLogger('mailbox');

interface PooledDriver {
  driver: MailboxDriver;
  connectedAt: number;
}

const pool = new Map<string, PooledDriver>();

export const workerId = `worker-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;

async function upsertSession(accountId: string, data: Record<string, unknown>) {
  const existing = await prisma.emailSession.findFirst({ where: { emailAccountId: accountId } });
  if (existing) {
    return prisma.emailSession.update({ where: { id: existing.id }, data });
  }
  return prisma.emailSession.create({ data: { emailAccountId: accountId, ...data } });
}

export function driverKind(): 'simulation' | 'playwright' {
  return env.GMAIL_DRIVER;
}

/** Returns a connected driver for the mailbox, creating one if necessary. */
export async function acquireMailbox(accountId: string): Promise<MailboxDriver> {
  const pooled = pool.get(accountId);
  if (pooled) {
    const status = await pooled.driver.checkSession();
    if (status.connected) return pooled.driver;
    await pooled.driver.close().catch(() => undefined);
    pool.delete(accountId);
  }

  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new Error(`email account ${accountId} not found`);

  const identity: MailboxIdentity = {
    accountId: account.id,
    email: account.email,
    displayName: account.displayName,
  };

  await upsertSession(accountId, { browserStatus: 'STARTING', workerId, lastActivityAt: new Date() });
  await prisma.emailAccount.update({ where: { id: accountId }, data: { connection: 'CONNECTING' } });
  await publish(account.workspaceId, 'worker.status', { accountId, browserStatus: 'STARTING' });

  const events = {
    onAction: (action: string, detail?: string) => {
      void upsertSession(accountId, { lastActivityAt: new Date() }).catch(() => undefined);
      void publish(account.workspaceId, 'worker.status', { accountId, action, detail });
    },
    onError: (code: string, message: string, screenshotPath?: string) => {
      log.warn(`${account.email} ${code}: ${message}`, screenshotPath);
    },
  };

  const driver: MailboxDriver =
    env.GMAIL_DRIVER === 'playwright'
      ? new GmailAutomationService(identity, events)
      : new SimulationGmailService(identity, events);

  try {
    const info = await driver.connect();
    if (!info.connected) throw new Error(info.detail ?? 'connection refused');

    pool.set(accountId, { driver, connectedAt: Date.now() });
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { connection: 'CONNECTED', lastConnectedAt: new Date(), lastError: null, lastErrorCode: null },
    });
    await upsertSession(accountId, {
      browserStatus: 'RUNNING',
      sessionStatus: 'VALID',
      workerId,
      lastActivityAt: new Date(),
      lastError: null,
    });
    await publish(account.workspaceId, 'worker.status', { accountId, browserStatus: 'RUNNING', connection: 'CONNECTED' });
    return driver;
  } catch (error) {
    // Always release the browser context. A persistent context holds an
    // exclusive lock on its profile directory, so leaving a failed one open
    // would make the next Connect attempt fail for the wrong reason.
    await driver.close().catch(() => undefined);

    const message = error instanceof Error ? error.message : String(error);
    const code = (error as { code?: string }).code ?? 'AUTH_ERROR';
    await prisma.emailAccount.update({
      where: { id: accountId },
      data: { connection: 'ERROR', lastError: message.slice(0, 500), lastErrorCode: code },
    });
    await upsertSession(accountId, {
      browserStatus: 'ERROR',
      sessionStatus: code === 'SESSION_EXPIRED' ? 'EXPIRED' : 'ERROR',
      lastError: message.slice(0, 500),
    });
    await publish(account.workspaceId, 'worker.status', { accountId, browserStatus: 'ERROR', error: message });
    throw error;
  }
}

/**
 * Per-mailbox serialisation.
 *
 * A browser context cannot be shared by concurrent callers: two jobs
 * interleaving compose actions corrupt each other, and two jobs racing to
 * launch the same persistent profile produce "profile is already in use" plus
 * a stray blank tab on every attempt. Every piece of browser work therefore
 * goes through here, which chains work per mailbox while leaving different
 * mailboxes fully parallel.
 */
const chains = new Map<string, Promise<unknown>>();

export function withMailbox<T>(
  accountId: string,
  fn: (driver: MailboxDriver) => Promise<T>,
): Promise<T> {
  const previous = chains.get(accountId) ?? Promise.resolve();

  const next = previous
    // A failed predecessor must not poison the queue for this mailbox.
    .catch(() => undefined)
    .then(async () => {
      const driver = await acquireMailbox(accountId);
      return fn(driver);
    });

  // Store a swallowed copy so an unconsumed rejection never goes unhandled,
  // and drop the entry once this mailbox goes idle.
  const tail = next.catch(() => undefined).finally(() => {
    if (chains.get(accountId) === tail) chains.delete(accountId);
  });
  chains.set(accountId, tail);

  return next;
}

export async function releaseMailbox(accountId: string) {
  const pooled = pool.get(accountId);
  if (!pooled) return;
  await pooled.driver.close().catch(() => undefined);
  pool.delete(accountId);
  await upsertSession(accountId, { browserStatus: 'STOPPED', currentJobId: null, currentCampaignId: null });
  await prisma.emailAccount.update({ where: { id: accountId }, data: { connection: 'DISCONNECTED' } });
}

export async function releaseAll() {
  await Promise.all([...pool.keys()].map((id) => releaseMailbox(id)));
}

export async function markMailboxBusy(accountId: string, jobId: string | null, campaignId: string | null) {
  await upsertSession(accountId, { currentJobId: jobId, currentCampaignId: campaignId, lastActivityAt: new Date() });
}

/**
 * Daily-limit accounting. Resets automatically when the calendar day changes so
 * a long-running worker does not need a separate cron.
 */
export async function reserveDailyQuota(accountId: string): Promise<{ allowed: boolean; sentToday: number; dailyLimit: number }> {
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account) return { allowed: false, sentToday: 0, dailyLimit: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const sentToday = account.sentTodayDate === today ? account.sentToday : 0;

  if (sentToday >= account.dailyLimit) {
    return { allowed: false, sentToday, dailyLimit: account.dailyLimit };
  }

  await prisma.emailAccount.update({
    where: { id: accountId },
    data: { sentToday: sentToday + 1, sentTodayDate: today },
  });
  return { allowed: true, sentToday: sentToday + 1, dailyLimit: account.dailyLimit };
}
