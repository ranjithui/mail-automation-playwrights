/**
 * Campaign lifecycle and dispatch.
 *
 * `dispatchDueSteps()` is the single place that turns campaign state into
 * queued work. It is safe to call repeatedly and concurrently: everything it
 * creates is keyed on the CampaignContactStep idempotency ledger, so a restart
 * never produces a duplicate send.
 */
import { prisma } from '@mail/database';
import { createLogger } from '@mail/config';
import { cancelJobs, enqueue } from '@mail/queue';
import { isWithinSendWindow, nextSendWindowSlot, percent, randomBetween } from '@mail/shared';
import type { CampaignProgress, CampaignStatus } from '@mail/shared';
import { logActivity } from './activity.js';
import { publish } from './realtime.js';
import { cancelPendingFollowUps, ensureStepProgress, nextStepFor, sendWindowOf } from './sequence.js';
import { removeFromAllLists } from './suppression.js';
import { isBounceScanFresh, lastBounceScanAt } from './bounce-scan.js';

const log = createLogger('campaign');

const TERMINAL_CONTACT_STATUSES = ['REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'COMPLETED', 'FAILED'];

export async function computeProgress(campaignId: string): Promise<CampaignProgress> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error(`campaign ${campaignId} not found`);

  const [total, grouped, stepStats, replies] = await Promise.all([
    prisma.campaignContact.count({ where: { campaignId } }),
    prisma.campaignContact.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } }),
    prisma.campaignContactStep.groupBy({
      by: ['status'],
      where: { campaignContact: { campaignId } },
      _count: { _all: true },
    }),
    prisma.campaignContact.count({ where: { campaignId, repliedAt: { not: null } } }),
  ]);

  const stepCount = (status: string) =>
    stepStats.find((s) => s.status === status)?._count._all ?? 0;

  const sent = stepCount('SENT');
  const drafted = stepCount('DRAFTED');
  const failed = stepCount('FAILED');
  const skipped = stepCount('SKIPPED');

  const done = grouped
    .filter((g) => TERMINAL_CONTACT_STATUSES.includes(g.status))
    .reduce((sum, g) => sum + g._count._all, 0);

  return {
    campaignId,
    status: campaign.status as CampaignStatus,
    total,
    processed: done,
    sent,
    drafted,
    failed,
    skipped,
    replies,
    percent: percent(done, total),
    updatedAt: new Date().toISOString(),
  };
}

export async function broadcastProgress(campaignId: string, extra?: Partial<CampaignProgress>) {
  const progress = await computeProgress(campaignId);
  const merged = { ...progress, ...extra };
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { workspaceId: true },
  });
  if (campaign) await publish(campaign.workspaceId, 'campaign.progress', merged);
  return merged;
}

/**
 * Why a RUNNING campaign is not currently sending.
 *
 * A campaign can be correctly RUNNING and still queue nothing - most often
 * because it is outside its sending window. Without surfacing that, the UI
 * shows "running, 0%" and looks broken when it is behaving exactly as
 * configured.
 */
export interface CampaignHold {
  reason: string;
  detail: string;
  nextAttemptAt: string | null;
}

export async function getHoldReason(campaignId: string): Promise<CampaignHold | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { emailAccount: true, _count: { select: { campaignContacts: true } } },
  });
  if (!campaign || campaign.status !== 'RUNNING') return null;

  if (!campaign.emailAccount) {
    return { reason: 'NO_MAILBOX', detail: 'No mailbox is attached to this campaign.', nextAttemptAt: null };
  }
  if (campaign.emailAccount.status !== 'ACTIVE') {
    return {
      reason: 'MAILBOX_UNAVAILABLE',
      detail: `The mailbox ${campaign.emailAccount.email} is ${campaign.emailAccount.status.toLowerCase()}.`,
      nextAttemptAt: null,
    };
  }

  const enabledSteps = await prisma.campaignStep.count({ where: { campaignId, enabled: true } });
  if (!enabledSteps) {
    return { reason: 'NO_STEPS', detail: 'The sequence has no enabled steps.', nextAttemptAt: null };
  }
  if (!campaign._count.campaignContacts) {
    return { reason: 'NO_CONTACTS', detail: 'No contacts are attached to this campaign.', nextAttemptAt: null };
  }

  const now = new Date();
  const window = sendWindowOf(campaign);
  if (!campaign.sendImmediately && !isWithinSendWindow(now, window)) {
    const next = nextSendWindowSlot(now, window);
    return {
      reason: 'OUTSIDE_SENDING_WINDOW',
      detail: `Outside the sending window (${campaign.sendWindowStart}-${campaign.sendWindowEnd} ${campaign.timezone}). Sending resumes automatically.`,
      nextAttemptAt: next.toISOString(),
    };
  }

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const queuedToday = await prisma.scheduledJob.count({
    where: { campaignId, queue: { in: ['email-send', 'email-followup'] }, createdAt: { gte: startOfDay } },
  });
  if (queuedToday >= campaign.dailyLimit) {
    const tomorrow = new Date(startOfDay.getTime() + 86_400_000);
    return {
      reason: 'DAILY_LIMIT_REACHED',
      detail: `The daily limit of ${campaign.dailyLimit} has been reached.`,
      nextAttemptAt: nextSendWindowSlot(tomorrow, window).toISOString(),
    };
  }

  const remaining = await prisma.campaignContact.count({
    where: { campaignId, status: { notIn: TERMINAL_CONTACT_STATUSES } },
  });
  if (!remaining) {
    return { reason: 'ALL_CONTACTS_DONE', detail: 'Every contact has finished the sequence.', nextAttemptAt: null };
  }

  return null;
}

// ------------------------------------------------------------ state changes

async function setStatus(campaignId: string, status: CampaignStatus, userId?: string | null) {
  const campaign = await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      status,
      ...(status === 'RUNNING' ? { lastRunAt: new Date() } : {}),
      ...(status === 'COMPLETED' ? { completedAt: new Date() } : {}),
    },
  });
  await logActivity({
    workspaceId: campaign.workspaceId,
    campaignId,
    userId: userId ?? null,
    action: `campaign.${status.toLowerCase()}`,
    message: `Campaign "${campaign.name}" is now ${status}`,
    status: 'INFO',
  });
  await publish(campaign.workspaceId, 'campaign.status', { campaignId, status });
  return campaign;
}

export async function startCampaign(campaignId: string, userId?: string | null) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: { where: { enabled: true } }, _count: { select: { campaignContacts: true } } },
  });
  if (!campaign) throw new Error('Campaign not found');
  if (!campaign.emailAccountId) throw new Error('Attach a mailbox before starting the campaign');
  if (!campaign.steps.length) throw new Error('Add at least one enabled sequence step');
  if (!campaign._count.campaignContacts) throw new Error('Add contacts before starting the campaign');

  await prisma.campaignContact.updateMany({
    where: { campaignId, status: 'PAUSED' },
    data: { status: 'QUEUED' },
  });

  await rearmForNewSteps(campaign);

  await setStatus(campaignId, 'RUNNING', userId);

  await enqueue({
    workspaceId: campaign.workspaceId,
    queue: 'campaign-scheduler',
    name: `schedule:${campaign.name}`,
    payload: { campaignId },
    campaignId,
    maxAttempts: 5,
  });

  return broadcastProgress(campaignId);
}

/**
 * Re-arms contacts that finished only because the sequence ended there.
 *
 * A contact is marked COMPLETED when its send advances to a step that does not
 * exist. Adding a follow-up afterwards used to change nothing: COMPLETED is
 * terminal, so the new step was never dispatched and starting the campaign
 * again just marked it complete a second time - no sends, no explanation.
 *
 * Only that one case is revived. REPLIED, BOUNCED, UNSUBSCRIBED and FAILED are
 * terminal for reasons that a new step does not undo, and are left alone.
 *
 * The revived contact is scheduled the way the send itself would have
 * scheduled it: the new step's delay measured from its last send, clamped into
 * the sending window unless the campaign ignores it. A follow-up added days
 * later therefore does not fire in a burst - except where it is genuinely
 * overdue, which is exactly when it should go.
 */
async function rearmForNewSteps(campaign: {
  id: string;
  sendImmediately: boolean;
  sendWindowStart: string;
  sendWindowEnd: string;
  sendDaysJson: string;
  timezone: string;
}): Promise<number> {
  const finished = await prisma.campaignContact.findMany({
    where: {
      campaignId: campaign.id,
      status: 'COMPLETED',
      repliedAt: null,
      bouncedAt: null,
      unsubscribedAt: null,
    },
    select: { id: true, currentStep: true, lastSentAt: true },
  });
  if (!finished.length) return 0;

  const now = new Date();
  const window = sendWindowOf(campaign);
  let revived = 0;

  for (const cc of finished) {
    const step = await nextStepFor(campaign.id, cc.currentStep);
    if (!step) continue;

    const from = cc.lastSentAt ?? now;
    const target = new Date(from.getTime() + step.delayDays * 86_400_000 + step.delayHours * 3_600_000);
    const scheduled = campaign.sendImmediately ? target : nextSendWindowSlot(target, window);

    await prisma.campaignContact.update({
      where: { id: cc.id },
      data: { status: 'FOLLOWUP_PENDING', nextStepAt: scheduled },
    });
    revived += 1;
  }

  if (revived) {
    log.info(`campaign ${campaign.id}: re-armed ${revived} completed contact(s) for a newly added step`);
  }
  return revived;
}

export async function pauseCampaign(campaignId: string, userId?: string | null) {
  await setStatus(campaignId, 'PAUSED', userId);
  await cancelJobs({ campaignId, queue: 'email-send' });
  await cancelJobs({ campaignId, queue: 'email-followup' });
  await prisma.campaignContactStep.updateMany({
    where: { campaignContact: { campaignId }, status: 'QUEUED' },
    data: { status: 'PENDING' },
  });
  return broadcastProgress(campaignId);
}

export async function resumeCampaign(campaignId: string, userId?: string | null) {
  await setStatus(campaignId, 'RUNNING', userId);
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await enqueue({
    workspaceId: campaign.workspaceId,
    queue: 'campaign-scheduler',
    name: `resume:${campaign.name}`,
    payload: { campaignId },
    campaignId,
  });
  return broadcastProgress(campaignId);
}

export async function stopCampaign(campaignId: string, userId?: string | null) {
  await setStatus(campaignId, 'CANCELLED', userId);
  await cancelJobs({ campaignId });
  await prisma.campaignContactStep.updateMany({
    where: { campaignContact: { campaignId }, status: { in: ['PENDING', 'QUEUED'] } },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  await prisma.campaignContact.updateMany({ where: { campaignId }, data: { nextStepAt: null } });
  return broadcastProgress(campaignId);
}

// ------------------------------------------------------------- dispatching

export interface DispatchResult {
  queued: number;
  skipped: number;
  reason?: string;
}

/**
 * Queues every step that is due right now for one campaign, respecting the
 * sending window, the daily limit and the configured inter-send delay.
 */
export async function dispatchDueSteps(campaignId: string, force = false): Promise<DispatchResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { emailAccount: true },
  });
  if (!campaign) return { queued: 0, skipped: 0, reason: 'campaign missing' };
  if (campaign.status !== 'RUNNING') return { queued: 0, skipped: 0, reason: `campaign is ${campaign.status}` };
  if (!campaign.emailAccountId) return { queued: 0, skipped: 0, reason: 'no mailbox attached' };

  const now = new Date();
  const window = sendWindowOf(campaign);
  // `force` is the one-off Run now action; `sendImmediately` is the campaign
  // setting. Either bypasses the window - the daily limit and suppression
  // checks below still apply, because those exist to protect the mailbox.
  if (!force && !campaign.sendImmediately && !isWithinSendWindow(now, window)) {
    return { queued: 0, skipped: 0, reason: 'outside sending window' };
  }

  // Daily cap is measured against work actually queued today for this campaign.
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const queuedToday = await prisma.scheduledJob.count({
    where: { campaignId, queue: { in: ['email-send', 'email-followup'] }, createdAt: { gte: startOfDay } },
  });
  let budget = campaign.dailyLimit - queuedToday;
  if (budget <= 0) return { queued: 0, skipped: 0, reason: 'daily limit reached' };

  const dueContacts = () =>
    prisma.campaignContact.findMany({
      where: {
        campaignId,
        status: { notIn: TERMINAL_CONTACT_STATUSES },
        OR: [{ nextStepAt: null }, { nextStepAt: { lte: now } }],
      },
      include: { contact: { select: { id: true, email: true } } },
      orderBy: [{ nextStepAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(budget, 500),
    });

  let candidates = await dueContacts();

  // Nothing due can mean the campaign is finished - or that a step was added to
  // a running campaign after its contacts had already run out of sequence. The
  // second case is only checked when there is no work anyway, so a busy
  // campaign never pays for it.
  if (!candidates.length && (await rearmForNewSteps(campaign))) {
    candidates = await dueContacts();
  }

  let queued = 0;
  let skipped = 0;
  // Sends are spread out rather than fired simultaneously: each successive job
  // is offset by a (optionally randomised) delay inside the window.
  let offsetMs = 0;

  /**
   * Follow-ups wait for a fresh bounce scan; first sends do not.
   *
   * A follow-up is the one send we already have evidence about - the previous
   * step may have bounced - so dispatching one before the delivery reports have
   * been read is the difference between a warm nudge and a second message to a
   * dead address. Resolved lazily so a campaign with only an initial step never
   * pays for the check.
   *
   * A campaign set to send immediately does not wait for it. That setting says
   * the operator wants each step to go the moment it falls due, follow-ups
   * included, and skipping the wait costs nothing that matters: the scan is
   * still queued, and every send re-checks replied / bounced / unsubscribed /
   * suppressed in preflight before it touches the mailbox. Waiting here only
   * ever delayed the send - it never decided it.
   */
  let followUpsAllowed: boolean | null = null;
  const canDispatchFollowUp = async () => {
    if (followUpsAllowed !== null) return followUpsAllowed;

    const scannedAt = await lastBounceScanAt(campaign.workspaceId);
    const fresh = isBounceScanFresh(scannedAt);
    followUpsAllowed = fresh || campaign.sendImmediately;

    if (!fresh) {
      // Queue the scan this tick so the next one can proceed, rather than
      // waiting for the half-hourly housekeeping pass to come round.
      await enqueue({
        workspaceId: campaign.workspaceId,
        queue: 'bounce-check',
        name: 'bounce-scan:before-followups',
        payload: {},
        dedupeKey: `bounce-check:followups:${campaign.workspaceId}:${Math.floor(Date.now() / 300_000)}`,
        priority: 15,
        maxAttempts: 2,
      });
      log.info(
        campaign.sendImmediately
          ? `bounce scan for "${campaign.name}" is stale; queued one, but follow-ups go now (send immediately)`
          : `holding follow-ups for "${campaign.name}": last bounce scan ${
              scannedAt ? scannedAt.toISOString() : 'never'
            }. Scan queued; follow-ups resume once it finishes.`,
      );
    }
    return followUpsAllowed;
  };

  for (const cc of candidates) {
    if (budget <= 0) break;

    const step = await nextStepFor(campaignId, cc.currentStep);
    if (!step) {
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { status: 'COMPLETED', nextStepAt: null },
      });
      skipped += 1;
      continue;
    }

    if (step.stepOrder > 1 && !(await canDispatchFollowUp())) {
      skipped += 1;
      continue;
    }

    const existing = await prisma.campaignContactStep.findUnique({
      where: { campaignContactId_stepId: { campaignContactId: cc.id, stepId: step.id } },
    });
    if (existing && existing.status !== 'PENDING') {
      skipped += 1;
      continue;
    }

    const runAt = new Date(now.getTime() + offsetMs);
    const progress = await ensureStepProgress({
      campaignId,
      contactId: cc.contactId,
      campaignContactId: cc.id,
      stepId: step.id,
      scheduledFor: runAt,
    });
    if (!progress) {
      skipped += 1;
      continue;
    }

    const jobId = await enqueue({
      workspaceId: campaign.workspaceId,
      queue: step.stepOrder === 1 ? 'email-send' : 'email-followup',
      name: `${campaign.name} / ${step.name} / ${cc.contact.email}`,
      payload: {
        campaignId,
        campaignContactId: cc.id,
        contactId: cc.contactId,
        stepId: step.id,
        stepOrder: step.stepOrder,
        emailAccountId: campaign.emailAccountId,
        mode: campaign.mode,
      },
      runAt,
      dedupeKey: progress.idempotencyKey,
      campaignId,
      stepId: step.id,
      maxAttempts: 3,
    });

    if (jobId) {
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: { status: cc.currentStep === 0 ? 'QUEUED' : 'FOLLOWUP_PENDING', nextStepAt: runAt },
      });
      queued += 1;
      budget -= 1;
      const gap = campaign.randomDelay
        ? randomBetween(campaign.minDelaySec, campaign.maxDelaySec)
        : campaign.minDelaySec;
      offsetMs += gap * 1000;
    }
  }

  if (queued) log.info(`campaign ${campaign.name}: queued ${queued} step(s), skipped ${skipped}`);

  // Nothing left to do anywhere in the campaign -> mark it complete.
  const remaining = await prisma.campaignContact.count({
    where: { campaignId, status: { notIn: TERMINAL_CONTACT_STATUSES } },
  });
  const inFlight = await prisma.scheduledJob.count({
    where: { campaignId, status: { in: ['PENDING', 'DELAYED', 'ACTIVE'] }, queue: { in: ['email-send', 'email-followup'] } },
  });
  if (remaining === 0 && inFlight === 0) {
    await setStatus(campaignId, 'COMPLETED');
  }

  await broadcastProgress(campaignId);
  return { queued, skipped };
}

/** Called when an inbound reply is attributed to a campaign contact. */
export async function handleReply(campaignContactId: string) {
  const cc = await prisma.campaignContact.findUnique({
    where: { id: campaignContactId },
    include: { campaign: true, contact: true },
  });
  if (!cc || cc.repliedAt) return;

  await prisma.campaignContact.update({
    where: { id: campaignContactId },
    data: { status: 'REPLIED', repliedAt: new Date(), nextStepAt: null },
  });
  await prisma.contact.update({
    where: { id: cc.contactId },
    data: { status: 'REPLIED', lastRepliedAt: new Date() },
  });

  let removedFromLists = 0;
  if (cc.campaign.stopOnReply) {
    await cancelPendingFollowUps(campaignContactId, 'REPLIED');

    // Someone who answered is in a conversation, not a cold sequence. Taking
    // them out of every list is what stops the next campaign built from those
    // lists mailing them again - cancelling this campaign's follow-ups only
    // covers this campaign. The contact, the reply and the history all stay;
    // it is list *membership* that decides who gets pulled into the next one.
    removedFromLists = await removeFromAllLists(cc.contactId);
  }

  await logActivity({
    workspaceId: cc.campaign.workspaceId,
    campaignId: cc.campaignId,
    contactId: cc.contactId,
    action: 'sequence.reply_received',
    message: cc.campaign.stopOnReply
      ? `${cc.contact.email} replied - follow-ups cancelled, removed from ${removedFromLists} list(s)`
      : `${cc.contact.email} replied - the campaign is set to keep sending`,
    status: 'INFO',
  });

  await broadcastProgress(cc.campaignId);
}
