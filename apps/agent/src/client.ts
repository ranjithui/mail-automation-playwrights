/**
 * The agent's side of the wire.
 *
 * Four calls, all outbound HTTPS: enrol once, then poll for work, report it,
 * and say hello periodically. Nothing listens on this machine, so no port is
 * opened, no firewall rule is needed, and the agent works from behind any
 * home or office router.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AGENT_VERSION } from './config.js';

export class RevokedError extends Error {
  constructor() {
    super('this device is no longer enrolled');
    this.name = 'RevokedError';
  }
}

export interface AgentTask {
  id: string;
  op: string;
  args: Record<string, unknown>;
  mailbox: { id: string; email: string; displayName: string };
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

/**
 * The poll is held open by the server for 25 seconds, so the client's own
 * ceiling has to sit above that or every idle poll would look like a failure.
 */
const POLL_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 30_000;

export class ServerClient {
  constructor(
    private readonly serverUrl: string,
    private readonly token?: string,
  ) {}

  private async request<T>(
    method: string,
    routePath: string,
    body?: unknown,
    timeoutMs = CALL_TIMEOUT_MS,
  ): Promise<{ status: number; data: T | null }> {
    const response = await fetch(`${this.serverUrl}${routePath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // A revoked or deleted device is told exactly once, on whatever call it
    // happens to make next, and stops.
    if (response.status === 401) throw new RevokedError();
    if (response.status === 204) return { status: 204, data: null };

    const envelope = (await response.json().catch(() => null)) as Envelope<T> | null;

    if (!response.ok || !envelope?.success) {
      const detail = envelope?.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`${method} ${routePath} failed: ${detail}`);
    }

    return { status: response.status, data: envelope.data ?? null };
  }

  static async enrol(
    serverUrl: string,
    code: string,
    machineName: string,
  ): Promise<{ deviceToken: string; deviceId: string; workspaceId: string }> {
    const client = new ServerClient(serverUrl);
    const { data } = await client.request<{ deviceToken: string; deviceId: string; workspaceId: string }>(
      'POST',
      '/api/agent/enrol',
      { code, machineName, platform: process.platform, agentVersion: AGENT_VERSION },
    );
    if (!data) throw new Error('the server accepted the code but returned no token');
    return data;
  }

  /** Blocks until there is work, or returns null when the hold expires. */
  async nextTask(): Promise<AgentTask | null> {
    const { status, data } = await this.request<AgentTask>('GET', '/api/agent/work', undefined, POLL_TIMEOUT_MS);
    return status === 204 ? null : data;
  }

  async reportSuccess(taskId: string, result: unknown): Promise<void> {
    await this.request('POST', `/api/agent/work/${taskId}`, { ok: true, result });
  }

  async reportFailure(
    taskId: string,
    code: string,
    message: string,
    screenshotPath?: string,
  ): Promise<void> {
    let screenshotBase64: string | undefined;
    if (screenshotPath) {
      try {
        const bytes = fs.readFileSync(screenshotPath);
        // Capped: a failure report that is too large to accept is a failure
        // report that never arrives, which is worse than one without a picture.
        if (bytes.byteLength <= 5_000_000) screenshotBase64 = bytes.toString('base64');
      } catch {
        /* a missing screenshot must never mask the error it illustrates */
      }
    }
    await this.request('POST', `/api/agent/work/${taskId}`, { ok: false, code, message, screenshotBase64 });
  }

  async heartbeat(
    mailboxes: Array<{ id: string; browserStatus: string; sessionStatus: string }>,
  ): Promise<void> {
    await this.request('POST', '/api/agent/heartbeat', { agentVersion: AGENT_VERSION, mailboxes });
  }

  /**
   * Fetches an attachment into a temporary file.
   *
   * The server holds the file; this machine needs a path to hand to the file
   * picker. Names are randomised locally so two sends of the same attachment
   * cannot collide mid-upload.
   */
  async downloadFile(fileId: string, filename: string): Promise<string> {
    const response = await fetch(`${this.serverUrl}/api/agent/files/${encodeURIComponent(fileId)}`, {
      headers: { authorization: `Bearer ${this.token ?? ''}` },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (response.status === 401) throw new RevokedError();
    if (!response.ok) throw new Error(`could not download attachment ${filename}: HTTP ${response.status}`);

    const dir = path.join(os.tmpdir(), 'mailflow-agent', crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(filename) || 'attachment');
    fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    return target;
  }
}
