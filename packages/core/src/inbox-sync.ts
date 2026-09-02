/**
 * InboxSyncService.
 *
 * Incremental: it asks the driver only for threads newer than the newest
 * message already stored for that mailbox, then upserts by Gmail thread and
 * message id. A full mailbox reload never happens on a routine sync.
 *
 * Every inbound message is run through attribution (contact -> campaign ->
 * sequence step) and the safety classifiers (bounce, opt-out, out-of-office)
 * before AI analysis is queued asynchronously.
 */
import { prisma } from '@mail/database';
import { createLogger } from '@mail/config';
import { enqueue } from '@mail/queue';
import {
  BOUNCE_SIGNATURES,
  extractFailedRecipients,
  OUT_OF_OFFICE_SIGNATURES,
  UNSUBSCRIBE_SIGNATURES,
  type FetchedMessage,
  type FetchedThread,
  type MailboxDriver,
} from '@mail/playwright';
import { normalizeEmail, stringifyJson, truncate } from '@mail/shared';
import { logActivity, notify, recordEvent } from './activity.js';
import { publish } from './realtime.js';
import { handleReply } from './campaign.js';
import { registerBounce, registerUnsubscribe } from './suppression.js';

const log = createLogger('inbox-sync');

export interface SyncSummary {
  threads: number;
  newMessages: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  outOfOffice: number;
}

export function classifyInbound(message: FetchedMessage) {
  const haystack = `${message.subject}\n${message.bodyText}`;
  const sender = normalizeEmail(message.sender);

  const bounce = BOUNCE_SIGNATURES.find((s) => s.pattern.test(haystack));
  const isMailerDaemon = /mailer-daemon|postmaster|delivery.?subsystem/i.test(sender);
  if (bounce && (isMailerDaemon || bounce.type === 'HARD')) {
    return { kind: 'BOUNCE' as const, bounceType: bounce.type };
  }
  if (UNSUBSCRIBE_SIGNATURES.some((re) => re.test(haystack))) return { kind: 'UNSUBSCRIBE' as const };
  if (OUT_OF_OFFICE_SIGNATURES.some((re) => re.test(haystack))) return { kind: 'OUT_OF_OFFICE' as const };
  return { kind: 'REPLY' as const };
}

export class InboxSyncService {
  constructor(
    private readonly driver: MailboxDriver,
    private readonly workspaceId: string,
    private readonly emailAccountId: string,
  ) {}

  /** The mailbox doing the sending - never the address that bounced. */
  private get mailboxAddress(): string | undefined {
    return this.driver.identity?.email;
  }

  /**
   * Refreshes the conversations this platform started.
   *
   * Deliberately NOT a scan of the whole mailbox. A cold-outreach inbox should
   * contain campaign correspondence and nothing else, so the join key is the
   * Gmail thread id captured when we sent - which means the cost scales with
   * campaign size rather than mailbox size, and unrelated personal mail is
   * never read or stored.
   *
   * (The strictly correct key is the RFC Message-ID carried in In-Reply-To,
   * but Gmail's web DOM does not expose it. A Gmail API integration would use
   * that instead; over the browser, the thread id is what is reliably
   * available.)
   */
  async syncInbox(limit = 40): Promise<SyncSummary> {
    const known = await prisma.emailThread.findMany({
      where: { emailAccountId: this.emailAccountId, status: { not: 'ARCHIVED' } },
      orderBy: { lastMessageAt: 'desc' },
      take: limit,
      select: { gmailThreadId: true },
    });

    const ids = new Set(known.map((t) => t.gmailThreadId));

    // Campaign labels are the second way in, and the more durable one. Gmail
    // applies a label to the whole conversation, so a reply to a labelled send
    // carries the label too - which means one search per campaign finds the
    // campaign's mail even for a thread whose id we never stored, or lost.
    for (const label of await this.campaignLabels()) {
      try {
        const rows = await this.driver.fetchThreadSummaries({ query: `label:"${label}"`, limit });
        for (const row of rows) ids.add(row.gmailThreadId);
      } catch (error) {
        log.debug(`label sweep for ${label} failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    const summary: SyncSummary = {
      threads: ids.size,
      newMessages: 0,
      replies: 0,
      bounces: 0,
      unsubscribes: 0,
      outOfOffice: 0,
    };

    if (!ids.size) {
      log.debug(`no campaign threads for ${this.emailAccountId}; nothing to sync`);
      return summary;
    }

    for (const gmailThreadId of ids) {
      const fetched = await this.driver.fetchThread(gmailThreadId);
      if (!fetched) continue;
      const result = await this.upsertThread(fetched);
      summary.newMessages += result.newMessages;
      summary.replies += result.replies;
      summary.bounces += result.bounces;
      summary.unsubscribes += result.unsubscribes;
      summary.outOfOffice += result.outOfOffice;
    }

    if (summary.newMessages) {
      await publish(this.workspaceId, 'inbox.updated', { emailAccountId: this.emailAccountId, ...summary });
      log.info(`sync ${this.emailAccountId}: ${summary.newMessages} new message(s)`, summary);
    }
    return summary;
  }

  /** Labels of every campaign this mailbox sends for. */
  private async campaignLabels(): Promise<string[]> {
    const campaigns = await prisma.campaign.findMany({
      where: { emailAccountId: this.emailAccountId, gmailLabel: { not: null } },
      select: { gmailLabel: true },
    });
    return [...new Set(campaigns.map((c) => c.gmailLabel!).filter(Boolean))];
  }

  async fetchThread(gmailThreadId: string) {
    const thread = await this.driver.fetchThread(gmailThreadId);
    if (!thread) return null;
    await this.upsertThread(thread);
    return thread;
  }

  // ---------------------------------------------------------- persistence

  private async resolveContact(thread: FetchedThread) {
    const mailboxEmail = normalizeEmail(this.driver.identity.email);
    const counterparties = [
      ...new Set(
        thread.messages
          .flatMap((m) => [m.sender, ...m.recipients])
          .map(normalizeEmail)
          .filter((e) => e && e !== mailboxEmail && !/mailer-daemon|postmaster/i.test(e)),
      ),
    ];

    for (const email of counterparties) {
      const contact = await prisma.contact.findUnique({
        where: { workspaceId_email: { workspaceId: this.workspaceId, email } },
      });
      if (contact) return contact;
    }
    return null;
  }

  private async upsertThread(fetched: FetchedThread) {
    const stats: SyncSummary = { threads: 1, newMessages: 0, replies: 0, bounces: 0, unsubscribes: 0, outOfOffice: 0 };

    const contact = await this.resolveContact(fetched);

    // Attribution: prefer a thread we created ourselves during a campaign send.
    const existing = await prisma.emailThread.findUnique({
      where: { emailAccountId_gmailThreadId: { emailAccountId: this.emailAccountId, gmailThreadId: fetched.gmailThreadId } },
    });

    let campaignContact = null;
    if (contact) {
      campaignContact = await prisma.campaignContact.findFirst({
        where: { contactId: contact.id, campaign: { workspaceId: this.workspaceId } },
        orderBy: { updatedAt: 'desc' },
      });
    }

    const last = fetched.messages[fetched.messages.length - 1];
    const threadData = {
      workspaceId: this.workspaceId,
      emailAccountId: this.emailAccountId,
      gmailThreadId: fetched.gmailThreadId,
      subject: fetched.subject,
      participantsJson: stringifyJson(fetched.participants),
      snippet: truncate(last?.snippet ?? '', 200),
      lastMessageAt: fetched.lastMessageAt,
      lastMessageDirection: last?.direction ?? 'OUTBOUND',
      isRead: fetched.isRead,
      isStarred: fetched.isStarred,
      isImportant: fetched.isImportant,
      labelsJson: stringifyJson(fetched.labels),
      contactId: contact?.id ?? existing?.contactId ?? null,
      campaignId: campaignContact?.campaignId ?? existing?.campaignId ?? null,
      campaignContactId: campaignContact?.id ?? existing?.campaignContactId ?? null,
    };

    const thread = existing
      ? await prisma.emailThread.update({ where: { id: existing.id }, data: threadData })
      : await prisma.emailThread.create({ data: threadData });

    for (const message of fetched.messages) {
      const known = await prisma.emailMessage.findFirst({
        where: { threadId: thread.id, gmailMessageId: message.gmailMessageId },
        select: { id: true },
      });
      if (known) continue;

      const stored = await prisma.emailMessage.create({
        data: {
          threadId: thread.id,
          gmailMessageId: message.gmailMessageId,
          messageId: message.rfcMessageId,
          inReplyTo: message.inReplyTo,
          sender: normalizeEmail(message.sender),
          senderName: message.senderName,
          recipientsJson: stringifyJson(message.recipients),
          ccJson: stringifyJson(message.cc),
          subject: message.subject,
          bodyText: message.bodyText,
          bodyHtml: message.bodyHtml,
          snippet: truncate(message.snippet, 300),
          direction: message.direction,
          isRead: message.isRead,
          hasAttachments: message.attachments.length > 0,
          receivedAt: message.direction === 'INBOUND' ? message.receivedAt : null,
          sentAt: message.direction === 'OUTBOUND' ? message.receivedAt : null,
        },
      });
      stats.newMessages += 1;

      for (const attachment of message.attachments) {
        await prisma.emailAttachment.create({
          data: {
            messageId: stored.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
            gmailAttachmentId: attachment.gmailAttachmentId ?? null,
          },
        });
      }

      if (message.direction === 'INBOUND') {
        await this.handleInbound(thread.id, stored.id, message, contact?.id ?? null, thread.campaignId, campaignContact?.id ?? null, stats);
      }
    }

    await prisma.emailThread.update({
      where: { id: thread.id },
      data: { lastMessageId: last?.rfcMessageId ?? null },
    });

    return stats;
  }

  private async handleInbound(
    threadId: string,
    messageId: string,
    message: FetchedMessage,
    contactId: string | null,
    campaignId: string | null,
    campaignContactId: string | null,
    stats: SyncSummary,
  ) {
    const classification = classifyInbound(message);

    await recordEvent({
      workspaceId: this.workspaceId,
      type: classification.kind === 'BOUNCE' ? 'BOUNCED' : classification.kind === 'UNSUBSCRIBE' ? 'UNSUBSCRIBED' : 'REPLY_RECEIVED',
      contactId,
      campaignId,
      threadId,
      messageId,
      meta: { classification: classification.kind },
    });

    switch (classification.kind) {
      case 'BOUNCE': {
        stats.bounces += 1;
        const contact = contactId
          ? await prisma.contact.findUnique({ where: { id: contactId }, select: { email: true } })
          : null;
        // Ranked candidates, not the first address in the body: a delivery
        // report names the daemon and our own mailbox too, and picking one of
        // those suppresses somebody who never bounced.
        const candidates = extractFailedRecipients(message.bodyText, this.mailboxAddress);
        const known = candidates.length
          ? await prisma.contact.findFirst({
              where: { workspaceId: this.workspaceId, email: { in: candidates } },
              select: { email: true },
            })
          : null;
        const recipient = known?.email ?? contact?.email ?? candidates[0] ?? message.recipients[0];
        if (recipient) {
          await registerBounce({
            workspaceId: this.workspaceId,
            email: recipient,
            contactId,
            campaignId,
            type: classification.bounceType,
            reason: truncate(message.subject, 200),
            rawSnippet: truncate(message.bodyText, 500),
          });
        }
        if (campaignContactId) {
          const { cancelPendingFollowUps } = await import('./sequence.js');
          await cancelPendingFollowUps(campaignContactId, 'BOUNCED');
        }
        break;
      }

      case 'UNSUBSCRIBE': {
        stats.unsubscribes += 1;
        await registerUnsubscribe({
          workspaceId: this.workspaceId,
          email: message.sender,
          contactId,
          campaignId,
          source: 'REPLY',
          reason: truncate(message.bodyText, 200),
        });
        await notify({
          workspaceId: this.workspaceId,
          type: 'NEW_IMPORTANT_REPLY',
          severity: 'WARNING',
          title: 'Opt-out request received',
          body: `${message.sender} asked to be removed. They have been added to the suppression list.`,
          linkUrl: `/inbox?thread=${threadId}`,
        });
        break;
      }

      case 'OUT_OF_OFFICE': {
        stats.outOfOffice += 1;
        // An auto-responder is not a real reply: the sequence keeps running but
        // the next step is pushed out so the follow-up does not land while the
        // recipient is away.
        if (campaignContactId) {
          await prisma.campaignContact.update({
            where: { id: campaignContactId },
            data: { nextStepAt: new Date(Date.now() + 3 * 86_400_000) },
          });
        }
        break;
      }

      default: {
        stats.replies += 1;
        if (campaignContactId) await handleReply(campaignContactId);
        await notify({
          workspaceId: this.workspaceId,
          type: 'NEW_IMPORTANT_REPLY',
          severity: 'SUCCESS',
          title: `New reply from ${message.senderName ?? message.sender}`,
          body: truncate(message.snippet, 160),
          linkUrl: `/inbox?thread=${threadId}`,
        });
        break;
      }
    }

    await prisma.emailThread.update({
      where: { id: threadId },
      data: { status: classification.kind === 'REPLY' ? 'REPLIED' : 'OPEN', isRead: false },
    });

    await publish(this.workspaceId, 'inbox.message', {
      threadId,
      messageId,
      sender: message.sender,
      subject: message.subject,
      snippet: message.snippet,
      classification: classification.kind,
    });

    // AI runs asynchronously so it can never slow down or block a sync.
    await enqueue({
      workspaceId: this.workspaceId,
      queue: 'ai-analysis',
      name: `analyse:${truncate(message.subject, 40)}`,
      payload: { threadId, messageId, emailAccountId: this.emailAccountId },
      dedupeKey: `ai-analysis:${messageId}`,
      maxAttempts: 2,
    });

    await logActivity({
      workspaceId: this.workspaceId,
      action: 'inbox.message_received',
      status: 'INFO',
      message: `${classification.kind} from ${message.sender}`,
      contactId,
      campaignId,
      emailAccountId: this.emailAccountId,
    });
  }

  // --------------------------------------------------------- thread actions

  async markAsRead(gmailThreadId: string) {
    await this.driver.markAsRead(gmailThreadId);
  }

  async markAsUnread(gmailThreadId: string) {
    await this.driver.markAsUnread(gmailThreadId);
  }

  async starThread(gmailThreadId: string, starred: boolean) {
    await this.driver.starThread(gmailThreadId, starred);
  }

  async archiveThread(gmailThreadId: string) {
    await this.driver.archiveThread(gmailThreadId);
  }

  async getAttachments(gmailThreadId: string) {
    const thread = await this.driver.fetchThread(gmailThreadId);
    return thread?.messages.flatMap((m) => m.attachments) ?? [];
  }
}
