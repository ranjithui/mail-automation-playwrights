import { Router } from 'express';
import { prisma } from '@mail/database';
import { percent, toIsoDay } from '@mail/shared';
import type { DashboardResponse } from '@mail/shared';
import { handler, ok } from '../lib/http.js';
import { authenticate, withWorkspace } from '../middleware/context.js';

export const dashboardRouter = Router();
dashboardRouter.use(authenticate, withWorkspace);

dashboardRouter.get(
  '/',
  handler(async (req, res) => {
    const workspaceId = req.ctx.workspaceId;
    const days = Math.min(90, Math.max(7, Number(req.query.days ?? 30)));
    const since = new Date(Date.now() - days * 86_400_000);

    const [
      totalContacts,
      eventCounts,
      campaigns,
      mailboxes,
      recentEvents,
      aiAnalyzed,
      aiSuggestions,
      aiSent,
      aiByIntent,
      inboxUnread,
      inboxAttention,
      inboxWaiting,
      inboxAiAvailable,
      recentActivity,
    ] = await Promise.all([
      prisma.contact.count({ where: { workspaceId } }),
      prisma.emailEvent.groupBy({ by: ['type'], where: { workspaceId }, _count: { _all: true } }),
      prisma.campaign.findMany({
        where: { workspaceId },
        include: { _count: { select: { campaignContacts: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 8,
      }),
      prisma.emailAccount.findMany({ where: { workspaceId } }),
      prisma.emailEvent.findMany({
        where: { workspaceId, createdAt: { gte: since } },
        select: { type: true, createdAt: true, campaignId: true },
        orderBy: { createdAt: 'asc' },
        take: 20000,
      }),
      prisma.aIAnalysis.count({ where: { workspaceId } }),
      prisma.aIReplySuggestion.count({ where: { workspaceId } }),
      prisma.aIReplySuggestion.count({ where: { workspaceId, sent: true } }),
      prisma.aIAnalysis.groupBy({ by: ['intent'], where: { workspaceId }, _count: { _all: true } }),
      prisma.emailThread.count({ where: { workspaceId, isRead: false, status: { not: 'ARCHIVED' } } }),
      prisma.emailThread.count({ where: { workspaceId, isRead: false, aiAnalyses: { some: { priority: 'HIGH' } } } }),
      prisma.emailThread.count({
        where: { workspaceId, lastMessageDirection: 'OUTBOUND', status: { in: ['OPEN', 'WAITING'] } },
      }),
      prisma.emailThread.count({ where: { workspaceId, aiSuggestions: { some: {} } } }),
      prisma.activityLog.findMany({
        where: { workspaceId },
        include: { campaign: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 12,
      }),
    ]);

    const count = (type: string) => eventCounts.find((e) => e.type === type)?._count._all ?? 0;
    const emailsSent = count('SENT');
    const replies = count('REPLY_RECEIVED');
    const bounces = count('BOUNCED');

    // Dense daily series with zero-fill so the chart never has gaps.
    const series = new Map<string, { date: string; sent: number; replies: number; bounces: number; drafts: number }>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = toIsoDay(new Date(Date.now() - i * 86_400_000));
      series.set(date, { date, sent: 0, replies: 0, bounces: 0, drafts: 0 });
    }
    for (const event of recentEvents) {
      const bucket = series.get(toIsoDay(event.createdAt));
      if (!bucket) continue;
      if (event.type === 'SENT') bucket.sent += 1;
      else if (event.type === 'REPLY_RECEIVED') bucket.replies += 1;
      else if (event.type === 'BOUNCED') bucket.bounces += 1;
      else if (event.type === 'DRAFT_CREATED') bucket.drafts += 1;
    }

    const perCampaign = new Map<string, { sent: number; replies: number; bounces: number }>();
    for (const event of recentEvents) {
      if (!event.campaignId) continue;
      const bucket = perCampaign.get(event.campaignId) ?? { sent: 0, replies: 0, bounces: 0 };
      if (event.type === 'SENT') bucket.sent += 1;
      if (event.type === 'REPLY_RECEIVED') bucket.replies += 1;
      if (event.type === 'BOUNCED') bucket.bounces += 1;
      perCampaign.set(event.campaignId, bucket);
    }

    const campaignProgress = await prisma.campaignContact.groupBy({
      by: ['campaignId', 'status'],
      where: { campaign: { workspaceId } },
      _count: { _all: true },
    });

    const mailboxEvents = await prisma.emailEvent.groupBy({
      by: ['type'],
      where: { workspaceId },
      _count: { _all: true },
    });
    void mailboxEvents;

    const today = toIsoDay(new Date());

    const response: DashboardResponse = {
      kpis: {
        totalContacts,
        emailsSent,
        draftsCreated: count('DRAFT_CREATED'),
        replies,
        followUps: Math.max(0, emailsSent - (await prisma.campaignContact.count({ where: { campaign: { workspaceId }, sentCount: { gt: 0 } } }))),
        bounces,
        unsubscribes: count('UNSUBSCRIBED'),
        failed: count('FAILED'),
        replyRate: percent(replies, emailsSent),
        bounceRate: percent(bounces, emailsSent),
      },
      activity: [...series.values()],
      campaignPerformance: campaigns.map((c) => {
        const stats = perCampaign.get(c.id) ?? { sent: 0, replies: 0, bounces: 0 };
        const rows = campaignProgress.filter((p) => p.campaignId === c.id);
        const done = rows
          .filter((r) => ['COMPLETED', 'REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'FAILED'].includes(r.status))
          .reduce((sum, r) => sum + r._count._all, 0);
        return {
          id: c.id,
          name: c.name,
          status: c.status as never,
          sent: stats.sent,
          replies: stats.replies,
          bounces: stats.bounces,
          replyRate: percent(stats.replies, stats.sent),
          progress: percent(done, c._count.campaignContacts),
        };
      }),
      mailboxPerformance: mailboxes.map((m) => ({
        id: m.id,
        email: m.email,
        sent: 0,
        replies: 0,
        bounces: 0,
        dailyLimit: m.dailyLimit,
        sentToday: m.sentTodayDate === today ? m.sentToday : 0,
        connection: m.connection as never,
      })),
      aiInsights: {
        analyzed: aiAnalyzed,
        suggestionsGenerated: aiSuggestions,
        suggestionsSent: aiSent,
        byIntent: aiByIntent.map((i) => ({ intent: i.intent as never, count: i._count._all })),
      },
      inboxActivity: {
        unread: inboxUnread,
        requiresAttention: inboxAttention,
        awaitingReply: inboxWaiting,
        aiAvailable: inboxAiAvailable,
      },
      recentActivity: recentActivity.map((l) => ({
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
        createdAt: l.createdAt.toISOString(),
      })),
    };

    // Per-mailbox totals need a second pass because EmailEvent has no mailbox
    // column; threads carry the mailbox association.
    const threadStats = await prisma.emailThread.groupBy({
      by: ['emailAccountId', 'lastMessageDirection'],
      where: { workspaceId },
      _count: { _all: true },
    });
    for (const mailbox of response.mailboxPerformance) {
      mailbox.sent = threadStats
        .filter((t) => t.emailAccountId === mailbox.id)
        .reduce((sum, t) => sum + t._count._all, 0);
      mailbox.replies =
        threadStats.find((t) => t.emailAccountId === mailbox.id && t.lastMessageDirection === 'INBOUND')?._count
          ._all ?? 0;
    }

    return ok(res, response);
  }),
);

dashboardRouter.get(
  '/analytics',
  handler(async (req, res) => {
    const workspaceId = req.ctx.workspaceId;
    const days = Math.min(180, Math.max(7, Number(req.query.days ?? 30)));
    const since = new Date(Date.now() - days * 86_400_000);

    const [events, campaigns, statusBreakdown, intents] = await Promise.all([
      prisma.emailEvent.findMany({
        where: { workspaceId, createdAt: { gte: since } },
        select: { type: true, createdAt: true, campaignId: true },
        orderBy: { createdAt: 'asc' },
        take: 50000,
      }),
      prisma.campaign.findMany({
        where: { workspaceId },
        select: { id: true, name: true, status: true },
      }),
      prisma.contact.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } }),
      prisma.aIAnalysis.groupBy({ by: ['intent'], where: { workspaceId }, _count: { _all: true } }),
    ]);

    const byDay = new Map<string, Record<string, number>>();
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = toIsoDay(new Date(Date.now() - i * 86_400_000));
      byDay.set(date, { sent: 0, replies: 0, bounces: 0, drafts: 0, failed: 0 });
    }
    for (const event of events) {
      const bucket = byDay.get(toIsoDay(event.createdAt));
      if (!bucket) continue;
      const key =
        { SENT: 'sent', REPLY_RECEIVED: 'replies', BOUNCED: 'bounces', DRAFT_CREATED: 'drafts', FAILED: 'failed' }[
          event.type
        ] ?? null;
      if (key) bucket[key] += 1;
    }

    const perCampaign = campaigns.map((c) => {
      const rows = events.filter((e) => e.campaignId === c.id);
      const sent = rows.filter((r) => r.type === 'SENT').length;
      const replies = rows.filter((r) => r.type === 'REPLY_RECEIVED').length;
      const bounces = rows.filter((r) => r.type === 'BOUNCED').length;
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        sent,
        replies,
        bounces,
        replyRate: percent(replies, sent),
        bounceRate: percent(bounces, sent),
      };
    });

    return ok(res, {
      timeline: [...byDay.entries()].map(([date, values]) => ({ date, ...values })),
      campaigns: perCampaign.sort((a, b) => b.sent - a.sent),
      contactStatus: statusBreakdown.map((s) => ({ status: s.status, count: s._count._all })),
      intents: intents.map((i) => ({ intent: i.intent, count: i._count._all })),
    });
  }),
);
