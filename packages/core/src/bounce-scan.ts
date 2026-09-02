/**
 * Bounce scan.
 *
 * Reads the delivery reports Gmail filed *about* our sends, rather than
 * re-reading the sends themselves. That distinction is the whole point of this
 * file: a bounce for `x@example.com` arrives as its own conversation from Mail
 * Delivery Subsystem, so the platform's earlier approach - reopening each
 * thread it had sent and looking for failure wording inside it - could not see
 * one, and never recorded a single bounce across hundreds of sends.
 *
 * What a confirmed bounce does, in order:
 *   1. records the Bounce row and suppresses the address (hard bounces)
 *   2. removes the contact from every contact list
 *   3. cancels any follow-up still queued for them
 *
 * Only then is it safe to send follow-ups.
 */
import { prisma } from '@mail/database';
import { createLogger } from '@mail/config';
import {
  BOUNCE_SIGNATURES,
  bounceSearchQuery,
  detectBounceFromThread,
  extractFailedRecipients,
  type MailboxDriver,
  type ThreadSummary,
} from '@mail/playwright';
import { normalizeEmail, truncate } from '@mail/shared';
import { registerBounce } from './suppression.js';
import { cancelPendingFollowUps } from './sequence.js';
import { logActivity } from './activity.js';

const log = createLogger('bounce-scan');

export interface BounceScanResult {
  reportsFound: number;
  bouncesRecorded: number;
  contactsRemoved: number;
  unmatched: string[];
}

export interface BounceScanOptions {
  /** How far back to look. Gmail's search granularity is whole days. */
  days?: number;
  /** Upper bound on reports opened in one pass. */
  limit?: number;
  /** Stop opening new reports once this much time has been spent. */
  deadline?: number;
}

/**
 * Resolves which of the addresses named in a report is the one we mailed.
 *
 * A delivery report names the daemon, the mailbox that sent the original, a
 * support link and the failed recipient. Preferring a candidate that matches a
 * contact this workspace has actually mailed is what stops the wrong person
 * being suppressed on the strength of an address that merely appeared first.
 */
async function resolveContact(workspaceId: string, candidates: string[]) {
  if (!candidates.length) return null;

  const matches = await prisma.contact.findMany({
    where: { workspaceId, email: { in: candidates.map(normalizeEmail) } },
    select: { id: true, email: true },
  });
  if (!matches.length) return null;

  // Candidates are ranked best-guess-first, so honour that order rather than
  // whatever order the database happened to return.
  for (const candidate of candidates.map(normalizeEmail)) {
    const hit = matches.find((m) => normalizeEmail(m.email) === candidate);
    if (hit) return hit;
  }
  return matches[0];
}

export async function scanBounces(
  driver: MailboxDriver,
  workspaceId: string,
  options: BounceScanOptions = {},
): Promise<BounceScanResult> {
  const limit = options.limit ?? 40;
  const query = bounceSearchQuery(options.days ?? 7);
  const mailbox = driver.identity?.email;

  // Phase 1: read the result list. No conversation is opened, so this costs one
  // search no matter how many reports there are.
  let rows: ThreadSummary[] = [];
  try {
    rows = await driver.fetchThreadSummaries({ query, limit });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`bounce search failed: ${message}`);
    // A scan that cannot read the mailbox must say so out loud. Returning a
    // silent zero here is indistinguishable from a clean mailbox, and a
    // follow-up batch would then be released on the strength of a scan that
    // never actually looked at anything.
    await logActivity({
      workspaceId,
      action: 'bounce.scan_failed',
      status: 'FAILURE',
      message: `Bounce scan could not read the mailbox: ${truncate(message, 300)}`,
      meta: { query },
    });
    return { reportsFound: 0, bouncesRecorded: 0, contactsRemoved: 0, unmatched: [] };
  }

  const result: BounceScanResult = {
    reportsFound: rows.length,
    bouncesRecorded: 0,
    contactsRemoved: 0,
    unmatched: [],
  };

  const handled = new Set<string>();
  /** Thread ids of the reports we matched, for the scan's activity record. */
  const reportThreadIds: string[] = [];

  for (const row of rows) {
    const text = `${row.sender} ${row.subject} ${row.snippet}`;
    const signature = BOUNCE_SIGNATURES.find((s) => s.pattern.test(text));
    const fromDaemon = /mailer-daemon|postmaster|delivery.?subsystem/i.test(row.sender);
    if (!signature && !fromDaemon) continue;
    reportThreadIds.push(row.gmailThreadId);

    // Phase 2: Gmail's snippet usually reads "Your message wasn't delivered to
    // <address> because ...", so most reports resolve from the row alone.
    let candidates = extractFailedRecipients([row.subject, row.snippet].join(' '), mailbox);
    let type = signature?.type ?? 'HARD';
    let reason = row.subject || row.snippet;
    let raw = row.snippet;
    let contact = await resolveContact(workspaceId, candidates);

    // Phase 3: only a report whose row did not name a contact we mailed is
    // worth opening, and only while there is time left to do it.
    if (!contact && (!options.deadline || Date.now() < options.deadline)) {
      const opened = await driver.fetchThread(row.gmailThreadId).catch(() => null);
      if (opened) {
        const verdict = detectBounceFromThread(opened);
        if (verdict?.isBounce) type = verdict.type;
        reason = verdict?.reason || reason;
        raw = opened.messages.map((m) => [m.subject, m.bodyText].join(' ')).join(' ');
        candidates = extractFailedRecipients(raw, mailbox);
        contact = await resolveContact(workspaceId, candidates);
      }
    }

    if (!contact) {
      // Surfaced rather than swallowed: either the report is about a send from
      // outside this platform, or its wording is one we cannot read yet - and
      // the second case is a gap someone should see.
      if (candidates.length) result.unmatched.push(candidates[0]);
      log.debug(`no contact matches ${candidates.join(', ') || '(no address found)'} - report ignored`);
      continue;
    }

    if (handled.has(contact.id)) continue;
    handled.add(contact.id);

    // The scan runs every half hour over an overlapping window, and each
    // mailbox sees the same reports, so the same delivery report is read many
    // times. Recording it once keeps the bounce history a record of what
    // happened rather than a record of how often we looked.
    const alreadyKnown = await prisma.bounce.findFirst({
      where: { workspaceId, email: normalizeEmail(contact.email) },
      select: { id: true },
    });
    if (alreadyKnown) {
      log.debug(`${contact.email} is already recorded as bounced - report skipped`);
      continue;
    }

    const campaignContact = await prisma.campaignContact.findFirst({
      where: { contactId: contact.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, campaignId: true },
    });

    const { removedFromLists } = await registerBounce({
      workspaceId,
      email: contact.email,
      contactId: contact.id,
      campaignId: campaignContact?.campaignId ?? null,
      type,
      reason: truncate(reason, 200),
      rawSnippet: truncate(raw, 500),
    });

    if (campaignContact) await cancelPendingFollowUps(campaignContact.id, 'BOUNCED');

    result.bouncesRecorded += 1;
    if (removedFromLists > 0) result.contactsRemoved += 1;

    log.info(
      `${type} bounce for ${contact.email}: suppressed, removed from ${removedFromLists} list(s), follow-ups cancelled`,
    );
  }

  // Logged every time, including a clean scan. "Ran, found nothing" is the
  // answer to "is bounce handling working?"; silence is not, and silence is
  // exactly what let this go unnoticed for hundreds of sends.
  await logActivity({
    workspaceId,
    action: 'bounce.scanned',
    status: result.bouncesRecorded ? 'WARNING' : 'INFO',
    message:
      `${result.reportsFound} delivery report(s) matched: ${result.bouncesRecorded} bounce(s) recorded, ` +
      `${result.contactsRemoved} contact(s) removed from their lists` +
      (result.unmatched.length ? `, ${result.unmatched.length} not matched to a contact` : ''),
    meta: { query, unmatched: result.unmatched.slice(0, 20) },
  });

  return result;
}

/**
 * How recently a scan must have finished for follow-ups to be allowed out.
 *
 * Matches the housekeeping cadence, so in steady state a follow-up never waits
 * on a scan that is not already scheduled.
 */
export const BOUNCE_SCAN_FRESHNESS_MS = 30 * 60_000;

/** When this workspace last completed a bounce scan, or null if it never has. */
export async function lastBounceScanAt(workspaceId: string): Promise<Date | null> {
  const job = await prisma.scheduledJob.findFirst({
    where: { workspaceId, queue: 'bounce-check', status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    select: { completedAt: true },
  });
  return job?.completedAt ?? null;
}

export function isBounceScanFresh(scannedAt: Date | null): boolean {
  return Boolean(scannedAt && Date.now() - scannedAt.getTime() < BOUNCE_SCAN_FRESHNESS_MS);
}
