# Architecture

## Processes

Three processes, deliberately separated:

| Process | Owns | Never does |
|---|---|---|
| **API** (`apps/api`) | HTTP, auth, validation, workspace isolation, WebSocket fan-out | touch a browser, run a send |
| **Worker** (`apps/worker`) | queue consumption, browser sessions, sends, inbox sync, AI processing | serve HTTP to the browser |
| **Web** (`apps/web`) | rendering, form state, optimistic UI | hold secrets, drive automation |

A crashed Chromium can never take the web app down, and a redeployed API never
interrupts a campaign mid-send.

## Request and job flow

```
User clicks "Start campaign"
        │
        ▼
POST /api/campaigns/:id/start ── validates role, campaign readiness
        │
        ▼
startCampaign()  sets RUNNING, enqueues a campaign-scheduler job
        │
        ▼
Worker picks up the scheduler job
        │
        ├── checks the sending window and the daily budget
        ├── finds contacts whose next step is due
        ├── creates a CampaignContactStep ledger row per (contact, step)
        └── enqueues one email-send / email-followup job per contact,
            offset by the configured (optionally randomised) delay
        │
        ▼
Worker picks up each send job
        │
        ├── 1. idempotency  — has this exact (contact, step) already run?
        ├── 2. preflight    — replied / bounced / unsubscribed / paused / suppressed?
        ├── 3. window       — re-checked at execution time, not just at queueing
        ├── 4. quota        — per-mailbox daily reservation
        ├── 5. render       — template + contact context
        ├── 6. drive        — new email, or a reply inside the existing thread
        ├── 7. persist      — thread, message, ledger, event, activity log
        └── 8. advance      — schedule the next step inside the window
        │
        ▼
Scheduler re-queues itself; when the window closes it sleeps until it reopens
```

## The job ledger

The queue has two drivers, but in both the database is the source of truth.

- `ScheduledJob` — one row per unit of work: queue, payload, `runAt`,
  `attempts`, `lockedBy`, `lockedAt`, `dedupeKey`.
- `CampaignContactStep` — the idempotency ledger, unique on
  `(campaignContactId, stepId)` **and** on `idempotencyKey`.

That gives four properties without any driver-specific code:

1. **No duplicate sends.** A second attempt at the same (campaign, contact,
   step) collides with a unique constraint. A restarted worker cannot resend.
2. **Worker recovery.** Jobs held by a dead worker are detected by a stale
   `lockedAt` and released for retry.
3. **Resume after restart.** Pending work is still in the table; the worker
   re-dispatches it on boot.
4. **Observability.** The Running Jobs screen is a plain query, not a
   Redis-specific introspection API.

`REDIS_URL` decides only *how work is dispatched*: BullMQ delay queues when
Redis is present, a polling loop over the ledger when it is not.

The polling loop hands out **free concurrency slots and returns**; it never
waits for the jobs it started. Awaiting them meant a single slow handler - a
bounce sweep walking two dozen Gmail conversations - held every slot and
silently froze the worker, so campaigns queued behind it never ran and no mail
went out. Three rules keep that from recurring:

- **Priority.** Sends outrank the scheduler, which outranks housekeeping, so a
  bounce sweep can delay a campaign but never block it.
- **A watchdog.** `JOB_TIMEOUT_MS` (8 min, under the 10-minute stale-lock
  window) fails any handler that will not return and frees its slot, while a
  heartbeat keeps a legitimately long job from being "recovered" and run twice.
- **Deferral is not completion.** A handler that declines to work *yet* -
  outside the sending window, daily quota spent - returns a `deferUntil` date
  and the job is rescheduled without spending an attempt. Completing it would
  retire the row for good: `enqueue` dedupes on the step's idempotency key, so
  once a job exists it is never recreated and the contact is stranded.

## Sequence model

The old system had fixed `FollowUp1/2/3` columns. Here a campaign owns an
ordered `CampaignStep[]`; nothing in the schema or the code caps the count.

```
CampaignStep(1)  INITIAL   day 0    replyInThread=false
CampaignStep(2)  FOLLOWUP  +3 days  replyInThread=true
CampaignStep(3)  FOLLOWUP  +7 days  replyInThread=true
CampaignStep(4)  FOLLOWUP  +14 days replyInThread=true
```

`advanceAfterSend()` computes the next step's due time and clamps it into the
sending window with `nextSendWindowSlot()`, which walks forward in 15-minute
increments in the campaign's IANA timezone — correct across DST without a
timezone library.

## Follow-up cancellation

Mandatory, and enforced in three independent places so no single failure can
let a follow-up land after someone has replied:

1. **Inbox sync** classifies an inbound message and calls `handleReply()`,
   which marks the contact `REPLIED` and calls `cancelPendingFollowUps()`.
2. **AI analysis** re-checks the classification; a `UNSUBSCRIBE`,
   `NOT_INTERESTED` or `BOUNCE` intent cancels pending steps too.
3. **Preflight** runs immediately before the browser action, so a reply that
   arrives while the job sits in the queue still stops the send.

Cancellation marks ledger rows `CANCELLED` *and* cancels the matching
`ScheduledJob` rows by `dedupeKey`.

## Real-time

The API owns the WebSocket server. The worker is a separate process, so rather
than requiring Redis pub/sub for local development it posts events to an
internal API route guarded by a shared secret; inside the API process the same
`publish()` call short-circuits to a direct broadcast.

Subscriptions are workspace-scoped and membership is verified at connect time.
Events: `campaign.progress`, `campaign.status`, `inbox.message`,
`inbox.updated`, `worker.status`, `ai.status`, `notification`, `activity`.

On the client each event invalidates the matching TanStack Query key, so
screens stay accurate without polling.

## Workspace isolation

Enforced in middleware, not in individual handlers. `withWorkspace` resolves
the active workspace from a header, cookie or first membership, verifies the
requester is a member, and puts it on `req.ctx`. Every workspace-scoped query
filters on `req.ctx.workspaceId`. A handler cannot accidentally read another
tenant's data because it never receives an unvalidated workspace id.

RBAC is a rank comparison (`OWNER 50 › ADMIN 40 › MANAGER 30 › USER 20 ›
VIEWER 10`) applied by `requireRole()` on the routes that need it, and mirrored
in the UI by `<RoleGate>` — the UI hides what the API would reject.

## Driver abstraction

`MailboxDriver` is one interface with two implementations:

- `GmailAutomationService` — real Chromium via Playwright.
- `SimulationGmailService` — durable in-process mailbox that threads replies
  correctly and generates realistic inbound traffic.

Everything above the driver — campaigns, sequences, inbox sync, AI, analytics,
safety — is identical in both modes. That is what makes the whole product
demonstrable and testable without a live mailbox, and it means the simulation
is a genuine test double rather than a stub.

`AIProvider` follows the same pattern: `LocalAIProvider` (offline, rule-based)
and `RemoteAIProvider` (OpenAI / Anthropic / Gemini / Groq behind one adapter).

## Shared code

`packages/shared` is isomorphic and imported by all three apps. The Zod schemas
that validate an API request are the same objects that drive the React form
resolver, and the template engine that renders a preview in the browser is the
same one the worker uses to render the outgoing email. The two layers cannot
drift.
