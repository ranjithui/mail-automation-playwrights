/** Isomorphic helpers shared by the API, the worker and the React client. */

/** Safe JSON parse for the "*Json" text columns used by the portable schema. */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseList(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function randomBetween(min: number, max: number): number {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Gmail refuses to create a label that collides with one of its own, so a
 * campaign called "Drafts" is filed as "Drafts campaign" instead.
 */
const RESERVED_GMAIL_LABELS = new Set([
  'inbox', 'sent', 'drafts', 'draft', 'spam', 'trash', 'starred', 'important',
  'snoozed', 'scheduled', 'chats', 'all mail', 'unread', 'categories',
]);

/** Gmail stops accepting label names past this length. */
const MAX_GMAIL_LABEL = 225;

/**
 * Gmail label for a campaign: the campaign name itself.
 *
 * The name is the campaign's identity in Gmail, which is why it is unique per
 * workspace - see the `[workspaceId, name]` constraint on Campaign. Only what
 * Gmail cannot accept in a label is adjusted: `/` nests a label under a parent
 * and `^` is reserved, so both become spaces rather than silently producing a
 * tree nobody asked for.
 *
 * Built from the name once, at creation, and then stored: renaming a campaign
 * that has already filed mail must not orphan it under the old label.
 */
export function campaignLabelName(campaignName: string): string {
  const cleaned = (campaignName ?? '')
    .replace(/[/\^]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_GMAIL_LABEL)
    .trim();
  if (!cleaned) return 'Campaign';
  return RESERVED_GMAIL_LABELS.has(cleaned.toLowerCase()) ? `${cleaned} campaign` : cleaned;
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'workspace';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (value: string): boolean => EMAIL_RE.test((value ?? '').trim());
export const emailDomain = (value: string): string => (value ?? '').split('@')[1]?.toLowerCase() ?? '';
export const normalizeEmail = (value: string): string => (value ?? '').trim().toLowerCase();

export function initials(first?: string | null, last?: string | null, email?: string | null): string {
  const a = (first ?? '').trim()[0];
  const b = (last ?? '').trim()[0];
  if (a || b) return `${a ?? ''}${b ?? ''}`.toUpperCase();
  return (email ?? '?').trim()[0]?.toUpperCase() ?? '?';
}

export function displayName(contact: { firstName?: string | null; lastName?: string | null; email: string }): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
  return name || contact.email;
}

export function truncate(value: string, max = 140): string {
  const v = (value ?? '').trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

/** "HH:mm" -> minutes since midnight. Returns null for malformed input. */
export function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes-since-midnight for a Date rendered in an IANA timezone. */
export function minutesInTimezone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/** ISO weekday (1 = Monday .. 7 = Sunday) for a Date in an IANA timezone. */
export function isoWeekdayInTimezone(date: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(date);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[name] ?? 1;
}

export interface SendWindow {
  start: string;
  end: string;
  days: number[];
  timezone: string;
}

/** True when `at` falls inside the campaign sending window. */
export function isWithinSendWindow(at: Date, window: SendWindow): boolean {
  const start = parseClock(window.start) ?? 0;
  const end = parseClock(window.end) ?? 24 * 60;
  const days = window.days?.length ? window.days : [1, 2, 3, 4, 5];
  if (!days.includes(isoWeekdayInTimezone(at, window.timezone))) return false;
  const now = minutesInTimezone(at, window.timezone);
  return start <= end ? now >= start && now <= end : now >= start || now <= end;
}

/**
 * Next instant at or after `from` that sits inside the sending window.
 * Scans forward in 15-minute steps for at most 14 days, which keeps it exact
 * across DST transitions without pulling in a timezone library.
 */
export function nextSendWindowSlot(from: Date, window: SendWindow): Date {
  if (isWithinSendWindow(from, window)) return from;
  const step = 15 * 60 * 1000;
  const limit = from.getTime() + 14 * 24 * 60 * 60 * 1000;
  let cursor = from.getTime() + step;
  while (cursor <= limit) {
    const candidate = new Date(cursor);
    if (isWithinSendWindow(candidate, window)) return candidate;
    cursor += step;
  }
  return new Date(limit);
}

/** Exponential backoff used by both queue drivers: 30s, 2m, 10m, 30m ... */
export function backoffDelayMs(attempt: number): number {
  const ladder = [30_000, 120_000, 600_000, 1_800_000];
  return ladder[Math.min(attempt, ladder.length - 1)];
}

export function toIsoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}
