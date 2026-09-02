/**
 * Unit tests for the pure logic the whole platform depends on:
 * template variables, scheduling, sequence maths, suppression matching,
 * retry backoff, idempotency and AI prompt/intent behaviour.
 *
 * Run with: npm test
 */
import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  buildReplyChain,
  campaignLabelName,
  contactToContext,
  emailDomain,
  extractVariables,
  htmlToText,
  isEmail,
  isWithinSendWindow,
  nextSendWindowSlot,
  normalizeEmail,
  parseClock,
  parseJson,
  parseList,
  percent,
  renderTemplate,
  replySubject,
  slugify,
  validateTemplate,
  type SendWindow,
} from '@mail/shared';
import { classifyInbound } from '@mail/core/inbox-sync';
import { GmailAutomationService, SELECTORS, bounceSearchQuery, extractFailedRecipients } from '@mail/playwright';
import { idempotencyKey } from '@mail/core/sequence';
import { LocalAIProvider } from '@mail/ai/local.provider';
import { buildReplyPrompt, GUARDRAILS, PROMPT_VERSIONS } from '@mail/ai/prompt.service';

/* ------------------------------------------------------- template engine */

describe('template variables', () => {
  const contact = {
    firstName: 'John',
    lastName: 'Smith',
    companyName: 'ABC Technologies',
    industry: 'SaaS',
    email: 'john@abc.example',
    customJson: JSON.stringify({ 'Renewal Month': 'March' }),
  };

  it('renders canonical, camelCase and snake_case spellings identically', () => {
    const context = contactToContext(contact);
    for (const token of ['{{First Name}}', '{{firstName}}', '{{first_name}}']) {
      expect(renderTemplate(token, context).output).toBe('John');
    }
  });

  it('derives Full Name and exposes custom fields', () => {
    const context = contactToContext(contact);
    expect(renderTemplate('{{Full Name}}', context).output).toBe('John Smith');
    expect(renderTemplate('{{Renewal Month}}', context).output).toBe('March');
  });

  it('uses the inline fallback when a value is missing or empty', () => {
    const context = contactToContext({ ...contact, firstName: '' });
    expect(renderTemplate('Hi {{First Name | there}},', context).output).toBe('Hi there,');
  });

  it('reports missing variables rather than silently printing empty text', () => {
    const result = renderTemplate('Hi {{Nickname}}', contactToContext(contact));
    expect(result.output).toBe('Hi ');
    expect(result.missing).toContain('Nickname');
  });

  it('extracts every distinct token in order', () => {
    expect(extractVariables('{{First Name}} at {{Company Name}} — {{First Name}}')).toEqual([
      'First Name',
      'Company Name',
    ]);
  });

  it('flags unknown variables and empty values before sending', () => {
    const issues = validateTemplate('{{First Name}} {{Nope}}', ['First Name'], { 'First Name': '' });
    expect(issues).toContainEqual({ variable: 'Nope', reason: 'UNKNOWN_VARIABLE' });
    expect(issues).toContainEqual({ variable: 'First Name', reason: 'EMPTY_VALUE' });
  });

  it('converts HTML to readable text and decodes entities', () => {
    expect(htmlToText('<p>Hi&nbsp;John</p><p>A &mdash; B &amp; C</p>')).toBe('Hi John\n\nA — B & C');
  });
});

/* -------------------------------------------------------- thread replies */

describe('Gmail thread replies', () => {
  it('never stacks more than one Re: prefix', () => {
    expect(replySubject('Re: Re: Proposal')).toBe('Re: Proposal');
    expect(replySubject('Proposal')).toBe('Re: Proposal');
  });

  it('quotes the previous message as a trimmed chain', () => {
    const chain = buildReplyChain('<p>New</p>', {
      fromName: 'John Smith',
      fromEmail: 'john@abc.example',
      sentAt: new Date('2026-01-05T10:00:00Z'),
      bodyHtml: '<p>Old</p>',
    });
    expect(chain).toContain('<p>New</p>');
    expect(chain).toContain('gmail_quote');
    expect(chain).toContain('John Smith');
    expect(chain).toContain('<p>Old</p>');
  });

  it('trims an over-long quoted history', () => {
    const chain = buildReplyChain('<p>New</p>', {
      fromEmail: 'a@b.example',
      sentAt: new Date(),
      bodyHtml: 'x'.repeat(9000),
    });
    expect(chain).toContain('earlier message trimmed');
    expect(chain.length).toBeLessThan(9000);
  });

  it('returns the body unchanged when there is nothing to quote', () => {
    expect(buildReplyChain('<p>New</p>', null)).toBe('<p>New</p>');
  });
});

/* ------------------------------------------------------------ scheduling */

describe('sending window', () => {
  const window: SendWindow = { start: '09:30', end: '17:30', days: [1, 2, 3, 4, 5], timezone: 'UTC' };

  it('parses and rejects clock strings', () => {
    expect(parseClock('09:30')).toBe(570);
    expect(parseClock('24:00')).toBeNull();
    expect(parseClock('nonsense')).toBeNull();
  });

  it('accepts a weekday inside the window', () => {
    // 2026-01-05 is a Monday.
    expect(isWithinSendWindow(new Date('2026-01-05T10:00:00Z'), window)).toBe(true);
  });

  it('rejects before the window opens, after it closes, and at weekends', () => {
    expect(isWithinSendWindow(new Date('2026-01-05T08:00:00Z'), window)).toBe(false);
    expect(isWithinSendWindow(new Date('2026-01-05T19:00:00Z'), window)).toBe(false);
    expect(isWithinSendWindow(new Date('2026-01-03T10:00:00Z'), window)).toBe(false);
  });

  it('moves a Saturday send to the next open weekday slot', () => {
    const slot = nextSendWindowSlot(new Date('2026-01-03T10:00:00Z'), window);
    expect(isWithinSendWindow(slot, window)).toBe(true);
    expect(slot.getUTCDay()).toBe(1);
  });

  it('leaves an in-window instant untouched', () => {
    const at = new Date('2026-01-05T10:00:00Z');
    expect(nextSendWindowSlot(at, window).getTime()).toBe(at.getTime());
  });

  it('honours the timezone rather than server local time', () => {
    const ist: SendWindow = { ...window, timezone: 'Asia/Kolkata' };
    // 05:00 UTC == 10:30 IST -> inside; 17:00 UTC == 22:30 IST -> outside.
    expect(isWithinSendWindow(new Date('2026-01-05T05:00:00Z'), ist)).toBe(true);
    expect(isWithinSendWindow(new Date('2026-01-05T17:00:00Z'), ist)).toBe(false);
  });
});

/* ----------------------------------------------------- retry/idempotency */

describe('retry and idempotency', () => {
  it('backs off exponentially and then plateaus', () => {
    expect(backoffDelayMs(0)).toBe(30_000);
    expect(backoffDelayMs(1)).toBe(120_000);
    expect(backoffDelayMs(2)).toBe(600_000);
    expect(backoffDelayMs(9)).toBe(1_800_000);
  });

  it('derives a stable key from campaign + contact + step', () => {
    expect(idempotencyKey('c1', 'p1', 's1')).toBe('c1:p1:s1');
    expect(idempotencyKey('c1', 'p1', 's1')).toBe(idempotencyKey('c1', 'p1', 's1'));
    expect(idempotencyKey('c1', 'p1', 's2')).not.toBe(idempotencyKey('c1', 'p1', 's1'));
  });
});

/* ------------------------------------------------------------ suppression */

describe('suppression matching', () => {
  it('normalises addresses and extracts domains', () => {
    expect(normalizeEmail('  John@ABC.Example ')).toBe('john@abc.example');
    expect(emailDomain('john@abc.example')).toBe('abc.example');
  });

  it('validates email shape', () => {
    expect(isEmail('john@abc.example')).toBe(true);
    expect(isEmail('john@abc')).toBe(false);
    expect(isEmail('not an email')).toBe(false);
  });
});

/* -------------------------------------------------- inbound classification */

describe('inbound classification', () => {
  const base = {
    gmailMessageId: 'm1',
    rfcMessageId: null,
    inReplyTo: null,
    senderName: null,
    recipients: [],
    cc: [],
    snippet: '',
    direction: 'INBOUND' as const,
    receivedAt: new Date(),
    isRead: false,
    attachments: [],
    bodyHtml: '',
  };

  it('detects a hard bounce from a mailer daemon', () => {
    const result = classifyInbound({
      ...base,
      sender: 'mailer-daemon@googlemail.com',
      subject: 'Delivery Status Notification (Failure)',
      bodyText: 'Address not found. 550 5.1.1 the account does not exist.',
    });
    expect(result.kind).toBe('BOUNCE');
  });

  it('detects an opt-out however it is phrased', () => {
    for (const text of ['Please remove me from your list', 'stop emailing me', 'unsubscribe']) {
      expect(classifyInbound({ ...base, sender: 'a@b.example', subject: 'Re: hi', bodyText: text }).kind).toBe(
        'UNSUBSCRIBE',
      );
    }
  });

  it('detects an auto-responder and does not treat it as a reply', () => {
    const result = classifyInbound({
      ...base,
      sender: 'a@b.example',
      subject: 'Automatic reply: Re: hi',
      bodyText: 'I am out of the office until Monday.',
    });
    expect(result.kind).toBe('OUT_OF_OFFICE');
  });

  it('treats an ordinary human answer as a reply', () => {
    const result = classifyInbound({
      ...base,
      sender: 'a@b.example',
      subject: 'Re: hi',
      bodyText: 'Sounds interesting, can you send more detail?',
    });
    expect(result.kind).toBe('REPLY');
  });
});

/* --------------------------------------------------------------------- AI */

describe('AI prompt construction', () => {
  const context = {
    contact: { name: 'John Smith', email: 'john@abc.example', company: 'ABC Technologies', title: 'CEO', industry: 'SaaS' },
    campaign: { name: 'SaaS Outreach', sequenceStep: 2, stepName: 'Follow-up 1' },
    conversation: [],
    latestMessage: 'Could you share your pricing?',
    originalMessage: 'Hi John,',
    sender: { name: 'Alex Morgan', email: 'sales@company.com' },
    style: 'PROFESSIONAL' as const,
    length: 'MEDIUM' as const,
    subject: 'Quick question about ABC Technologies',
  };

  it('is versioned so every stored result is traceable', () => {
    expect(buildReplyPrompt(context).version).toBe(PROMPT_VERSIONS.reply);
  });

  it('carries the guardrails into the system prompt', () => {
    const prompt = buildReplyPrompt(context);
    expect(prompt.system).toContain('Never invent pricing');
    expect(GUARDRAILS).toContain('Never invent pricing');
  });

  it('includes only the permitted context fields', () => {
    const prompt = buildReplyPrompt(context);
    expect(prompt.user).toContain('ABC Technologies');
    expect(prompt.user).toContain('SaaS Outreach');
    expect(prompt.user).toContain('Could you share your pricing?');
    expect(prompt.user).not.toContain('password');
    expect(prompt.user).not.toContain('cookie');
  });
});

describe('local AI provider', () => {
  const provider = new LocalAIProvider();
  const email = (text: string, subject = 'Re: proposal') => ({
    contact: null,
    subject,
    latestMessage: text,
    conversation: [],
  });

  it('classifies a pricing question as high priority', async () => {
    const result = await provider.classifyIntent(email('Could you share your pricing tiers?'));
    expect(result.intent).toBe('ASKING_PRICING');
    expect(result.priority).toBe('HIGH');
    expect(result.nextAction).toBe('SEND_PRICING');
  });

  it('classifies a meeting request', async () => {
    const result = await provider.classifyIntent(email('Do you have 30 minutes for a call next Tuesday?'));
    expect(result.intent).toBe('MEETING_REQUEST');
  });

  it('classifies an opt-out and a rejection distinctly', async () => {
    expect((await provider.classifyIntent(email('Please remove me from your list'))).intent).toBe('UNSUBSCRIBE');
    expect((await provider.classifyIntent(email('Not interested, we just renewed'))).intent).toBe('NOT_INTERESTED');
  });

  it('reports low confidence when nothing matches', async () => {
    const result = await provider.classifyIntent(email('Ok.'));
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('drafts a grounded reply that refuses to invent a price', async () => {
    const suggestion = await provider.generateReply({
      contact: { name: 'John Smith', email: 'j@a.example', company: 'ABC', title: null, industry: null },
      campaign: null,
      conversation: [],
      latestMessage: 'Could you share your pricing?',
      originalMessage: '',
      sender: { name: 'Alex Morgan', email: 'sales@company.com' },
      style: 'PROFESSIONAL',
      length: 'MEDIUM',
      subject: 'Re: pricing',
    });
    expect(suggestion.text).toContain('John');
    expect(suggestion.text).not.toMatch(/[$£€]\s?\d/);
    expect(suggestion.promptVersion).toBe(PROMPT_VERSIONS.reply);
  });

  it('shortens a draft without inventing new content', async () => {
    const draft = 'Para one.\n\nPara two.\n\nPara three.\n\nPara four.';
    const result = await provider.editDraft(draft, 'SHORTEN', {} as never);
    expect(result.text.split(/\n\s*\n/).length).toBeLessThan(4);
  });
});

/* ------------------------------------------------------------- utilities */

describe('shared utilities', () => {
  it('parses JSON columns without throwing on malformed input', () => {
    expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJson('not json', { fallback: true })).toEqual({ fallback: true });
    expect(parseList('["a","b"]')).toEqual(['a', 'b']);
    expect(parseList(null)).toEqual([]);
  });

  it('computes percentages safely', () => {
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 0)).toBe(0);
  });

  it('produces url-safe slugs', () => {
    expect(slugify('  Acme Ltd — Growth!  ')).toBe('acme-ltd-growth');
    expect(slugify('!!!')).toBe('workspace');
  });

  it('files a campaign under its own name in Gmail', () => {
    // The name is the label, verbatim - that is what makes one `label:` search
    // in the mailbox equal to one campaign in the app.
    expect(campaignLabelName('Test3 21-8')).toBe('Test3 21-8');
    expect(campaignLabelName('  Q3 Outreach  ')).toBe('Q3 Outreach');
    // '/' would nest the label under a parent nobody asked for, '^' is
    // reserved by Gmail, and Gmail rejects its own label names outright.
    expect(campaignLabelName('Q3 / EU')).toBe('Q3 EU');
    expect(campaignLabelName('Drafts')).toBe('Drafts campaign');
    expect(campaignLabelName('   ')).toBe('Campaign');
    expect(campaignLabelName('x'.repeat(300))).toHaveLength(225);
  });
});

/* ------------------------------------------------- selector resolution */

describe('selector resolution', () => {
  /**
   * A never-matching locator that burns exactly the timeout it is handed, so
   * a test can measure how the budget was spent across a candidate list.
   */
  const missingLocator = () => ({
    first: () => ({
      waitFor: ({ timeout }: { timeout: number }) =>
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('not visible')), timeout)),
    }),
  });

  const driver = () => {
    const service = new GmailAutomationService({ accountId: 'acc-1', email: 'sender@example.com' } as never);
    return service as unknown as {
      page: unknown;
      resolve: (group?: unknown, timeoutMs?: number) => Promise<any>;
      getThreadId(): Promise<string | null>;
      firstVisible(locator: unknown, max?: number): Promise<any>;
    };
  };

  const group = [
    { kind: 'css', value: 'div.one' },
    { kind: 'css', value: 'div.two' },
    { kind: 'css', value: 'div.three' },
  ];

  /**
   * A page that answers only for the selectors listed in `present`, the way a
   * real one would: css goes through `locator`, roles through `getByRole`,
   * text through `getByText`.
   */
  const pageShowing = (present: {
    css?: string[];
    roles?: Array<{ role: string; name: string }>;
    text?: string[];
  }) => {
    const hit = (found: boolean) => ({
      count: async () => (found ? 1 : 0),
      nth: () => ({ isVisible: async () => found }),
      first: () => ({
        waitFor: ({ timeout }: { timeout: number }) =>
          found
            ? Promise.resolve()
            : new Promise((_r, reject) => setTimeout(() => reject(new Error('not visible')), timeout)),
      }),
    });

    const matchesName = (name: unknown, actual: string) =>
      name === undefined ||
      (name instanceof RegExp ? name.test(actual) : String(name).toLowerCase() === actual.toLowerCase());

    return {
      locator: (selector: string) => hit((present.css ?? []).includes(selector)),
      getByRole: (role: string, options?: { name?: unknown }) =>
        hit(
          (present.roles ?? []).some(
            (candidate) => candidate.role === role && matchesName(options?.name, candidate.name),
          ),
        ),
      getByText: (value: string) => hit((present.text ?? []).some((t) => t.includes(value))),
      getByLabel: () => hit(false),
      getByPlaceholder: () => hit(false),
      getByTestId: () => hit(false),
    };
  };

  it('finds the on-screen row behind a session of stale result panes', async () => {
    // Gmail never removes a result pane, so the live rows sit at the end of a
    // long list of hidden ones. Examining only the first N matches reported an
    // empty mailbox while five results were plainly on screen - which is how
    // labelling worked early in a session and silently stopped later.
    // Shaped like the real thing: the driver's visibility test asks for a
    // bounding box and checkVisibility, so hidden panes answer 0x0.
    const nodes = Array.from({ length: 105 }, (_, i) => {
      const onScreen = i >= 100;
      return {
        getBoundingClientRect: () => ({ width: onScreen ? 240 : 0, height: onScreen ? 20 : 0 }),
        checkVisibility: () => onScreen,
      };
    });
    const locator = {
      evaluateAll: async (fn: (list: unknown[], arg: string) => number, arg: string) => fn(nodes, arg),
      nth: (i: number) => ({ index: i }),
      count: async () => nodes.length,
    };

    const service = driver();
    const found = await service.firstVisible(locator);
    expect(found).toEqual({ index: 100 });
  });

  it('keeps the compose query string out of a captured thread id', async () => {
    // Gmail's URL reads `#all/<id>?compose=new` while a compose window is open.
    // Taking the last path segment carried that into the id, and every later
    // `#all/<id>?compose=new` resolved nothing - which is how in-thread
    // follow-ups lost the thread they were meant to reply inside.
    const service = driver();
    const container = {
      getAttribute: async (name: string) =>
        name === 'data-thread-perm-id' ? 'KtbxLvHTBmFHzjwPLPjncgZgHdfLzpphJq?compose=new' : null,
    };
    service.resolve = async () => container;

    await expect(service.getThreadId()).resolves.toBe('KtbxLvHTBmFHzjwPLPjncgZgHdfLzpphJq');
  });

  it('does not mistake the signed-out Gmail page for a loaded mailbox', async () => {
    // What mail.google.com serves a profile with no session: a marketing page.
    // It has a <main>, which is why "role=main" alone once passed for a
    // connected mailbox - the mailbox then failed every send minutes later
    // because Compose does not exist on a page nobody is signed in to.
    const service = driver();
    service.page = pageShowing({
      css: ['main'],
      roles: [
        { role: 'main', name: '' },
        { role: 'link', name: 'Sign in' },
        { role: 'link', name: 'Create an account' },
      ],
      text: ['AI-powered email for everyone'],
    });

    await expect(service.resolve(SELECTORS.inboxReady, 300)).rejects.toThrow(/no candidate matched/);
    await expect(service.resolve(SELECTORS.signInDetected, 300)).resolves.toBeTruthy();
  });

  it('recognises the real mailbox by its own hooks', async () => {
    const service = driver();
    service.page = pageShowing({
      css: ['div[gh="cm"]', 'div[gh="tm"]', 'div.AO', 'div[role="main"]'],
      roles: [{ role: 'main', name: '' }],
    });

    await expect(service.resolve(SELECTORS.inboxReady, 300)).resolves.toBeTruthy();
    await expect(service.resolve(SELECTORS.signInDetected, 300)).rejects.toThrow(/no candidate matched/);
  });

  it('spends the timeout on the group, not on each candidate', async () => {
    const service = driver();
    service.page = { locator: () => missingLocator() };

    const started = Date.now();
    await expect(service.resolve(group, 600)).rejects.toThrow(/no candidate matched/);
    const elapsed = Date.now() - started;

    // Three candidates once cost 3 x 600ms, overrunning the caller's deadline -
    // and on a send that overrun triggered a retry that delivered a duplicate.
    expect(elapsed).toBeLessThan(1200);
  });

  it('still returns a lower-ranked candidate when it is the one on the page', async () => {
    const service = driver();
    const match = { waitFor: async () => undefined, marker: 'third' };
    service.page = {
      locator: (value: string) => (value === 'div.three' ? { first: () => match } : missingLocator()),
    };

    await expect(service.resolve(group, 600)).resolves.toBe(match);
  });
});

/* --------------------------------------------------------- bounce reports */

describe('bounce report parsing', () => {
  const MAILBOX = 'sender@ourcompany.com';

  // Gmail's own wording, as it appears in the web UI.
  const ADDRESS_NOT_FOUND = `
    Address not found
    Your message wasn't delivered to vincent.georges@aesope.fr because the address
    couldn't be found, or is unable to receive mail.
    LEARN MORE
    The response from the remote server was:
    550 5.1.1 <vincent.georges@aesope.fr>: Recipient address rejected: User unknown
  `;

  const DSN_FAILURE = `
    Delivery Status Notification (Failure)
    ** Address not found **
    Delivery to the following recipient failed permanently: thomas@cofipa.fr
    Technical details of permanent failure:
    Google tried to deliver your message, but it was rejected by the server for the
    recipient domain cofipa.fr by mx.cofipa.fr. [1.2.3.4].
    Final-Recipient: rfc822; thomas@cofipa.fr
  `;

  const MAILBOX_FULL = `
    Your message wasn't delivered to romain@hottinguer.fr because their inbox is full
    or is not accepting messages right now.
  `;

  it('names the recipient that actually failed, not the daemon or ourselves', () => {
    expect(extractFailedRecipients(ADDRESS_NOT_FOUND, MAILBOX)[0]).toBe('vincent.georges@aesope.fr');
    expect(extractFailedRecipients(DSN_FAILURE, MAILBOX)[0]).toBe('thomas@cofipa.fr');
    expect(extractFailedRecipients(MAILBOX_FULL, MAILBOX)[0]).toBe('romain@hottinguer.fr');
  });

  it('never offers the sending mailbox or the postmaster as the bounced address', () => {
    const report = `
      From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
      Your message from ${MAILBOX} wasn't delivered to lea@aesope.fr.
      Reply to postmaster@googlemail.com for help. See https://support.google.com/mail
    `;
    const candidates = extractFailedRecipients(report, MAILBOX);
    expect(candidates[0]).toBe('lea@aesope.fr');
    expect(candidates).not.toContain(MAILBOX);
    expect(candidates.some((c) => c.includes('mailer-daemon'))).toBe(false);
    expect(candidates.some((c) => c.includes('postmaster'))).toBe(false);
  });

  it('falls back to the addresses present when the wording is unfamiliar', () => {
    const odd = 'Undeliverable: your note to claire@metentis.fr could not be processed.';
    expect(extractFailedRecipients(odd, MAILBOX)).toEqual(['claire@metentis.fr']);
    expect(extractFailedRecipients('no addresses at all', MAILBOX)).toEqual([]);
  });

  it('searches where the report actually lands, not the thread we sent', () => {
    const query = bounceSearchQuery(7);
    expect(query).toContain('in:anywhere');
    expect(query).toContain('newer_than:7d');
    expect(query).toContain('from:mailer-daemon');
    expect(query).toContain('from:postmaster');
    expect(query).toContain('Address not found');
  });
});
