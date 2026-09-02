/** Inbox synchronisation, browser session control and bounce sweeps. */
import { createLogger } from '@mail/config';
import { prisma } from '@mail/database';
import { JobError, type JobRecord } from '@mail/queue';
import {
  InboxSyncService,
  logActivity,
  notify,
  releaseMailbox,
  scanBounces,
  withMailbox,
} from '@mail/core';
import { AutomationError } from '@mail/playwright';
import { truncate } from '@mail/shared';

const log = createLogger('inbox-worker');

export async function processInboxSync(job: JobRecord) {
  const emailAccountId = job.payload.emailAccountId as string;
  const limit = Number(job.payload.limit ?? 30);

  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } });
  if (!account) throw new JobError('Mailbox no longer exists', 'AUTH_ERROR', false);
  if (account.status !== 'ACTIVE') return { skipped: true, reason: `mailbox is ${account.status}` };

  const started = Date.now();
  try {
    const summary = await withMailbox(emailAccountId, (driver) =>
      new InboxSyncService(driver, account.workspaceId, emailAccountId).syncInbox(limit),
    );

    if (summary.newMessages) {
      await logActivity({
        workspaceId: account.workspaceId,
        emailAccountId,
        jobId: job.id,
        action: 'inbox.synced',
        status: 'SUCCESS',
        message: `${summary.newMessages} new message(s) across ${summary.threads} thread(s)`,
        durationMs: Date.now() - started,
        meta: summary as unknown as Record<string, unknown>,
      });
    }
    return summary as unknown as Record<string, unknown>;
  } catch (error) {
    const code = error instanceof AutomationError ? error.code : 'UNKNOWN_ERROR';
    const message = error instanceof Error ? error.message : String(error);

    if (code === 'SESSION_EXPIRED' || code === 'AUTH_ERROR') {
      await notify({
        workspaceId: account.workspaceId,
        type: 'AUTH_EXPIRED',
        severity: 'ERROR',
        title: `Reconnect ${account.email}`,
        body: 'The mailbox session expired. Reconnect it from Email Accounts to resume automation.',
        linkUrl: `/email-accounts/${account.id}`,
      });
    }

    await logActivity({
      workspaceId: account.workspaceId,
      emailAccountId,
      jobId: job.id,
      action: 'inbox.sync_failed',
      status: 'FAILURE',
      message: truncate(message, 300),
      errorCode: code,
      durationMs: Date.now() - started,
    });

    throw new JobError(message, code, code !== 'SESSION_EXPIRED');
  }
}

/** Connect / test / reconnect / disconnect / thread actions from the UI. */
export async function processBrowserAction(job: JobRecord) {
  const emailAccountId = job.payload.emailAccountId as string;
  const action = String(job.payload.action ?? 'connect');

  const account = await prisma.emailAccount.findUnique({ where: { id: emailAccountId } });
  if (!account) throw new JobError('Mailbox no longer exists', 'AUTH_ERROR', false);

  if (action === 'disconnect') {
    await releaseMailbox(emailAccountId);
    await logActivity({
      workspaceId: account.workspaceId,
      emailAccountId,
      action: 'mailbox.disconnected',
      message: `${account.email} disconnected`,
      status: 'INFO',
    });
    return { disconnected: true };
  }

  if (action === 'restart') await releaseMailbox(emailAccountId);

  return withMailbox(emailAccountId, async (driver) => {
  // Read-only mailbox search. Returns the result rows without opening
  // anything, which is what the label and bounce paths both rely on.
  if (action === 'search') {
    const rows = await driver.fetchThreadSummaries({
      query: String(job.payload.query ?? 'in:inbox'),
      limit: Number(job.payload.limit ?? 10),
    });
    return { rows };
  }

  // Diagnostic for Gmail UI drift: reports the markup around the labels menu
  // instead of making us guess a selector per deploy.
  if (action === 'open-diag') {
    const service = driver as unknown as {
      describeOpenAttempt?: (query: string) => Promise<Array<{ step: string; html: string }>>;
    };
    if (!service.describeOpenAttempt) return { unsupported: 'driver has no open probe' };
    return { steps: await service.describeOpenAttempt(String(job.payload.query ?? 'in:sent')) };
  }

  if (action === 'label-probe') {
    const service = driver as unknown as {
      describeLabelMenu?: (query: string, label?: string) => Promise<Array<{ step: string; html: string }>>;
    };
    if (!service.describeLabelMenu) return { unsupported: 'driver has no label probe' };
    return {
      steps: await service.describeLabelMenu(
        String(job.payload.query ?? 'in:sent newer_than:2d'),
        job.payload.label ? String(job.payload.label) : undefined,
      ),
    };
  }

  // Diagnostic: can this thread actually be opened? Everything an in-thread
  // follow-up does depends on it, so it is worth being able to ask directly.
  if (action === 'open-probe') {
    const gmailThreadId = String(job.payload.gmailThreadId ?? '');
    const query = String(job.payload.query ?? '');
    const opened = query
      ? await driver.openConversationBySearch(query)
      : await driver.openConversation(gmailThreadId);
    const latest = opened ? await driver.getLatestMessage(gmailThreadId).catch(() => null) : null;
    return {
      gmailThreadId,
      opened,
      latestSender: latest?.sender ?? null,
      latestSubject: latest?.subject ?? null,
      latestSnippet: latest?.snippet?.slice(0, 200) ?? null,
    };
  }

  if (action === 'thread-action') {
    const gmailThreadId = String(job.payload.gmailThreadId ?? '');
    const threadAction = String(job.payload.threadAction ?? '');
    let applied: number | null = null;
    let failure: string | null = null;
    try {
      switch (threadAction) {
        case 'LABEL':
          applied = await driver.applyLabel(String(job.payload.query ?? ''), String(job.payload.label ?? ''));
          break;
        case 'MARK_READ':
          await driver.markAsRead(gmailThreadId);
          break;
        case 'MARK_UNREAD':
          await driver.markAsUnread(gmailThreadId);
          break;
        case 'STAR':
          await driver.starThread(gmailThreadId, true);
          break;
        case 'UNSTAR':
          await driver.starThread(gmailThreadId, false);
          break;
        case 'ARCHIVE':
          await driver.archiveThread(gmailThreadId);
          break;
        default:
          break;
      }
    } catch (error) {
      // Mirroring a UI action into the mailbox is best-effort: the platform
      // state is already correct, so a Gmail hiccup must not fail the job.
      failure = error instanceof Error ? error.message : String(error);
      log.warn(`thread action ${threadAction} failed`, failure);
      applied = 0;
    }
    // The reason travels with the result. A silent `applied: false` is
    // unactionable, and the mailbox UI shifts often enough that knowing which
    // step gave way is the difference between a one-line selector fix and a
    // guessing game.
    return {
      threadAction,
      gmailThreadId,
      ...(applied === null ? {} : { labelled: applied }),
      ...(failure ? { failure: truncate(failure, 400) } : {}),
    };
  }

  const status = await driver.checkSession();
  await logActivity({
    workspaceId: account.workspaceId,
    emailAccountId,
    jobId: job.id,
    action: `mailbox.${action}`,
    status: status.connected ? 'SUCCESS' : 'FAILURE',
    message: status.connected
      ? `${account.email} connected (${status.detail ?? 'session valid'})`
      : `${account.email} could not be connected: ${status.detail ?? 'unknown reason'}`,
  });

  if (action === 'test' || action === 'connect' || action === 'reconnect' || action === 'restart') {
    await driver.openInbox().catch(() => undefined);
  }

  return { connected: status.connected, detail: status.detail ?? null };
  });
}

/**
 * Longest a single bounce scan may hold the mailbox.
 *
 * Every report it opens is a Gmail conversation in the shared browser, and a
 * campaign send waits its turn behind them. Unbounded, housekeeping once held
 * the mailbox for the better part of an hour; the scan now stops at the
 * deadline and picks up the rest next pass.
 */
const BOUNCE_SCAN_BUDGET_MS = 90_000;

/**
 * Bounce scan.
 *
 * Searches the mailbox for delivery reports - "Address not found", Delivery
 * Status Notification, anything from Mail Delivery Subsystem or postmaster -
 * and acts on each one: record the bounce, suppress the address, take the
 * contact off every list, cancel their queued follow-ups.
 *
 * It searches rather than re-reading the threads we sent, because Gmail files a
 * delivery report as its own conversation. Re-reading our own sent threads,
 * which is what this job used to do, could never find one.
 */
export async function processBounceCheck(job: JobRecord) {
  const workspaceId = job.workspaceId;
  const deadline = Date.now() + BOUNCE_SCAN_BUDGET_MS;
  // A manual scan can ask to look further back than the routine sweep, which
  // only needs to cover the gap since the last one.
  const days = Number(job.payload.days ?? 7);
  const limit = Number(job.payload.limit ?? 40);

  const mailboxes = await prisma.emailAccount.findMany({
    where: { workspaceId, status: 'ACTIVE' },
    select: { id: true, email: true },
  });
  if (!mailboxes.length) return { skipped: true, reason: 'no active mailbox' };

  let reportsFound = 0;
  let detected = 0;
  let removed = 0;
  const unmatched: string[] = [];

  for (const mailbox of mailboxes) {
    if (Date.now() > deadline) {
      log.info('bounce scan stopping early: the mailbox is needed for sending');
      break;
    }
    try {
      const result = await withMailbox(mailbox.id, (driver) =>
        scanBounces(driver, workspaceId, { days, limit, deadline }),
      );
      reportsFound += result.reportsFound;
      detected += result.bouncesRecorded;
      removed += result.contactsRemoved;
      unmatched.push(...result.unmatched);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`bounce scan failed for ${mailbox.email}: ${message}`);
      await logActivity({
        workspaceId,
        action: 'bounce.scan_failed',
        status: 'FAILURE',
        emailAccountId: mailbox.id,
        jobId: job.id,
        message: `Bounce scan failed for ${mailbox.email}: ${truncate(message, 300)}`,
      });
    }
  }

  if (detected) {
    const total = await prisma.bounce.count({ where: { workspaceId } });
    const sent = await prisma.emailEvent.count({ where: { workspaceId, type: 'SENT' } });
    if (sent > 20 && total / sent > 0.05) {
      await notify({
        workspaceId,
        type: 'HIGH_BOUNCE_RATE',
        severity: 'WARNING',
        title: 'Bounce rate above 5%',
        body: `${total} bounce(s) across ${sent} sends. Review list quality before continuing.`,
        linkUrl: '/bounces',
      });
    }
  }

  return { reportsFound, detected, removedFromLists: removed, unmatched: unmatched.slice(0, 20) };
}
