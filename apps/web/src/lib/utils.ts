import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { formatDistanceToNowStrict, format, isToday, isYesterday, parseISO } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const toDate = (value: string | Date | null | undefined): Date | null => {
  if (!value) return null;
  const date = typeof value === 'string' ? parseISO(value) : value;
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Inbox-style timestamp: time today, "Yesterday", date beyond that. */
export function mailTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  if (isToday(date)) return format(date, 'HH:mm');
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'd MMM');
}

export function fullDateTime(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? format(date, 'd MMM yyyy, HH:mm') : '—';
}

export function dateOnly(value: string | Date | null | undefined): string {
  const date = toDate(value);
  return date ? format(date, 'd MMM yyyy') : '—';
}

export function relative(value: string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  if (Math.abs(diff) < 45_000) return diff >= 0 ? 'just now' : 'in a moment';
  return `${formatDistanceToNowStrict(date)}${diff >= 0 ? ' ago' : ''}`;
}

export function compactNumber(value: number | null | undefined): string {
  const n = value ?? 0;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return n.toLocaleString();
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function pct(value: number | null | undefined): string {
  return `${(value ?? 0).toFixed(1).replace(/\.0$/, '')}%`;
}

export function initialsOf(first?: string | null, last?: string | null, fallback?: string | null): string {
  const a = (first ?? '').trim()[0];
  const b = (last ?? '').trim()[0];
  if (a || b) return `${a ?? ''}${b ?? ''}`.toUpperCase();
  return (fallback ?? '?').trim()[0]?.toUpperCase() ?? '?';
}

export function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Strips scriptable content from HTML that originated in a mailbox or a
 * user-authored template before it is rendered with dangerouslySetInnerHTML.
 * The API also validates on write; this is the second line of defence.
 */
export function sanitizeEmailHtml(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

export function plainToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function htmlToPlain(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = sanitizeEmailHtml(html);
  return (div.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

export const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
];

export const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'UTC',
];
