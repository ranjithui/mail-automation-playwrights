import { Router } from 'express';
import { prisma } from '@mail/database';
import { encrypt, maskSecret, tryDecrypt } from '@mail/config/crypto';
import { getAISettings, getProvider, saveAISettings } from '@mail/ai';
import type { ReplyContext } from '@mail/ai';
import { aiEditSchema, aiGenerateSchema, aiSettingsSchema, displayName, htmlToText, parseList } from '@mail/shared';
import { AppError, handler, ok } from '../lib/http.js';
import { authenticate, requireAdmin, requireWrite, withWorkspace } from '../middleware/context.js';

export const aiRouter = Router();
aiRouter.use(authenticate, withWorkspace);

/**
 * Assembles the structured context an AI provider is allowed to see.
 * Deliberately narrow: contact facts, campaign position, the conversation and
 * the message being answered. No credentials, no cookies, no unrelated mail.
 */
async function buildReplyContext(
  workspaceId: string,
  threadId: string,
  messageId: string | undefined,
  style: string,
  length: string,
  customInstructions?: string | null,
): Promise<ReplyContext> {
  const thread = await prisma.emailThread.findFirst({
    where: { id: threadId, workspaceId },
    include: {
      contact: true,
      campaign: { select: { name: true } },
      campaignContact: { select: { currentStep: true } },
      emailAccount: { select: { email: true, displayName: true, signatureHtml: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!thread) throw AppError.notFound('Thread');

  const latest =
    (messageId ? thread.messages.find((m) => m.id === messageId) : null) ??
    [...thread.messages].reverse().find((m) => m.direction === 'INBOUND') ??
    thread.messages[thread.messages.length - 1];

  const original = thread.messages.find((m) => m.direction === 'OUTBOUND');

  const stepName = thread.campaignContact
    ? await prisma.campaignStep.findFirst({
        where: { campaign: { name: thread.campaign?.name }, stepOrder: thread.campaignContact.currentStep },
        select: { name: true },
      })
    : null;

  return {
    contact: {
      name: thread.contact ? displayName(thread.contact) : (latest?.senderName ?? latest?.sender ?? 'there'),
      email: thread.contact?.email ?? latest?.sender ?? '',
      company: thread.contact?.companyName ?? null,
      title: thread.contact?.title ?? null,
      industry: thread.contact?.industry ?? null,
      city: thread.contact?.companyCity ?? null,
      country: thread.contact?.companyCountry ?? null,
    },
    campaign: thread.campaign
      ? {
          name: thread.campaign.name,
          sequenceStep: thread.campaignContact?.currentStep ?? 1,
          stepName: stepName?.name ?? null,
        }
      : null,
    conversation: thread.messages.slice(-10).map((m) => ({
      direction: m.direction as 'INBOUND' | 'OUTBOUND',
      from: m.senderName ? `${m.senderName} <${m.sender}>` : m.sender,
      at: (m.receivedAt ?? m.sentAt ?? m.createdAt).toISOString(),
      text: m.bodyText ?? htmlToText(m.bodyHtml ?? ''),
    })),
    latestMessage: latest?.bodyText ?? htmlToText(latest?.bodyHtml ?? ''),
    originalMessage: original?.bodyText ?? htmlToText(original?.bodyHtml ?? ''),
    sender: {
      name: thread.emailAccount.displayName,
      email: thread.emailAccount.email,
      signature: thread.emailAccount.signatureHtml,
    },
    style: style as ReplyContext['style'],
    length: length as ReplyContext['length'],
    customInstructions: customInstructions ?? null,
    subject: thread.subject,
  };
}

aiRouter.post(
  '/generate-reply',
  requireWrite,
  handler(async (req, res) => {
    const input = aiGenerateSchema.parse(req.body);
    const { provider, settings } = await getProvider(req.ctx.workspaceId);
    if (!settings.enableAIReply) throw AppError.forbidden('AI reply generation is disabled for this workspace');

    const thread = await prisma.emailThread.findFirst({
      where: { id: input.threadId, workspaceId: req.ctx.workspaceId },
      select: { id: true, contactId: true },
    });
    if (!thread) throw AppError.notFound('Thread');

    // Multiple variants use complementary styles so the user is choosing
    // between genuinely different options, not three near-identical drafts.
    const styles =
      input.variants === 1
        ? [input.style]
        : ['PROFESSIONAL', 'FRIENDLY', 'CONCISE'].slice(0, input.variants);

    const suggestions = [];
    for (const style of styles) {
      const context = await buildReplyContext(
        req.ctx.workspaceId,
        input.threadId,
        input.messageId,
        style,
        input.length,
        input.customInstructions,
      );
      const result = await provider.generateReply(context);

      const saved = await prisma.aIReplySuggestion.create({
        data: {
          workspaceId: req.ctx.workspaceId,
          threadId: thread.id,
          messageId: input.messageId ?? null,
          contactId: thread.contactId,
          provider: result.provider,
          model: result.model,
          style,
          length: input.length,
          promptVersion: result.promptVersion,
          customInstructions: input.customInstructions ?? null,
          suggestion: result.text,
          subject: result.subject,
          tokensIn: result.tokensIn ?? null,
          tokensOut: result.tokensOut ?? null,
        },
      });
      suggestions.push(saved);
    }

    return ok(res, { suggestions, provider: provider.name });
  }),
);

aiRouter.post(
  '/edit',
  requireWrite,
  handler(async (req, res) => {
    const input = aiEditSchema.parse(req.body);
    const { provider } = await getProvider(req.ctx.workspaceId);

    const context = await buildReplyContext(
      req.ctx.workspaceId,
      input.threadId,
      undefined,
      'PROFESSIONAL',
      'MEDIUM',
    );
    const result = await provider.editDraft(input.draft, input.action, context);

    // Every generation is stored; nothing is ever overwritten (spec 59).
    const saved = await prisma.aIReplySuggestion.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        threadId: input.threadId,
        provider: result.provider,
        model: result.model,
        style: 'PROFESSIONAL',
        length: 'MEDIUM',
        promptVersion: result.promptVersion,
        customInstructions: `edit:${input.action}`,
        suggestion: result.text,
        subject: result.subject,
        edited: true,
      },
    });

    return ok(res, saved);
  }),
);

aiRouter.get(
  '/threads/:threadId/summary',
  handler(async (req, res) => {
    const { provider, settings } = await getProvider(req.ctx.workspaceId);
    if (!settings.enableThreadSummary) throw AppError.forbidden('Thread summaries are disabled');

    const cached = await prisma.aIAnalysis.findFirst({
      where: { threadId: req.params.threadId, workspaceId: req.ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    if (cached?.summary && req.query.refresh !== 'true') {
      return ok(res, { summary: cached.summary, analysis: cached, cached: true });
    }

    const context = await buildReplyContext(
      req.ctx.workspaceId,
      req.params.threadId,
      undefined,
      'PROFESSIONAL',
      'MEDIUM',
    );
    const summary = await provider.summarizeThread({
      contact: context.contact,
      subject: context.subject,
      latestMessage: context.latestMessage,
      conversation: context.conversation,
    });

    if (cached) {
      await prisma.aIAnalysis.update({ where: { id: cached.id }, data: { summary } });
    }
    return ok(res, { summary, analysis: cached, cached: false });
  }),
);

aiRouter.get(
  '/threads/:threadId/history',
  handler(async (req, res) => {
    const suggestions = await prisma.aIReplySuggestion.findMany({
      where: { threadId: req.params.threadId, workspaceId: req.ctx.workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return ok(res, suggestions);
  }),
);

aiRouter.post(
  '/suggestions/:id/save-as-template',
  requireWrite,
  handler(async (req, res) => {
    const suggestion = await prisma.aIReplySuggestion.findFirst({
      where: { id: req.params.id, workspaceId: req.ctx.workspaceId },
    });
    if (!suggestion) throw AppError.notFound('Suggestion');

    const name = String(req.body?.name ?? `AI reply ${new Date().toISOString().slice(0, 16)}`).slice(0, 120);
    const bodyHtml = `<div>${suggestion.suggestion.replace(/\n/g, '<br>')}</div>`;

    const template = await prisma.emailTemplate.create({
      data: {
        workspaceId: req.ctx.workspaceId,
        name,
        category: 'AI',
        subject: suggestion.subject ?? 'Re: {{Company Name}}',
        bodyHtml,
        bodyText: suggestion.suggestion,
        description: `Saved from an AI suggestion (${suggestion.provider}/${suggestion.promptVersion})`,
      },
    });
    return ok(res, template, undefined, 201);
  }),
);

// ---------------------------------------------------------------- settings

aiRouter.get(
  '/settings',
  handler(async (req, res) => {
    const settings = await getAISettings(req.ctx.workspaceId);
    const decrypted = tryDecrypt(settings.apiKeyEncrypted);
    // The key itself is never returned - only a masked hint that one exists.
    const { apiKeyEncrypted, ...rest } = settings;
    return ok(res, { ...rest, apiKeyMask: maskSecret(decrypted), hasApiKey: Boolean(decrypted) });
  }),
);

aiRouter.put(
  '/settings',
  requireAdmin,
  handler(async (req, res) => {
    const input = aiSettingsSchema.parse(req.body);
    const current = await getAISettings(req.ctx.workspaceId);

    const apiKeyEncrypted =
      input.apiKey === undefined || input.apiKey === null || input.apiKey === ''
        ? current.apiKeyEncrypted
        : encrypt(input.apiKey);

    const { apiKey, ...rest } = input;
    await saveAISettings(req.ctx.workspaceId, { ...current, ...rest, apiKeyEncrypted });

    const saved = await getAISettings(req.ctx.workspaceId);
    const { apiKeyEncrypted: _hidden, ...safe } = saved;
    return ok(res, { ...safe, hasApiKey: Boolean(apiKeyEncrypted) });
  }),
);

aiRouter.post(
  '/settings/test',
  requireAdmin,
  handler(async (req, res) => {
    const { provider } = await getProvider(req.ctx.workspaceId);
    try {
      const result = await provider.classifyIntent({
        contact: null,
        subject: 'Quick question about pricing',
        latestMessage: 'Hi, could you share your pricing tiers? We are evaluating this quarter.',
        conversation: [],
      });
      return ok(res, { ok: true, provider: provider.name, sample: result });
    } catch (error) {
      return ok(res, {
        ok: false,
        provider: provider.name,
        message: error instanceof Error ? error.message : 'Provider test failed',
      });
    }
  }),
);

aiRouter.get(
  '/analytics',
  handler(async (req, res) => {
    const workspaceId = req.ctx.workspaceId;
    const [analyzed, suggestions, sent, byIntent, byPriority] = await Promise.all([
      prisma.aIAnalysis.count({ where: { workspaceId } }),
      prisma.aIReplySuggestion.count({ where: { workspaceId } }),
      prisma.aIReplySuggestion.count({ where: { workspaceId, sent: true } }),
      prisma.aIAnalysis.groupBy({ by: ['intent'], where: { workspaceId }, _count: { _all: true } }),
      prisma.aIAnalysis.groupBy({ by: ['priority'], where: { workspaceId }, _count: { _all: true } }),
    ]);

    return ok(res, {
      analyzed,
      suggestionsGenerated: suggestions,
      suggestionsSent: sent,
      byIntent: byIntent.map((i) => ({ intent: i.intent, count: i._count._all })),
      byPriority: byPriority.map((p) => ({ priority: p.priority, count: p._count._all })),
    });
  }),
);
