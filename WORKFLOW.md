# Workflow

Two kinds of workflow live in this repository, and this document covers both.

- **[Part A — Runtime workflows](#part-a--runtime-workflows)**: what the platform
  actually does when a user starts a campaign, when mail arrives, when the AI runs.
- **[Part B — Engineering workflows](#part-b--engineering-workflows)**: how a change
  is made, verified and shipped by a developer working in this repo.

The *governance* around Part B — phases, roles, gates, release policy, risk
classification — is in [SDLC.md](./SDLC.md). Structural background is in
[ARCHITECTURE.md](./ARCHITECTURE.md).

---

# Part A — Runtime workflows

## A0. The three processes

Every runtime workflow is a hand-off between exactly three processes.

| Process | Path | Starts a workflow by | Never |
|---|---|---|---|
| **Web** | `apps/web` | calling the REST API, listening on WS | driving a browser, holding a secret |
| **API** | `apps/api` | validating, then writing a `ScheduledJob` row | sending mail, opening Chromium |
| **Worker** | `apps/worker` | claiming a job from the ledger | serving the SPA |

Nothing crosses those lines. The API never sends; the worker never takes an HTTP
request from a browser. A workflow moves between them through the database job
ledger, which is the source of truth under both queue drivers.

## A1. Queue map

Ten queues, all registered in [apps/worker/src/index.ts:23](apps/worker/src/index.ts:23),
all named in `QUEUES` in [packages/shared/src/enums.ts](packages/shared/src/enums.ts).

| Queue | Handler | Triggered by | Does |
|---|---|---|---|
| `campaign-scheduler` | `processScheduler` | campaign start, self-requeue | picks who is due, fans out send jobs |
| `email-send` | `processSend` | scheduler | initial step for one contact |
| `email-followup` | `processSend` | scheduler / `advanceAfterSend` | follow-up step, replies in-thread |
| `inbox-sync` | `processInboxSync` | maintenance cadence, manual sync | pulls new mail for one mailbox |
| `bounce-check` | `processBounceCheck` | maintenance cadence | sweeps for bounce notifications |
| `browser-worker` | `processBrowserAction` | mailbox connect / verify | one-off browser operations |
| `ai-analysis` | `processAIAnalysis` | new inbound message | intent, sentiment, priority, summary |
| `ai-reply` | `processAIReply` | user asks for a draft | reply drafting and editing |
| `notification` | `processNotification` | domain events | in-app notification rows |
| `analytics` | `processAnalytics` | maintenance cadence | rollups for the dashboard |

Priority is set by `QUEUE_PRIORITY` in [packages/queue/src/index.ts](packages/queue/src/index.ts):
sends outrank the scheduler, which outranks housekeeping. A bounce sweep can
delay a campaign; it can never block one.

## A2. Campaign lifecycle

```
DRAFT ──start──▶ SCHEDULED ──window opens──▶ RUNNING ──all steps done──▶ COMPLETED
  ▲                                            │  ▲
  │                                     pause  │  │ resume
  └── editable while draft                     ▼  │
                                            PAUSED
                                               │
                                        stop   ▼
                                          CANCELLED       (FAILED on fatal error)
```

Statuses are the `CAMPAIGN_STATUSES` union. A campaign in `DRAFT_ONLY` mode runs
the identical workflow, but the browser step creates a Gmail draft instead of
sending — the safest way to rehearse a real campaign.

## A3. The send workflow

The most safety-critical path in the product. Every send passes eight gates, in
order, and any gate may stop it.

```
scheduler job wakes
   │
   ├── sending window open?        no ──▶ deferUntil next slot (no attempt spent)
   ├── daily budget left?          no ──▶ deferUntil tomorrow
   ├── find contacts whose step is due
   ├── write a CampaignContactStep ledger row (unique per contact + step)
   └── enqueue one send job per contact, spaced by the randomised delay
   │
   ▼
send job claimed by the worker
   │
   1. idempotency  ── has this (campaign, contact, step) already run?   ▶ stop
   2. preflight    ── replied / bounced / unsubscribed / suppressed
                      / campaign paused?                               ▶ stop
   3. window       ── re-checked NOW, not just at queue time            ▶ defer
   4. quota        ── reserve one slot on this mailbox                  ▶ defer
   5. render       ── template + contact context; missing vars fail loudly
   6. drive        ── Playwright: compose new mail, or reply in thread
   7. persist      ── thread, message, ledger row, event, activity log
   8. advance      ── schedule the next step, clamped into the window
```

Three properties to internalise before touching this path:

- **Gate 1 is a database constraint, not a check.** `CampaignContactStep` is
  unique on `(campaignContactId, stepId)` *and* on `idempotencyKey`. A restarted
  worker physically cannot resend.
- **A send is never retried in place.** If step 6 fails ambiguously the job
  fails; it does not re-drive the browser and risk a second delivery. See
  [PLAYWRIGHT.md](./PLAYWRIGHT.md).
- **Deferral is not completion.** A handler that declines to work *yet* returns
  `deferUntil`. Completing the job instead would retire the ledger row for good
  and strand the contact, because `enqueue` dedupes on the idempotency key and
  will not recreate it.

## A4. Follow-ups and cancellation

Follow-up steps reply **inside the existing Gmail thread** with a trimmed quote
chain, so the recipient sees one conversation rather than four cold emails.

Cancellation is enforced in three independent places, deliberately redundant:

1. **Inbox sync** classifies an inbound message → `handleReply()` → contact
   marked `REPLIED` → `cancelPendingFollowUps()`.
2. **AI analysis** re-checks the classification; an `UNSUBSCRIBE`,
   `NOT_INTERESTED` or `BOUNCE` intent cancels pending steps too.
3. **Preflight** (gate 2) runs immediately before the browser action, catching a
   reply that landed while the job sat in the queue.

Cancellation marks ledger rows `CANCELLED` **and** cancels the matching
`ScheduledJob` rows by `dedupeKey`. Changing one of the three without the others
is a correctness regression, not a refactor.

## A5. Inbox sync workflow

```
inbox-sync job ──▶ open (or reuse) the mailbox session
               ──▶ read only what is new since the last cursor
               ──▶ attribute each message to a contact and campaign
               ──▶ classify: reply | bounce | opt-out | auto-responder
               ──▶ apply consequences (cancel follow-ups, suppress, mark bounced)
               ──▶ enqueue ai-analysis
               ──▶ publish inbox.message over WebSocket
```

Auto-responders are classified separately and do **not** count as replies — an
out-of-office must not silently kill a sequence. Details in
[INBOX.md](./INBOX.md).

## A6. AI workflow

The AI never acts on its own. `ai-analysis` writes a classification; `ai-reply`
writes a *suggestion*; a human presses send. Provider choice (`local`, `openai`,
`anthropic`, `gemini`, `groq`) is configuration, never code — see [AI.md](./AI.md).
`AI_PROVIDER=local` is a real heuristic provider rather than a stub, so the whole
pipeline is exercisable offline with no key and no cost.

## A7. Real-time workflow

The worker has no WebSocket server of its own. It POSTs events to an internal API
route guarded by a shared secret; inside the API process the same `publish()`
call short-circuits to a direct broadcast. Subscriptions are workspace-scoped and
membership is verified at connect time.

Events: `campaign.progress`, `campaign.status`, `inbox.message`, `inbox.updated`,
`worker.status`, `ai.status`, `notification`, `activity`.

On the client each event invalidates the matching TanStack Query key. **If you
add a mutation, invalidate the key — do not add polling.**

---

# Part B — Engineering workflows

## B0. First-run setup

```bash
npm install && npm run setup && npm run dev
```

`npm run setup` ([scripts/setup.mjs](scripts/setup.mjs)) is idempotent and does
four things: writes `.env` from `.env.example` with freshly generated secrets (an
existing `.env` is never overwritten), creates `storage/` and `prisma/data`,
generates and pushes the Prisma schema, and seeds the demo workspace.

Then open <http://localhost:5173> and log in as `admin@mailflow.local` /
`Admin@12345`. The API answers on <http://localhost:4000/api/health>.

Defaults are chosen so a new developer needs no Postgres, no Redis and no Gmail
account:

| Knob | Dev default | Production |
|---|---|---|
| `DATABASE_PROVIDER` | `sqlite` | `postgresql` |
| `REDIS_URL` | empty → database queue driver | Redis → BullMQ |
| `GMAIL_DRIVER` | `simulation` | `playwright` |
| `AI_PROVIDER` | `local` | any hosted provider |

Each is a driver behind one interface. Flipping one must not change behaviour
anywhere else — that is the contract the abstraction exists to keep.

## B1. The daily loop

```bash
npm run dev          # API + worker + web, colour-tagged in one terminal
npm run typecheck    # strict TS across every app and package
npm test             # vitest over tests/
npm run db:reset     # rebuild and re-seed local data when state gets weird
```

`npm run dev` runs `tsx watch` on the API and the worker, so both restart on
save. The worker resumes from the ledger on restart — an interrupted campaign
picks up where it stopped, which is what you want mid-debug.

## B2. Change recipes

### Add or change an API endpoint

1. Schema first: add the Zod schema to
   [packages/shared/src/schemas.ts](packages/shared/src/schemas.ts) so the web app
   and the API validate against one definition.
2. Handler in the matching `apps/api/src/routes/*.ts`. Wrap it with `handler()`
   and return through `ok()` so the response envelope stays uniform.
3. Register a new router in [apps/api/src/app.ts:96](apps/api/src/app.ts:96).
4. Authorisation is middleware, not per-handler: go through `withWorkspace` and
   `requireRole`. Never re-implement a workspace filter inside a handler.
5. Client method in [apps/web/src/lib/api.ts](apps/web/src/lib/api.ts), consumed
   through TanStack Query.
6. Update [API.md](./API.md) in the same change, not as a follow-up.

### Add a queue or background job

1. Add the name to `QUEUES` in
   [packages/shared/src/enums.ts](packages/shared/src/enums.ts).
2. Write the processor under `apps/worker/src/processors/`.
3. Register it in the `handlers` map,
   [apps/worker/src/index.ts:23](apps/worker/src/index.ts:23).
4. Give it a priority in `QUEUE_PRIORITY`
   ([packages/queue/src/index.ts](packages/queue/src/index.ts)).
5. Decide its failure semantics explicitly: retry, `deferUntil`, or fail hard.
   Anything touching a mailbox must be idempotent under a stale-lock replay.
6. If it can run longer than `JOB_TIMEOUT_MS` (8 minutes, deliberately under the
   10-minute stale-lock window) it must heartbeat, or the watchdog frees its slot
   and the work runs twice.

### Change the database schema

`prisma/schema.prisma` is **generated and gitignored**. Edit
[prisma/schema.template.prisma](prisma/schema.template.prisma);
[scripts/prepare-prisma.mjs](scripts/prepare-prisma.mjs) substitutes the
datasource from `DATABASE_PROVIDER`.

```bash
npm run prisma:generate
npm run prisma:push        # fast local sqlite iteration
npm run prisma:migrate     # when the change is ready to become a real migration
```

Every model must stay portable across SQLite and Postgres — see the portability
rules in [DATABASE.md](./DATABASE.md). A Postgres-only type passes on a
developer's SQLite machine and fails in production.

### Add a frontend page

Component under `apps/web/src/pages/`, route in
[apps/web/src/App.tsx](apps/web/src/App.tsx), nav entry in
[apps/web/src/components/layout/Sidebar.tsx](apps/web/src/components/layout/Sidebar.tsx).
Use the existing primitives in `components/ui/` rather than introducing a
component library.

### Touch the Playwright layer

Selectors live in
[packages/playwright/src/selectors.ts](packages/playwright/src/selectors.ts) as
ordered candidate groups, never inline in the automation service. Every action is
wrapped with error classification (`errors.ts`). Develop against
`GMAIL_DRIVER=simulation` first; switch to `playwright` only against a throwaway
mailbox you own. Read [PLAYWRIGHT.md](./PLAYWRIGHT.md) before editing this
package — the constraints there are not stylistic.

## B3. Verifying a change

What you owe depends on what you touched.

| Change | Minimum verification |
|---|---|
| Shared utility, template engine, classification | unit test in `tests/unit.test.ts` |
| API route | `npm run typecheck` plus exercising the endpoint against the dev server |
| Worker / queue | run a campaign end to end with `GMAIL_DRIVER=simulation` |
| Send path (any of the eight gates) | simulation campaign **plus** a targeted unit test **plus** a second reviewer |
| Frontend | `npm run dev`, click the flow, confirm the console is clean |
| Schema | `npm run db:reset` from scratch, re-seed, re-run the flow |

Both gates currently pass on `main`: `npm run typecheck` is clean and `npm test`
reports **48 passing tests**.

## B4. Debugging

- **A campaign is not sending.** Check the Running Jobs screen first — it is a
  plain query over `ScheduledJob`, not a Redis introspection API. A job sitting
  in `DELAYED` with a future `runAt` is usually a closed sending window or a
  spent daily quota, both correct behaviour.
- **A job ran twice.** Look at the heartbeat, not the queue driver. A handler
  that exceeds the stale-lock window gets recovered and re-dispatched.
- **A send did nothing.** Check `CampaignContactStep` for that contact: a
  `SKIPPED` row with a reason means a preflight gate stopped it deliberately.
- **A selector broke.** Screenshots land in `SCREENSHOT_DIR`
  (`./storage/screenshots`). Set `PLAYWRIGHT_HEADLESS=false` and
  `PLAYWRIGHT_SLOWMO_MS` to watch it happen.
- **Local state is corrupt.** `npm run db:reset` rebuilds and re-seeds.

## B5. Before you open a change for review

```bash
npm run typecheck && npm test
```

Then confirm the four things that are easy to forget: the affected `.md` file is
updated, SQLite/Postgres portability holds, any new mutation invalidates its
query key, and — if you touched the send path — the description says so
explicitly, so the change gets the review it needs.

Branching, review, release and rollback policy: [SDLC.md](./SDLC.md).
