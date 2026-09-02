/**
 * Cross-process realtime bus.
 *
 * The API owns the WebSocket server; the worker runs in a separate process.
 * Rather than requiring Redis pub/sub for local development, the worker posts
 * events to an internal API endpoint guarded by a shared secret. Inside the API
 * process the same call short-circuits to a direct broadcast.
 */
import { createLogger, env } from '@mail/config';
import type { RealtimeEvent } from '@mail/shared';

const log = createLogger('realtime');

type Broadcaster = (event: RealtimeEvent) => void;

let localBroadcaster: Broadcaster | null = null;

/** Called once by the API when its WebSocket server is ready. */
export function registerBroadcaster(fn: Broadcaster) {
  localBroadcaster = fn;
}

export const INTERNAL_EVENT_HEADER = 'x-internal-token';
export const internalToken = () => env.SESSION_SECRET;

export async function publish(
  workspaceId: string,
  type: RealtimeEvent['type'],
  payload: unknown,
): Promise<void> {
  const event: RealtimeEvent = { type, workspaceId, payload, at: new Date().toISOString() };

  if (localBroadcaster) {
    localBroadcaster(event);
    return;
  }

  try {
    await fetch(`${env.API_URL}/api/internal/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [INTERNAL_EVENT_HEADER]: internalToken() },
      body: JSON.stringify(event),
    });
  } catch (error) {
    // A missing API is never a reason to fail a job - realtime is advisory.
    log.debug('realtime publish failed (API unreachable)', error instanceof Error ? error.message : error);
  }
}
