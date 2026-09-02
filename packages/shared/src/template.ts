/**
 * Template variable engine.
 *
 * Replaces the Apps Script string-replace loop with a single tokenizer that is
 * shared by the API (render before sending), the worker (final render) and the
 * React preview pane - so what a user previews is byte-identical to what gets
 * sent.
 *
 * Supported syntax:
 *   {{First Name}}                  canonical field
 *   {{firstName}}                   camelCase alias
 *   {{ Company Name | there }}      inline fallback when the value is empty
 */

export interface TemplateContext {
  [key: string]: string | number | null | undefined;
}

export interface RenderResult {
  output: string;
  used: string[];
  missing: string[];
}

/** Canonical merge fields exposed in the UI variable picker. */
export const STANDARD_VARIABLES = [
  'First Name',
  'Last Name',
  'Full Name',
  'Title',
  'Company Name',
  'Email',
  'Corporate Phone',
  'Employees',
  'Industry',
  'Keywords',
  'Person Linkedin Url',
  'Website',
  'Company Linkedin Url',
  'Company Address',
  'Company City',
  'Company State',
  'Company Country',
  'Qualify Contact',
] as const;

const normalise = (key: string): string => key.trim().toLowerCase().replace(/[\s_-]+/g, '');

/** Builds a lookup where "First Name", "firstName" and "first_name" all match. */
export function buildLookup(context: TemplateContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(context)) {
    if (value === null || value === undefined) continue;
    map.set(normalise(key), String(value));
  }
  return map;
}

const TOKEN_RE = /\{\{\s*([^{}|]+?)\s*(?:\|\s*([^{}]*?)\s*)?\}\}/g;

export function renderTemplate(template: string, context: TemplateContext): RenderResult {
  const lookup = buildLookup(context);
  const used = new Set<string>();
  const missing = new Set<string>();

  const output = (template ?? '').replace(TOKEN_RE, (_match, rawKey: string, fallback?: string) => {
    const key = rawKey.trim();
    const value = lookup.get(normalise(key));
    if (value !== undefined && value !== '') {
      used.add(key);
      return value;
    }
    if (fallback !== undefined) {
      used.add(key);
      return fallback;
    }
    missing.add(key);
    return '';
  });

  return { output, used: [...used], missing: [...missing] };
}

/** Every {{token}} found in a template, deduped and in order of appearance. */
export function extractVariables(template: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of (template ?? '').matchAll(TOKEN_RE)) {
    const key = (match[1] ?? '').trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      found.push(key);
    }
  }
  return found;
}

export interface ValidationIssue {
  variable: string;
  reason: 'UNKNOWN_VARIABLE' | 'EMPTY_VALUE';
}

/**
 * Pre-send validation. `knownFields` should contain the contact's own fields
 * plus any workspace custom fields.
 */
export function validateTemplate(
  template: string,
  knownFields: string[],
  sampleContext?: TemplateContext,
): ValidationIssue[] {
  const known = new Set(knownFields.map(normalise));
  const issues: ValidationIssue[] = [];
  const lookup = sampleContext ? buildLookup(sampleContext) : null;

  for (const variable of extractVariables(template)) {
    if (!known.has(normalise(variable))) {
      issues.push({ variable, reason: 'UNKNOWN_VARIABLE' });
      continue;
    }
    if (lookup && !lookup.get(normalise(variable))) {
      issues.push({ variable, reason: 'EMPTY_VALUE' });
    }
  }
  return issues;
}

/** Contact record -> template context, including the derived "Full Name". */
export function contactToContext(contact: Record<string, unknown>): TemplateContext {
  const get = (k: string) => (contact[k] == null ? '' : String(contact[k]));
  const fullName = [get('firstName'), get('lastName')].filter(Boolean).join(' ');

  const base: TemplateContext = {
    'First Name': get('firstName'),
    'Last Name': get('lastName'),
    'Full Name': fullName,
    Title: get('title'),
    'Company Name': get('companyName'),
    Email: get('email'),
    'Corporate Phone': get('corporatePhone'),
    Employees: get('employees'),
    Industry: get('industry'),
    Keywords: get('keywords'),
    'Person Linkedin Url': get('personLinkedinUrl'),
    Website: get('website'),
    'Company Linkedin Url': get('companyLinkedinUrl'),
    'Company Address': get('companyAddress'),
    'Company City': get('companyCity'),
    'Company State': get('companyState'),
    'Company Country': get('companyCountry'),
    'Qualify Contact': get('qualifyContact'),
  };

  // Custom fields are stored as a JSON blob and merged last so a workspace can
  // shadow nothing standard but can add anything it likes.
  const raw = contact.customJson;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const custom = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(custom)) {
        if (v != null) base[k] = String(v);
      }
    } catch {
      /* malformed custom blob is ignored rather than blocking a send */
    }
  }
  return base;
}

/** Very small HTML -> text conversion for the plain-text alternative part. */
export function htmlToText(html: string): string {
  return (html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    // Block-level elements become a blank line so the plain-text alternative
    // keeps the paragraph structure of the HTML part.
    .replace(/<\/(p|div|h[1-6]|blockquote|table)>/gi, '\n\n')
    .replace(/<\/(li|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo|bull|middot);/g, (_m, name: string) => {
      const map: Record<string, string> = {
        mdash: '—',
        ndash: '–',
        hellip: '…',
        lsquo: '‘',
        rsquo: '’',
        ldquo: '“',
        rdquo: '”',
        bull: '•',
        middot: '·',
      };
      return map[name] ?? '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Ampersand last so a decoded entity cannot be re-decoded.
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(value: string): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Builds the trimmed Gmail-style quoted chain used when a follow-up replies
 * inside an existing conversation. Mirrors the behaviour of the Apps Script
 * implementation (previous message quoted, older history collapsed).
 */
export function buildReplyChain(
  newBodyHtml: string,
  previous: { fromName?: string | null; fromEmail: string; sentAt: Date | string; bodyHtml: string } | null,
  maxQuotedChars = 4000,
): string {
  if (!previous) return newBodyHtml;

  const when = typeof previous.sentAt === 'string' ? new Date(previous.sentAt) : previous.sentAt;
  const stamp = when.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const who = previous.fromName ? `${previous.fromName} <${previous.fromEmail}>` : previous.fromEmail;

  let quoted = previous.bodyHtml ?? '';
  if (quoted.length > maxQuotedChars) {
    quoted = `${quoted.slice(0, maxQuotedChars)}<div>[... earlier message trimmed ...]</div>`;
  }

  return [
    newBodyHtml,
    '<br>',
    `<div class="gmail_quote">`,
    `<div dir="ltr" class="gmail_attr">On ${escapeHtml(stamp)}, ${escapeHtml(who)} wrote:</div>`,
    `<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">`,
    quoted,
    `</blockquote></div>`,
  ].join('\n');
}

/** Gmail-safe reply subject: never stacks more than one "Re: ". */
export function replySubject(subject: string): string {
  const clean = (subject ?? '').replace(/^(re:\s*)+/i, '').trim();
  return `Re: ${clean}`;
}
