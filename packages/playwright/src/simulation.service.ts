/**
 * SimulationGmailService - a faithful stand-in for the Gmail driver.
 *
 * It satisfies the identical `MailboxDriver` contract, keeps a durable mailbox
 * on disk, threads replies correctly and produces realistic inbound traffic
 * (interest, pricing questions, meeting requests, out-of-office, opt-outs and
 * delivery failures). That makes the entire product - campaigns, sequences,
 * follow-up cancellation, inbox, AI analysis, bounce and suppression handling -
 * runnable and testable end to end without touching a real mailbox.
 *
 * Switch to the real browser driver with GMAIL_DRIVER=playwright.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, env } from '@mail/config';
import { htmlToText, randomBetween, sleep, truncate } from '@mail/shared';
import { detectBounceFromThread, synthesizeId, synthesizeRfcId } from './gmail-automation.service.js';
import type {
  AttachmentRef,
  BounceInfo,
  ComposeRequest,
  ConnectionInfo,
  DriverEvents,
  FetchedMessage,
  FetchedThread,
  MailboxDriver,
  MailboxIdentity,
  ReplyRequest,
  SendResult,
  SyncOptions,
  ThreadSummary,
} from './types.js';

const log = createLogger('gmail-sim');

interface SimReply {
  intent: string;
  subjectPrefix?: string;
  body: string;
  weight: number;
  fromMailer?: boolean;
}

/** Reply archetypes, weighted so most sends simply go unanswered. */
const REPLY_LIBRARY: SimReply[] = [
  {
    intent: 'ASKING_PRICING',
    weight: 14,
    body: `Thanks for reaching out. This looks relevant to what we are evaluating this quarter.\n\nCould you share your pricing tiers and what a typical rollout looks like for a team of our size?`,
  },
  {
    intent: 'MEETING_REQUEST',
    weight: 12,
    body: `Appreciate the note. Happy to take a look.\n\nWould you have 30 minutes next Tuesday or Wednesday afternoon for a short call? Please send an invite that works on your side.`,
  },
  {
    intent: 'INTERESTED',
    weight: 10,
    body: `This is interesting timing - we have been discussing exactly this internally.\n\nCan you send over a short overview and a couple of customer examples in our industry?`,
  },
  {
    intent: 'ASKING_INFORMATION',
    weight: 9,
    body: `Thanks for the message. Before we go further, could you clarify how the product handles data residency and whether there is an audit trail for every action?`,
  },
  {
    intent: 'NOT_INTERESTED',
    weight: 8,
    body: `Thanks for getting in touch, but this is not a priority for us right now. We have just renewed with an existing vendor.`,
  },
  {
    intent: 'OUT_OF_OFFICE',
    weight: 7,
    subjectPrefix: 'Automatic reply: ',
    body: `I am currently out of the office with limited access to email and will return on Monday.\n\nFor anything urgent please contact operations@example.com.\n\nThis is an automatic reply.`,
  },
  {
    intent: 'UNSUBSCRIBE',
    weight: 4,
    body: `Please remove me from your list and do not contact me again.`,
  },
  {
    intent: 'BOUNCE',
    weight: 4,
    fromMailer: true,
    subjectPrefix: 'Delivery Status Notification (Failure) - ',
    body: `Address not found.\n\nYour message wasn't delivered because the address couldn't be found, or is unable to receive mail.\n\nThe response was:\n550 5.1.1 The email account that you tried to reach does not exist.`,
  },
];

interface SimThread {
  gmailThreadId: string;
  subject: string;
  participants: string[];
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  archived: boolean;
  labels: string[];
  /** Set once a synthetic inbound reply has been produced for this thread. */
  replied: boolean;
  replyDueAt: number | null;
  messages: FetchedMessage[];
}

interface SimStore {
  threads: Record<string, SimThread>;
}

function pickWeighted(items: SimReply[]): SimReply {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[0];
}

export class SimulationGmailService implements MailboxDriver {
  private store: SimStore = { threads: {} };
  private connected = false;
  private currentThreadId: string | null = null;
  private draft: Partial<ComposeRequest> = {};

  constructor(
    readonly identity: MailboxIdentity,
    private readonly events: DriverEvents = {},
  ) {
    this.load();
  }

  // ------------------------------------------------------------ persistence

  private get file() {
    return path.join(env.sessionDir, `simulation-${this.identity.accountId}.json`);
  }

  private load() {
    try {
      if (fs.existsSync(this.file)) {
        this.store = JSON.parse(fs.readFileSync(this.file, 'utf8')) as SimStore;
        for (const thread of Object.values(this.store.threads)) {
          for (const message of thread.messages) {
            message.receivedAt = new Date(message.receivedAt);
          }
        }
      }
    } catch {
      this.store = { threads: {} };
    }
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.store), 'utf8');
  }

  private report(action: string, detail?: string) {
    this.events.onAction?.(action, detail);
  }

  /** Small, variable pause so progress in the UI looks like real work. */
  private async pause(min = 120, max = 320) {
    await sleep(randomBetween(min, max));
  }

  // -------------------------------------------------------------- lifecycle

  async connect(): Promise<ConnectionInfo> {
    this.report('connect', this.identity.email);
    await this.pause(300, 700);
    this.connected = true;
    log.info(`simulated mailbox connected: ${this.identity.email}`);
    return { connected: true, email: this.identity.email, detail: 'simulation driver' };
  }

  async checkSession(): Promise<ConnectionInfo> {
    return { connected: this.connected, email: this.connected ? this.identity.email : null };
  }

  async openInbox(): Promise<void> {
    this.report('openInbox');
    await this.pause();
  }

  async logout(): Promise<void> {
    this.connected = false;
  }

  async close(): Promise<void> {
    this.save();
    this.connected = false;
  }

  // ---------------------------------------------------------------- compose

  async openCompose(): Promise<void> {
    this.report('openCompose');
    this.draft = {};
    await this.pause();
  }

  async fillRecipient(to: string, cc: string[] = [], bcc: string[] = []): Promise<void> {
    this.report('fillRecipient', to);
    this.draft.to = to;
    this.draft.cc = cc;
    this.draft.bcc = bcc;
    await this.pause();
  }

  async fillSubject(subject: string): Promise<void> {
    this.report('fillSubject', truncate(subject, 60));
    this.draft.subject = subject;
    await this.pause();
  }

  async fillBody(bodyHtml: string): Promise<void> {
    this.report('fillBody');
    this.draft.bodyHtml = bodyHtml;
    await this.pause();
  }

  async attachFile(attachment: AttachmentRef): Promise<void> {
    this.report('attachFile', attachment.filename);
    this.draft.attachments = [...(this.draft.attachments ?? []), attachment];
    await this.pause();
  }

  private newThread(request: ComposeRequest, isDraft: boolean): SendResult {
    const gmailThreadId = synthesizeId('thread');
    const message = this.outboundMessage(request.subject, request.bodyHtml, request.to, request.cc ?? [], request.attachments ?? []);

    // Roughly one in three prospects answers, after a short realistic lag.
    const willReply = Math.random() < 0.34;

    this.store.threads[gmailThreadId] = {
      gmailThreadId,
      subject: request.subject,
      participants: [this.identity.email, request.to],
      isRead: true,
      isStarred: false,
      isImportant: false,
      archived: false,
      labels: isDraft ? ['DRAFT'] : ['SENT'],
      replied: false,
      replyDueAt: willReply && !isDraft ? Date.now() + randomBetween(20, 240) * 1000 : null,
      messages: [message],
    };
    this.save();
    this.currentThreadId = gmailThreadId;

    return {
      gmailThreadId,
      gmailMessageId: message.gmailMessageId,
      rfcMessageId: message.rfcMessageId!,
      sentAt: message.receivedAt,
      isDraft,
    };
  }

  private outboundMessage(
    subject: string,
    bodyHtml: string,
    to: string,
    cc: string[],
    attachments: AttachmentRef[],
  ): FetchedMessage {
    return {
      gmailMessageId: synthesizeId('msg'),
      rfcMessageId: synthesizeRfcId(this.identity.email),
      inReplyTo: null,
      sender: this.identity.email,
      senderName: this.identity.displayName,
      recipients: [to],
      cc,
      subject,
      bodyHtml,
      bodyText: htmlToText(bodyHtml),
      snippet: truncate(htmlToText(bodyHtml), 160),
      direction: 'OUTBOUND',
      receivedAt: new Date(),
      isRead: true,
      attachments: attachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType ?? 'application/octet-stream',
        size: a.size ?? 0,
      })),
    };
  }

  async saveDraft(request: ComposeRequest): Promise<SendResult> {
    await this.openCompose();
    await this.fillRecipient(request.to, request.cc, request.bcc);
    await this.fillSubject(request.subject);
    await this.fillBody(request.bodyHtml);
    for (const a of request.attachments ?? []) await this.attachFile(a);
    this.report('saveDraft', request.to);
    await this.pause(200, 400);
    return this.newThread(request, true);
  }

  async sendMessage(request: ComposeRequest): Promise<SendResult> {
    await this.openCompose();
    await this.fillRecipient(request.to, request.cc, request.bcc);
    await this.fillSubject(request.subject);
    await this.fillBody(request.bodyHtml);
    for (const a of request.attachments ?? []) await this.attachFile(a);
    this.report('sendMessage', request.to);
    await this.pause(250, 500);
    return this.newThread(request, false);
  }

  // -------------------------------------------------------------- threading

  async searchConversation(gmailThreadId: string): Promise<boolean> {
    this.report('searchConversation', gmailThreadId);
    await this.pause();
    return Boolean(this.store.threads[gmailThreadId]);
  }

  async openConversation(gmailThreadId: string): Promise<boolean> {
    this.report('openConversation', gmailThreadId);
    await this.pause();
    const exists = Boolean(this.store.threads[gmailThreadId]);
    if (exists) this.currentThreadId = gmailThreadId;
    return exists;
  }

  async getThreadId(): Promise<string | null> {
    return this.currentThreadId;
  }

  async replyToConversation(request: ReplyRequest, mode: 'DRAFT' | 'SEND'): Promise<SendResult> {
    const thread = this.store.threads[request.gmailThreadId];
    if (!thread) {
      // Behaves exactly like the real driver: an orphaned thread is a hard,
      // non-retryable failure so the sequence can fall back to a new email.
      const { AutomationError } = await import('./errors.js');
      throw new AutomationError('THREAD_NOT_FOUND', `thread ${request.gmailThreadId} not found`, { retryable: false });
    }
    this.report('replyToConversation', request.gmailThreadId);
    await this.pause(250, 550);

    const recipient = thread.participants.find((p) => p !== this.identity.email) ?? '';
    const message = this.outboundMessage(request.subject, request.bodyHtml, recipient, [], request.attachments ?? []);
    message.inReplyTo = request.inReplyTo ?? null;
    thread.messages.push(message);
    thread.isRead = true;

    if (mode === 'SEND' && !thread.replied && thread.replyDueAt === null && Math.random() < 0.28) {
      thread.replyDueAt = Date.now() + randomBetween(20, 200) * 1000;
    }
    this.save();

    return {
      gmailThreadId: thread.gmailThreadId,
      gmailMessageId: message.gmailMessageId,
      rfcMessageId: message.rfcMessageId!,
      sentAt: message.receivedAt,
      isDraft: mode === 'DRAFT',
    };
  }

  // ---------------------------------------------------------------- reading

  /** Materialises any inbound replies whose simulated arrival time has passed. */
  private maturePendingReplies(): number {
    let created = 0;
    const now = Date.now();
    for (const thread of Object.values(this.store.threads)) {
      if (thread.replied || !thread.replyDueAt || thread.replyDueAt > now) continue;

      const template = pickWeighted(REPLY_LIBRARY);
      const counterparty = thread.participants.find((p) => p !== this.identity.email) ?? 'prospect@example.com';
      const sender = template.fromMailer ? 'mailer-daemon@googlemail.com' : counterparty;
      const nameSource = counterparty.split('@')[0].replace(/[._-]+/g, ' ');
      const bodyHtml = `<div>${template.body.replace(/\n/g, '<br>')}</div>`;

      thread.messages.push({
        gmailMessageId: synthesizeId('msg'),
        rfcMessageId: synthesizeRfcId(sender),
        inReplyTo: thread.messages[thread.messages.length - 1]?.rfcMessageId ?? null,
        sender,
        senderName: template.fromMailer
          ? 'Mail Delivery Subsystem'
          : nameSource.replace(/\b\w/g, (c) => c.toUpperCase()),
        recipients: [this.identity.email],
        cc: [],
        subject: `${template.subjectPrefix ?? 'Re: '}${thread.subject.replace(/^re:\s*/i, '')}`,
        bodyHtml,
        bodyText: template.body,
        snippet: truncate(template.body, 160),
        direction: 'INBOUND',
        receivedAt: new Date(thread.replyDueAt),
        isRead: false,
        attachments: [],
      });

      thread.replied = true;
      thread.replyDueAt = null;
      thread.isRead = false;
      thread.isImportant = ['ASKING_PRICING', 'MEETING_REQUEST', 'INTERESTED'].includes(template.intent);
      created += 1;
    }
    if (created) this.save();
    return created;
  }

  private toFetched(thread: SimThread): FetchedThread {
    const last = thread.messages[thread.messages.length - 1];
    return {
      gmailThreadId: thread.gmailThreadId,
      subject: thread.subject,
      participants: thread.participants,
      snippet: last?.snippet ?? '',
      lastMessageAt: new Date(last?.receivedAt ?? Date.now()),
      isRead: thread.isRead,
      isStarred: thread.isStarred,
      isImportant: thread.isImportant,
      labels: thread.labels,
      messages: thread.messages.map((m) => ({ ...m, receivedAt: new Date(m.receivedAt) })),
    };
  }

  async fetchThreads(options: SyncOptions = {}): Promise<FetchedThread[]> {
    this.report('fetchThreads');
    const created = this.maturePendingReplies();
    if (created) log.debug(`simulated ${created} inbound reply(ies) for ${this.identity.email}`);
    await this.pause(200, 500);

    const since = options.since?.getTime() ?? 0;
    return Object.values(this.store.threads)
      .filter((t) => !t.archived)
      .map((t) => this.toFetched(t))
      .filter((t) => t.lastMessageAt.getTime() >= since)
      .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
      .slice(0, options.limit ?? 50);
  }

  async fetchThreadSummaries(options: SyncOptions = {}): Promise<ThreadSummary[]> {
    const threads = await this.fetchThreads(options);
    return threads.map((thread) => {
      const last = thread.messages[thread.messages.length - 1];
      return {
        gmailThreadId: thread.gmailThreadId,
        sender: last?.sender ?? '',
        senderName: last?.senderName ?? null,
        subject: thread.subject,
        snippet: thread.snippet ?? last?.snippet ?? '',
      };
    });
  }

  async fetchThread(gmailThreadId: string): Promise<FetchedThread | null> {
    this.maturePendingReplies();
    const thread = this.store.threads[gmailThreadId];
    return thread ? this.toFetched(thread) : null;
  }

  async getLatestMessage(gmailThreadId: string): Promise<FetchedMessage | null> {
    const thread = await this.fetchThread(gmailThreadId);
    if (!thread?.messages.length) return null;
    return thread.messages[thread.messages.length - 1];
  }

  async detectBounce(gmailThreadId: string): Promise<BounceInfo> {
    const thread = await this.fetchThread(gmailThreadId);
    const none: BounceInfo = { isBounce: false, type: 'SOFT', reason: '', recipient: null };
    if (!thread) return none;
    return detectBounceFromThread(thread) ?? none;
  }

  // ---------------------------------------------------------------- actions

  private mutate(gmailThreadId: string, fn: (t: SimThread) => void) {
    const thread = this.store.threads[gmailThreadId];
    if (!thread) return;
    fn(thread);
    this.save();
  }

  async openConversationBySearch(query: string): Promise<boolean> {
    const subject = /subject:"([^"]+)"/i.exec(query)?.[1]?.toLowerCase();
    if (!subject) return false;
    return Object.values(this.store.threads).some((t) => t.subject.toLowerCase().includes(subject));
  }

  async applyLabel(query: string, label: string): Promise<number> {
    this.report('applyLabel', `${label} <- ${query}`);
    // The simulation understands the one operator the send path actually uses.
    const subject = /subject:"([^"]+)"/i.exec(query)?.[1]?.toLowerCase();
    const recipient = /to:(\S+)/i.exec(query)?.[1]?.toLowerCase();

    let labelled = 0;
    for (const thread of Object.values(this.store.threads)) {
      if (subject && !thread.subject.toLowerCase().includes(subject)) continue;
      if (recipient && !thread.participants.some((p) => p.toLowerCase() === recipient)) continue;
      if (!thread.labels.includes(label)) thread.labels.push(label);
      labelled += 1;
    }
    return labelled;
  }

  async markAsRead(gmailThreadId: string) {
    this.report('markAsRead', gmailThreadId);
    this.mutate(gmailThreadId, (t) => {
      t.isRead = true;
      t.messages.forEach((m) => (m.isRead = true));
    });
  }

  async markAsUnread(gmailThreadId: string) {
    this.report('markAsUnread', gmailThreadId);
    this.mutate(gmailThreadId, (t) => (t.isRead = false));
  }

  async starThread(gmailThreadId: string, starred: boolean) {
    this.report('starThread', gmailThreadId);
    this.mutate(gmailThreadId, (t) => (t.isStarred = starred));
  }

  async archiveThread(gmailThreadId: string) {
    this.report('archiveThread', gmailThreadId);
    this.mutate(gmailThreadId, (t) => (t.archived = true));
  }

  /** Test hook: forces an inbound reply on a thread immediately. */
  forceReply(gmailThreadId: string) {
    this.mutate(gmailThreadId, (t) => {
      t.replied = false;
      t.replyDueAt = Date.now() - 1;
    });
    this.maturePendingReplies();
  }
}
