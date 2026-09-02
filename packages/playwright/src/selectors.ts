/**
 * Gmail selector strategies.
 *
 * Gmail ships obfuscated class names that change without notice, so nothing
 * here depends on a single CSS hook. Each logical element is a ranked list of
 * candidates - ARIA role, accessible name, label, stable attribute, then a CSS
 * fallback - and `resolve()` in gmail-automation.service.ts walks the list
 * until one resolves.
 */

export interface SelectorCandidate {
  kind: 'role' | 'label' | 'placeholder' | 'text' | 'css' | 'testid';
  value: string;
  /** Accessible name for role-based lookups. */
  name?: string | RegExp;
  exact?: boolean;
}

export type SelectorGroup = SelectorCandidate[];

export const GMAIL_URL = 'https://mail.google.com/mail/u/0/';

export const SELECTORS = {
  /**
   * Proof that the *mailbox* is on screen, not merely that a page loaded.
   *
   * `role=main` is not proof and cannot be kept even as a fallback: signed
   * out, mail.google.com serves a marketing page that has a `<main>` too, so a
   * dead session read as a connected one and only failed minutes later when
   * Compose was nowhere to be found. Every candidate here is a hook that
   * exists only inside the mail app - Gmail's own `gh` attributes on the
   * compose and toolbar containers, and the list pane.
   */
  inboxReady: [
    { kind: 'css', value: 'div[gh="cm"]' },
    { kind: 'css', value: 'div[gh="tm"]' },
    { kind: 'css', value: 'div.AO' },
  ] as SelectorGroup,

  /**
   * Any page that means "nobody is signed in here".
   *
   * Two different pages say it. The credential form is the obvious one; the
   * other is the Gmail product page Google serves at mail.google.com when the
   * profile has no session at all, which carries no credential form and so
   * went unrecognised - the reason a fresh mailbox connected "successfully"
   * and then failed every send.
   */
  signInDetected: [
    { kind: 'css', value: 'input[type="email"][name="identifier"]' },
    { kind: 'text', value: 'Sign in to continue' },
    { kind: 'css', value: '#identifierId' },
    { kind: 'role', value: 'link', name: /^sign in$/i },
    { kind: 'role', value: 'button', name: /^sign in$/i },
    { kind: 'role', value: 'link', name: /^create an account$/i },
  ] as SelectorGroup,

  composeButton: [
    { kind: 'role', value: 'button', name: /^compose$/i },
    { kind: 'text', value: 'Compose' },
    { kind: 'css', value: 'div[gh="cm"]' },
    { kind: 'css', value: 'div[role="button"][jsname]' },
  ] as SelectorGroup,

  composeDialog: [
    { kind: 'role', value: 'dialog', name: /new message/i },
    { kind: 'css', value: 'div[role="dialog"]' },
    { kind: 'css', value: 'div.nH.Hd' },
  ] as SelectorGroup,

  recipientTo: [
    { kind: 'role', value: 'combobox', name: /^to recipients$/i },
    { kind: 'label', value: 'To recipients' },
    { kind: 'css', value: 'input[aria-label="To recipients"]' },
    { kind: 'css', value: 'textarea[name="to"]' },
    { kind: 'css', value: 'input[peoplekit-id]' },
  ] as SelectorGroup,

  recipientCc: [
    { kind: 'role', value: 'combobox', name: /^cc recipients$/i },
    { kind: 'css', value: 'input[aria-label="CC recipients"]' },
    { kind: 'css', value: 'textarea[name="cc"]' },
  ] as SelectorGroup,

  recipientBcc: [
    { kind: 'role', value: 'combobox', name: /^bcc recipients$/i },
    { kind: 'css', value: 'input[aria-label="BCC recipients"]' },
    { kind: 'css', value: 'textarea[name="bcc"]' },
  ] as SelectorGroup,

  ccToggle: [
    { kind: 'role', value: 'button', name: /add cc recipients/i },
    { kind: 'css', value: 'span[aria-label="Add Cc recipients"]' },
  ] as SelectorGroup,

  bccToggle: [
    { kind: 'role', value: 'button', name: /add bcc recipients/i },
    { kind: 'css', value: 'span[aria-label="Add Bcc recipients"]' },
  ] as SelectorGroup,

  subjectInput: [
    { kind: 'role', value: 'textbox', name: /^subject$/i },
    { kind: 'label', value: 'Subject' },
    { kind: 'css', value: 'input[name="subjectbox"]' },
  ] as SelectorGroup,

  bodyInput: [
    { kind: 'role', value: 'textbox', name: /message body/i },
    { kind: 'label', value: 'Message Body' },
    { kind: 'css', value: 'div[aria-label="Message Body"]' },
    { kind: 'css', value: 'div[g_editable="true"][role="textbox"]' },
  ] as SelectorGroup,

  attachButton: [
    { kind: 'role', value: 'button', name: /attach files/i },
    { kind: 'css', value: 'div[command="Files"]' },
    { kind: 'css', value: 'input[type="file"]' },
  ] as SelectorGroup,

  sendButton: [
    { kind: 'role', value: 'button', name: /^send/i },
    { kind: 'css', value: 'div[role="button"][data-tooltip^="Send"]' },
    { kind: 'css', value: 'div[aria-label^="Send"]' },
  ] as SelectorGroup,

  saveDraftClose: [
    { kind: 'role', value: 'button', name: /save & close/i },
    { kind: 'css', value: 'img[aria-label="Save & close"]' },
    { kind: 'css', value: 'div[aria-label="Save & close"]' },
  ] as SelectorGroup,

  sentConfirmation: [
    { kind: 'text', value: 'Message sent' },
    { kind: 'css', value: 'div.bAq span:has-text("Message sent")' },
    { kind: 'css', value: 'div[role="alert"]' },
  ] as SelectorGroup,

  searchInput: [
    { kind: 'role', value: 'combobox', name: /search mail/i },
    { kind: 'role', value: 'searchbox' },
    { kind: 'css', value: 'input[aria-label="Search mail"]' },
    { kind: 'css', value: 'input[aria-label="Search in mail"]' },
    { kind: 'css', value: 'input[placeholder*="Search" i]' },
    { kind: 'css', value: 'form[role="search"] input' },
    { kind: 'css', value: 'input[name="q"]' },
  ] as SelectorGroup,

  threadRows: [
    { kind: 'css', value: 'tr.zA' },
    { kind: 'css', value: 'div[role="main"] table[role="grid"] tr' },
  ] as SelectorGroup,

  /**
   * Proof that a conversation is open.
   *
   * `data-thread-perm-id` is on the subject <h2>, not on a <div>, and the old
   * `div[...]`-prefixed selectors here matched nothing - which is why reading a
   * thread id always failed and every send recorded a synthesized one instead.
   * A message block is the surest sign: it exists only inside an open thread.
   */
  openThreadContainer: [
    { kind: 'css', value: 'div[role="main"] [data-message-id]' },
    { kind: 'css', value: '[data-thread-perm-id]' },
    { kind: 'css', value: 'h2.hP' },
    { kind: 'css', value: '[role="listitem"][data-legacy-thread-id]' },
    { kind: 'css', value: 'div.nH.if' },
  ] as SelectorGroup,

  messageBlocks: [
    { kind: 'css', value: 'div[data-message-id]' },
    { kind: 'css', value: 'div.adn.ads' },
  ] as SelectorGroup,

  replyButton: [
    { kind: 'role', value: 'button', name: /^reply$/i },
    { kind: 'css', value: 'div[role="button"][aria-label^="Reply"]' },
    { kind: 'css', value: 'span.ams.bkH' },
  ] as SelectorGroup,

  archiveButton: [
    { kind: 'role', value: 'button', name: /^archive$/i },
    { kind: 'css', value: 'div[aria-label="Archive"]' },
  ] as SelectorGroup,

  /** Header "Select all" checkbox above a result list. */
  selectAllCheckbox: [
    { kind: 'css', value: 'div[role="main"] [role="checkbox"][aria-label*="Select"]' },
    { kind: 'css', value: 'span.T-Jo-auh' },
  ] as SelectorGroup,

  /**
   * Toolbar "Labels" button, shown only once something is selected.
   *
   * Gmail relabels this control between releases - tooltip, aria-label and the
   * legacy `act` code have all been the only working hook at some point - so
   * every form it has taken is listed rather than any one of them trusted.
   */
  labelsButton: [
    // Tag-agnostic on purpose. These controls are not always <div>, and a
    // `div[...]` selector silently misses a button that is plainly on the page
    // - which is exactly how this went unfound for several rounds.
    { kind: 'css', value: '[role="button"][data-tooltip="Labels"]' },
    { kind: 'css', value: '[role="button"][aria-label="Labels"]' },
    { kind: 'css', value: '[act="19"]' },
    { kind: 'css', value: '[role="button"][data-tooltip^="Label"]' },
    // Anything looser than a toolbar tooltip is deliberately not listed: a bare
    // "Label" accessible name also matches the sidebar, and clicking that
    // navigates away instead of opening the menu - a wrong element found is
    // worse than no element found.
  ] as SelectorGroup,

  /**
   * Toolbar overflow menu.
   *
   * Gmail collapses the message-action buttons into "More" whenever the window
   * is narrow - which, at the viewport this driver runs at with the side panel
   * showing, is always. Labels is inside it, not on the toolbar.
   */
  moreOptionsButton: [
    { kind: 'css', value: '[role="button"][aria-label="More email options"]' },
    { kind: 'css', value: '[role="button"][data-tooltip="More"]' },
    { kind: 'css', value: '[act="30"]' },
  ] as SelectorGroup,

  /** "Label as" entry inside the overflow menu. */
  labelAsMenuItem: [
    // The overflow menu labels nothing: its items carry no aria-label and no
    // `act` code, only visible text ("Label as" plus a submenu arrow). Text is
    // the only hook there is.
    { kind: 'css', value: '[role="menuitem"]:has-text("Label as")' },
    { kind: 'css', value: '[role="menuitem"][aria-label="Label as"]' },
    { kind: 'text', value: 'Label as' },
  ] as SelectorGroup,

  /** The "Label as:" filter box inside the labels menu. */
  labelSearchInput: [
    { kind: 'css', value: 'input[placeholder="Label as:"]' },
    { kind: 'css', value: 'input[placeholder^="Label"]' },
    // The input itself carries these classes - it is not a descendant of them.
    { kind: 'css', value: 'input.h-J-Ji' },
    { kind: 'css', value: 'div.J-M input[type="text"]' },
    { kind: 'css', value: 'div[role="menu"] input[type="text"]' },
    { kind: 'css', value: 'div[role="menu"] input' },
    { kind: 'placeholder', value: 'Label as:' },
  ] as SelectorGroup,

  /**
   * One label's row inside the labels menu, ticked to file the selection under
   * it. Gmail gives these `role="menuitemcheckbox"` and carries the state in
   * `aria-checked`; the row for a particular name is picked by text, so there
   * is no name-specific selector here.
   */
  labelOptionRow: [
    { kind: 'css', value: '[role="menuitemcheckbox"]' },
    { kind: 'css', value: 'div.J-LC' },
  ] as SelectorGroup,

  /**
   * "Create new" entry at the foot of the labels menu.
   *
   * Always present, whatever is typed in the filter box - which is why its
   * presence says nothing about whether the label exists. `act="14"` is
   * Gmail's own code for it.
   */
  labelCreateNew: [
    { kind: 'css', value: '[act="14"]' },
    { kind: 'css', value: '[role="menuitem"]:has-text("Create new")' },
    { kind: 'text', value: 'Create new' },
  ] as SelectorGroup,

  /** Confirm button of the "New label" dialog. */
  labelCreateConfirm: [
    { kind: 'role', value: 'button', name: /^create$/i },
    { kind: 'css', value: 'button[name="ok"]' },
    { kind: 'css', value: 'div[role="dialog"] button:has-text("Create")' },
  ] as SelectorGroup,

  /**
   * "Apply" entry that commits the labels menu selection.
   *
   * It sits in the menu as a `menuitem`, not as a button - looking for a
   * button here found nothing, so the ticked label was never committed.
   */
  labelApply: [
    { kind: 'css', value: '[role="menu"] [role="menuitem"]:has-text("Apply")' },
    { kind: 'css', value: '[role="menuitem"]:has-text("Apply")' },
    { kind: 'role', value: 'button', name: /^apply$/i },
    { kind: 'css', value: '[role="menu"] [role="button"]:has-text("Apply")' },
  ] as SelectorGroup,

  markUnreadButton: [
    { kind: 'role', value: 'button', name: /mark as unread/i },
    { kind: 'css', value: 'div[aria-label="Mark as unread"]' },
  ] as SelectorGroup,

  starToggle: [
    { kind: 'role', value: 'button', name: /^(not starred|starred)$/i },
    { kind: 'css', value: 'span[aria-label="Not starred"]' },
    { kind: 'css', value: 'span.T-KT' },
  ] as SelectorGroup,

  accountButton: [
    { kind: 'role', value: 'button', name: /google account/i },
    { kind: 'css', value: 'a[aria-label^="Google Account"]' },
  ] as SelectorGroup,
} as const;

/** Phrases that identify an automated delivery-failure notification. */
export const BOUNCE_SIGNATURES = [
  { pattern: /address not found/i, type: 'HARD' as const },
  { pattern: /delivery status notification \(failure\)/i, type: 'HARD' as const },
  { pattern: /mail delivery subsystem/i, type: 'HARD' as const },
  { pattern: /550[ -]?5\.\d\.\d/i, type: 'HARD' as const },
  { pattern: /user unknown|no such user|recipient rejected/i, type: 'HARD' as const },
  { pattern: /mailbox (is )?full|over quota/i, type: 'SOFT' as const },
  { pattern: /temporarily (unavailable|deferred)|try again later/i, type: 'SOFT' as const },
  { pattern: /delivery (has been )?delayed/i, type: 'SOFT' as const },
];

/** Phrases treated as an explicit opt-out request. */
export const UNSUBSCRIBE_SIGNATURES = [
  /\bunsubscribe\b/i,
  /\bremove me\b/i,
  /\bstop emailing\b/i,
  /\bdo not contact\b/i,
  /\bdon'?t contact me\b/i,
  /\btake me off\b/i,
  /\bopt me out\b/i,
];

/** Phrases that indicate an auto-responder rather than a human reply. */
export const OUT_OF_OFFICE_SIGNATURES = [
  /\bout of (the )?office\b/i,
  /\bautomatic reply\b/i,
  /\bauto[- ]?reply\b/i,
  /\bon (annual |parental )?leave\b/i,
  /\baway (from|until)\b/i,
  /\bvacation (response|reply)\b/i,
];
