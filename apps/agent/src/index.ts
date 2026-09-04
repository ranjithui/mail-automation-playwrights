/**
 * The MailFlow agent.
 *
 * Runs on the machine where a person is: it holds the Gmail browser profiles,
 * opens a window when somebody has to sign in, and does the browser work the
 * server asks for. It has no database connection and no inbound port - it asks
 * the server for work and reports back, and that is the whole of its access.
 *
 *   npm run start:agent
 *
 * First run asks for a pairing code from the dashboard. After that it starts
 * straight into its poll loop.
 */
import readline from 'node:readline/promises';
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

const log = createLogger('agent');

const HEARTBEAT_MS = 30_000;
/** Backoff after a failed poll, so a server restart is not a busy loop. */
const RETRY_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------- enrolment

async function enrol(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('  MailFlow agent - first run');
    console.log('  ---------------------------------------------------------');
    console.log('  In the dashboard: Devices -> Add device, and copy the code.');
    console.log('');

    let serverUrl = defaultServerUrl();
    if (!serverUrl) {
      serverUrl = (await rl.question('  Server URL (e.g. https://mailflow-vs2j.onrender.com): ')).trim();
    }
    serverUrl = serverUrl.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(serverUrl)) throw new Error('that does not look like a URL');

    const code = (await rl.question('  Pairing code: ')).trim();
    const machineName = defaultMachineName();

    const enrolled = await ServerClient.enrol(serverUrl, code, machineName);
    writeConfig({ serverUrl, machineName, ...enrolled });

    console.log('');
    console.log(`  Enrolled as "${machineName}".`);
    console.log(`  Saved to ${CONFIG_PATH}`);
    console.log('');
  } finally {
    rl.close();
  }
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

// -------------------------------------------------------------------- loop

async function main() {
  if (!readConfig()) await enrol();

  const config = readConfig();
  if (!config) throw new Error('enrolment did not complete');

  const client = new ServerClient(config.serverUrl, config.deviceToken);

  log.info(`agent ${AGENT_VERSION} for "${config.machineName}"`);
  log.info(`server ${config.serverUrl}`);
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

  // Status is reported on its own clock: an idle agent still needs to show as
  // online in the dashboard, and a busy one should not go quiet for minutes.
  const beat = setInterval(() => {
    void (async () => {
      const mailboxes = [];
      for (const [id, driver] of drivers) {
        const session = await driver.checkSession().catch(() => null);
        mailboxes.push({
          id,
          browserStatus: session ? 'RUNNING' : 'ERROR',
          sessionStatus: session?.connected ? 'VALID' : 'EXPIRED',
        });
      }
      await client.heartbeat(mailboxes);
    })().catch((error) => {
      if (error instanceof RevokedError) void revoked();
      else log.debug(`heartbeat failed: ${String(error)}`);
    });
  }, HEARTBEAT_MS);

  const revoked = async () => {
    clearInterval(beat);
    log.error('this device has been revoked in the dashboard - stopping and forgetting its token');
    clearConfig();
    for (const driver of drivers.values()) await driver.close().catch(() => undefined);
    process.exit(1);
  };

  log.info('waiting for work');

  for (;;) {
    try {
      const task = await client.nextTask();
      if (!task) continue;

      log.info(`${task.op} for ${task.mailbox.email}`);
      const started = Date.now();

      try {
        const result = await run(client, task);
        await client.reportSuccess(task.id, result ?? null);
        log.info(`${task.op} done in ${Date.now() - started}ms`);
      } catch (error) {
        if (error instanceof RevokedError) throw error;
        const code = classifyError(error);
        const message = error instanceof Error ? error.message : String(error);
        const shot = error instanceof AutomationError ? error.options.screenshotPath : undefined;
        log.warn(`${task.op} failed (${code}): ${message}`);
        // Reported rather than swallowed: the server is waiting on this row and
        // would otherwise sit through the whole lease before failing blind.
        await client.reportFailure(task.id, code, message, shot).catch((reportError) => {
          log.error(`could not report the failure: ${String(reportError)}`);
        });
      }
    } catch (error) {
      if (error instanceof RevokedError) return revoked();
      log.warn(`cannot reach the server: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(RETRY_MS);
    }
  }
}

main().catch((error) => {
  log.error('agent stopped', error);
  process.exit(1);
});
