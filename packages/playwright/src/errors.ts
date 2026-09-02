import type { AutomationErrorCode } from '@mail/shared';

/** Structured automation failure. Every browser action throws one of these. */
export class AutomationError extends Error {
  constructor(
    readonly code: AutomationErrorCode,
    message: string,
    readonly options: { retryable?: boolean; screenshotPath?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'AutomationError';
  }

  get retryable(): boolean {
    if (this.options.retryable !== undefined) return this.options.retryable;
    return RETRYABLE_CODES.includes(this.code);
  }
}

export const RETRYABLE_CODES: AutomationErrorCode[] = [
  'TIMEOUT',
  'NETWORK_ERROR',
  'SELECTOR_NOT_FOUND',
  'GMAIL_NOT_AVAILABLE',
  'RATE_LIMIT',
  'SEND_FAILED',
  'UNKNOWN_ERROR',
];

/** Maps an arbitrary thrown value onto the structured error taxonomy. */
export function classifyError(error: unknown): AutomationErrorCode {
  if (error instanceof AutomationError) return error.code;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (message.includes('timeout') || message.includes('timed out')) return 'TIMEOUT';
  if (message.includes('net::') || message.includes('econnrefused') || message.includes('enotfound'))
    return 'NETWORK_ERROR';
  if (message.includes('waiting for selector') || message.includes('locator') || message.includes('strict mode'))
    return 'SELECTOR_NOT_FOUND';
  if (message.includes('sign in') || message.includes('signin') || message.includes('captcha'))
    return 'SESSION_EXPIRED';
  // Chromium holds its profile directory exclusively: a second process that
  // tries to open the same one is refused at the lock, not at Gmail.
  if (message.includes('lockfile') || message.includes('singletonlock') || message.includes('already in use'))
    return 'PROFILE_IN_USE';
  if (message.includes('quota') || message.includes('rate limit') || message.includes('too many'))
    return 'RATE_LIMIT';
  if (message.includes('attachment') || message.includes('file chooser')) return 'ATTACHMENT_ERROR';
  if (message.includes('thread') && message.includes('not found')) return 'THREAD_NOT_FOUND';
  return 'UNKNOWN_ERROR';
}

/** Human-readable copy used by the UI and notifications. */
export const ERROR_MESSAGES: Record<AutomationErrorCode, string> = {
  AUTH_ERROR: 'The mailbox rejected authentication.',
  SESSION_EXPIRED: 'The browser session expired. Reconnect the mailbox.',
  PROFILE_IN_USE: 'Another process is already using this mailbox profile.',
  GMAIL_NOT_AVAILABLE: 'Gmail did not load. It may be temporarily unavailable.',
  SELECTOR_NOT_FOUND: 'A Gmail interface element could not be located.',
  ATTACHMENT_ERROR: 'An attachment could not be uploaded.',
  THREAD_NOT_FOUND: 'The conversation no longer exists in this mailbox.',
  SEND_FAILED: 'Gmail did not confirm the send.',
  BOUNCE: 'The message bounced.',
  RATE_LIMIT: 'The provider is rate limiting this mailbox.',
  TIMEOUT: 'The action timed out.',
  NETWORK_ERROR: 'A network error occurred.',
  SUPPRESSED: 'The recipient is on the suppression list.',
  DAILY_LIMIT_REACHED: 'The mailbox reached its daily sending limit.',
  OUTSIDE_SENDING_WINDOW: 'Outside the configured sending window.',
  UNKNOWN_ERROR: 'An unexpected error occurred.',
};
