# Software Development Life Cycle

How work on MailFlow is planned, built, verified, released and operated. This is
the *process* document; the mechanics of doing the work are in
[WORKFLOW.md](./WORKFLOW.md).

It describes a small-team cycle for a product that automates a real mailbox.
That last point sets the tone throughout: a defect here does not render a
misaligned button, it sends a stranger a second copy of an email, or a follow-up
after they already replied. The gates below are sized for that risk, not for the
size of the codebase.

---

## 1. Model

**Iterative, phase-delivered, trunk-based.** Work is cut into vertical slices
that each cross the full stack — schema → domain service → API → UI → docs — and
each slice is releasable on its own. There is no separate "integration phase";
integration happens on every merge.

The initial build ran as twelve sequential phases, all delivered:

| # | Phase | # | Phase |
|---|---|---|---|
| 1 | Foundation (monorepo, auth, tenancy) | 7 | Inbox |
| 2 | Contacts | 8 | AI |
| 3 | Templates | 9 | Safety and intelligence |
| 4 | Gmail automation | 10 | Analytics |
| 5 | Campaigns | 11 | Migration |
| 6 | Follow-ups | 12 | Production concerns |

That phase list is now history, not a plan. Ongoing work runs the cycle in §4 per
change.

---

## 2. Roles

The repository is small enough that one person often wears several hats. The
distinction that matters is not headcount, it is that **the author of a
send-path change is never its sole reviewer**.

| Role | Owns |
|---|---|
| Product owner | what gets built and in what order; accepts against §5 |
| Maintainer | architecture boundaries, merge decisions, releases |
| Engineer | the change, its tests, its documentation |
| Reviewer | correctness, blast radius, adherence to §7 gates |
| Operator | deployment, environment secrets, incident response |

---

## 3. Environments

| Environment | Database | Queue | Gmail driver | AI | Purpose |
|---|---|---|---|---|---|
| **Local** | SQLite file | database driver | `simulation` | `local` | daily development; no external service, no real mailbox |
| **Integration** | Postgres (docker-compose) | Redis + BullMQ | `simulation` | `local` or hosted | production-shaped, still no real mail |
| **Staging** | Postgres | Redis + BullMQ | `playwright`, throwaway mailbox | hosted | last stop before production; real browser, real Gmail, disposable recipients |
| **Production** | Postgres | Redis + BullMQ | `playwright` | hosted | real mailboxes, real recipients |

`docker-compose.yml` builds the integration shape. Promotion is
local → integration → staging → production; a change that alters the send path or
the schema may not skip staging.

Every environment difference is a driver behind one interface, never a code
branch. Full setup: [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## 4. The cycle, per change

### 4.1 Intake

**In:** a request, defect report or migration gap.
**Out:** a scoped item with an explicit blast radius.

Classify it immediately — the class determines every gate that follows:

| Class | Examples | Gates |
|---|---|---|
| **Critical** | any of the eight send gates, idempotency, follow-up cancellation, suppression, quota, sending window | §7 full, staging required, second reviewer required |
| **Standard** | new endpoint, new page, schema addition, queue, analytics | §7 standard |
| **Low** | copy, styling, docs, non-behavioural refactor | typecheck + tests |

If you cannot tell, it is Critical.

### 4.2 Definition of Ready

An item may not start until: the behaviour is described in terms a user would
recognise; the affected layers are named; the classification is agreed; and, for
Critical items, the failure mode it is meant to prevent is written down.

### 4.3 Design

Lightweight and mostly by precedent — the boundaries in
[ARCHITECTURE.md](./ARCHITECTURE.md) already decide most questions. A written
design note is required only when a change would:

- move logic across the API / worker / web boundary,
- add a driver or a new external dependency,
- alter the job ledger, its locking, or its idempotency guarantees,
- change the database schema in a way that is not purely additive.

The note goes in the relevant `.md` file, not in a chat message.

### 4.4 Implement

Follow the recipes in [WORKFLOW.md §B2](./WORKFLOW.md#b2-change-recipes).
Standing rules:

- **Shared types are shared.** Enums and Zod schemas live in `packages/shared`
  and are the one definition the web app, API and worker all use.
- **Domain logic lives in `packages/core`.** If both the API and the worker need
  it, it does not belong in either.
- **Driver parity.** Both queue drivers, both database providers and both Gmail
  drivers must behave identically; a feature that only works on one is unfinished.
- **Secrets never reach the browser.** See [SECURITY.md](./SECURITY.md).

### 4.5 Verify

See the verification matrix in
[WORKFLOW.md §B3](./WORKFLOW.md#b3-verifying-a-change). Baseline for every
change:

```bash
npm run typecheck && npm test
```

### 4.6 Review

Reviewer checks, in order: does it hold the process boundaries; is the failure
mode handled (retry vs defer vs fail); is it idempotent if it touches a mailbox;
is workspace isolation intact; is the documentation updated in the same change.

Critical items require a second reviewer and an explicit note in the description
saying which of the eight gates was touched and why.

### 4.7 Merge and release

Trunk-based on `main`. Short-lived branches named `feat/…`, `fix/…`, `chore/…`,
`docs/…`. Conventional-style commit subjects; a commit body explaining *why* is
expected for anything not Low.

`main` is expected to be releasable at all times. Tag releases `vMAJOR.MINOR.PATCH`:

- **MAJOR** — a migration that is not backward compatible, or a change to the
  send guarantees.
- **MINOR** — new capability, additive schema.
- **PATCH** — fixes, documentation, dependencies.

### 4.8 Deploy

1. Back up the production database ([DEPLOYMENT.md](./DEPLOYMENT.md) §Backup).
2. Apply migrations (`npm run prisma:migrate deploy`) — migrations are applied
   before the new code, and must be backward compatible with the running version.
3. Deploy the API, then the worker. The worker resumes from the ledger, so
   restarting it mid-campaign is safe by design.
4. Deploy the web bundle.
5. Verify `/api/health`, watch the job ledger for one full scheduler cycle,
   confirm no campaign has stalled.

### 4.9 Operate

Health endpoint, job ledger, activity log and the Running Jobs screen are the
standing instruments. Alert on: jobs failing repeatedly, stale-lock recoveries
climbing, a mailbox in `ERROR` connection status, a campaign in `RUNNING` with no
progress across a full window.

### 4.10 Rollback

Because migrations are backward compatible, code rolls back independently of the
schema. Order: pause running campaigns → redeploy the previous API and worker →
confirm the ledger drains → resume. Only restore a database backup when the data
itself is corrupt, and accept that anything sent since the backup is not
reflected in it.

---

## 5. Definition of Done

A change is done when all of these hold:

1. `npm run typecheck` passes.
2. `npm test` passes, and new behaviour has a test if it is testable in isolation.
3. It was exercised in the simulation driver if it touches the send or inbox path.
4. Workspace isolation and role checks are intact.
5. It works on both SQLite and Postgres, and under both queue drivers.
6. The relevant `.md` document was updated in the same change.
7. No secret, key or session token is reachable from the browser.
8. For Critical changes: reviewed by a second person and exercised in staging.

---

## 6. Testing strategy

| Layer | Status | Where |
|---|---|---|
| **Unit** | 48 tests, passing | `tests/unit.test.ts` |
| **Type-level** | strict TS across every app and package | `npm run typecheck` |
| **Simulation end-to-end** | manual — run a campaign with `GMAIL_DRIVER=simulation` | dev / integration |
| **Real-browser** | manual, staging only, throwaway mailbox | staging |

Unit coverage today: template variable rendering and validation, reply-chain
construction, subject normalisation, sending windows across timezones and DST,
retry backoff, idempotency keys, suppression matching, inbound classification
(bounce / opt-out / out-of-office / reply), AI prompt construction and
guardrails, local-provider classification and drafting, and selector resolution.

The simulation driver is what makes this tractable: it implements the same
interface as the real Playwright driver, so the entire pipeline — scheduler,
gates, ledger, threading, inbox, AI — is exercisable in CI-like conditions with
no mailbox and no network.

**Known gap:** the simulation end-to-end run is not automated, and there is no CI
pipeline in the repository. See §10.

---

## 7. Quality gates

| Gate | Low | Standard | Critical |
|---|---|---|---|
| Typecheck + unit tests | ✔ | ✔ | ✔ |
| New/updated unit test | — | if testable | required |
| Simulation end-to-end run | — | ✔ | ✔ |
| Docs updated | if user-facing | ✔ | ✔ |
| Second reviewer | — | — | ✔ |
| Staging soak before production | — | recommended | required |

---

## 8. Change management on the send path

Treated separately because it is the only part of the system whose defects reach
people outside the organisation.

Any change to the eight gates in
[WORKFLOW.md §A3](./WORKFLOW.md#a3-the-send-workflow), to idempotency, to
follow-up cancellation, or to suppression must state in its description:

1. which gate changed,
2. the failure mode it prevents or introduces,
3. what happens on a stale-lock replay of the affected job,
4. what happens if a reply arrives while the job is queued.

Follow-up cancellation is enforced in three independent places on purpose.
Removing one of them "because it is redundant" is a defect, not a simplification.

---

## 9. Security and compliance in the cycle

Carried through every phase, not bolted on at the end. Design considers what
reaches the browser; implementation encrypts credentials at rest (AES-256-GCM)
and validates every input with Zod; review checks workspace isolation and role
enforcement; release runs the production checklist in
[SECURITY.md](./SECURITY.md).

Two rules that constrain what may be built at all:

- **No provider-security bypass.** No CAPTCHA solving, no anti-abuse evasion, no
  credential entry on the user's behalf, no detection avoidance. A proposal
  requiring any of these is rejected at intake.
- **Opt-outs are honoured automatically.** Suppression is a system guarantee, not
  a user-configurable preference.

---

## 10. Documentation as a deliverable

Docs ship with the change that makes them true. Ownership map:

| Document | Covers |
|---|---|
| [README.md](./README.md) | what the product is |
| [WORKFLOW.md](./WORKFLOW.md) | runtime and engineering workflows |
| [SDLC.md](./SDLC.md) | this process |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | processes, job ledger, boundaries |
| [API.md](./API.md) | endpoints, envelope, WebSocket, rate limits |
| [DATABASE.md](./DATABASE.md) | schema generation, portability, indexes |
| [PLAYWRIGHT.md](./PLAYWRIGHT.md) | drivers, selectors, sessions |
| [INBOX.md](./INBOX.md) | sync, attribution, classification |
| [AI.md](./AI.md) | providers, prompts, guardrails |
| [SECURITY.md](./SECURITY.md) | auth, encryption, responsible use |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | topology, Docker, migrations, scaling |
| [MIGRATION.md](./MIGRATION.md) | importing the Apps Script system |
| [how to run.txt](./how%20to%20run.txt) | the shortest path to a running app |

---

## 11. Process backlog

Honest list of where this cycle is currently manual, in priority order:

1. **No CI.** `typecheck` and `test` are run by hand. A pipeline running both on
   every push is the single highest-value addition.
2. **No automated end-to-end run.** The simulation driver makes a scripted
   campaign-to-completion test entirely feasible; it does not exist yet.
3. **One test file.** 48 tests in `tests/unit.test.ts`. Splitting by domain would
   make the suite navigable as it grows.
4. **No migration history.** Local development uses `prisma db push`; production
   deployment expects real migrations. The first production release must
   establish a migration baseline.
5. **Single-commit history.** Trunk-based development assumes reviewable commits;
   the repository currently has two.
6. **No dependency update cadence.** Playwright in particular is version-pinned
   against a Gmail DOM that changes without notice.
