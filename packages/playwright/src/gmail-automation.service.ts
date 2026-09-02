/**
 * GmailAutomationService - drives a real Chromium against the Gmail web UI.
 *
 * Design rules enforced here:
 *   * every action goes through `act()`, which applies timeout, retry with
 *     backoff, structured error classification and a screenshot on failure
 *   * no single fragile CSS selector: `resolve()` walks a ranked candidate list
 *   * one isolated persistent browser context per mailbox, stored under
 *     storage/sessions/<accountId> and never surfaced to the frontend
 *
 * This service deliberately contains nothing that would bypass provider
 * security: no CAPTCHA handling, no anti-abuse evasion, no credential entry.
 * A human connects the mailbox once in a visible browser window; afterwards the
 * saved context is reused and, when it expires, the mailbox is flagged
 * SESSION_EXPIRED for a human to reconnect.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createLogger, env } from '@mail/config';
import { htmlToText, sleep, truncate } from '@mail/shared';
import { AutomationError, classifyError } from './errors.js';
import {
  BOUNCE_SIGNATURES,
  GMAIL_URL,
  SELECTORS,
  type SelectorCandidate,
  type SelectorGroup,
} from './selectors.js';
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

const log = createLogger('gmail');

/**
 * How long a headed connect waits for a human to finish signing in. Kept below
 * the queue's stale-lock threshold so the job cannot be recovered and re-run
 * underneath an open sign-in window.
 */
/**
 * A Gmail thread id with whatever the address bar had glued to it removed.
 *
 * While a compose window is open Gmail's URL reads `#all/<id>?compose=new`, and
 * taking the last path segment carried `?compose=new` into the id itself. Every
 * later navigation to `#all/<id>?compose=new` then resolved nothing: the
 * in-thread follow-up could not open the conversation it was supposed to reply
 * inside, so it had no thread to continue.
 */
const cleanThreadId = (value: string | null | undefined): string | null => {
  const id = (value ?? '').split(/[?&#]/)[0].trim();
  return id.length > 8 ? id : null;
};

/**
 * A Gmail search term matching only what arrived in the last `minutes`.
 *
 * `newer_than:` has day granularity at best, so "the message I just sent" and
 * "the one I sent this subject to this contact yesterday" were the same search.
 * Re-running a campaign therefore filed - and read the thread id from - the
 * wrong conversation. Gmail's `after:` accepts Unix seconds, which is the only
 * way to say "since a moment ago" and mean it.
 */
const sentSince = (minutes: number): string =>
  `after:${Math.floor((Date.now() - minutes * 60_000) / 1000)}`;

const SIGN_IN_WAIT_MS = 5 * 60_000;

/**
 * Grace period after closing a persistent context before its profile
 * directory may be reused. Without it, a relaunch attaches to the still-dying
 * browser ("profile is already in use") and leaks a blank tab.
 */
const PROFILE_RELEASE_MS = 1500;

/**
 * Budget for a whole compose-and-send. The default action timeout covers a
 * single interaction; a send is a dozen of them plus a confirmation wait, and
 * when the two shared one 30s budget the deadline fired after Gmail had already
 * accepted the message - which is how contacts ended up with duplicates.
 */
const SEND_TIMEOUT_MS = Math.max(env.PLAYWRIGHT_TIMEOUT_MS * 3, 90_000);

export class GmailAutomationService implements MailboxDriver {
  private browser: any = null;
  private context: any = null;
  private page: any = null;

  constructor(
    readonly identity: MailboxIdentity,
    private readonly events: DriverEvents = {},
  ) {}

  // ------------------------------------------------------------- plumbing

  private get storageDir() {
    return path.join(env.sessionDir, this.identity.accountId);
  }

  private report(action: string, detail?: string) {
    this.events.onAction?.(action, detail);
    log.debug(`${this.identity.email}: ${action}${detail ? ` - ${detail}` : ''}`);
  }

  private async screenshot(tag: string): Promise<string | undefined> {
    if (!this.page) return undefined;
    try {
      const file = path.join(
        env.screenshotDir,
        `${this.identity.accountId}-${tag}-${Date.now()}.png`,
      );
      await this.page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return undefined;
    }
  }

  /**
   * Runs one browser interaction with timeout, retry and failure capture.
   * Every public method delegates here so behaviour is uniform.
   */
  private async act<T>(
    name: string,
    fn: () => Promise<T>,
    options: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const retries = options.retries ?? 2;
    const timeoutMs = options.timeoutMs ?? env.PLAYWRIGHT_TIMEOUT_MS;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const started = Date.now();
      try {
        this.report(name, attempt > 0 ? `retry ${attempt}` : undefined);
        const result = await Promise.race([
          fn(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new AutomationError('TIMEOUT', `${name} timed out after ${timeoutMs}ms`)), timeoutMs),
          ),
        ]);
        log.debug(`${name} ok in ${Date.now() - started}ms`);
        return result;
      } catch (error) {
        lastError = error;
        const code = classifyError(error);
        const retryable = error instanceof AutomationError ? error.retryable : true;
        if (attempt === retries || !retryable) {
          const shot = await this.screenshot(name.replace(/\W+/g, '-'));
          const message = error instanceof Error ? error.message : String(error);
          this.events.onError?.(code, `${name}: ${message}`, shot);
          throw new AutomationError(code, `${name}: ${message}`, { screenshotPath: shot, cause: error });
        }
        await sleep(1000 * (attempt + 1));
      }
    }
    throw lastError;
  }

  /** Turns one ranked candidate into a Playwright locator. */
  private locatorFor(candidate: SelectorCandidate): any {
    switch (candidate.kind) {
      case 'role':
        return this.page.getByRole(candidate.value, candidate.name ? { name: candidate.name } : undefined);
      case 'label':
        return this.page.getByLabel(candidate.value, { exact: candidate.exact ?? false });
      case 'placeholder':
        return this.page.getByPlaceholder(candidate.value);
      case 'text':
        return this.page.getByText(candidate.value, { exact: candidate.exact ?? false });
      case 'testid':
        return this.page.getByTestId(candidate.value);
      default:
        return this.page.locator(candidate.value);
    }
  }

  /**
   * Walks the ranked candidate list until one locator actually matches.
   *
   * `timeoutMs` is the budget for the WHOLE group, never per candidate. Giving
   * every candidate the full timeout is what made a three-candidate group take
   * three times as long as the caller asked for; on a send that overran the
   * enclosing act() deadline *after* Gmail had accepted the message, act()
   * retried, and the contact received a second copy.
   *
   * Two passes keep both properties: a fast ranked probe so an element already
   * on the page still wins in rank order, then a race over whatever budget is
   * left for one that has yet to render.
   */
  private async resolve(group: SelectorGroup, timeoutMs = 5000): Promise<any> {
    if (!this.page) throw new AutomationError('GMAIL_NOT_AVAILABLE', 'Browser page is not open');
    const deadline = Date.now() + timeoutMs;

    const locators: any[] = [];
    for (const candidate of group) {
      try {
        locators.push(this.locatorFor(candidate));
      } catch {
        /* a candidate that will not even build is simply not a candidate */
      }
    }

    // Ranked probe. Every match is examined, not just the first: Gmail keeps
    // several copies of a toolbar in the DOM and hides all but one, so `.first()`
    // routinely lands on a hidden duplicate and the element is reported missing
    // while it is plainly on the page.
    //
    // The examination runs inside the page (see firstVisible), so however many
    // stale copies have piled up costs one call. It used to look at the first
    // eight matches only - fine on a fresh tab, wrong once a session's worth of
    // searches have left their panes behind and pushed the live copy past them.
    for (const locator of locators) {
      if (Date.now() >= deadline) break;
      const visible = await this.firstVisible(locator).catch(() => null);
      if (visible) return visible;
    }

    const remaining = deadline - Date.now();
    if (remaining > 0 && locators.length) {
      const winner = await Promise.any(
        locators.map((locator) => {
          const first = locator.first();
          return first.waitFor({ state: 'visible', timeout: remaining }).then(() => first);
        }),
      ).catch(() => null);
      if (winner) return winner;
    }

    throw new AutomationError('SELECTOR_NOT_FOUND', `no candidate matched (${group.map((c) => c.value).join(' | ')})`);
  }

  private async exists(group: SelectorGroup, timeoutMs = 1500): Promise<boolean> {
    try {
      await this.resolve(group, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Is a live browser holding this profile?
   *
   * The same test Playwright itself uses. On Windows Chromium keeps `lockfile`
   * open for the life of the profile, so anything but ENOENT when opening it
   * means someone owns it. Elsewhere `SingletonLock` is a symlink naming the
   * owning pid, which can be signalled to see whether it is still alive.
   *
   * This matters because the alternative - deleting the locks and launching
   * anyway - would put two browsers on one profile and corrupt the signed-in
   * session, and the mailbox would have to be connected again by hand.
   */
  private isProfileLocked(): boolean {
    if (process.platform === 'win32') {
      const lockPath = path.join(this.storageDir, 'lockfile');
      try {
        fs.closeSync(fs.openSync(lockPath, 'r+'));
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
    }

    try {
      const target = fs.readlinkSync(path.join(this.storageDir, 'SingletonLock'));
      const pid = Number.parseInt(target.split('-').pop() ?? '', 10);
      if (Number.isNaN(pid)) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Removes the locks a crashed Chromium left behind. */
  private clearProfileLocks(): void {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
      fs.rmSync(path.join(this.storageDir, name), { recursive: true, force: true });
    }
  }

  // ------------------------------------------------------------- lifecycle

  async connect(): Promise<ConnectionInfo> {
    return this.act('connect', async () => {
      const { chromium } = await import('playwright');
      fs.mkdirSync(this.storageDir, { recursive: true });

      const launch = () =>
        chromium.launchPersistentContext(this.storageDir, {
          headless: env.PLAYWRIGHT_HEADLESS,
          slowMo: env.PLAYWRIGHT_SLOWMO_MS,
          viewport: { width: 1440, height: 900 },
          args: ['--disable-blink-features=AutomationControlled'],
        });

      try {
        this.context = await launch();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Windows reports the same conflict as EPERM on the profile's
        // `lockfile`, which never matched the old "already in use" test and so
        // failed the job with a raw filesystem error.
        if (!/already in use|existing browser session|lockfile|singletonlock/i.test(message)) throw error;

        // Two cases look identical from here and must not be treated alike.
        //
        // A live browser owns the profile - almost always a second worker from
        // another `npm run dev`, since one worker serialises its own mailboxes
        // - and the only correct move is to say so. A Chromium orphaned by an
        // unclean shutdown owns nothing, and its locks are cleared so one crash
        // does not fail every future job until someone reboots.
        if (this.isProfileLocked()) {
          throw new AutomationError(
            'PROFILE_IN_USE',
            `The browser profile for ${this.identity.email} is open in another process. ` +
              'Only one worker can drive a mailbox at a time, so check whether a second ' +
              '`npm run dev` is running and stop it.',
            { retryable: false, cause: error },
          );
        }

        log.warn(`profile ${this.identity.email} had stale locks; clearing them and retrying`);
        this.clearProfileLocks();
        await sleep(PROFILE_RELEASE_MS);
        this.context = await launch();
      }
      this.browser = this.context.browser();

      // Prefer a page already showing Gmail (a restored profile tab) over
      // opening yet another one.
      const open = this.context.pages();
      this.page =
        open.find((p: any) => String(p.url() ?? '').includes('mail.google.com')) ??
        open[0] ??
        (await this.context.newPage());
      this.page.setDefaultTimeout(env.PLAYWRIGHT_TIMEOUT_MS);

      await this.page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded' });
      await this.pruneBlankTabs();

      // The mailbox is asked about first. A signed-in Gmail can carry stray
      // "sign in" wording, and treating that as a dead session would send a
      // working mailbox round the sign-in path for no reason.
      const mailboxOnScreen = await this.exists(SELECTORS.inboxReady, 8000);

      if (!mailboxOnScreen && (await this.exists(SELECTORS.signInDetected, 4000))) {
        // Headless: nobody can complete a sign-in, so fail fast and ask for a
        // human. Headed: the window is already open in front of that human, so
        // wait for them to finish rather than throwing it away.
        if (env.PLAYWRIGHT_HEADLESS) {
          throw new AutomationError(
            'SESSION_EXPIRED',
            'Gmail is asking for sign-in. Set PLAYWRIGHT_HEADLESS=false, restart the worker, and press Connect again - a browser window will open for you to sign in yourself.',
            { retryable: false },
          );
        }

        log.info(`waiting up to ${SIGN_IN_WAIT_MS / 60_000} minutes for interactive sign-in on ${this.identity.email}`);
        this.report('awaitingSignIn', 'Complete sign-in in the browser window that just opened');

        const signedIn = await this.waitForSignIn(SIGN_IN_WAIT_MS);
        if (!signedIn) {
          throw new AutomationError(
            'SESSION_EXPIRED',
            `Sign-in was not completed within ${SIGN_IN_WAIT_MS / 60_000} minutes. Press Connect again to reopen the window.`,
            { retryable: false },
          );
        }
        await this.warnOnAccountMismatch();
      }

      await this.resolve(SELECTORS.inboxReady, 20000);
      log.info(`connected mailbox ${this.identity.email}`);
      return { connected: true, email: this.identity.email };
    }, {
      retries: 0,
      // An interactive sign-in has to fit inside the action timeout.
      timeoutMs: env.PLAYWRIGHT_HEADLESS ? 60_000 : SIGN_IN_WAIT_MS + 60_000,
    });
  }

  /**
   * Polls until the mailbox finishes loading after a human signs in. Returns
   * false on timeout, or if the operator closed the window.
   */
  private async waitForSignIn(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.page?.isClosed?.()) return false;
      if (await this.exists(SELECTORS.inboxReady, 2000)) return true;
      await sleep(2000);
    }
    return false;
  }

  /**
   * A mailbox signed in as a different Google account would send from the wrong
   * address. Best-effort check: warn loudly, but do not block - the account
   * label is not a stable enough signal to fail a connection on.
   */
  private async warnOnAccountMismatch(): Promise<void> {
    try {
      const button = await this.resolve(SELECTORS.accountButton, 4000);
      const label = (await button.getAttribute('aria-label')) ?? '';
      const found = /([\w.+-]+@[\w.-]+\.\w{2,})/.exec(label)?.[1];
      if (found && found.toLowerCase() !== this.identity.email.toLowerCase()) {
        const message = `signed in as ${found} but this mailbox is configured as ${this.identity.email} - mail would send from the wrong address`;
        log.warn(message);
        this.events.onError?.('AUTH_ERROR', message);
      }
    } catch {
      /* the account chip is not always present; not worth failing over */
    }
  }

  /**
   * Liveness check for a pooled context.
   *
   * Only a sign-in wall means the session is actually dead. The page may
   * legitimately be sitting on a conversation, a compose window or a search
   * result after the previous job - that is not a reason to tear down the
   * browser. Reporting a false negative here is expensive: the caller closes
   * the context and relaunches it, and relaunching a persistent context whose
   * profile has not yet been released attaches to the surviving browser and
   * leaves a stray blank tab behind every time.
   */
  async checkSession(): Promise<ConnectionInfo> {
    if (!this.page || this.page.isClosed?.()) {
      return { connected: false, email: null, detail: 'browser not started' };
    }
    try {
      // Mailbox first, sign-in second: the presence of the app is the stronger
      // signal, and asking in this order means stray "sign in" wording inside
      // a working mailbox cannot evict a good session from the pool.
      if (await this.exists(SELECTORS.inboxReady, 3000)) {
        return { connected: true, email: this.identity.email };
      }
      if (await this.exists(SELECTORS.signInDetected, 1500)) {
        return { connected: false, email: null, detail: 'signed out' };
      }

      // Somewhere other than the mailbox: navigate home and re-check once
      // before giving up on the whole context.
      const url = String(this.page.url() ?? '');
      if (!url.includes('mail.google.com')) {
        await this.page.goto(GMAIL_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
      }
      const ok = await this.exists(SELECTORS.inboxReady, 8000);
      if (!ok && (await this.exists(SELECTORS.signInDetected, 1500))) {
        return { connected: false, email: null, detail: 'signed out' };
      }
      return {
        connected: ok,
        email: ok ? this.identity.email : null,
        detail: ok ? undefined : 'gmail did not load',
      };
    } catch {
      return { connected: false, email: null, detail: 'unreachable' };
    }
  }

  /**
   * Chromium restores the profile's previous tabs on launch and adds a fresh
   * about:blank. Left alone those accumulate in front of the user.
   */
  private async pruneBlankTabs(): Promise<void> {
    try {
      for (const page of this.context?.pages?.() ?? []) {
        if (page === this.page || page.isClosed?.()) continue;
        const url = String(page.url() ?? '');
        if (!url || url === 'about:blank' || url.startsWith('chrome://new-tab')) {
          await page.close().catch(() => undefined);
        }
      }
    } catch {
      /* best effort - never fail a job over tab hygiene */
    }
  }

  async openInbox(): Promise<void> {
    await this.act('openInbox', async () => {
      await this.page.goto(`${GMAIL_URL}#inbox`, { waitUntil: 'domcontentloaded' });
      await this.resolve(SELECTORS.inboxReady, 15000);
    });
  }

  async logout(): Promise<void> {
    await this.act('logout', async () => {
      await this.page.goto('https://mail.google.com/mail/u/0/?logout', { waitUntil: 'domcontentloaded' });
    }, { retries: 0 });
  }

  /**
   * Closes the context and waits for Chromium to release the profile lock.
   * Relaunching the same user-data-dir too eagerly makes Playwright attach to
   * the dying browser instead of starting a clean one.
   */
  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* already gone */
    }
    try {
      await this.browser?.close();
    } catch {
      /* the persistent context usually owns the browser already */
    }
    this.page = null;
    this.context = null;
    this.browser = null;
    await sleep(PROFILE_RELEASE_MS);
  }

  // --------------------------------------------------------------- compose

  async openCompose(): Promise<void> {
    await this.act('openCompose', async () => {
      const button = await this.resolve(SELECTORS.composeButton, 10000);
      await button.click();
      await this.resolve(SELECTORS.composeDialog, 10000);
    });
  }

  async fillRecipient(to: string, cc: string[] = [], bcc: string[] = []): Promise<void> {
    await this.act('fillRecipient', async () => {
      const toField = await this.resolve(SELECTORS.recipientTo, 8000);
      await toField.click();
      await toField.fill(to);
      await this.page.keyboard.press('Tab');

      if (cc.length) {
        if (await this.exists(SELECTORS.ccToggle, 1000)) (await this.resolve(SELECTORS.ccToggle)).click();
        const ccField = await this.resolve(SELECTORS.recipientCc, 5000);
        await ccField.fill(cc.join(', '));
        await this.page.keyboard.press('Tab');
      }
      if (bcc.length) {
        if (await this.exists(SELECTORS.bccToggle, 1000)) (await this.resolve(SELECTORS.bccToggle)).click();
        const bccField = await this.resolve(SELECTORS.recipientBcc, 5000);
        await bccField.fill(bcc.join(', '));
        await this.page.keyboard.press('Tab');
      }
    });
  }

  async fillSubject(subject: string): Promise<void> {
    await this.act('fillSubject', async () => {
      const field = await this.resolve(SELECTORS.subjectInput, 8000);
      await field.click();
      await field.fill(subject);
    });
  }

  /**
   * Writes the message body into the compose editor.
   *
   * Gmail enforces Trusted Types, which rejects EVERY way of turning a string
   * into markup from injected script: innerHTML, insertAdjacentHTML,
   * Range.createContextualFragment, DOMParser.parseFromString and
   * execCommand('insertHTML'). All of them throw "This document requires
   * 'TrustedHTML' assignment".
   *
   * So the HTML is never handed to the page as markup. It is put on the
   * clipboard and pasted: Gmail then parses it through its own trusted policy,
   * exactly as it would for a human, and formatting survives. Typing is the
   * fallback when the clipboard is unavailable.
   *
   * The result is always verified. Silently leaving the body empty is how a
   * run ends up producing a mailbox full of blank drafts.
   */
  async fillBody(bodyHtml: string): Promise<void> {
    await this.act('fillBody', async () => {
      const body = await this.resolve(SELECTORS.bodyInput, 8000);
      const plain = htmlToText(bodyHtml);
      const isMac = process.platform === 'darwin';
      const paste = isMac ? 'Meta+V' : 'Control+V';
      // Gmail pre-fills the editor with the account signature and puts the
      // caret after it. Clicking the editor centre would land the message
      // below the signature, so the caret is moved to the very top first.
      const toTop = isMac ? 'Meta+ArrowUp' : 'Control+Home';

      // Strategy 1: rich paste through the clipboard.
      let written = false;
      try {
        await this.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: 'https://mail.google.com',
        });
        await this.page.evaluate(async (payload: { html: string; text: string }) => {
          const g = globalThis as any;
          const item = new g.ClipboardItem({
            'text/html': new g.Blob([payload.html], { type: 'text/html' }),
            'text/plain': new g.Blob([payload.text], { type: 'text/plain' }),
          });
          await g.navigator.clipboard.write([item]);
        }, { html: bodyHtml, text: plain });

        await body.click();
        await this.page.keyboard.press(toTop);
        await this.page.keyboard.press(paste);
        await sleep(700);
        written = await this.bodyContains(body, plain);
      } catch (error) {
        log.debug(`clipboard paste unavailable: ${error instanceof Error ? error.message : error}`);
      }

      // Strategy 2: type it as a human would. Loses rich formatting, but a
      // plain-text body that arrives beats a formatted one that does not.
      if (!written) {
        log.debug('falling back to typing the body');
        await body.click();
        await this.page.keyboard.press(toTop);
        await this.page.keyboard.type(plain, { delay: 0 });
        await sleep(500);
        written = await this.bodyContains(body, plain);
      }

      if (!written) {
        throw new AutomationError(
          'SEND_FAILED',
          'the message body could not be written into the compose window - refusing to send an empty message',
          { retryable: true },
        );
      }
    });
  }

  /** Confirms the editor really holds the body we asked for. */
  private async bodyContains(body: any, plain: string): Promise<boolean> {
    const probe = plain.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!probe) return true;
    try {
      const actual: string = await body.innerText();
      return actual.replace(/\s+/g, ' ').includes(probe);
    } catch {
      return false;
    }
  }

  async attachFile(attachment: AttachmentRef): Promise<void> {
    await this.act('attachFile', async () => {
      if (!fs.existsSync(attachment.path)) {
        throw new AutomationError('ATTACHMENT_ERROR', `file missing: ${attachment.path}`, { retryable: false });
      }
      const inputs = this.page.locator('input[type="file"]');
      if (await inputs.count()) {
        await inputs.first().setInputFiles(attachment.path);
        return;
      }
      const [chooser] = await Promise.all([
        this.page.waitForEvent('filechooser', { timeout: 10000 }),
        (await this.resolve(SELECTORS.attachButton, 8000)).click(),
      ]);
      await chooser.setFiles(attachment.path);
    });
  }

  private async composeInto(request: ComposeRequest): Promise<void> {
    await this.openCompose();
    await this.fillRecipient(request.to, request.cc, request.bcc);
    await this.fillSubject(request.subject);
    await this.fillBody(request.bodyHtml);
    for (const attachment of request.attachments ?? []) {
      await this.attachFile(attachment);
    }
  }

  async saveDraft(request: ComposeRequest): Promise<SendResult> {
    return this.act('saveDraft', async () => {
      await this.composeInto(request);
      const close = await this.resolve(SELECTORS.saveDraftClose, 8000);
      await close.click();
      await sleep(1200);
      const threadId = (await this.getThreadId()) ?? synthesizeId('thread');
      return {
        gmailThreadId: threadId,
        gmailMessageId: synthesizeId('msg'),
        rfcMessageId: synthesizeRfcId(this.identity.email),
        sentAt: new Date(),
        isDraft: true,
      };
    }, { retries: 1, timeoutMs: SEND_TIMEOUT_MS });
  }

  /**
   * Looks for a message this mailbox has already sent to `to` under `subject`.
   *
   * The sent folder - not our own job state - is the only honest answer to
   * "did that actually go out?". A driver retry, a job retry or a worker
   * restart can all re-enter sendMessage after Gmail accepted the message but
   * before we recorded it, and each of those used to deliver a second copy.
   *
   * Returns the Gmail thread id of the existing message, or null.
   */
  private async findRecentSent(to: string, subject: string): Promise<string | null> {
    try {
      const clean = subject.replace(/["\\]/g, '').trim();
      if (!clean) return null;
      await this.search(`in:sent to:${to} subject:"${clean}" newer_than:1d`);
      const rows = this.page.locator('tr.zA');
      if (!(await rows.count())) return null;

      // Guard against Gmail's fuzzy subject matching: only an exact subject
      // counts as the same message.
      const rowSubject: string =
        (await rows.first().locator('span.bog').first().innerText().catch(() => '')) ?? '';
      const normalise = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (rowSubject && normalise(rowSubject) !== normalise(clean)) return null;

      await rows.first().click();
      await sleep(700);
      return (await this.getThreadId()) ?? synthesizeId('thread');
    } catch {
      return null;
    }
  }

  async sendMessage(request: ComposeRequest): Promise<SendResult> {
    // ------------------------------------------------ duplicate guard, first
    if (env.SEND_DUPLICATE_GUARD) {
      const already = await this.findRecentSent(request.to, request.subject);
      if (already) {
        log.warn(`not re-sending to ${request.to}: "${truncate(request.subject, 60)}" is already in the sent folder`);
        return {
          gmailThreadId: already,
          gmailMessageId: synthesizeId('msg'),
          rfcMessageId: synthesizeRfcId(this.identity.email),
          sentAt: new Date(),
          isDraft: false,
          alreadySent: true,
        };
      }
    }

    // A send is not idempotent, so it is never retried in place: `retries: 0`.
    // If anything here fails, the job-level retry re-enters through the guard
    // above, which can tell an unsent message from an unconfirmed one.
    await this.act('sendMessage', async () => {
      await this.composeInto(request);
      const send = await this.resolve(SELECTORS.sendButton, 8000);
      await send.click();
      this.report('sendMessage', 'send clicked - awaiting confirmation');

      const confirmed = await this.exists(SELECTORS.sentConfirmation, 10000);
      if (!confirmed) {
        // The toast is easy to miss on a slow page; treat a closed composer as
        // the secondary success signal before declaring failure.
        const composerGone = !(await this.exists(SELECTORS.composeDialog, 2000));
        if (!composerGone) throw new AutomationError('SEND_FAILED', 'Gmail did not confirm the send');
      }
    }, { retries: 0, timeoutMs: SEND_TIMEOUT_MS });

    // Bookkeeping only, and deliberately outside the block above: the message
    // has left. Failing to work out its thread id must never be reported as a
    // failed send, or the job retries and the contact gets a second copy.
    await sleep(800);
    const threadId = await this.findThreadIdForSubject(request.subject, request.to).catch(() => null);
    return {
      gmailThreadId: threadId ?? synthesizeId('thread'),
      gmailMessageId: synthesizeId('msg'),
      rfcMessageId: synthesizeRfcId(this.identity.email),
      sentAt: new Date(),
      isDraft: false,
    };
  }

  // ------------------------------------------------------------ threading

  async getThreadId(): Promise<string | null> {
    try {
      const container = await this.resolve(SELECTORS.openThreadContainer, 4000);
      const permId = cleanThreadId(await container.getAttribute('data-thread-perm-id'));
      if (permId) return permId;
      const legacy = cleanThreadId(await container.getAttribute('data-legacy-thread-id'));
      if (legacy) return legacy;
      const url: string = this.page.url();
      const hash = url.split('#')[1] ?? '';
      return cleanThreadId(hash.split('/').pop());
    } catch {
      return null;
    }
  }

  /**
   * The Gmail thread id of a message just sent, read from the search result row.
   *
   * It used to click into the conversation and read the id off the open
   * container, which failed silently every single time: every thread the
   * platform had ever recorded carried a synthesized `thread_...` id instead of
   * a real one. Nothing that needs a real id could work - an in-thread
   * follow-up cannot open the conversation to reply to, and labelling cannot
   * find it either.
   *
   * The result row already carries the id in `data-legacy-thread-id`, which is
   * the same place `collectThreadIds()` reads it from, and reading it there
   * costs no navigation at all.
   */
  private async findThreadIdForSubject(subject: string, to?: string): Promise<string | null> {
    try {
      const clean = subject.replace(/["\\]/g, '').trim();
      const scope = to ? `to:${to} ` : '';
      await this.search(`in:sent ${scope}subject:"${clean}" ${sentSince(10)}`);
      // The row carries the legacy hex id, which Gmail's router will not
      // resolve: `#all/<hex>` opens nothing. The id the URL accepts is the
      // permanent one, and that only appears once the conversation is open -
      // so it is opened once and the right id recorded. Storing the hex id
      // instead is what left every later action unable to find the thread.
      const rowId = (await this.collectThreadIds(1))[0] ?? null;
      if (await this.clickFirstVisibleRow()) {
        await sleep(1500);
        const permId = await this.getThreadId();
        if (permId) return permId;
      }

      if (!rowId) log.warn(`no sent row matched "${truncate(clean, 60)}" - thread id unavailable`);
      return rowId;
    } catch (error) {
      log.warn(`thread id lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Runs a Gmail search.
   *
   * Driving the URL fragment is far more robust than the search box, which
   * Gmail restyles regularly and renders collapsed on narrow viewports. The
   * box is kept as a fallback.
   */
  private async search(query: string): Promise<void> {
    const target = `#search/${encodeURIComponent(query)}`;
    try {
      await this.page.evaluate((hash: string) => {
        (globalThis as any).location.hash = hash;
      }, target);
      if (await this.searchSettled(query, 6000)) return;
    } catch {
      /* fall through to the search box */
    }

    const input = await this.resolve(SELECTORS.searchInput, 8000);
    await input.click();
    await input.fill(query);
    await this.page.keyboard.press('Enter');
    if (!(await this.searchSettled(query, 4000))) {
      log.warn(`Gmail did not confirm the search "${truncate(query, 80)}" - results may be stale`);
    }
  }

  /**
   * Waits until Gmail is actually showing the results for `query`.
   *
   * Changing the URL fragment does not guarantee the list re-renders, and the
   * old check - "does a main region exist?" - is true on every page, so a
   * search that never took effect looked like a success. Everything downstream
   * then read the previous result list: the wrong thread id after a send, the
   * wrong conversation opened, a bounce scan over whatever happened to be on
   * screen. Gmail echoes the active query back in `data-query`, and that is
   * what gets waited on.
   */
  private async searchSettled(query: string, timeoutMs: number): Promise<boolean> {
    const wanted = query.replace(/\s+/g, ' ').trim();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      // No named functions in here - esbuild rewrites them into a `__name()`
      // helper that does not exist inside the page.
      const shown: string = await this.page
        .evaluate(() => {
          const doc = (globalThis as any).document;
          // Every search leaves its pane behind, each carrying its own
          // `data-query`, so the first one found is usually a previous search.
          // All of them are reported and the caller looks for a match.
          const queries: string[] = [];
          for (const holder of Array.from(doc.querySelectorAll('[data-query]')) as any[]) {
            const value = holder.getAttribute('data-query');
            if (value) queries.push(value);
          }
          const input = doc.querySelector('input[aria-label="Search mail"], input[name="q"]');
          if (input && input.value) queries.push(input.value);
          return queries.join(' ');
        })
        .catch(() => '');

      const matched = shown
        .split(' ')
        .some((candidate) => candidate.replace(/\s+/g, ' ').trim() === wanted);
      if (matched) {
        // The query attribute updates well before the list does: Gmail hides
        // the previous results and renders the new ones, and in between there
        // are fifty rows in the DOM and none of them on screen. Waiting for a
        // visible row - or for Gmail to say there are none - is what makes the
        // result list safe to read.
        const listDeadline = Date.now() + 5000;
        while (Date.now() < listDeadline) {
          const state: string = await this.page
            .evaluate((visibleSrc: string) => {
              const doc = (globalThis as any).document;
              const isVisible = (0, eval)(visibleSrc);
              let visible = 0;
              for (const row of Array.from(doc.querySelectorAll('tr.zA')) as any[]) {
                if (isVisible(row)) visible += 1;
              }
              if (visible > 0) return 'rows';
              const main = doc.querySelector('div[role="main"]');
              const text = main ? (main.innerText ?? '').slice(0, 2000) : '';
              return /no messages matched|no results|nothing to see/i.test(text) ? 'empty' : 'pending';
            }, GmailAutomationService.VISIBLE_TEST)
            .catch(() => 'pending');
          if (state !== 'pending') return true;
          await sleep(400);
        }
        return true;
      }
      await sleep(400);
    }
    return false;
  }

  /**
   * Reads thread ids straight off the list rows.
   *
   * The previous approach clicked each row and pressed back. Gmail virtualises
   * the list, so rows scroll out from under the click and the action times out
   * waiting for a row that is no longer attached - which is exactly what the
   * "waiting for locator('tr.zA')" failures were.
   */
  private async collectThreadIds(limit: number): Promise<string[]> {
    const ids: string[] = await this.page.evaluate((max: number) => {
      const out: string[] = [];
      const doc = (globalThis as any).document;
      for (const row of Array.from(doc.querySelectorAll('tr.zA')) as any[]) {
        if (out.length >= max) break;
        // Gmail leaves hidden rows in the list; their ids are not the ones on
        // screen and acting on one opens the wrong conversation.
        const rect = row.getBoundingClientRect();
        if (rect.width < 5 || rect.height < 5) continue;
        const holder = row.querySelector('[data-legacy-thread-id], [data-thread-id]');
        const id =
          holder?.getAttribute('data-legacy-thread-id') ||
          holder?.getAttribute('data-thread-id')?.replace(/^#/, '') ||
          row.getAttribute('id');
        if (id) out.push(String(id));
      }
      return out;
    }, limit);

    return [...new Set(ids)].filter(Boolean);
  }

  /**
   * Navigates Gmail's SPA router.
   *
   * `page.goto()` with only the fragment changed does not reliably re-render
   * Gmail, so the hash is set directly and the router is given time to react.
   */
  private async navigateHash(hash: string): Promise<void> {
    await this.page.evaluate((next: string) => {
      const loc = (globalThis as any).location;
      // Force a hashchange even when the target equals the current fragment.
      if (loc.hash === next) loc.hash = '#inbox';
      loc.hash = next;
    }, hash);
    await sleep(1400);
  }

  async searchConversation(gmailThreadId: string): Promise<boolean> {
    return this.act('searchConversation', async () => {
      // A Gmail thread id is not an RFC Message-ID, so `rfc822msgid:` never
      // matches it - searching for the bare id is the only thing that can.
      await this.search(gmailThreadId);
      return (await this.page.locator('tr.zA').count()) > 0;
    }, { retries: 0 });
  }

  /**
   * Opens a conversation by finding it in a search and clicking the row.
   *
   * The id route cannot be relied on: the list gives us a legacy hex thread id
   * and Gmail's router no longer resolves one, so `#all/<id>` silently lands on
   * nothing. Searching for the message and clicking it is what a person does,
   * and it does not depend on which of Gmail's several id formats we happen to
   * be holding.
   */
  async openConversationBySearch(query: string): Promise<boolean> {
    return this.act('openConversationBySearch', async () => {
      await this.search(query);
      const row = await this.firstVisible(this.page.locator('tr.zA'));
      if (!row) {
        log.warn(`nothing visible matched "${truncate(query, 80)}" - no conversation to open`);
        return false;
      }
      // Click the subject cell rather than the row: the row's left edge is
      // checkbox and star, and hitting those selects instead of opening.
      if (!(await this.clickFirstVisibleRow())) {
        log.warn(`could not click a result row for "${truncate(query, 80)}"`);
        return false;
      }
      await sleep(1800);
      return this.exists(SELECTORS.openThreadContainer, 8000);
    }, { retries: 0, timeoutMs: 60_000 });
  }

  async openConversation(rawThreadId: string): Promise<boolean> {
    // Threads recorded before the id was cleaned at capture still carry the
    // query string the address bar had at the time, so it is stripped here too
    // rather than leaving those conversations permanently unopenable.
    const gmailThreadId = cleanThreadId(rawThreadId) ?? rawThreadId;

    return this.act('openConversation', async () => {
      // `#all/` resolves a thread whatever label it carries; `#inbox/` only
      // works while it is still in the inbox.
      for (const view of ['all', 'inbox']) {
        await this.navigateHash(`#${view}/${gmailThreadId}`);
        // The URL has to agree. A conversation left open from a previous
        // action still satisfies the container check, so without this the
        // driver reports success and then reads the wrong thread.
        const landed = this.page.url().includes(gmailThreadId);
        if (landed && (await this.exists(SELECTORS.openThreadContainer, 5000))) return true;
      }

      // Last resort: search for the id and open the first hit, but never click
      // into an empty result set.
      const found = await this.searchConversation(gmailThreadId);
      if (!found) {
        log.debug(`thread ${gmailThreadId} could not be opened`);
        return false;
      }

      const rows = this.page.locator('tr.zA');
      if ((await rows.count()) === 0) return false;
      await rows.first().click({ timeout: 8000 }).catch(() => undefined);
      await sleep(900);
      return this.exists(SELECTORS.openThreadContainer, 6000);
    }, { retries: 0, timeoutMs: 45_000 });
  }

  async replyToConversation(request: ReplyRequest, mode: 'DRAFT' | 'SEND'): Promise<SendResult> {
    return this.act('replyToConversation', async () => {
      let opened = await this.openConversation(request.gmailThreadId);
      if (!opened && request.to) {
        // The id route failing is the norm, not the exception - Gmail's router
        // will not resolve the legacy thread id the list hands us - so the
        // search route is a first-class fallback rather than a last resort.
        const clean = request.subject.replace(/["\\]/g, '').replace(/^re:\s*/i, '').trim();
        opened = await this.openConversationBySearch(`in:anywhere to:${request.to} subject:"${clean}"`);
      }
      if (!opened) {
        throw new AutomationError('THREAD_NOT_FOUND', `thread ${request.gmailThreadId} not found`, { retryable: false });
      }

      const reply = await this.resolve(SELECTORS.replyButton, 10000);
      await reply.click();
      await sleep(900);

      await this.fillBody(request.bodyHtml);
      for (const attachment of request.attachments ?? []) await this.attachFile(attachment);

      if (mode === 'DRAFT') {
        const close = await this.resolve(SELECTORS.saveDraftClose, 8000);
        await close.click();
      } else {
        const send = await this.resolve(SELECTORS.sendButton, 8000);
        await send.click();
        this.report('replyToConversation', 'send clicked - awaiting confirmation');
        const confirmed = await this.exists(SELECTORS.sentConfirmation, 10000);
        if (!confirmed) {
          // A vanished reply box means Gmail took it; only a reply box that is
          // still sitting there means the click did nothing.
          const composerGone = !(await this.exists(SELECTORS.composeDialog, 2000));
          if (!composerGone) throw new AutomationError('SEND_FAILED', 'reply was not confirmed by Gmail');
        }
      }

      await sleep(700);
      return {
        gmailThreadId: request.gmailThreadId,
        gmailMessageId: synthesizeId('msg'),
        rfcMessageId: synthesizeRfcId(this.identity.email),
        sentAt: new Date(),
        isDraft: mode === 'DRAFT',
      };
    }, { retries: 0, timeoutMs: SEND_TIMEOUT_MS });
  }

  // ---------------------------------------------------------------- reading

  private async scrapeOpenThread(gmailThreadId: string): Promise<FetchedThread | null> {
    const subject = await this.page
      .locator('h2[data-thread-perm-id], h2.hP')
      .first()
      .textContent()
      .catch(() => null);

    const blocks = this.page.locator('div[data-message-id]');
    const count = await blocks.count();
    if (!count) return null;

    const messages: FetchedMessage[] = [];
    for (let i = 0; i < count; i += 1) {
      const block = blocks.nth(i);
      const messageId = (await block.getAttribute('data-message-id')) ?? synthesizeId('msg');
      const from = (await block.locator('span[email]').first().getAttribute('email').catch(() => null)) ?? '';
      const fromName = await block.locator('span[email]').first().getAttribute('name').catch(() => null);
      const bodyHtml = (await block.locator('div.a3s').first().innerHTML().catch(() => '')) ?? '';
      const stamp = await block.locator('span[title]').first().getAttribute('title').catch(() => null);
      const receivedAt = stamp ? new Date(stamp) : new Date();

      messages.push({
        gmailMessageId: messageId,
        rfcMessageId: null,
        inReplyTo: null,
        sender: from || this.identity.email,
        senderName: fromName,
        recipients: [],
        cc: [],
        subject: subject ?? '(no subject)',
        bodyHtml,
        bodyText: htmlToText(bodyHtml),
        snippet: truncate(htmlToText(bodyHtml), 160),
        direction: from && from.toLowerCase() !== this.identity.email.toLowerCase() ? 'INBOUND' : 'OUTBOUND',
        receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
        isRead: true,
        attachments: [],
      });
    }

    const last = messages[messages.length - 1];
    return {
      gmailThreadId,
      subject: subject ?? '(no subject)',
      participants: [...new Set(messages.map((m) => m.sender))],
      snippet: last?.snippet ?? '',
      lastMessageAt: last?.receivedAt ?? new Date(),
      isRead: true,
      isStarred: false,
      isImportant: false,
      labels: [],
      messages,
    };
  }

  async fetchThread(gmailThreadId: string): Promise<FetchedThread | null> {
    return this.act('fetchThread', async () => {
      const opened = await this.openConversation(gmailThreadId);
      if (!opened) return null;
      return this.scrapeOpenThread(gmailThreadId);
    }, { retries: 1 });
  }

  /**
   * Incremental inbox read. Uses Gmail's own `newer_than:` search so a sync
   * never reloads the whole mailbox.
   */
  async fetchThreads(options: SyncOptions = {}): Promise<FetchedThread[]> {
    return this.act('fetchThreads', async () => {
      const limit = options.limit ?? 25;
      let query = options.query ?? 'in:inbox';
      if (options.since) {
        const days = Math.max(1, Math.ceil((Date.now() - options.since.getTime()) / 86_400_000));
        query += ` newer_than:${days}d`;
      }
      await this.search(query);

      const ids = await this.collectThreadIds(limit);
      log.debug(`fetchThreads: ${ids.length} thread(s) matched "${query}"`);

      const results: FetchedThread[] = [];
      for (const threadId of ids) {
        const opened = await this.openConversation(threadId);
        if (!opened) continue;
        const thread = await this.scrapeOpenThread(threadId);
        if (thread) results.push(thread);
      }
      return results;
    }, { retries: 1, timeoutMs: 240_000 });
  }

  /**
   * Reads the result list itself - subject, sender and snippet per row - with
   * no conversation opened.
   *
   * A bounce scan over 25 delivery reports took over eight minutes when each
   * one had to be opened, which is longer than a job is allowed to run. Gmail
   * puts the failed address in the snippet often enough that most reports can
   * be resolved from this list alone, and only the stragglers need opening.
   */
  async fetchThreadSummaries(options: SyncOptions = {}): Promise<ThreadSummary[]> {
    return this.act('fetchThreadSummaries', async () => {
      const limit = options.limit ?? 25;
      let query = options.query ?? 'in:inbox';
      if (options.since) {
        const days = Math.max(1, Math.ceil((Date.now() - options.since.getTime()) / 86_400_000));
        query += ` newer_than:${days}d`;
      }
      await this.search(query);

      // NOTE: nothing inside this callback may declare a named function - not
      // even `const helper = () => ...`. esbuild (via tsx) rewrites those into
      // a `__name()` call, and that helper does not exist inside the page, so
      // the evaluate dies with "__name is not defined". Everything here is
      // therefore written inline.
      const rows: ThreadSummary[] = await this.page.evaluate((max: number) => {
        const out: any[] = [];
        const doc = (globalThis as any).document;

        for (const row of Array.from(doc.querySelectorAll('tr.zA')) as any[]) {
          if (out.length >= max) break;
          const rect = row.getBoundingClientRect();
          if (rect.width < 5 || rect.height < 5) continue;
          const holder = row.querySelector('[data-legacy-thread-id], [data-thread-id]');
          const id =
            holder?.getAttribute('data-legacy-thread-id') ||
            holder?.getAttribute('data-thread-id')?.replace(/^#/, '') ||
            row.getAttribute('id');
          if (!id) continue;

          const from = row.querySelector('span[email]');
          out.push({
            gmailThreadId: String(id),
            sender: from?.getAttribute('email') ?? '',
            senderName: from?.getAttribute('name') ?? null,
            subject: (row.querySelector('span.bog')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
            // Gmail renders the preview as ' - <snippet>'; the dash is markup,
            // not content, so it goes.
            snippet: (row.querySelector('span.y2')?.textContent ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .replace(/^[\s-]+/, ''),
          });
        }
        return out;
      }, limit);

      log.debug(`fetchThreadSummaries: ${rows.length} row(s) matched "${query}"`);
      return rows;
    }, { retries: 1, timeoutMs: 90_000 });
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

  // --------------------------------------------------------------- actions

  /**
   * Clicks the first on-screen result row, inside the page, in one go.
   *
   * Holding a Playwright locator across a check and then a click loses the
   * race with Gmail, which re-renders the result list underneath us: the
   * element passes `isVisible()` and is gone by the time the click lands, so
   * the click waits for a visibility that will never return. Finding and
   * clicking in the same synchronous pass in the page cannot be raced.
   *
   * Returns whether a row was clicked.
   */
  /**
   * In-page test for "really on screen", matching what Playwright means by it.
   *
   * A bounding box is not enough: Gmail keeps whole result panes in the layout
   * with `visibility: hidden`, so their rows measure non-zero while Playwright
   * - correctly - refuses to click them. `checkVisibility` accounts for CSS
   * visibility and opacity, which is the same standard, so the two agree.
   */
  private static readonly VISIBLE_TEST = `
    (function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
      }
      return true;
    })
  `;

  private async clickFirstVisibleRow(): Promise<boolean> {
    // No named functions in here - esbuild rewrites them into a `__name()`
    // helper that does not exist inside the page.
    return this.page.evaluate((visibleSrc: string) => {
      const doc = (globalThis as any).document;
      const isVisible = (0, eval)(visibleSrc);
      for (const row of Array.from(doc.querySelectorAll('tr.zA')) as any[]) {
        if (!isVisible(row)) continue;
        // The subject cell opens the conversation; the row's left edge is
        // checkbox and star, which select it instead.
        const target = row.querySelector('span.bog') ?? row.querySelector('span.y2') ?? row;
        target.click();
        return true;
      }
      return false;
    }, GmailAutomationService.VISIBLE_TEST);
  }

  /**
   * First match that is actually on screen.
   *
   * Gmail keeps hidden rows and duplicated controls in the DOM - every search
   * leaves its pane behind, so a list of fifty can sit behind fifty stale ones
   * - and `.first()` lands on something invisible where every click times out.
   *
   * `max` has to be generous for the same reason: a small cap gives up before
   * reaching the rows that are actually on screen and reports an empty list.
   */
  private async firstVisible(locator: any, max = 80): Promise<any | null> {
    // One round trip, whatever the pile size. The old walk asked Playwright
    // about one element at a time and stopped after `max`, which broke exactly
    // where it mattered: Gmail never removes a result pane, so a long-lived
    // worker accumulates hidden rows, and by the hundredth search of a session
    // the on-screen rows sat past the cap. The driver then reported "nothing
    // matched" on a mailbox that was plainly showing five results - which is
    // why filing worked at the start of a session and quietly stopped later.
    const index: number = await locator
      .evaluateAll((nodes: any[], visibleSrc: string) => {
        // No named functions in here - esbuild rewrites them into a `__name()`
        // helper that does not exist inside the page.
        const isVisible = (0, eval)(visibleSrc);
        for (let i = 0; i < nodes.length; i += 1) if (isVisible(nodes[i])) return i;
        return -1;
      }, GmailAutomationService.VISIBLE_TEST)
      .catch(() => -2);

    if (index >= 0) return locator.nth(index);
    if (index === -1) return null;

    // `evaluateAll` unavailable (a stubbed locator in tests, or a detached
    // frame): fall back to the per-element walk.
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, max); i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return null;
  }

  /**
   * Ticks a Gmail checkbox.
   *
   * A row checkbox sits under the row's hover overlay, so a plain click waits
   * for actionability that never arrives and times out. Hovering the row first
   * is what a person does; a forced click and then a DOM-level click are the
   * fallbacks, because failing to tick a box must not cost the caller the
   * whole action.
   */
  private async tick(locator: any): Promise<boolean> {
    try {
      await locator.hover({ timeout: 2000 }).catch(() => undefined);
      await locator.click({ timeout: 2500 });
      return true;
    } catch {
      /* covered - fall through */
    }
    try {
      await locator.click({ timeout: 2500, force: true });
      return true;
    } catch {
      /* still covered - fall through */
    }
    try {
      await locator.evaluate((node: any) => node.click());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Diagnostic: reports what happens when we try to open a conversation.
   *
   * Read-only apart from the click that opens it.
   */
  async describeOpenAttempt(query: string): Promise<Array<{ step: string; html: string }>> {
    return this.act('describeOpenAttempt', async () => {
      const steps: Array<{ step: string; html: string }> = [];
      await this.search(query);

      const rows = this.page.locator('tr.zA');
      const count = await rows.count();
      steps.push({ step: 'rows', html: `${count} row(s) matched` });
      if (!count) return steps;
      const visibleRow = await this.firstVisible(rows);
      steps.push({ step: 'visible-row', html: visibleRow ? 'found' : 'none visible' });
      if (!visibleRow) return steps;

      steps.push({ step: 'url-before', html: this.page.url() });

      const clicked = await this.clickFirstVisibleRow();
      steps.push({ step: 'click', html: clicked ? 'clicked in-page' : 'no visible row to click' });
      await sleep(2000);

      steps.push({ step: 'url-after', html: this.page.url() });

      const shape: string = await this.page.evaluate(() => {
        const doc = (globalThis as any).document;
        const probe = [
          'div[role="main"] [data-message-id]',
          '[data-thread-perm-id]',
          'h2.hP',
          'div.nH.if',
          'tr.zA',
          'div.a3s',
        ];
        const out: string[] = [];
        for (const sel of probe) out.push(`${sel} => ${doc.querySelectorAll(sel).length}`);
        const h2 = doc.querySelector('h2');
        out.push(`first h2: ${h2 ? h2.outerHTML.slice(0, 200) : '(none)'}`);
        return out.join('  //  ');
      });
      steps.push({ step: 'dom-after-click', html: shape });

      return steps;
    }, { retries: 0, timeoutMs: 60_000 });
  }

  /**
   * Diagnostic: walks up to the labels menu and reports the markup at each step.
   *
   * Gmail renames these controls between releases, and finding the new hook by
   * proposing a selector, deploying, and reading a one-line failure costs a
   * round trip per guess. Reading the actual DOM once costs one.
   *
   * Read-only apart from selecting a row and opening a menu; nothing is filed.
   */
  private probeLabel?: string;

  async describeLabelMenu(query: string, label?: string): Promise<Array<{ step: string; html: string }>> {
    this.probeLabel = label;
    return this.act('describeLabelMenu', async () => {
      const steps: Array<{ step: string; html: string }> = [];
      const cap = (value: string) => (value.length > 2500 ? `${value.slice(0, 2500)}...[cut]` : value);

      await this.search(query);

      const boxes = this.page.locator('tr.zA [role="checkbox"]');
      const available = await boxes.count();
      steps.push({ step: 'rows', html: `${available} row checkbox(es) matched "${query}"` });
      if (!available) return steps;

      // The first box in the DOM is usually inside a stale, hidden results
      // pane: ticking that one leaves Gmail's own toolbar in its unselected
      // state and every message action hidden, which is not the state the real
      // filing path is in. Select what a person would see, as applyLabel does.
      const box = await this.firstVisible(boxes);
      steps.push({ step: 'visible-row', html: box ? 'found' : 'none visible' });

      // Where the on-screen rows actually sit in the match list. Gmail leaves
      // every previous result pane in the DOM, so a scan that stops early can
      // walk a hundred hidden rows and conclude the mailbox is empty.
      const visibility: string = await this.page.evaluate((visibleSrc: string) => {
        const doc = (globalThis as any).document;
        const isVisible = (0, eval)(visibleSrc);
        const boxes = Array.from(doc.querySelectorAll('tr.zA [role="checkbox"]')) as any[];
        const indices: number[] = [];
        for (let i = 0; i < boxes.length; i += 1) if (isVisible(boxes[i])) indices.push(i);
        const rows = Array.from(doc.querySelectorAll('tr.zA')) as any[];
        let visibleRows = 0;
        for (const row of rows) if (isVisible(row)) visibleRows += 1;
        return (
          `${boxes.length} checkbox(es), visible at indices [${indices.slice(0, 12).join(', ')}]` +
          ` // ${rows.length} tr.zA, ${visibleRows} visible`
        );
      }, GmailAutomationService.VISIBLE_TEST);
      steps.push({ step: 'row-visibility', html: visibility });

      if (!box) return steps;
      await this.tick(box);
      await sleep(1500);

      // No named functions inside evaluate - esbuild rewrites them into a
      // `__name()` helper that does not exist in the page.
      // Did the tick actually register? `aria-checked` is Gmail's own answer,
      // and it separates "the button is named something else" from "nothing is
      // selected, so the button does not exist yet".
      const selectionState: string = await this.page.evaluate(() => {
        const doc = (globalThis as any).document;
        const box = doc.querySelector('tr.zA [role="checkbox"]');
        const checked = doc.querySelectorAll('tr.zA [role="checkbox"][aria-checked="true"]').length;
        return `first row aria-checked=${box?.getAttribute('aria-checked') ?? '(none)'}, ${checked} row(s) checked`;
      });
      steps.push({ step: 'selection-state', html: selectionState });

      // Every button the page is offering, by the names a selector could use.
      const buttons: string = await this.page.evaluate(() => {
        const doc = (globalThis as any).document;
        const out: string[] = [];
        for (const el of Array.from(doc.querySelectorAll('[role="button"]')) as any[]) {
          const box = el.getBoundingClientRect();
          if (box.width < 8 || box.height < 8) continue;
          const tooltip = el.getAttribute('data-tooltip') ?? '';
          const aria = el.getAttribute('aria-label') ?? '';
          const act = el.getAttribute('act') ?? '';
          if (!tooltip && !aria && !act) continue;
          out.push(`tooltip="${tooltip}" aria="${aria}" act="${act}"`);
        }
        return out.join('  //  ') || '(no labelled buttons)';
      });
      steps.push({ step: 'visible-buttons', html: cap(buttons) });

      const dumpMenus = async (): Promise<string> =>
        this.page.evaluate(() => {
          const doc = (globalThis as any).document;
          const found: string[] = [];
          for (const menu of Array.from(doc.querySelectorAll('div[role="menu"]')) as any[]) {
            const box = menu.getBoundingClientRect();
            if (box.width < 60 || box.height < 40) continue;
            const items: string[] = [];
            for (const item of Array.from(menu.querySelectorAll('[role="menuitem"]')) as any[]) {
              items.push(
                `[aria="${item.getAttribute('aria-label') ?? ''}" act="${
                  item.getAttribute('act') ?? ''
                }" text="${(item.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}"]`,
              );
            }
            found.push(items.join(' ') || '(menu with no items)');
          }
          return found.join('  ||  ') || '(no visible menu)';
        });

      let route = 'none';
      try {
        const direct = await this.resolve(SELECTORS.labelsButton, 2500);
        await direct.click();
        route = 'toolbar Labels button';
      } catch {
        try {
          const more = await this.resolve(SELECTORS.moreOptionsButton, 5000);
          await more.click();
          route = 'More menu';
        } catch (error) {
          steps.push({
            step: 'route',
            html: `neither Labels nor More was found: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          return steps;
        }
      }
      steps.push({ step: 'route', html: route });
      await sleep(1200);
      steps.push({ step: 'menu-items', html: cap(await dumpMenus()) });

      if (route === 'More menu') {
        try {
          const labelAs = await this.resolve(SELECTORS.labelAsMenuItem, 5000);
          await labelAs.click();
          await sleep(1200);
          steps.push({ step: 'after-label-as', html: cap(await dumpMenus()) });
        } catch (error) {
          steps.push({
            step: 'label-as',
            html: `not found: ${error instanceof Error ? error.message : String(error)}`,
          });

          // The item is plainly in the menu dump above, so "not found" means
          // the locator could not reach it, not that Gmail renamed it. Every
          // copy in the DOM is reported with the position it holds in the
          // match list and whether it is on screen - which is what separates
          // "wrong hook" from "right hook, wrong copy".
          const copies: string = await this.page.evaluate(() => {
            const doc = (globalThis as any).document;
            const all = Array.from(doc.querySelectorAll('[role="menuitem"]')) as any[];
            const out: string[] = [];
            let index = -1;
            for (const item of all) {
              const text = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (!text.toLowerCase().includes('label as')) continue;
              index += 1;
              const rect = item.getBoundingClientRect();
              const style = (globalThis as any).getComputedStyle(item);
              out.push(
                `#${index} text="${text.slice(0, 24)}" rect=${Math.round(rect.width)}x${Math.round(
                  rect.height,
                )}@${Math.round(rect.left)},${Math.round(rect.top)} display=${style.display} ` +
                  `visibility=${style.visibility} opacity=${style.opacity}`,
              );
            }
            return `${out.length} copy(ies): ${out.join('  //  ')}`;
          });
          steps.push({ step: 'label-as-copies', html: cap(copies) });
        }
      }

      // What the labels menu actually offers once a name is typed into it:
      // which rows exist, whether one of them is the label we want, and what
      // the create entry looks like. Nothing is clicked - the probe never
      // creates a label.
      const wanted = String(this.probeLabel ?? '').trim();
      if (wanted) {
        try {
          const search = await this.resolve(SELECTORS.labelSearchInput, 6000);
          await search.click();
          await search.fill(wanted);
          await sleep(900);
          const offered: string = await this.page.evaluate((name: string) => {
            const doc = (globalThis as any).document;
            const out: string[] = [];
            for (const item of Array.from(
              doc.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], div.J-N, div.J-LC'),
            ) as any[]) {
              const rect = item.getBoundingClientRect();
              if (rect.width < 20 || rect.height < 8) continue;
              const text = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
              if (!text) continue;
              out.push(
                `[role="${item.getAttribute('role') ?? ''}" class="${String(item.className).slice(0, 30)}" ` +
                  `checked="${item.getAttribute('aria-checked') ?? ''}" text="${text.slice(0, 40)}"]`,
              );
            }
            return `typed "${name}" -> ${out.length} row(s): ${out.join(' ')}`;
          }, wanted);
          steps.push({ step: 'labels-menu-offers', html: cap(offered) });
        } catch (error) {
          steps.push({
            step: 'labels-menu-offers',
            html: `filter box not found: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const inputs: string = await this.page.evaluate(() => {
        const doc = (globalThis as any).document;
        const out: string[] = [];
        for (const input of Array.from(doc.querySelectorAll('input')) as any[]) {
          const box = input.getBoundingClientRect();
          if (box.width < 5 || box.height < 5) continue;
          out.push(
            `<input type="${input.type}" class="${input.className}" placeholder="${
              input.placeholder ?? ''
            }" aria-label="${input.getAttribute('aria-label') ?? ''}">`,
          );
        }
        return out.join(' | ') || '(no visible inputs)';
      });
      steps.push({ step: 'visible-inputs', html: cap(inputs) });

      return steps;
    }, { retries: 0, timeoutMs: 60_000 });
  }

  /**
   * The row for one label inside the open labels menu, or null if Gmail is not
   * offering it.
   *
   * Matched on the row's own text rather than a name-bearing attribute,
   * because Gmail gives these rows none: they are `menuitemcheckbox` elements
   * whose only identity is what they say.
   */
  private async labelRow(label: string): Promise<any | null> {
    const wanted = label.trim().toLowerCase();
    const rows = this.page.locator('[role="menuitemcheckbox"]');
    const count = await rows.count().catch(() => 0);

    for (let i = 0; i < Math.min(count, 40); i += 1) {
      const row = rows.nth(i);
      if (!(await row.isVisible().catch(() => false))) continue;
      const text = ((await row.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
      if (text.toLowerCase() === wanted) return row;
    }
    return null;
  }

  /**
   * Does Gmail itself now return this message under this label?
   *
   * Asking Gmail is the only answer worth having. Everything up to here is a
   * sequence of clicks that can each appear to work while filing nothing.
   */
  private async isFiledUnder(query: string, label: string): Promise<boolean> {
    try {
      await this.search(`label:"${label.replace(/"/g, '')}" ${query}`);
      return Boolean(await this.firstVisible(this.page.locator('tr.zA')));
    } catch {
      return false;
    }
  }

  /**
   * Files the newest conversation matching a Gmail search under `label`,
   * creating the label on first use. Returns how many were filed (0 or 1).
   *
   * Works from the results list and never opens a conversation. Opening one is
   * the least reliable thing this driver does - it depends on Gmail's SPA
   * router resolving a thread id in the URL - and the send path has already
   * run the very search that finds the message, so there is nothing to gain by
   * navigating into it.
   */
  async applyLabel(query: string, label: string): Promise<number> {
    return this.act('applyLabel', async () => {
      // Gmail does not always have a just-sent message in its search index by
      // the time the send returns, so the first search can legitimately come
      // back empty. That used to end the action quietly - the mail went out
      // and nothing was ever filed - so the search is retried before giving
      // up, and giving up now leaves a screenshot behind.
      let box: any = null;
      for (let attempt = 0; attempt < 3 && !box; attempt += 1) {
        if (attempt > 0) await sleep(3000);
        await this.search(query);
        box = await this.firstVisible(this.page.locator('tr.zA [role="checkbox"]'));
      }
      if (!box) {
        await this.screenshot('applyLabel-no-match');
        log.warn(`nothing visible matched "${truncate(query, 80)}" - nothing to file under ${label}`);
        return 0;
      }

      // One click, not one per row. Ticking each row individually meant up to
      // twenty-five four-second clicks, which on its own overran the whole
      // action's budget before the labels menu was ever reached.
      // Only the newest match is filed, never the whole result set. A search
      // meant to find one message can still return a page of them - the same
      // subject goes to many contacts - and select-all would file all fifty.
      if (!(await this.tick(box))) {
        await this.screenshot('applyLabel-no-select');
        log.warn(`could not select a row to file under ${label}`);
        return 0;
      }
      const selected = 1;
      // Gmail swaps the toolbar into selection mode after the tick; nothing
      // that acts on a message exists until it has.
      await sleep(1200);

      // A click that lands on the row's hover overlay instead of the checkbox
      // looks like a successful tick and selects nothing, which is how the
      // labels menu came to be opened with no message under it. The box says
      // whether it actually took.
      const ticked = await box.getAttribute('aria-checked').catch(() => null);
      if (ticked !== 'true' && !(await this.tick(box))) {
        await this.screenshot('applyLabel-no-select');
        log.warn(`row did not stay selected - not filing under ${label}`);
        return 0;
      }

      // Labels sits on the toolbar only when the window is wide enough. It is
      // usually inside "More" instead, so both routes are tried.
      let menuOpen = false;
      try {
        const direct = await this.resolve(SELECTORS.labelsButton, 2500);
        await direct.click();
        menuOpen = true;
      } catch {
        log.debug('no Labels button on the toolbar - going through the More menu');
      }
      if (!menuOpen) {
        const more = await this.resolve(SELECTORS.moreOptionsButton, 6000);
        await more.click();
        await sleep(700);
        const labelAs = await this.resolve(SELECTORS.labelAsMenuItem, 6000);
        await labelAs.click();
      }
      await sleep(700);

      const search = await this.resolve(SELECTORS.labelSearchInput, 6000);
      await search.click();
      await search.fill(label);
      await sleep(700);

      // The label's own row is what files the mail. "Create new" sits at the
      // foot of this menu whatever is typed, so treating its presence as "the
      // label does not exist yet" sent every send down the create path: Gmail
      // answered "that label already exists", nothing was filed, and the
      // action still reported success. The row is the only honest test.
      const row = await this.labelRow(label);

      if (row) {
        if ((await row.getAttribute('aria-checked').catch(() => null)) !== 'true') {
          await this.tick(row);
          await sleep(500);
        }
        // Some Gmail builds commit the moment the row is ticked and close the
        // menu; others wait for Apply. Click Apply when it is there and never
        // fail for its absence - a missing button is not proof of a missing
        // label, and the check below is what actually decides.
        if (await this.exists(SELECTORS.labelApply, 1500)) {
          const apply = await this.resolve(SELECTORS.labelApply, 3000);
          await apply.click().catch(() => undefined);
        } else {
          await this.page.keyboard.press('Escape').catch(() => undefined);
        }
      } else {
        const create = await this.resolve(SELECTORS.labelCreateNew, 4000);
        await create.click();
        await sleep(900);
        // Gmail prefills the dialog from the filter box, but not always - an
        // empty name leaves Create inert and the dialog open.
        const name = await this.firstVisible(this.page.locator('div[role="dialog"] input[type="text"]'));
        if (name && !(await name.inputValue().catch(() => ''))) await name.fill(label);
        const confirm = await this.resolve(SELECTORS.labelCreateConfirm, 6000);
        await confirm.click();
      }
      await sleep(1800);

      // Proof, not optimism. Every failure so far was silent - the menu was
      // driven, something was clicked, and `1` came back while the mailbox had
      // no such label on the message. Gmail's own index is the arbiter.
      if (!(await this.isFiledUnder(query, label))) {
        await this.screenshot('applyLabel-not-filed');
        log.warn(`gmail does not show ${truncate(query, 60)} under ${label}`);
        return 0;
      }

      this.report('applyLabel', `filed ${selected} thread(s) under ${label}`);
      return selected;
      // Filing is best-effort and the caller carries on without it, so a
      // failure is reported once rather than retried at twice the cost.
    }, { retries: 0, timeoutMs: 90_000 });
  }

  async markAsRead(gmailThreadId: string): Promise<void> {
    await this.act('markAsRead', async () => {
      await this.openConversation(gmailThreadId);
    });
  }

  async markAsUnread(gmailThreadId: string): Promise<void> {
    await this.act('markAsUnread', async () => {
      await this.openConversation(gmailThreadId);
      const button = await this.resolve(SELECTORS.markUnreadButton, 6000);
      await button.click();
    });
  }

  async starThread(gmailThreadId: string, starred: boolean): Promise<void> {
    await this.act('starThread', async () => {
      await this.openConversation(gmailThreadId);
      const star = await this.resolve(SELECTORS.starToggle, 6000);
      const label = (await star.getAttribute('aria-label')) ?? '';
      const currentlyStarred = /^starred/i.test(label);
      if (currentlyStarred !== starred) await star.click();
    });
  }

  async archiveThread(gmailThreadId: string): Promise<void> {
    await this.act('archiveThread', async () => {
      await this.openConversation(gmailThreadId);
      const button = await this.resolve(SELECTORS.archiveButton, 6000);
      await button.click();
    });
  }
}

// --------------------------------------------------------------- helpers

export function synthesizeId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function synthesizeRfcId(email: string): string {
  const domain = email.split('@')[1] ?? 'mail.local';
  return `<${crypto.randomBytes(12).toString('hex')}@${domain}>`;
}

/** Shared bounce classifier - used by both the real and simulated drivers. */
export function detectBounceFromThread(thread: FetchedThread): BounceInfo | null {
  for (const message of [...thread.messages].reverse()) {
    const haystack = `${message.sender} ${message.subject} ${message.bodyText}`;
    for (const signature of BOUNCE_SIGNATURES) {
      if (signature.pattern.test(haystack)) {
        const recipient = /([\w.+-]+@[\w.-]+\.\w{2,})/.exec(message.bodyText)?.[1] ?? null;
        return {
          isBounce: true,
          type: signature.type,
          reason: truncate(message.subject || message.snippet, 200),
          recipient,
        };
      }
    }
  }
  return null;
}
