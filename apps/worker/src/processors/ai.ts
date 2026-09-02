/**
 * AI workers.
 *
 * `ai-analysis` classifies an inbound message and, when the workspace has opted
 * in, pre-generates a reply suggestion. `ai-reply` performs the actual mailbox
 * write for a reply the user composed - defaulting to a draft, never an
 * automatic send.
 */
import { createLogger } from '@mail/config';
import { prisma } from '@mail/database';
import { JobError, type JobRecord } from '@mail/queue';
import { getProvider, shouldAnalyze } from '@mail/ai';
import type { ReplyContext } from '@mail/ai';
import {
  logActivity,
  notify,
  publish,
  registerUnsubscribe,
  storage,
  withMailbox,
} from '@mail/core';
import { AutomationError } from '@mail/playwright';
import type { AttachmentRef } from '@mail/playwright';
import { STOP_INTENTS, displayName, htmlToText, stringifyJson, truncate } from '@mail/shared';

const log = createLogger('ai-worker');

export async function processAIAnalysis(job: JobRecord) {
  const threadId = job.payload.threadId as string;
  const messageId = job.payload.messageId as string;

  const message = await prisma.emailMessage.findUnique({
    where: { id: messageId },
    include: {
      thread: {
        include: {
          contact: true,
          campaign: { select: { id: true, name: true } },
          campaignContact: { select: { id: true, currentStep: true } },
          emailAccount: { select: { email: true, displayName: true, signatureHtml: true } },
          messages: { orderBy: { createdAt: 'asc' }, take: 12 },
        },
      },
    },
  });
  if (!message) return { skipped: true, reason: 'message no longer exists' };

  const { thread } = message;
  const { provider, settings } = await getProvider(job.workspaceId);

  if (!shouldAnalyze(settings, { isRead: message.isRead, hasCampaign: Boolean(thread.campaignId) })) {
    return { skipped: true, reason: `analyzeScope=${settings.analyzeScope}` };
  }

  await publish(job.workspaceId, 'ai.status', { threadId, state: 'ANALYZING' });

  const contactContext = thread.contact
    ? {
        name: displayName(thread.contact),
        email: thread.contact.email,
        company: thread.contact.companyName,
        title: thread.contact.title,
        industry: thread.contact.industry,
      }
    : null;

  const conversation = thread.messages.map((m) => ({
    direction: m.direction as 'INBOUND' | 'OUTBOUND',
    from: m.senderName ? `${m.senderName} <${m.sender}>` : m.sender,
    at: (m.receivedAt ?? m.sentAt ?? m.createdAt).toISOString(),
    text: m.bodyText ?? htmlToText(m.bodyHtml ?? ''),
  }));

  const emailContext = {
    contact: contactContext,
    subject: message.subject,
    latestMessage: message.bodyText ?? htmlToText(message.bodyHtml ?? ''),
    conversation,
  };

  const classification = await provider.classifyIntent(emailContext);
  const summary = settings.enableThreadSummary ? await provider.summarizeThread(emailContext) : null;

  await prisma.aIAnalysis.upsert({
    where: { messageId: message.id },
    create: {
      workspaceId: job.workspaceId,
      threadId: thread.id,
      messageId: message.id,
      intent: classification.intent,
      sentiment: classification.sentiment,
      priority: classification.priority,
      nextAction: classification.nextAction,
      confidence: classification.confidence,
      summary,
      provider: classification.provider,
      model: classification.model,
      promptVersion: classification.promptVersion,
      metaJson: stringifyJson({ reasons: classification.reasons }),
    },
    update: {
      intent: classification.intent,
      sentiment: classification.sentiment,
      priority: classification.priority,
      nextAction: classification.nextAction,
      confidence: classification.confidence,
      summary,
    },
  });

  await prisma.emailThread.update({
    where: { id: thread.id },
    data: { isImportant: classification.priority === 'HIGH' },
  });

  // The classifier is a second line of defence behind the keyword matcher in
  // inbox sync: an opt-out must be honoured however it is phrased.
  if (classification.intent === 'UNSUBSCRIBE') {
    await registerUnsubscribe({
      workspaceId: job.workspaceId,
      email: message.sender,
      contactId: thread.contactId,
      campaignId: thread.campaignId,
      source: 'AI',
      reason: 'Detected by intent classification',
    });
  }
  if (STOP_INTENTS.includes(classification.intent) && thread.campaignContactId) {
    const { cancelPendingFollowUps } = await import('@mail/core');
    await cancelPendingFollowUps(thread.campaignContactId, 'STOPPED');
  }

  let suggestionId: string | null = null;
  if (
    settings.enableAIReply &&
    settings.autoGenerateReplies &&
    !STOP_INTENTS.includes(classification.intent) &&
    classification.intent !== 'OUT_OF_OFFICE'
  ) {
    const replyContext: ReplyContext = {
      contact: contactContext ?? {
        name: message.senderName ?? message.sender,
        email: message.sender,
        company: null,
        title: null,
        industry: null,
      },
      campaign: thread.campaign
        ? { name: thread.campaign.name, sequenceStep: thread.campaignContact?.currentStep ?? 1, stepName: null }
        : null,
      conversation,
      latestMessage: emailContext.latestMessage,
      originalMessage: conversation.find((c) => c.direction === 'OUTBOUND')?.text ?? '',
      sender: {
        name: thread.emailAccount.displayName,
        email: thread.emailAccount.email,
        signature: thread.emailAccount.signatureHtml,
      },
      style: settings.defaultStyle,
      length: settings.defaultLength,
      subject: thread.subject,
    };

    const suggestion = await provider.generateReply(replyContext);
    const saved = await prisma.aIReplySuggestion.create({
      data: {
        workspaceId: job.workspaceId,
        threadId: thread.id,
        messageId: message.id,
        contactId: thread.contactId,
        provider: suggestion.provider,
        model: suggestion.model,
        style: settings.defaultStyle,
        length: settings.defaultLength,
        promptVersion: suggestion.promptVersion,
        suggestion: suggestion.text,
        subject: suggestion.subject,
        tokensIn: suggestion.tokensIn ?? null,
        tokensOut: suggestion.tokensOut ?? null,
      },
    });
    suggestionId = saved.id;

    await notify({
      workspaceId: job.workspaceId,
      type: 'AI_REPLY_AVAILABLE',
      severity: 'INFO',
      title: `AI reply ready for ${contactContext?.name ?? message.sender}`,
      body: truncate(suggestion.text, 140),
      linkUrl: `/inbox?thread=${thread.id}`,
    });
  }

  await publish(job.workspaceId, 'ai.status', {
    threadId,
    state: 'DONE',
    intent: classification.intent,
    priority: classification.priority,
    hasSuggestion: Boolean(suggestionId),
  });

  await logActivity({
    workspaceId: job.workspaceId,
    action: 'ai.analyzed',
    status: 'SUCCESS',
    message: `${classification.intent} (${classification.priority}) via ${classification.provider}`,
    contactId: thread.contactId,
    campaignId: thread.campaignId,
    jobId: job.id,
  });

  return {
    intent: classification.intent,
    priority: classification.priority,
    provider: classification.provider,
    suggestionId,
  };
}

/**
 * Writes a user-authored (optionally AI-assisted) reply into the mailbox.
 * DRAFT is the default; SEND only happens because a human explicitly chose it.
 */
export async function processAIReply(job: JobRecord) {
  const payload = job.payload as {
    threadId: string;
    emailAccountId: string;
    gmailThreadId: string;
    subject: string;
    bodyHtml: string;
    cc?: string[];
    bcc?: string[];
    attachmentIds?: string[];
    inReplyTo?: string | null;
    mode: 'DRAFT' | 'SEND';
    suggestionId?: string | null;
    userId?: string;
  };

  const thread = await prisma.emailThread.findUnique({
    where: { id: payload.threadId },
    include: { emailAccount: true, contact: { select: { id: true, email: true } } },
  });
  if (!thread) throw new JobError('Thread no longer exists', 'THREAD_NOT_FOUND', false);

  const attachments: AttachmentRef[] = [];
  if (payload.attachmentIds?.length) {
    const rows = await prisma.attachment.findMany({
      where: { id: { in: payload.attachmentIds }, workspaceId: job.workspaceId },
    });
    for (const row of rows) {
      if (!storage.exists(row.storagePath)) continue;
      attachments.push({
        filename: row.originalName,
        path: storage.resolve(row.storagePath),
        mimeType: row.mimeType,
        size: row.size,
      });
    }
  }

  try {
    const result = await withMailbox(payload.emailAccountId, (driver) =>
      driver.replyToConversation(
        {
          gmailThreadId: payload.gmailThreadId,
          inReplyTo: payload.inReplyTo ?? null,
          subject: payload.subject,
          bodyHtml: payload.bodyHtml,
          attachments,
        },
        payload.mode,
      ),
    );

    await prisma.emailMessage.create({
      data: {
        threadId: thread.id,
        gmailMessageId: result.gmailMessageId,
        messageId: result.rfcMessageId,
        inReplyTo: payload.inReplyTo ?? null,
        sender: thread.emailAccount.email,
        senderName: thread.emailAccount.displayName,
        recipientsJson: stringifyJson([thread.contact?.email].filter(Boolean)),
        ccJson: stringifyJson(payload.cc ?? []),
        bccJson: stringifyJson(payload.bcc ?? []),
        subject: payload.subject,
        bodyHtml: payload.bodyHtml,
        bodyText: htmlToText(payload.bodyHtml),
        snippet: truncate(htmlToText(payload.bodyHtml), 300),
        direction: 'OUTBOUND',
        isDraft: result.isDraft,
        hasAttachments: attachments.length > 0,
        sentAt: result.sentAt,
      },
    });

    await prisma.emailThread.update({
      where: { id: thread.id },
      data: {
        lastMessageId: result.rfcMessageId,
        lastMessageAt: result.sentAt,
        lastMessageDirection: 'OUTBOUND',
        status: result.isDraft ? 'OPEN' : 'WAITING',
        isRead: true,
      },
    });

    if (payload.suggestionId) {
      await prisma.aIReplySuggestion.update({
        where: { id: payload.suggestionId },
        data: { selected: true, sent: !result.isDraft },
      });
    }

    await logActivity({
      workspaceId: job.workspaceId,
      userId: payload.userId ?? null,
      emailAccountId: payload.emailAccountId,
      contactId: thread.contactId,
      campaignId: thread.campaignId,
      jobId: job.id,
      action: result.isDraft ? 'inbox.draft_saved' : 'inbox.reply_sent',
      status: 'SUCCESS',
      message: `${result.isDraft ? 'Draft saved' : 'Reply sent'} on "${thread.subject}"`,
    });

    await publish(job.workspaceId, 'inbox.updated', { threadId: thread.id, mode: payload.mode });
    return { mode: payload.mode, messageId: result.rfcMessageId };
  } catch (error) {
    const code = error instanceof AutomationError ? error.code : 'SEND_FAILED';
    const message = error instanceof Error ? error.message : String(error);

    await logActivity({
      workspaceId: job.workspaceId,
      userId: payload.userId ?? null,
      emailAccountId: payload.emailAccountId,
      jobId: job.id,
      action: 'inbox.reply_failed',
      status: 'FAILURE',
      message: truncate(message, 300),
      errorCode: code,
    });

    log.error(`reply failed on thread ${thread.id}: ${message}`);
    throw new JobError(message, code, code !== 'THREAD_NOT_FOUND');
  }
}
