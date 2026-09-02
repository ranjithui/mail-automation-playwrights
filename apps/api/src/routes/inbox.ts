import { Router } from 'express';
import { prisma } from '@mail/database';
import { enqueue } from '@mail/queue';
import { logActivity } from '@mail/core';
import {
  composeReplySchema,
  displayName,
  inboxQuerySchema,
  parseList,
  replySubject,
  threadActionSchema,
} from '@mail/shared';
import type { ThreadDetail, ThreadListItem } from '@mail/shared';
import { AppError, handler, ok, paginate } from '../lib/http.js';
import { authenticate, requireWrite, withWorkspace } from '../middleware/context.js';

export const inboxRouter = Router();
inboxRouter.use(authenticate, withWorkspace);

/**
 * Gmail-style search operators (spec section 67): from:, to:, subject:,
 * campaign:, company:, status:, date: plus free-text keywords.
 */
export function parseSearch(raw: string) {
  const operators: Record<string, string> = {};
  const keywords: string[] = [];
  const re = /(\w+):("[^"]*"|\S+)|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(raw)) !== null) {
    if (match[1]) {
      operators[match[1].toLowerCase()] = (match[2] ?? '').replace(/^"|"$/g, '');
    } else if (match[3]) {
      keywords.push(match[3]);
    }
  }
  return { operators, keywords: keywords.join(' ').trim() };
}

function toListItem(thread: any): ThreadListItem {
  const analysis = thread.aiAnalyses?.[0];
  return {
    id: thread.id,
    subject: thread.subject,
    snippet: thread.snippet,
    isRead: thread.isRead,
    isStarred: thread.isStarred,
    isImportant: thread.isImportant,
    status: thread.status,
    lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
    lastMessageDirection: thread.lastMessageDirection,
    hasAttachments: Boolean(thread.messages?.some((m: any) => m.hasAttachments)),
    participants: parseList(thread.participantsJson),
    contact: thread.contact
      ? {
          id: thread.contact.id,
          name: displayName(thread.contact),
          email: thread.contact.email,
          companyName: thread.contact.companyName ?? null,
        }
      : null,
    campaign: thread.campaign ? { id: thread.campaign.id, name: thread.campaign.name } : null,
    sequenceStep: thread.campaignContact ? `Step ${thread.campaignContact.currentStep}` : null,
    emailAccount: { id: thread.emailAccount.id, email: thread.emailAccount.email },
    ai: analysis
      ? {
          intent: analysis.intent,
          sentiment: analysis.sentiment,
          priority: analysis.priority,
          summary: analysis.summary,
          hasSuggestion: (thread._count?.aiSuggestions ?? 0) > 0,
        }
      : (thread._count?.aiSuggestions ?? 0) > 0
        ? { intent: null, sentiment: null, priority: null, summary: null, hasSuggestion: true }
        : null,
  };
}

inboxRouter.get(
  '/',
  handler(async (req, res) => {
    const query = inboxQuerySchema.parse(req.query);
    const where: Record<string, any> = { workspaceId: req.ctx.workspaceId };

    switch (query.folder) {
      case 'UNREAD':
        where.isRead = false;
        break;
      case 'IMPORTANT':
        where.isImportant = true;
        break;
      case 'REPLIED':
        where.status = 'REPLIED';
        break;
      case 'WAITING':
        where.lastMessageDirection = 'OUTBOUND';
        where.status = { in: ['OPEN', 'WAITING'] };
        break;
      case 'AI_SUGGESTED':
        where.aiSuggestions = { some: {} };
        break;
      case 'ARCHIVED':
        where.status = 'ARCHIVED';
        break;
      default:
        where.status = { not: 'ARCHIVED' };
    }

    if (query.emailAccountId) where.emailAccountId = query.emailAccountId;
    if (query.campaignId) where.campaignId = query.campaignId;
    if (query.starred !== undefined) where.isStarred = query.starred;
    if (query.hasAttachment) where.messages = { some: { hasAttachments: true } };
    if (query.intent) where.aiAnalyses = { some: { intent: query.intent } };
    if (query.priority) where.aiAnalyses = { some: { priority: query.priority } };

    if (query.q) {
      const { operators, keywords } = parseSearch(query.q);
      const and: any[] = [];

      if (operators.from) and.push({ messages: { some: { sender: { contains: operators.from } } } });
      if (operators.to) and.push({ messages: { some: { recipientsJson: { contains: operators.to } } } });
      if (operators.subject) and.push({ subject: { contains: operators.subject } });
      if (operators.campaign) and.push({ campaign: { name: { contains: operators.campaign } } });
      if (operators.company) and.push({ contact: { companyName: { contains: operators.company } } });
      if (operators.status) and.push({ status: operators.status.toUpperCase() });
      if (operators.date) {
        const since = new Date(operators.date);
        if (!Number.isNaN(since.getTime())) and.push({ lastMessageAt: { gte: since } });
      }
      if (keywords) {
        and.push({
          OR: [
            { subject: { contains: keywords } },
            { snippet: { contains: keywords } },
            { messages: { some: { bodyText: { contains: keywords } } } },
            { contact: { email: { contains: keywords } } },
          ],
        });
      }
      if (and.length) where.AND = and;
    }

    const [rows, total] = await Promise.all([
      prisma.emailThread.findMany({
        where,
        include: {
          contact: { select: { id: true, email: true, firstName: true, lastName: true, companyName: true } },
          campaign: { select: { id: true, name: true } },
          campaignContact: { select: { currentStep: true } },
          emailAccount: { select: { id: true, email: true } },
          messages: { select: { hasAttachments: true } },
          aiAnalyses: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count: { select: { aiSuggestions: true } },
        },
        orderBy: { lastMessageAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      prisma.emailThread.count({ where }),
    ]);

    return ok(res, paginate(rows.map(toListItem), total, query.page, query.pageSize));
  }),
);

inboxRouter.get(
  '/counts',
  handler(async (req, res) => {
    const workspaceId = req.ctx.workspaceId;
    const [all, unread, important, replied, waiting, aiSuggested, archived, requiresAttention] = await Promise.all([
      prisma.emailThread.count({ where: { workspaceId, status: { not: 'ARCHIVED' } } }),
      prisma.emailThread.count({ where: { workspaceId, isRead: false, status: { not: 'ARCHIVED' } } }),
      prisma.emailThread.count({ where: { workspaceId, isImportant: true } }),
      prisma.emailThread.count({ where: { workspaceId, status: 'REPLIED' } }),
      prisma.emailThread.count({
        where: { workspaceId, lastMessageDirection: 'OUTBOUND', status: { in: ['OPEN', 'WAITING'] } },
      }),
      prisma.emailThread.count({ where: { workspaceId, aiSuggestions: { some: {} } } }),
      prisma.emailThread.count({ where: { workspaceId, status: 'ARCHIVED' } }),
      prisma.emailThread.count({
        where: { workspaceId, isRead: false, aiAnalyses: { some: { priority: 'HIGH' } } },
      }),
    ]);

    const byIntent = await prisma.aIAnalysis.groupBy({
      by: ['intent'],
      where: { workspaceId },
      _count: { _all: true },
    });

    return ok(res, {
      folders: { all, unread, important, replied, waiting, aiSuggested, archived },
      smart: {
        requiresAttention,
        pricingRequests: byIntent.find((i) => i.intent === 'ASKING_PRICING')?._count._all ?? 0,
        meetingRequests: byIntent.find((i) => i.intent === 'MEETING_REQUEST')?._count._all ?? 0,
        interested: byIntent.find((i) => i.intent === 'INTERESTED')?._count._all ?? 0,
        notInterested: byIntent.find((i) => i.intent === 'NOT_INTERESTED')?._count._all ?? 0,
        waitingForResponse: waiting,
      },
    });
  }),
);

inboxRouter.get(
  '/threads/:id',
  handler(async (req, res) => {
    const thread = await prisma.emailThread.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      include: {
        contact: { select: { id: true, email: true, firstName: true, lastName: true, companyName: true, title: true, industry: true } },
        campaign: { select: { id: true, name: true } },
        campaignContact: { select: { id: true, currentStep: true, status: true } },
        emailAccount: { select: { id: true, email: true, displayName: true, signatureHtml: true } },
        messages: { include: { attachments: true }, orderBy: { createdAt: 'asc' } },
        aiAnalyses: { orderBy: { createdAt: 'desc' }, take: 1 },
        aiSuggestions: { orderBy: { createdAt: 'desc' }, take: 20 },
        _count: { select: { aiSuggestions: true } },
      },
    });
    if (!thread) throw AppError.notFound('Thread');

    const detail: ThreadDetail = {
      ...toListItem(thread),
      messages: thread.messages.map((m) => ({
        id: m.id,
        direction: m.direction as 'INBOUND' | 'OUTBOUND',
        sender: m.sender,
        senderName: m.senderName,
        recipients: parseList(m.recipientsJson),
        cc: parseList(m.ccJson),
        subject: m.subject,
        bodyHtml: m.bodyHtml,
        bodyText: m.bodyText,
        snippet: m.snippet,
        isDraft: m.isDraft,
        sentAt: m.sentAt?.toISOString() ?? null,
        receivedAt: m.receivedAt?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
        attachments: m.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })),
      })),
      suggestions: thread.aiSuggestions.map((s) => ({
        id: s.id,
        style: s.style as never,
        length: s.length as never,
        suggestion: s.suggestion,
        subject: s.subject,
        provider: s.provider,
        model: s.model,
        promptVersion: s.promptVersion,
        selected: s.selected,
        edited: s.edited,
        sent: s.sent,
        createdAt: s.createdAt.toISOString(),
      })),
    };

    return ok(res, {
      ...detail,
      analysis: thread.aiAnalyses[0] ?? null,
      mailboxSignature: thread.emailAccount.signatureHtml,
    });
  }),
);

inboxRouter.post(
  '/threads/:id/action',
  requireWrite,
  handler(async (req, res) => {
    const input = threadActionSchema.parse(req.body);
    const thread = await prisma.emailThread.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!thread) throw AppError.notFound('Thread');

    const data: Record<string, unknown> = {};
    switch (input.action) {
      case 'MARK_READ':
        data.isRead = true;
        break;
      case 'MARK_UNREAD':
        data.isRead = false;
        break;
      case 'STAR':
        data.isStarred = true;
        break;
      case 'UNSTAR':
        data.isStarred = false;
        break;
      case 'IMPORTANT':
        data.isImportant = !thread.isImportant;
        break;
      case 'ARCHIVE':
        data.status = 'ARCHIVED';
        break;
      case 'UNARCHIVE':
        data.status = 'OPEN';
        break;
    }

    const updated = await prisma.emailThread.update({ where: { id: thread.id }, data });
    if (input.action === 'MARK_READ') {
      await prisma.emailMessage.updateMany({ where: { threadId: thread.id }, data: { isRead: true } });
    }

    // Mirror the change into the real mailbox in the background.
    await enqueue({
      workspaceId: req.ctx.workspaceId,
      queue: 'browser-worker',
      name: `thread-action:${input.action}`,
      payload: {
        emailAccountId: thread.emailAccountId,
        action: 'thread-action',
        threadAction: input.action,
        gmailThreadId: thread.gmailThreadId,
      },
      maxAttempts: 1,
    });

    return ok(res, updated);
  }),
);

/**
 * Reply composer. The default is DRAFT: an AI-assisted reply is never sent
 * automatically, it is written into the mailbox for a human to review and send.
 */
inboxRouter.post(
  '/threads/:id/reply',
  requireWrite,
  handler(async (req, res) => {
    const input = composeReplySchema.parse(req.body);
    const thread = await prisma.emailThread.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        contact: { select: { email: true } },
      },
    });
    if (!thread) throw AppError.notFound('Thread');

    const jobId = await enqueue({
      workspaceId: req.ctx.workspaceId,
      queue: 'ai-reply',
      name: `${input.mode === 'SEND' ? 'send' : 'draft'}-reply:${thread.subject}`,
      payload: {
        threadId: thread.id,
        emailAccountId: thread.emailAccountId,
        gmailThreadId: thread.gmailThreadId,
        subject: input.subject ?? replySubject(thread.subject),
        bodyHtml: input.bodyHtml,
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        attachmentIds: input.attachmentIds ?? [],
        inReplyTo: thread.messages[0]?.messageId ?? null,
        mode: input.mode,
        suggestionId: input.suggestionId ?? null,
        userId: req.ctx.userId,
      },
      maxAttempts: 2,
    });

    if (input.suggestionId) {
      await prisma.aIReplySuggestion.updateMany({
        where: { id: input.suggestionId, workspaceId: req.ctx.workspaceId },
        data: { selected: true, sent: input.mode === 'SEND' },
      });
    }

    await logActivity({
      workspaceId: req.ctx.workspaceId,
      userId: req.ctx.userId,
      action: input.mode === 'SEND' ? 'inbox.reply_sent' : 'inbox.draft_created',
      message: `Reply queued for "${thread.subject}"`,
      jobId,
    });

    return ok(res, { queued: true, jobId, mode: input.mode });
  }),
);

inboxRouter.post(
  '/threads/:id/create-contact',
  requireWrite,
  handler(async (req, res) => {
    const thread = await prisma.emailThread.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
      include: { messages: { where: { direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!thread) throw AppError.notFound('Thread');
    if (thread.contactId) throw AppError.conflict('This thread is already linked to a contact');

    const message = thread.messages[0];
    if (!message) throw AppError.badRequest('This thread has no inbound message to create a contact from');

    const [firstName, ...rest] = (message.senderName ?? '').split(' ');
    const contact = await prisma.contact.upsert({
      where: { workspaceId_email: { workspaceId: req.ctx.workspaceId, email: message.sender } },
      create: {
        workspaceId: req.ctx.workspaceId,
        email: message.sender,
        firstName: firstName || null,
        lastName: rest.join(' ') || null,
        status: 'REPLIED',
      },
      update: {},
    });

    await prisma.emailThread.update({ where: { id: thread.id }, data: { contactId: contact.id } });
    return ok(res, contact, undefined, 201);
  }),
);

inboxRouter.post(
  '/sync',
  requireWrite,
  handler(async (req, res) => {
    const accounts = await prisma.emailAccount.findMany({
      where: { workspaceId: req.ctx.workspaceId, status: 'ACTIVE' },
      select: { id: true, email: true },
    });
    if (!accounts.length) throw AppError.badRequest('Connect a mailbox first');

    for (const account of accounts) {
      await enqueue({
        workspaceId: req.ctx.workspaceId,
        queue: 'inbox-sync',
        name: `manual-sync:${account.email}`,
        payload: { emailAccountId: account.id, limit: 50 },
        maxAttempts: 2,
      });
    }
    return ok(res, { queued: accounts.length });
  }),
);
