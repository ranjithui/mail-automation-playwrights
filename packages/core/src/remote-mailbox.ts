/**
 * A mailbox driven by an agent on somebody else's machine.
 *
 * This implements the same `MailboxDriver` interface as the in-process
 * Chromium driver, so nothing that sends mail knows the difference: a
 * processor calls `driver.sendMessage(request)` and receives a `SendResult`,
 * and whether that happened in this process or on a laptop in another country
 * is decided in one place - `acquireMailbox` - and nowhere else.
 *
 * Each call becomes an `AgentTask` row naming the interface method and its
 * arguments. The agent that owns the mailbox leases the row, runs it against a
 * real browser, and writes the answer back; this side waits for that row to
 * reach a terminal state. The operation set is therefore data rather than
 * protocol: adding a method to the driver needs no new endpoint.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { createLogger } from '@mail/config';
import { prisma } from '@mail/database';
import { AutomationError } from '@mail/playwright';
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
} from '@mail/playwright';

const log = createLogger('remote-mailbox');

/** How often this side looks to see whether the agent has answered. */
const POLL_INTERVAL_MS = 750;

/**
 * Budget for one operation, from row creation to a terminal state.
 *
 * It has to stay comfortably under JOB_TIMEOUT_MS (eight minutes by default),
 * or a laptop that goes to sleep mid-send would hold its job until the queue's
 * own watchdog fires - and the job would then be retried without anybody
 * knowing whether the first attempt had already put mail in the world.
 */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Signing in is the one operation that waits on a person: a window opens on
 * their screen and somebody types a password and passes 2FA. Fifteen minutes
 * is generous; the alternative is failing an enrolment because someone went to
 * find their phone.
 */
const TIMEOUT_BY_OP: Record<string, number> = {
  connect: 15 * 60_000,
  fetchThreads: 8 * 60_000,
  logout: 60_000,
  close: 30_000,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Values that were Date objects before JSON flattened them.
 *
 * Revived by name rather than by sniffing every string for something
 * date-shaped, which would rewrite a subject line that happens to read like a
 * timestamp.
 */
const DATE_KEYS = new Set(['sentAt', 'receivedAt', 'lastMessageAt', 'createdAt', 'completedAt']);

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = DATE_KEYS.has(key) && typeof item === 'string' ? new Date(item) : revive(item);
    }
    return out;
  }
  return value;
}

/**
 * Rewrites attachments so they can be fetched rather than opened.
 *
 * On this side an attachment is an absolute path into the storage directory.
 * The agent has no such directory and no business having one, so what travels
 * is the opaque stored filename; the agent downloads it back through
 * `GET /api/agent/files/:name`, authorised as itself.
 */
function portableAttachments(attachments: AttachmentRef[] | undefined) {
  return (attachments ?? []).map((a) => ({
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    fileId: path.basename(a.path),
  }));
}

export class RemoteMailboxDriver implements MailboxDriver {
  constructor(
    readonly identity: MailboxIdentity,
    private readonly deviceId: string,
    private readonly events: DriverEvents = {},
  ) {}

  /**
   * Runs one operation on the agent and returns its result.
   *
   * Every public method below is a one-line call into here. The waiting is a
   * poll rather than a socket on purpose: the row is the contract, so an agent
   * that reconnects, or a server that restarts mid-operation, both recover by
   * looking at the same place.
   */
  private async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    const timeoutMs = TIMEOUT_BY_OP[op] ?? DEFAULT_TIMEOUT_MS;

    const task = await prisma.agentTask.create({
      data: {
        deviceId: this.deviceId,
        emailAccountId: this.identity.accountId,
        op,
        argsJson: JSON.stringify(args),
      },
      select: { id: true },
    });

    this.events.onAction?.(op, `sent to agent`);
    log.debug(`${this.identity.email} ${op} -> task ${task.id}`);

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      const row = await prisma.agentTask.findUnique({
        where: { id: task.id },
        select: { status: true, resultJson: true, error: true, errorCode: true, screenshotId: true },
      });

      // The row is gone - the device was deleted mid-operation. Nothing will
      // ever answer, so stop waiting rather than burn the whole budget.
      if (!row) {
        throw new AutomationError('UNKNOWN_ERROR', `${op}: the device was removed while it was working`, {
          retryable: false,
        });
      }

      if (row.status === 'DONE') {
        return revive(JSON.parse(row.resultJson ?? 'null')) as T;
      }

      if (row.status === 'FAILED') {
        const code = (row.errorCode ?? 'UNKNOWN_ERROR') as ConstructorParameters<typeof AutomationError>[0];
        this.events.onError?.(code, `${op}: ${row.error ?? 'failed'}`, row.screenshotId ?? undefined);
        throw new AutomationError(code, `${op}: ${row.error ?? 'the agent reported a failure'}`);
      }
    }

    // Timed out. Closing the row matters as much as throwing: an agent that
    // wakes up late must not run an operation whose caller has already given
    // up and, for a send, possibly already retried.
    await prisma.agentTask
      .updateMany({
        where: { id: task.id, status: { in: ['PENDING', 'LEASED'] } },
        data: {
          status: 'FAILED',
          errorCode: 'TIMEOUT',
          error: `no answer from the agent within ${Math.round(timeoutMs / 1000)}s`,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);

    throw new AutomationError(
      'TIMEOUT',
      `${op}: the agent for ${this.identity.email} did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
        'Check that it is running and signed in.',
      { retryable: true },
    );
  }

  // ------------------------------------------------------------- lifecycle

  connect(): Promise<ConnectionInfo> {
    return this.call<ConnectionInfo>('connect');
  }

  checkSession(): Promise<ConnectionInfo> {
    return this.call<ConnectionInfo>('checkSession');
  }

  logout(): Promise<void> {
    return this.call<void>('logout');
  }

  /**
   * Best effort by design. Releasing a browser this process does not own must
   * never be the thing that fails a job, and an agent that has gone away has
   * already released it by dying.
   */
  async close(): Promise<void> {
    await this.call<void>('close').catch((error) => {
      log.debug(`close for ${this.identity.email} went unanswered: ${String(error)}`);
    });
  }

  // ------------------------------------------------------------- composing

  openInbox(): Promise<void> {
    return this.call<void>('openInbox');
  }

  openCompose(): Promise<void> {
    return this.call<void>('openCompose');
  }

  fillRecipient(to: string, cc?: string[], bcc?: string[]): Promise<void> {
    return this.call<void>('fillRecipient', { to, cc, bcc });
  }

  fillSubject(subject: string): Promise<void> {
    return this.call<void>('fillSubject', { subject });
  }

  fillBody(bodyHtml: string): Promise<void> {
    return this.call<void>('fillBody', { bodyHtml });
  }

  attachFile(attachment: AttachmentRef): Promise<void> {
    return this.call<void>('attachFile', { attachment: portableAttachments([attachment])[0] });
  }

  saveDraft(request: ComposeRequest): Promise<SendResult> {
    return this.call<SendResult>('saveDraft', {
      ...request,
      attachments: portableAttachments(request.attachments),
    });
  }

  sendMessage(request: ComposeRequest): Promise<SendResult> {
    return this.call<SendResult>('sendMessage', {
      ...request,
      attachments: portableAttachments(request.attachments),
    });
  }

  replyToConversation(request: ReplyRequest, mode: 'DRAFT' | 'SEND'): Promise<SendResult> {
    return this.call<SendResult>('replyToConversation', {
      request: { ...request, attachments: portableAttachments(request.attachments) },
      mode,
    });
  }

  // --------------------------------------------------------------- reading

  searchConversation(gmailThreadId: string): Promise<boolean> {
    return this.call<boolean>('searchConversation', { gmailThreadId });
  }

  openConversation(gmailThreadId: string): Promise<boolean> {
    return this.call<boolean>('openConversation', { gmailThreadId });
  }

  openConversationBySearch(query: string): Promise<boolean> {
    return this.call<boolean>('openConversationBySearch', { query });
  }

  getLatestMessage(gmailThreadId: string): Promise<FetchedMessage | null> {
    return this.call<FetchedMessage | null>('getLatestMessage', { gmailThreadId });
  }

  getThreadId(): Promise<string | null> {
    return this.call<string | null>('getThreadId');
  }

  detectBounce(gmailThreadId: string): Promise<BounceInfo> {
    return this.call<BounceInfo>('detectBounce', { gmailThreadId });
  }

  fetchThreads(options?: SyncOptions): Promise<FetchedThread[]> {
    return this.call<FetchedThread[]>('fetchThreads', { options });
  }

  fetchThreadSummaries(options?: SyncOptions): Promise<ThreadSummary[]> {
    return this.call<ThreadSummary[]>('fetchThreadSummaries', { options });
  }

  fetchThread(gmailThreadId: string): Promise<FetchedThread | null> {
    return this.call<FetchedThread | null>('fetchThread', { gmailThreadId });
  }

  // -------------------------------------------------------------- labelling

  applyLabel(query: string, label: string): Promise<number> {
    return this.call<number>('applyLabel', { query, label });
  }

  markAsRead(gmailThreadId: string): Promise<void> {
    return this.call<void>('markAsRead', { gmailThreadId });
  }

  markAsUnread(gmailThreadId: string): Promise<void> {
    return this.call<void>('markAsUnread', { gmailThreadId });
  }

  starThread(gmailThreadId: string, starred: boolean): Promise<void> {
    return this.call<void>('starThread', { gmailThreadId, starred });
  }

  archiveThread(gmailThreadId: string): Promise<void> {
    return this.call<void>('archiveThread', { gmailThreadId });
  }
}

// ---------------------------------------------------------------- enrolment

/** A pairing code short enough to read aloud, without the ambiguous glyphs. */
export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}`;
}

/** The bearer token an agent presents, and the hash that is kept instead. */
export function generateDeviceToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashDeviceToken(token) };
}

export function hashDeviceToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
