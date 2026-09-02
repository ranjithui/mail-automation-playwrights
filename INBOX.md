# Inbox

A shared, campaign-aware mail client. Every reply is attributed to a contact
and a campaign, classified, and acted on before a person ever opens it.

## Synchronisation

`InboxSyncService` is **incremental**. It reads the newest stored message for
the mailbox, subtracts a one-minute overlap so a message arriving mid-sync is
not lost, and asks the driver only for threads newer than that. A full mailbox
reload never happens on a routine sync.

```
Gmail ──► InboxSyncService ──► database ──► WebSocket ──► React inbox
```

Triggers: every 45 seconds from the scheduler, on demand from the Sync
button, and per-mailbox from the Email Accounts screen. It runs on the
`inbox-sync` queue, so a slow mailbox never blocks the API.

Upserts are keyed on `(emailAccountId, gmailThreadId)` for threads and
`gmailMessageId` for messages, so re-syncing the same window is a no-op.

## Attribution

For each thread:

```
counterparty address ──► Contact lookup (workspace-scoped)
                            │
                    found?  ├── yes ──► most recent CampaignContact ──► Campaign + step
                            └── no  ──► thread shows "create contact"
```

The thread carries `contactId`, `campaignId` and `campaignContactId`, which is
what lets the inbox show *"SaaS Outreach — Q3 · Step 2"* beside a reply, and
lets the campaign screen list its own replies.

A contact can be created from an unattributed thread in one click.

## Classification and consequences

Every inbound message is classified before anything else happens:

| Class | Detected by | Consequence |
|---|---|---|
| `BOUNCE` | mailer-daemon sender or a hard-failure signature (`550 5.x.x`, "address not found") | record `Bounce`, suppress hard bounces, mark the contact `BOUNCED`, **remove them from every contact list**, cancel pending follow-ups |
| `UNSUBSCRIBE` | "remove me", "stop emailing", "unsubscribe", "do not contact" | record `Unsubscribe`, add to suppression, mark `UNSUBSCRIBED`, cancel every pending step, notify |
| `OUT_OF_OFFICE` | "out of office", "automatic reply", "on leave" | **not** treated as a reply — the next step is deferred by three days |
| `REPLY` | anything else | mark the contact `REPLIED`, cancel all pending follow-ups, notify |

Then AI analysis is queued asynchronously. Classification never waits on it.

## The bounce scan

Inbound classification only sees replies *inside* a conversation we started.
A bounce is not one of those: Gmail files the delivery report from Mail
Delivery Subsystem as **its own thread**, sometimes in spam. Re-reading the
threads we sent - which is what the platform originally did - cannot find one,
and across several hundred sends it never recorded a single bounce.

So the scan searches instead:

```
in:anywhere newer_than:7d (from:mailer-daemon OR from:postmaster OR
  subject:"Address not found" OR subject:"Delivery Status Notification" OR
  subject:"Delivery incomplete" OR subject:"Undelivered Mail Returned to Sender")
```

It reads the **result rows** - subject, sender, snippet - without opening
anything, because Gmail's snippet normally names the failed address itself
("Your message wasn't delivered to x@y.com because ..."). Only a report whose
row does not name a contact we mailed is opened. Opening all of them took over
eight minutes and hit the job watchdog; reading rows takes seconds.

Naming the *right* address matters more than it looks: a delivery report also
contains the daemon's address, our own mailbox and a support link.
`extractFailedRecipients()` ranks candidates by Gmail's own phrasings, drops
the messenger addresses, and the scan prefers a candidate that matches a
contact this workspace actually mailed.

Each confirmed bounce, hard or soft:

1. records the `Bounce` and suppresses the address (hard bounces)
2. **removes the contact from every contact list** - membership only; the
   contact, its reason and its history are kept, so the evidence survives and a
   re-import cannot quietly resurrect a dead address
3. cancels every follow-up still queued for them

The scan is idempotent: the same report is seen on every pass and by every
mailbox, and is recorded once.

## One campaign, one label

Each campaign created from now on gets a Gmail label - `MailFlow/<slug>`, fixed
at creation so renaming the campaign cannot orphan mail already filed - and
every send is filed under it. Filing runs after the message has gone and is
wrapped in a catch: a labels menu that misbehaves must never turn a delivered
email into a failed job that gets retried and sent twice.

Gmail applies a label to the **whole conversation**, which is what makes this
worth doing: replies inherit it, and so does the delivery report Gmail threads
into the sent conversation. One search returns the campaign's outbound mail and
everything that came back:

```
label:"MailFlow/spring-outreach"
  → Quick question about Philippe Hottinguer Gestion
    "Address not found  Your message wasn't delivered to ..."
```

Inbox sync sweeps these labels in addition to the thread ids it has stored, so
a campaign thread is still found when its id was never recorded.

Campaigns created before labelling have no label and are untouched.

## Follow-ups wait for it

A follow-up is the one send we already have evidence about - the previous step
may have bounced. `dispatchDueSteps()` will not release a step beyond the first
unless a bounce scan has completed within `BOUNCE_SCAN_FRESHNESS_MS` (30
minutes). If the last scan is stale it queues one and holds the follow-ups;
they go out on the next tick, once the dead addresses are off the list.

Initial sends are not gated - there is nothing to have learned yet.

## Three-panel interface

```
┌──────────────┬─────────────────────────┬───────────────────────────┐
│ Folders      │ Thread list             │ Reader                    │
│              │                         │                           │
│ All mail     │ Clara Khan       13:00  │ Quick question about …    │
│ Unread       │ Quick question about …  │ Clara Khan · Summit Legal │
│ Important    │ Could you share your…   │ SaaS Outreach · Step 1    │
│ Replied      │ [pricing] [high] [AI]   │ ─────────────────────     │
│ Waiting      │                         │ AI summary                │
│ AI suggested │ Sarah Khan       13:01  │ asking pricing · high     │
│ Archived     │ Automatic reply: …      │ ─────────────────────     │
│              │ [out of office]         │ message chain             │
│ AI inbox     │                         │ ─────────────────────     │
│              │                         │ [Reply] [Generate AI]     │
└──────────────┴─────────────────────────┴───────────────────────────┘
```

Below 1024px the reader takes over the viewport and a back control appears;
the folder rail collapses into the main navigation.

Opening a thread marks it read, exactly like a mail client, and the change is
mirrored into the real mailbox in the background.

## Search and filters

Gmail-style operators, parsed server-side:

```
from:john  to:sales  subject:"Q3 proposal"  campaign:outreach
company:acme  status:replied  date:2026-01-01  plus free text
```

Filters: unread, starred, has attachment, AI reply available, intent, priority,
campaign, mailbox, date.

Folders: All · Unread · Important · Replied · Waiting for reply · AI suggested ·
Archived.

## AI inbox

A second view that groups by what the sender actually wants: Requires
attention · Pricing requests · Meeting requests · Interested · Not interested ·
Waiting for response. Each bucket is a query over the stored `AIAnalysis`, so
it stays accurate without a separate index.

## Composer

`To · Subject · Body · Attachments · AI assistant · Templates`, with two
distinct actions:

- **Save draft** — writes the reply into the mailbox. Nothing is sent.
- **Send reply** — sends, and only ever after an explicit click.

Replies go through the `ai-reply` queue and are posted into the existing thread
with the correct `In-Reply-To`, so the conversation continues rather than
forking.

## Real-time

New messages, thread updates, worker activity and AI completion all arrive over
the WebSocket and invalidate the matching query cache. A reply appearing in the
inbox does not require a refresh, and the toast that announces it is generated
from the same event.

## Data model

`EmailThread` → `EmailMessage` → `EmailAttachment`, with `direction`
(`INBOUND`/`OUTBOUND`) on every message. Direction drives conversation
rendering, analytics and which messages the AI is asked to reply to.
