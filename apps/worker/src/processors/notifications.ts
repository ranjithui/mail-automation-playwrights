/** Daily digest and analytics roll-up. Replaces the Apps Script digest email. */
import { prisma } from '@mail/database';
import type { JobRecord } from '@mail/queue';
import { logActivity, notify } from '@mail/core';
import { percent, toIsoDay } from '@mail/shared';

export async function processNotification(job: JobRecord) {
  const kind = String(job.payload.kind ?? 'DAILY_DIGEST');
  if (kind !== 'DAILY_DIGEST') return { skipped: true };

  const workspaceId = job.workspaceId;
  const since = new Date();
  since.setHours(0, 0, 0, 0);

  const [events, runs, failedJobs, pausedCampaigns] = await Promise.all([
    prisma.emailEvent.groupBy({
      by: ['type'],
      where: { workspaceId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.automationRun.count({ where: { workspaceId, startedAt: { gte: since } } }),
    prisma.scheduledJob.count({ where: { workspaceId, status: 'FAILED', updatedAt: { gte: since } } }),
    prisma.campaign.count({ where: { workspaceId, status: 'PAUSED' } }),
  ]);

  const count = (type: string) => events.find((e) => e.type === type)?._count._all ?? 0;
  const sent = count('SENT');
  const replies = count('REPLY_RECEIVED');

  const lines = [
    `Campaigns processed: ${runs}`,
    `Emails sent: ${sent}`,
    `Drafts created: ${count('DRAFT_CREATED')}`,
    `Replies: ${replies} (${percent(replies, sent)}%)`,
    `Bounces: ${count('BOUNCED')}`,
    `Unsubscribes: ${count('UNSUBSCRIBED')}`,
    `Failures: ${failedJobs}`,
    `Paused campaigns: ${pausedCampaigns}`,
  ];

  await notify({
    workspaceId,
    type: 'DAILY_DIGEST',
    severity: failedJobs > 0 ? 'WARNING' : 'INFO',
    title: `Daily digest - ${toIsoDay(new Date())}`,
    body: lines.join('\n'),
    linkUrl: '/analytics',
  });

  await logActivity({
    workspaceId,
    action: 'notification.digest',
    status: 'INFO',
    message: `Daily digest generated (${sent} sent, ${replies} replies)`,
    jobId: job.id,
  });

  return { sent, replies, failedJobs };
}

/**
 * Housekeeping: resets per-mailbox daily counters and trims very old logs so
 * the activity table cannot grow without bound.
 */
export async function processAnalytics(job: JobRecord) {
  const today = toIsoDay(new Date());

  const reset = await prisma.emailAccount.updateMany({
    where: { sentTodayDate: { not: today } },
    data: { sentToday: 0, sentTodayDate: today },
  });

  const cutoff = new Date(Date.now() - 90 * 86_400_000);
  const [logs, jobs] = await Promise.all([
    prisma.activityLog.deleteMany({ where: { workspaceId: job.workspaceId, createdAt: { lt: cutoff } } }),
    prisma.scheduledJob.deleteMany({
      where: { workspaceId: job.workspaceId, status: { in: ['COMPLETED', 'CANCELLED'] }, completedAt: { lt: cutoff } },
    }),
  ]);

  return { mailboxesReset: reset.count, logsPruned: logs.count, jobsPruned: jobs.count };
}
