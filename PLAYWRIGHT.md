# Browser automation

`packages/playwright` drives the Gmail web interface. It runs only inside the
worker process — never in the API, and never in the browser.

## Two drivers, one interface

Everything above this layer talks to `MailboxDriver`:

```ts
connect() · checkSession() · openInbox() · openCompose()
fillRecipient() · fillSubject() · fillBody() · attachFile()
saveDraft() · sendMessage()
searchConversation() · openConversation() · replyToConversation()
getLatestMessage() · getThreadId() · detectBounce()
fetchThreads() · fetchThread()
markAsRead() · markAsUnread() · starThread() · archiveThread()
logout() · close()
```

| Implementation | `GMAIL_DRIVER` | Behaviour |
|---|---|---|
| `GmailAutomationService` | `playwright` | real Chromium against mail.google.com |
| `SimulationGmailService` | `simulation` (default) | durable in-process mailbox that threads replies correctly and produces realistic inbound traffic |

The simulation is a genuine test double, not a stub: it persists to disk,
maintains real thread structure, and generates pricing questions, meeting
requests, interest, out-of-office notices, opt-outs and delivery failures at
weighted probabilities. The entire product — sequences, follow-up cancellation,
inbox, AI, bounce and suppression handling — is exercisable through it.

## Selector strategy

Gmail ships obfuscated class names that change without notice, so nothing here
depends on a single CSS hook. Each logical element is a **ranked candidate
list** in `selectors.ts`, and `resolve()` walks it until one matches:

```ts
composeButton: [
  { kind: 'role', value: 'button', name: /^compose$/i },  // ARIA role + name
  { kind: 'text',  value: 'Compose' },                    // visible text
  { kind: 'css',   value: 'div[gh="cm"]' },               // stable attribute
  { kind: 'css',   value: 'div[role="button"][jsname]' }, // structural fallback
]
```

Priority is ARIA role → accessible name → label → text → stable attribute →
CSS. When Gmail changes its markup, the fix is usually one new entry in one
array rather than a code change.

The timeout passed to `resolve()` is the budget for the **whole group**, never
per candidate: a fast ranked probe finds anything already on the page in rank
order, then the remaining budget is raced across every candidate. Spending the
full timeout on each candidate in turn is what once let a three-candidate
lookup take three times as long as its caller allowed — and on a send, that
overran the enclosing `act()` deadline *after* Gmail had accepted the message.

## Every action is wrapped

`act()` is the single path through which browser interaction happens:

- **Timeout** — `PLAYWRIGHT_TIMEOUT_MS`, raced against the action.
- **Retry** — with a widening pause, but only for retryable error classes.
- **Screenshot on failure** — written to `storage/screenshots/` and attached to
  the activity log entry.
- **Error classification** — the thrown value is mapped onto the structured
  taxonomy before it leaves the driver.

```
AUTH_ERROR · SESSION_EXPIRED · GMAIL_NOT_AVAILABLE · SELECTOR_NOT_FOUND
ATTACHMENT_ERROR · THREAD_NOT_FOUND · SEND_FAILED · BOUNCE · RATE_LIMIT
TIMEOUT · NETWORK_ERROR · SUPPRESSED · DAILY_LIMIT_REACHED
OUTSIDE_SENDING_WINDOW · UNKNOWN_ERROR
```

Retryable and non-retryable are distinguished deliberately: a `TIMEOUT` is
worth another attempt, a `THREAD_NOT_FOUND` is not, and `SESSION_EXPIRED`
stops retrying and notifies a human to reconnect.

## Reading Gmail's DOM

Four assumptions in this driver were wrong for long enough to break real
things. They are worth stating, because every one of them failed *silently*:

- **The visible element is rarely the first one.** Gmail leaves each search's
  result pane in the DOM, so a list of fifty sits behind fifty stale rows, and
  toolbars exist in several hidden copies. `.first()` picks one of those, and
  the click waits forever for a visibility that never comes. `resolve()` and
  `firstVisible()` scan for a match that is genuinely on screen, and the scan
  limit has to be generous enough to get past the stale ones.
- **A locator held across a check and a click is racing a re-render.** The
  element passes `isVisible()` and is gone by the time the click lands.
  `clickFirstVisibleRow()` finds and clicks in one pass inside the page.
- **Selectors must not assume a tag.** These controls are not always `<div>`,
  and `div[role="button"][aria-label="Labels"]` silently misses a button that
  is plainly on the page.
- **A search is not done when the URL changes.** The old check - "does a main
  region exist?" - is true on every page, so a search that never took effect
  looked like success and everything downstream read the previous results.
  `searchSettled()` waits for Gmail to echo the query back and for a visible
  row to appear.

And one rule for `page.evaluate`: **no named functions inside the callback**,
not even `const helper = () => ...`. esbuild rewrites those into a `__name()`
call that does not exist in the page, and the evaluate dies with
`ReferenceError: __name is not defined`.

## Thread ids

Gmail has two, and they are not interchangeable. A result row carries the
**legacy** id (16 hex characters); the URL router only accepts the **permanent**
id (`FMfcgz...`), which appears once a conversation is open. Storing the legacy
id meant `#all/<id>` opened nothing, so every send recorded a synthesized
`thread_...` placeholder and nothing that needed a real thread could work - an
in-thread follow-up least of all. After a send the driver opens the conversation
once and records the permanent id.

## Sends are never retried in place

Everything `act()` wraps is safe to run twice except the one thing that is not:
clicking Send. So `sendMessage` and `replyToConversation` run with `retries: 0`
and their own longer budget (`SEND_TIMEOUT_MS`). Three rules keep a retry from
delivering a second copy:

1. **The sent folder is the source of truth.** Before composing, the driver
   searches `in:sent to:<contact> subject:"<subject>" newer_than:1d`. A hit
   means an earlier attempt already delivered the message, so it returns that
   thread with `alreadySent: true` instead of sending again. Controlled by
   `SEND_DUPLICATE_GUARD` (on by default).
2. **Post-send bookkeeping cannot fail a send.** Resolving the Gmail thread id
   happens *outside* the timed block. The message has left; failing to label it
   must not be reported as a failure, or the job retries.
3. **A timed-out send tears the mailbox down.** `act()`'s timeout reports a
   failure but cannot abort the compose it raced, so the worker releases the
   browser context and the step refuses to restart for three minutes — long
   enough that no orphaned compose can click Send underneath the retry.

## Session management

One isolated persistent browser context per mailbox, stored under
`storage/sessions/<accountId>` and pooled for the worker's lifetime.

```
acquireMailbox(accountId)
  ├── pooled and still valid?  reuse
  ├── pooled but expired?      close, drop, rebuild
  └── new                      launchPersistentContext, verify inbox loads
```

State is mirrored into `EmailSession` (browser status, session status, current
job, last activity, last error) so the Email Accounts screen can show what is
happening in real time.

### One mailbox, one action at a time

The worker runs several jobs concurrently, but a browser context cannot be
shared. Every piece of browser work therefore goes through `withMailbox()`,
which chains work per mailbox while leaving different mailboxes fully parallel:

```ts
await withMailbox(accountId, async (driver) => driver.sendMessage(request));
```

Without it, two jobs for the same mailbox either interleave compose actions and
corrupt each other, or race to launch the same persistent profile — which
Playwright resolves by attaching to the surviving browser and leaving a stray
`about:blank` tab behind on every attempt. `acquireMailbox()` is not called
directly from a processor for this reason.

Three details make the pooling safe:

- `checkSession()` treats **only** a sign-in wall as a dead session. A page
  sitting on a conversation or a compose window is not a reason to tear down
  and relaunch the context — a false negative there is what produced the tab
  storm in the first place.
- `close()` shuts the context *and* the browser, then waits
  `PROFILE_RELEASE_MS` before the profile directory may be reused.
- `connect()` reuses an existing Gmail page rather than opening another, and
  prunes stray blank tabs that Chromium restores from the profile.

**Cookies, storage state and browser profiles never leave the worker.** They
are not serialised into any API response and there is no endpoint that could
return them.

## Sign-in

The platform never types credentials and never handles passwords or 2FA.

```
Connect (PLAYWRIGHT_HEADLESS=false)
        │
        ▼
launchPersistentContext → mail.google.com
        │
        ├── already signed in ──────────────► CONNECTED
        │
        └── sign-in wall detected
                 │
                 ├── headless: fail fast with SESSION_EXPIRED and instructions
                 │
                 └── headed:  emit "awaitingSignIn", then poll for up to
                              5 minutes while the human signs in
                                   │
                                   ├── inbox loads ──► verify the signed-in
                                   │                   address matches the
                                   │                   configured mailbox,
                                   │                   warn on mismatch
                                   │                   ──────────► CONNECTED
                                   └── timeout ──────► SESSION_EXPIRED
```

The wait is capped at five minutes, deliberately below the queue's ten-minute
stale-lock threshold, so job recovery can never re-run a connect underneath an
open sign-in window. On any failure the context is closed, because a persistent
context holds an exclusive lock on its profile directory and an orphaned one
would make the next attempt fail for the wrong reason.

Afterwards the saved context is reused. When it expires the mailbox is marked
`SESSION_EXPIRED`, a notification is raised, and automation stops for that
mailbox until a person reconnects it.

## Thread replies

A follow-up with `replyInThread` opens the stored `gmailThreadId`, clicks
Reply, and posts a body assembled by `buildReplyChain()`: the new message,
then the previous message quoted in Gmail's own `gmail_quote` markup with the
attribution line, with older history trimmed past 4000 characters. The subject
is normalised by `replySubject()` so `Re:` never stacks.

If the thread cannot be found, the driver throws a non-retryable
`THREAD_NOT_FOUND` rather than silently starting a new conversation.

## Incremental reading

`fetchThreads()` uses Gmail's own `newer_than:<n>d` search, derived from the
newest message already stored for that mailbox. A routine sync never reloads
the whole mailbox.

## What this deliberately does not do

No CAPTCHA solving. No anti-abuse or bot-detection evasion. No credential
entry. No attempt to exceed provider limits — rate limiting, sending windows
and daily quotas exist to stay inside them.

## Configuration

```env
GMAIL_DRIVER=simulation        # or: playwright
PLAYWRIGHT_HEADLESS=true       # false for the initial interactive sign-in
PLAYWRIGHT_SLOWMO_MS=0         # raise to watch it work
PLAYWRIGHT_TIMEOUT_MS=30000
PLAYWRIGHT_STORAGE_DIR=./storage/sessions
SCREENSHOT_DIR=./storage/screenshots
```

Install the browser with `npm run playwright:install`.
