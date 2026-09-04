/**
 * Everything this machine remembers between runs.
 *
 * Two values: where the server is, and the token proving this machine was
 * enrolled into one workspace. Deliberately not in the project's `.env` - that
 * file belongs to the server and carries database credentials, which is
 * exactly what an agent is designed never to hold.
 *
 * Kept in the user's own profile directory so a shared machine gives each
 * account its own enrolment, and so the file survives reinstalling the agent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AgentConfig {
  serverUrl: string;
  deviceToken: string;
  deviceId: string;
  workspaceId: string;
  machineName: string;
}

export const AGENT_VERSION = '1.0.0';

function configDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'MailFlow Agent');
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(base, 'mailflow-agent');
}

export const CONFIG_PATH = path.join(configDir(), 'agent.json');

export function readConfig(): AgentConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    if (!parsed.serverUrl || !parsed.deviceToken) return null;
    return parsed as AgentConfig;
  } catch {
    return null;
  }
}

export function writeConfig(config: AgentConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
  // Best effort: on POSIX this makes the token unreadable to other users. On
  // Windows there are no mode bits to set, and the profile directory is
  // already per-user, so failing here is not worth reporting.
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* not a POSIX filesystem */
  }
}

/**
 * Forgets this machine's enrolment.
 *
 * Called when the server says the device is revoked. Keeping a dead token
 * around would mean every future start hammers an endpoint that will only ever
 * answer 401.
 */
export function clearConfig(): void {
  fs.rmSync(CONFIG_PATH, { force: true });
}

/** Where the server lives, for a machine that has not enrolled yet. */
export function defaultServerUrl(): string {
  return (process.env.MAILFLOW_SERVER ?? '').replace(/\/+$/, '');
}

export function defaultMachineName(): string {
  return process.env.MAILFLOW_AGENT_NAME ?? `${os.hostname()} (${process.platform})`;
}
