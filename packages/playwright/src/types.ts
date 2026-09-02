import type { AutomationErrorCode, Direction } from '@mail/shared';

export interface MailboxIdentity {
  accountId: string;
  email: string;
  displayName: string;
}

export interface AttachmentRef {
  filename: string;
  path: string;
  mimeType?: string;
  size?: number;
}

export interface ComposeRequest {
  to: string;
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml: string;
  attachments?: AttachmentRef[];
}

export interface ReplyRequest {
  /** Recipient, so the thread can be found by search when its id will not resolve. */
  to?: string;
  gmailThreadId: string;
  /** RFC 822 Message-ID of the message being replied to, when known. */
  inReplyTo?: string | null;
  subject: string;
  bodyHtml: string;
  attachments?: AttachmentRef[];
}

export interface SendResult {
  gmailThreadId: string;
  gmailMessageId: string;
  rfcMessageId: string;
  sentAt: Date;
  isDraft: boolean;
  /**
   * Set when the driver found this exact message already in the sent folder
   * and returned it instead of composing a second copy. The send is a success
   * from the campaign's point of view; nothing new left the mailbox.
   */
  alreadySent?: boolean;
}

export interface FetchedMessage {
  gmailMessageId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  sender: string;
  senderName: string | null;
  recipients: string[];
  cc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  snippet: string;
  direction: Direction;
  receivedAt: Date;
  isRead: boolean;
  attachments: Array<{ filename: string; mimeType: string; size: number; gmailAttachmentId?: string }>;
}

export interface FetchedThread {
  gmailThreadId: string;
  subject: string;
  participants: string[];
  snippet: string;
  lastMessageAt: Date;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  labels: string[];
  messages: FetchedMessage[];
}

export interface BounceInfo {
  isBounce: boolean;
  type: 'HARD' | 'SOFT';
  reason: string;
  recipient: string | null;
}

export interface ConnectionInfo {
  connected: boolean;
  email: string | null;
  detail?: string;
}

/**
 * One row of a Gmail result list, read without opening the conversation.
 *
 * Enough to recognise a delivery report and usually enough to name the address
 * that failed - Gmail's own snippet starts "Your message wasn't delivered to
 * ...". Opening every report instead took minutes and timed out; this is what
 * makes a bounce scan cheap enough to run before every follow-up batch.
 */
export interface ThreadSummary {
  gmailThreadId: string;
  sender: string;
  senderName: string | null;
  subject: string;
  snippet: string;
}

export interface SyncOptions {
  /** Only fetch threads newer than this - the basis of incremental sync. */
  since?: Date | null;
  limit?: number;
  query?: string;
}

/**
 * The contract every mailbox driver implements. `GmailAutomationService`
 * fulfils it with a real Chromium; `SimulationGmailService` fulfils it in
 * memory so the full campaign/inbox/AI pipeline is exercisable without a live
 * mailbox or credentials.
 */
export interface MailboxDriver {
  readonly identity: MailboxIdentity;
  connect(): Promise<ConnectionInfo>;
  checkSession(): Promise<ConnectionInfo>;
  openInbox(): Promise<void>;
  openCompose(): Promise<void>;
  fillRecipient(to: string, cc?: string[], bcc?: string[]): Promise<void>;
  fillSubject(subject: string): Promise<void>;
  fillBody(bodyHtml: string): Promise<void>;
  attachFile(attachment: AttachmentRef): Promise<void>;
  saveDraft(request: ComposeRequest): Promise<SendResult>;
  sendMessage(request: ComposeRequest): Promise<SendResult>;
  searchConversation(gmailThreadId: string): Promise<boolean>;
  openConversation(gmailThreadId: string): Promise<boolean>;
  /** Opens a conversation found by a Gmail search, independent of id format. */
  openConversationBySearch(query: string): Promise<boolean>;
  replyToConversation(request: ReplyRequest, mode: 'DRAFT' | 'SEND'): Promise<SendResult>;
  getLatestMessage(gmailThreadId: string): Promise<FetchedMessage | null>;
  getThreadId(): Promise<string | null>;
  detectBounce(gmailThreadId: string): Promise<BounceInfo>;
  fetchThreads(options?: SyncOptions): Promise<FetchedThread[]>;
  /** Result rows for a search, without opening any conversation. */
  fetchThreadSummaries(options?: SyncOptions): Promise<ThreadSummary[]>;
  fetchThread(gmailThreadId: string): Promise<FetchedThread | null>;
  /**
   * Files everything matching a Gmail search under a label, creating the label
   * if needed. Returns how many conversations were selected.
   *
   * Gmail applies a label to the whole conversation, so every later reply -
   * and any delivery report Gmail threads into it - inherits the label. One
   * `label:` search then returns a campaign's outbound mail and everything
   * that came back.
   */
  applyLabel(query: string, label: string): Promise<number>;
  markAsRead(gmailThreadId: string): Promise<void>;
  markAsUnread(gmailThreadId: string): Promise<void>;
  starThread(gmailThreadId: string, starred: boolean): Promise<void>;
  archiveThread(gmailThreadId: string): Promise<void>;
  logout(): Promise<void>;
  close(): Promise<void>;
}

export interface DriverEvents {
  onAction?: (action: string, detail?: string) => void;
  onError?: (code: AutomationErrorCode, message: string, screenshotPath?: string) => void;
}
