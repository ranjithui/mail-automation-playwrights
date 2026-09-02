/**
 * Bounce report parsing.
 *
 * Kept free of Playwright and Prisma so it can be tested on fixture text: the
 * failure modes here are all about odd wording in a delivery report, and those
 * are much easier to pin down as strings than as a browser session.
 *
 * The important thing this file gets right is *which address bounced*. A Gmail
 * delivery report mentions several: the daemon that sent it, the mailbox that
 * sent the original, a support link, and - somewhere in there - the recipient
 * that actually failed. Taking the first address in the body, which is what the
 * platform used to do, suppresses the wrong person about as often as the right
 * one.
 */

const ADDRESS = String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`;

/**
 * Gmail search that finds delivery reports wherever they landed.
 *
 * A bounce is NOT part of the conversation it refers to: Gmail files the report
 * from Mail Delivery Subsystem as its own thread, and sometimes in spam. Only
 * re-reading the threads we sent - the platform's original approach - can never
 * see one, which is why no bounce had ever been recorded.
 */
export function bounceSearchQuery(days = 7): string {
  const window = Math.max(1, Math.ceil(days));
  return (
    `in:anywhere newer_than:${window}d ` +
    '(from:mailer-daemon OR from:postmaster OR ' +
    'subject:"Address not found" OR subject:"Delivery Status Notification" OR ' +
    'subject:"Delivery incomplete" OR subject:"Undelivered Mail Returned to Sender")'
  );
}

/** Senders that are never the bounced recipient, only the messenger. */
const MESSENGER = [
  /^mailer-daemon@/i,
  /^postmaster@/i,
  /^no-?reply@/i,
  /@googlemail\.com$/i,
  /@google\.com$/i,
  /@support\./i,
];

/**
 * Phrasings that name the failed recipient outright, in Gmail's own wording
 * and in the RFC 3464 report attached underneath it.
 */
const EXPLICIT: RegExp[] = [
  new RegExp(String.raw`(?:wasn'?t|was not|couldn'?t be) delivered to\s+(${ADDRESS})`, 'i'),
  new RegExp(String.raw`problem delivering your message to\s+(${ADDRESS})`, 'i'),
  new RegExp(String.raw`delivery to the following recipients? failed(?: permanently)?:?\s*(${ADDRESS})`, 'i'),
  new RegExp(String.raw`Final-Recipient:\s*(?:rfc822;)?\s*(${ADDRESS})`, 'i'),
  new RegExp(String.raw`Original-Recipient:\s*(?:rfc822;)?\s*(${ADDRESS})`, 'i'),
  new RegExp(String.raw`<(${ADDRESS})>:?\s*(?:Recipient address rejected|User unknown|host |Sorry)`, 'i'),
  new RegExp(String.raw`(?:^|\s)(${ADDRESS})\s*(?::|\s)\s*(?:Recipient address rejected|User unknown|does not exist)`, 'i'),
];

/**
 * Every address that could plausibly be the one that bounced, best guess first.
 *
 * The caller decides which to trust - the worker prefers a candidate that
 * matches a contact it actually mailed - so this deliberately returns a ranked
 * list rather than picking one and hiding the alternatives.
 */
export function extractFailedRecipients(bodyText: string, mailboxAddress?: string): string[] {
  const text = bodyText ?? '';
  const own = mailboxAddress?.toLowerCase().trim();
  const ranked: string[] = [];

  const consider = (value: string | undefined) => {
    if (!value) return;
    const address = value.toLowerCase().trim();
    if (address === own) return;
    if (MESSENGER.some((re) => re.test(address))) return;
    if (!ranked.includes(address)) ranked.push(address);
  };

  for (const pattern of EXPLICIT) consider(pattern.exec(text)?.[1]);

  // Fallback: anything left in the body, in the order it appears. A report we
  // do not have a phrasing for is still worth acting on if one of the
  // addresses in it turns out to be a contact we mailed.
  for (const match of text.matchAll(new RegExp(ADDRESS, 'gi'))) consider(match[0]);

  return ranked;
}
