/**
 * Sequence engine.
 *
 * Replaces the fixed FOLLOWUP1/2/3 spreadsheet columns with an ordered,
 * unbounded step list. Nothing in the schema or this module caps the number of
 * follow-ups; a campaign can have as many steps as a workspace configures.
 */
import { prisma } from '@mail/database';
import { createLogger } from '@mail/config';
import { nextSendWindowSlot, parseJson, type SendWindow } from '@mail/shared';
import { isSuppressed } from './suppression.js';

const log = createLogger('sequence');

export const idempotencyKey = (campaignId: string, contactId: string, stepId: string) =>
  `${campaignId}:${contactId}:${stepId}`;

export function sendWindowOf(campaign: {
  sendWindowStart: string;
  sendWindowEnd: string;
  sendDaysJson: string;
  timezone: string;
}): SendWindow {
  return {
    start: campaign.sendWindowStart,
    end: campaign.sendWindowEnd,
    days: parseJson<number[]>(campaign.sendDaysJson, [1, 2, 3, 4, 5]),
    timezone: campaign.timezone,
  };
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  code?: string;
}

/**
 * Smart follow-up rules (spec section 25). Evaluated immediately before every
 * send, not just at scheduling time, so a reply that lands while a job sits in
 * the queue still cancels the send.
 */
export async function preflight(campaignContactId: string): Promise<PreflightResult> {
  const cc = await prisma.campaignContact.findUnique({
    where: { id: campaignContactId },
    include: {
      contact: true,
      campaign: { include: { emailAccount: true } },
    },
  });

  if (!cc) return { ok: false, reason: 'Campaign contact no longer exists', code: 'THREAD_NOT_FOUND' };

  if (cc.repliedAt) return { ok: false, reason: 'Recipient already replied', code: 'REPLIED' };
  if (cc.unsubscribedAt) return { ok: false, reason: 'Recipient unsubscribed', code: 'SUPPRESSED' };
  if (cc.bouncedAt) return { ok: false, reason: 'Previous message bounced', code: 'BOUNCE' };
  if (['REPLIED', 'UNSUBSCRIBED', 'BOUNCED', 'COMPLETED'].includes(cc.status)) {
    return { ok: false, reason: `Contact status is ${cc.status}`, code: 'SUPPRESSED' };
  }

  const suppression = await isSuppressed(cc.campaign.workspaceId, cc.contact.email);
  if (suppression.suppressed) {
    return { ok: false, reason: `Suppressed (${suppression.type})`, code: 'SUPPRESSED' };
  }

  if (cc.campaign.status !== 'RUNNING') {
    return { ok: false, reason: `Campaign is ${cc.campaign.status}`, code: 'PAUSED' };
  }

  if (!cc.campaign.emailAccount) {
    return { ok: false, reason: 'No mailbox is attached to this campaign', code: 'AUTH_ERROR' };
  }
  if (cc.campaign.emailAccount.status !== 'ACTIVE') {
    return { ok: false, reason: `Mailbox is ${cc.campaign.emailAccount.status}`, code: 'AUTH_ERROR' };
  }

  return { ok: true };
}

/** Creates (or returns) the idempotency ledger row for one contact-step pair. */
export async function ensureStepProgress(params: {
  campaignId: string;
  contactId: string;
  campaignContactId: string;
  stepId: string;
  scheduledFor: Date;
}) {
  const key = idempotencyKey(params.campaignId, params.contactId, params.stepId);
  const existing = await prisma.campaignContactStep.findUnique({
    where: { campaignContactId_stepId: { campaignContactId: params.campaignContactId, stepId: params.stepId } },
  });
  if (existing) return existing;

  try {
    return await prisma.campaignContactStep.create({
      data: {
        campaignContactId: params.campaignContactId,
        stepId: params.stepId,
        idempotencyKey: key,
        status: 'QUEUED',
        scheduledFor: params.scheduledFor,
      },
    });
  } catch {
    // Lost a race with another scheduler pass - the row now exists, use it.
    return prisma.campaignContactStep.findUnique({
      where: { campaignContactId_stepId: { campaignContactId: params.campaignContactId, stepId: params.stepId } },
    });
  }
}

/** The next enabled step after `currentStep`, or null when the sequence ends. */
export async function nextStepFor(campaignId: string, currentStep: number) {
  return prisma.campaignStep.findFirst({
    where: { campaignId, enabled: true, stepOrder: { gt: currentStep } },
    orderBy: { stepOrder: 'asc' },
  });
}

/**
 * Advances a contact after a successful send: bumps the step counter and sets
 * `nextStepAt` from the following step's delay, clamped into the send window.
 */
export async function advanceAfterSend(campaignContactId: string, stepOrder: number) {
  const cc = await prisma.campaignContact.findUnique({
    where: { id: campaignContactId },
    include: { campaign: true },
  });
  if (!cc) return;

  const next = await nextStepFor(cc.campaignId, stepOrder);
  const now = new Date();

  if (!next) {
    await prisma.campaignContact.update({
      where: { id: campaignContactId },
      data: {
        currentStep: stepOrder,
        status: 'COMPLETED',
        nextStepAt: null,
        sentCount: { increment: 1 },
        lastSentAt: now,
      },
    });
    return;
  }

  const target = new Date(now.getTime() + next.delayDays * 86_400_000 + next.delayHours * 3_600_000);
  // An immediate campaign is not clamped into a window it does not observe.
  const scheduled = cc.campaign.sendImmediately
    ? target
    : nextSendWindowSlot(target, sendWindowOf(cc.campaign));

  await prisma.campaignContact.update({
    where: { id: campaignContactId },
    data: {
      currentStep: stepOrder,
      status: 'FOLLOWUP_PENDING',
      nextStepAt: scheduled,
      sentCount: { increment: 1 },
      lastSentAt: now,
    },
  });
}

/**
 * Mandatory follow-up cancellation (spec section 44). Called whenever an
 * inbound reply, bounce or opt-out is detected for a contact.
 */
export async function cancelPendingFollowUps(
  campaignContactId: string,
  reason: 'REPLIED' | 'BOUNCED' | 'UNSUBSCRIBED' | 'STOPPED',
): Promise<number> {
  const cancelled = await prisma.campaignContactStep.updateMany({
    where: { campaignContactId, status: { in: ['PENDING', 'QUEUED'] } },
    data: { status: 'CANCELLED', error: `Cancelled: ${reason}`, completedAt: new Date() },
  });

  const steps = await prisma.campaignContactStep.findMany({
    where: { campaignContactId },
    select: { idempotencyKey: true },
  });

  if (steps.length) {
    await prisma.scheduledJob.updateMany({
      where: { dedupeKey: { in: steps.map((s) => s.idempotencyKey) }, status: { in: ['PENDING', 'DELAYED'] } },
      data: { status: 'CANCELLED', completedAt: new Date(), error: `Cancelled: ${reason}` },
    });
  }

  await prisma.campaignContact.update({
    where: { id: campaignContactId },
    data: { nextStepAt: null },
  });

  if (cancelled.count) {
    log.info(`cancelled ${cancelled.count} pending follow-up(s) for ${campaignContactId} (${reason})`);
  }
  return cancelled.count;
}
