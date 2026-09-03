/**
 * Campaign scheduler.
 *
 * Persistent replacement for the Apps Script time-based triggers. It re-queues
 * itself on a fixed cadence for as long as a campaign is RUNNING, so progress
 * survives a restart without any external cron.
 */
import { createLogger, env } from '@mail/config';
import { prisma } from '@mail/database';
import { enqueue, type JobRecord } from '@mail/queue';
import { dispatchDueSteps, logActivity, notify } from '@mail/core';
import { isWithinSendWindow, nextSendWindowSlot, parseJson } from '@mail/shared';

const log = createLogger('scheduler');

const TICK_MS = 60_000;

export async function processScheduler(job: JobRecord) {
  const campaignId = job.payload.campaignId as string | undefined;

  const campaigns = campaignId
    ? await prisma.campaign.findMany({ where: { id: campaignId } })
    : await prisma.campaign.findMany({ where: { status: 'RUNNING' } });

  const results = [];

  for (const campaign of campaigns) {
    if (campaign.status !== 'RUNNING') {
      log.debug(`campaign ${campaign.name} is ${campaign.status}; not rescheduling`);
      continue;
    }

    const run = await prisma.automationRun.create({
      data: {
        workspaceId: campaign.workspaceId,
        campaignId: campaign.id,
        trigger: campaignId ? 'MANUAL' : 'SCHEDULE',
        status: 'RUNNING',
      },
    });

    const result = await dispatchDueSteps(campaign.id);
    results.push({ campaign: campaign.name, ...result });

    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        processed: result.queued + result.skipped,
        skipped: result.skipped,
        summaryJson: JSON.stringify(result),
      },
    });

    const fresh = await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true } });
    if (fresh?.status !== 'RUNNING') {
      if (fresh?.status === 'COMPLETED') {
        await notify({
          workspaceId: campaign.workspaceId,
          type: 'CAMPAIGN_COMPLETED',
          severity: 'SUCCESS',
          title: `Campaign "${campaign.name}" completed`,
          body: 'Every contact has reached the end of the sequence.',
          linkUrl: `/campaigns/${campaign.id}`,
        });
      }
      continue;
    }

    // Reschedule. If the window has closed, wake up exactly when it reopens
    // instead of burning a tick every minute overnight.
    const window = {
      start: campaign.sendWindowStart,
      end: campaign.sendWindowEnd,
      days: parseJson<number[]>(campaign.sendDaysJson, [1, 2, 3, 4, 5]),
      timezone: campaign.timezone,
    };
    const now = new Date();
    const runAt =
      campaign.sendImmediately || isWithinSendWindow(now, window)
        ? new Date(now.getTime() + TICK_MS)
        : nextSendWindowSlot(now, window);

    await enqueue({
      workspaceId: campaign.workspaceId,
      queue: 'campaign-scheduler',
      name: `tick:${campaign.name}`,
      payload: { campaignId: campaign.id },
      runAt,
      dedupeKey: `scheduler:${campaign.id}:${Math.floor(runAt.getTime() / 1000)}`,
      campaignId: campaign.id,
      maxAttempts: 5,
    });
  }

  // Inbox sync is scheduled by the worker's maintenance loop, not here - it has
  // to keep running when no campaign is live.

  if (results.length) {
    await logActivity({
      workspaceId: job.workspaceId,
      action: 'scheduler.tick',
      status: 'INFO',
      message: results.map((r) => `${r.campaign}: +${r.queued}`).join(', '),
      jobId: job.id,
    });
  }

  return { campaigns: results.length, results };
}

/** Bootstraps one scheduler job per RUNNING campaign after a worker restart. */
export async function bootstrapSchedulers() {
  const running = await prisma.campaign.findMany({
    // This worker's workspaces only: resuming a campaign it cannot send for
    // queues work that fails on whichever machine lacks that browser profile.
    where: {
      status: 'RUNNING',
      ...(env.workerWorkspaces.length ? { workspaceId: { in: env.workerWorkspaces } } : {}),
    },
    select: { id: true, name: true, workspaceId: true },
  });

  for (const campaign of running) {
    await enqueue({
      workspaceId: campaign.workspaceId,
      queue: 'campaign-scheduler',
      name: `resume:${campaign.name}`,
      payload: { campaignId: campaign.id },
      dedupeKey: `scheduler-boot:${campaign.id}:${Date.now()}`,
      campaignId: campaign.id,
      maxAttempts: 5,
    });
  }

  if (running.length) log.info(`resumed scheduling for ${running.length} running campaign(s)`);
  return running.length;
}
