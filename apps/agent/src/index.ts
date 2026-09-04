/**
 * The MailFlow agent.
 *
 * Runs on the machine where a person is: it holds the Gmail browser profiles,
 * opens a window when somebody has to sign in, and does the browser work the
 * server asks for. It has no database connection and no inbound port beyond
 * its own control panel on loopback - it asks the server for work and reports
 * back, and that is the whole of its access.
 *
 * First run opens a small panel in the browser to paste a pairing code into.
 * After that it goes straight to waiting for work, and the same panel shows
 * what it is doing.
 */
import { createLogger, env } from '@mail/config';
import { AutomationError, GmailAutomationService, classifyError } from '@mail/playwright';
import type {
  AttachmentRef,
  ComposeRequest,
  MailboxDriver,
  MailboxIdentity,
  ReplyRequest,
  SyncOptions,
} from '@mail/playwright';
import {
  AGENT_VERSION,
  CONFIG_PATH,
  clearConfig,
  defaultMachineName,
  defaultServerUrl,
  readConfig,
  writeConfig,
} from './config.js';
import { RevokedError, ServerClient, type AgentTask } from './client.js';
import { openInBrowser, startUi, type AgentStatus } from './ui.js';

const log = createLogger('agent');

const HEARTBEAT_MS = 30_000;
/** Backoff after a failed poll, so a server restart is not a busy loop. */
const RETRY_MS = 5_000;
const UI_PORT = Number(process.env.AGENT_UI_PORT ?? 7420);
/** Enough history to see what just happened, not a log file. */
const RECENT_LIMIT = 12;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (date = new Date()) => date.toTimeString().slice(0, 8);
/** Console output only - the log formatter has its own newlines. */
const LF = String.fromCharCode(10);

// ------------------------------------------------------- what the panel shows

const recent: AgentStatus['recent'] = [];

const status: AgentStatus = {
  enrolled: false,
  serverUrl: '',
  machineName: defaultMachineName(),
  startedAt: new Date().toISOString(),
  waiting: false,
  mailboxes: [],
  recent,
};

function record(op: string, mailbox: string, ok: boolean, detail?: string) {
  recent.unshift({ at: clock(), op, mailbox, ok, detail });
  recent.length = Math.min(recent.length, RECENT_LIMIT);
}

// ------------------------------------------------------------ browser pool

/**
 * One driver per mailbox, kept alive between operations.
 *
 * A persistent Chromium profile takes seconds to launch and holds an exclusive
 * lock on its directory, so tearing it down between two sends would be both
 * slow and a way to trip over ourselves.
 */
const drivers = new Map<string, MailboxDriver>();

function driverFor(mailbox: AgentTask['mailbox']): MailboxDriver {
  const existing = drivers.get(mailbox.id);
  if (existing) return existing;

  const identity: MailboxIdentity = {
    accountId: mailbox.id,
    email: mailbox.email,
    displayName: mailbox.displayName,
  };
  const driver = new GmailAutomationService(identity, {
    onAction: (action, detail) => log.debug(`${mailbox.email} ${action}${detail ? `: ${detail}` : ''}`),
    onError: (code, message) => log.warn(`${mailbox.email} ${code}: ${message}`),
  });
  drivers.set(mailbox.id, driver);
  return driver;
}

// ---------------------------------------------------------------- dispatch

/** `since` is a Date on both sides but a string in between. */
function reviveOptions(raw: unknown): SyncOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const options = { ...(raw as SyncOptions & { since?: string | Date | null }) };
  if (typeof options.since === 'string') options.since = new Date(options.since);
  return options as SyncOptions;
}

/**
 * Turns the portable attachment descriptions back into local files.
 *
 * The server sent stored names because it has no idea what this machine's
 * filesystem looks like; Gmail's file picker needs a real path, so each one is
 * downloaded first.
 */
async function materialise(client: ServerClient, raw: unknown): Promise<AttachmentRef[]> {
  const list = Array.isArray(raw) ? raw : [];
  const out: AttachmentRef[] = [];
  for (const item of list as Array<{ filename: string; fileId: string; mimeType?: string; size?: number }>) {
    if (!item?.fileId) continue;
    out.push({
      filename: item.filename,
      path: await client.downloadFile(item.fileId, item.filename),
      mimeType: item.mimeType,
      size: item.size,
    });
  }
  return out;
}

/**
 * Runs one operation.
 *
 * The switch is the only place the two sides have to agree, and it mirrors
 * `RemoteMailboxDriver` method for method. Anything unknown is refused rather
 * than guessed at - a newer server talking to an older agent should fail
 * loudly on the one operation it added, not silently do the wrong thing.
 */
async function run(client: ServerClient, task: AgentTask): Promise<unknown> {
  const d = driverFor(task.mailbox);
  const a = task.args;
  const str = (key: string) => a[key] as string;
  const list = (key: string) => a[key] as string[] | undefined;

  switch (task.op) {
    case 'connect':
      return d.connect();
    case 'checkSession':
      return d.checkSession();
    case 'logout':
      return d.logout();
    case 'close': {
      await d.close();
      drivers.delete(task.mailbox.id);
      return null;
    }

    case 'openInbox':
      return d.openInbox();
    case 'openCompose':
      return d.openCompose();
    case 'fillRecipient':
      return d.fillRecipient(str('to'), list('cc'), list('bcc'));
    case 'fillSubject':
      return d.fillSubject(str('subject'));
    case 'fillBody':
      return d.fillBody(str('bodyHtml'));
    case 'attachFile': {
      const [attachment] = await materialise(client, [a.attachment]);
      return d.attachFile(attachment);
    }

    case 'saveDraft':
      return d.saveDraft({
        ...(a as unknown as ComposeRequest),
        attachments: await materialise(client, a.attachments),
      });
    case 'sendMessage':
      return d.sendMessage({
        ...(a as unknown as ComposeRequest),
        attachments: await materialise(client, a.attachments),
      });
    case 'replyToConversation': {
      const request = a.request as ReplyRequest & { attachments?: unknown };
      return d.replyToConversation(
        { ...request, attachments: await materialise(client, request.attachments) },
        a.mode as 'DRAFT' | 'SEND',
      );
    }

    case 'searchConversation':
      return d.searchConversation(str('gmailThreadId'));
    case 'openConversation':
      return d.openConversation(str('gmailThreadId'));
    case 'openConversationBySearch':
      return d.openConversationBySearch(str('query'));
    case 'getLatestMessage':
      return d.getLatestMessage(str('gmailThreadId'));
    case 'getThreadId':
      return d.getThreadId();
    case 'detectBounce':
      return d.detectBounce(str('gmailThreadId'));
    case 'fetchThreads':
      return d.fetchThreads(reviveOptions(a.options));
    case 'fetchThreadSummaries':
      return d.fetchThreadSummaries(reviveOptions(a.options));
    case 'fetchThread':
      return d.fetchThread(str('gmailThreadId'));

    case 'applyLabel':
      return d.applyLabel(str('query'), str('label'));
    case 'markAsRead':
      return d.markAsRead(str('gmailThreadId'));
    case 'markAsUnread':
      return d.markAsUnread(str('gmailThreadId'));
    case 'starThread':
      return d.starThread(str('gmailThreadId'), Boolean(a.starred));
    case 'archiveThread':
      return d.archiveThread(str('gmailThreadId'));

    default:
      throw new AutomationError('UNKNOWN_ERROR', `this agent does not know the operation "${task.op}"`, {
        retryable: false,
      });
  }
}

// ------------------------------------------------------------- self-check

/**
 * Answers "will this machine be able to drive a browser at all?"
 *
 *   mailflow-agent --check
 *
 * Worth having because the two things that go wrong here go wrong late: a
 * packaged build that cannot resolve Playwright, and a machine without the
 * Chrome the agent expects to drive. Both would otherwise first appear as a
 * failed connect, minutes after somebody typed a pairing code, with the real
 * reason buried in a screenshot.
 */
async function selfCheck(): Promise<number> {
  let failures = 0;
  const ok = (label: string, detail = '') => console.log(`  ok    ${label}${detail ? '  ' + detail : ''}`);
  const bad = (label: string, detail: string) => {
    failures += 1;
    console.log(`  FAIL  ${label}${LF}        ${detail}`);
  };

  console.log(`${LF}MailFlow agent ${AGENT_VERSION} - checking this machine${LF}`);

  let chromium: typeof import('playwright').chromium | null = null;
  try {
    ({ chromium } = await import('playwright'));
    ok('playwright loads');
  } catch (error) {
    bad('playwright loads', error instanceof Error ? error.message : String(error));
  }

  if (chromium) {
    const channel = env.PLAYWRIGHT_BROWSER_CHANNEL;
    try {
      const browser = await chromium.launch({
        headless: true,
        ...(channel ? { channel } : {}),
      });
      const version = browser.version();
      await browser.close();
      ok(channel ? `${channel} launches` : 'bundled chromium launches', version);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      bad(
        channel ? `${channel} launches` : 'bundled chromium launches',
        channel === 'chrome'
          ? 'Install Google Chrome, or set PLAYWRIGHT_BROWSER_CHANNEL= to use a downloaded browser. ' + message.split(LF)[0]
          : message.split(LF)[0],
      );
    }
  }

  const config = readConfig();
  if (config) ok('enrolled', `${config.machineName} -> ${config.serverUrl}`);
  else ok('not enrolled yet', 'run without --check to enrol');

  console.log(`${LF}${failures ? failures + ' check(s) failed' : 'all checks passed'}${LF}`);
  return failures;
}

// -------------------------------------------------------------------- loop

async function main() {
  if (process.argv.includes('--check')) process.exit(await selfCheck());

  const existing = readConfig();
  status.enrolled = Boolean(existing);
  status.serverUrl = existing?.serverUrl ?? defaultServerUrl();
  status.machineName = existing?.machineName ?? defaultMachineName();

  log.info(`MailFlow agent ${AGENT_VERSION}`);

  // Blocks until this machine is enrolled. Already-enrolled machines fall
  // straight through, with the panel left running as a status window.
  const panelUrl = await startUi({
    port: UI_PORT,
    getStatus: () => status,
    onEnrol: async (serverUrl, code) => {
      const machineName = defaultMachineName();
      const enrolled = await ServerClient.enrol(serverUrl, code, machineName);
      writeConfig({ serverUrl, machineName, ...enrolled });
      status.enrolled = true;
      status.serverUrl = serverUrl;
      status.machineName = machineName;
      log.info(`enrolled as "${machineName}" - token saved to ${CONFIG_PATH}`);
    },
  });

  const config = readConfig();
  if (!config) throw new Error('enrolment did not complete');

  const client = new ServerClient(config.serverUrl, config.deviceToken);

  log.info(`"${config.machineName}" -> ${config.serverUrl}`);
  log.info(`control panel: ${panelUrl}`);
  log.info(
    env.PLAYWRIGHT_HEADLESS
      ? 'headless - a mailbox that needs signing in will fail until PLAYWRIGHT_HEADLESS=false'
      : 'a browser window will open when a mailbox needs signing in',
  );

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal} - closing browsers`);
    for (const driver of drivers.values()) await driver.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  const revoked = async () => {
    status.waiting = false;
    record('revoked', 'this device', false, 'access was withdrawn in the dashboard');
    log.error('this device has been revoked in the dashboard - stopping and forgetting its token');
    clearConfig();
    for (const driver of drivers.values()) await driver.close().catch(() => undefined);
    process.exit(1);
  };

  // Status is reported on its own clock: an idle agent still needs to show as
  // online in the dashboard, and a busy one should not go quiet for minutes.
  setInterval(() => {
    void (async () => {
      const mailboxes = [];
      for (const [id, driver] of drivers) {
        const session = await driver.checkSession().catch(() => null);
        mailboxes.push({
          id,
          email: driver.identity.email,
          browserStatus: session ? 'RUNNING' : 'ERROR',
          sessionStatus: session?.connected ? 'VALID' : 'EXPIRED',
        });
      }
      status.mailboxes = mailboxes.map((m) => ({ email: m.email, browserStatus: m.browserStatus }));
      await client.heartbeat(mailboxes.map(({ id, browserStatus, sessionStatus }) => ({ id, browserStatus, sessionStatus })));
    })().catch((error) => {
      if (error instanceof RevokedError) void revoked();
      else log.debug(`heartbeat failed: ${String(error)}`);
    });
  }, HEARTBEAT_MS);

  log.info('waiting for work');
  status.waiting = true;

  for (;;) {
    try {
      const task = await client.nextTask();
      if (!task) continue;

      log.info(`${task.op} for ${task.mailbox.email}`);
      const started = Date.now();

      try {
        const result = await run(client, task);
        await client.reportSuccess(task.id, result ?? null);
        const ms = Date.now() - started;
        record(task.op, task.mailbox.email, true, `${ms}ms`);
        log.info(`${task.op} done in ${ms}ms`);
      } catch (error) {
        if (error instanceof RevokedError) throw error;
        const code = classifyError(error);
        const message = error instanceof Error ? error.message : String(error);
        const shot = error instanceof AutomationError ? error.options.screenshotPath : undefined;
        record(task.op, task.mailbox.email, false, `${code}: ${message.slice(0, 140)}`);
        log.warn(`${task.op} failed (${code}): ${message}`);
        // Reported rather than swallowed: the server is waiting on this row and
        // would otherwise sit through the whole lease before failing blind.
        await client.reportFailure(task.id, code, message, shot).catch((reportError) => {
          log.error(`could not report the failure: ${String(reportError)}`);
        });
      }
    } catch (error) {
      if (error instanceof RevokedError) return revoked();
      status.waiting = false;
      log.warn(`cannot reach the server: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(RETRY_MS);
      status.waiting = true;
    }
  }
}

main().catch((error) => {
  log.error('agent stopped', error);
  // Left open on purpose when it was double-clicked: a window that vanishes
  // takes the reason with it.
  if (process.platform === 'win32' && !process.stdout.isTTY) openInBrowser(`http://127.0.0.1:${UI_PORT}`);
  process.exit(1);
});
