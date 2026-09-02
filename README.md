# MailFlow — Enterprise Mail Automation SaaS

Multi-user, multi-workspace, multi-mailbox outbound platform: sequence builder,
durable job queue, browser-driven Gmail automation, unified inbox with AI
analysis and reply drafting, and safety controls that are checked before every
single send.

Built as a replacement for a Google Apps Script + Sheets mail automation system —
preserving its behaviour (campaign processing, drafts, three-plus follow-up
levels, true Gmail thread replies, attachments, scheduling, bounce cleanup,
progress tracking, notifications) while removing its architectural limits.

> **Getting it running:** see [`how to run.txt`](./how%20to%20run.txt).
> Short version: `npm install && npm run setup && npm run dev`, then
> <http://localhost:5173> with `admin@mailflow.local` / `Admin@12345`.

---

## What it does

| Area | Capability |
|---|---|
| **Campaigns** | 8-step creation wizard, unlimited sequence steps, per-step template/delay/attachments, sending window + timezone, daily limit, randomised inter-send delay, draft-only mode, pause / resume / stop |
| **Sequences** | Initial send plus any number of follow-ups. Follow-ups reply **inside the existing Gmail thread** with a trimmed quote chain |
| **Safety** | Reply, bounce, opt-out and suppression checks before *every* send. A reply cancels all pending follow-ups automatically |
| **Contacts** | CRM-style records, custom fields, tags, bulk operations, CSV/XLSX import with column mapping, validation and duplicate detection, CSV export |
| **Templates** | Merge fields with inline fallbacks, live desktop/mobile preview against a real contact, pre-send variable validation, reusable attachments |
| **Mailboxes** | Multiple connected accounts, isolated browser sessions, per-mailbox daily/hourly quota, connection and session state |
| **Inbox** | Three-panel client, incremental sync, Gmail-style search operators, filters, contact and campaign attribution, real-time arrival |
| **AI** | Intent / sentiment / priority classification, thread summaries, reply drafting in 11 tones and 3 lengths, 9 editing actions, full suggestion history, provider abstraction |
| **Automation** | Durable job ledger, exponential backoff retry, stale-job recovery, per-step idempotency, live campaign monitor |
| **Analytics** | KPI cards, daily volume, per-campaign and per-step performance, mailbox load, AI insights, complete activity log |
| **Tenancy** | Organizations → workspaces → members, five roles, workspace-isolated data |
| **Migration** | Import the Apps Script workbook including thread metadata, so migrated conversations continue rather than restart |

---

## Architecture

```
                        ┌──────────────────────────┐
                        │   React + Vite + TS      │
                        │   TanStack Query · WS    │
                        └────────────┬─────────────┘
                                     │ REST + WebSocket
                                     ▼
                        ┌──────────────────────────┐
                        │   Node.js API (Express)  │
                        │   auth · RBAC · Zod      │
                        └────────────┬─────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
      ┌───────────────┐     ┌────────────────┐     ┌────────────────┐
      │  PostgreSQL   │     │  Redis/BullMQ  │     │  AI provider   │
      │  or SQLite    │     │  or DB queue   │     │  abstraction   │
      │  via Prisma   │     │  (job ledger)  │     │  5 providers   │
      └───────────────┘     └───────┬────────┘     └────────────────┘
                                    ▼
                          ┌────────────────────┐
                          │  Playwright Worker │
                          │  Gmail automation  │
                          └─────────┬──────────┘
                                    ▼
                              ┌──────────┐
                              │  Gmail   │
                              └──────────┘
```

Playwright never runs in the frontend, and the React app is never responsible
for browser automation. See [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Repository layout

```
mail-automation/
├── apps/
│   ├── web/          React + Vite + Tailwind SPA
│   ├── api/          Express REST API + WebSocket server
│   └── worker/       queue consumer, browser sessions, AI processing
├── packages/
│   ├── shared/       enums, Zod schemas, template engine, utilities (isomorphic)
│   ├── database/     Prisma client singleton
│   ├── config/       validated env, logger, AES-256-GCM crypto
│   ├── queue/        durable queue with BullMQ and database drivers
│   ├── playwright/   GmailAutomationService + simulation driver
│   ├── ai/           provider abstraction, prompt service, local provider
│   └── core/         domain services shared by api and worker
├── prisma/           schema template, generated schema, seeder
├── tests/            unit tests
├── docs/             (see the .md files in the root)
└── docker-compose.yml
```

`packages/core`, `packages/queue` and `packages/ai` are additions to the
structure in the specification; they exist because both the API and the worker
need the same domain logic, and a cross-app import between `apps/` would be
worse. The four packages named in the spec (`shared`, `database`, `config`,
`playwright`) are all present with those responsibilities.

---

## Technology

**Frontend** — React 18, Vite 5, TypeScript, React Router 6, Tailwind CSS 3,
Radix UI primitives (shadcn/ui pattern, hand-written), TanStack Query 5,
React Hook Form + Zod, Recharts, Lucide icons, Sonner.

**Backend** — Node.js, TypeScript, Express, Zod validation, JWT + bcrypt,
`ws` WebSockets, Helmet, rate limiting, Multer uploads, ExcelJS + Papa Parse.

**Data** — Prisma ORM over PostgreSQL or SQLite. Redis + BullMQ, or the
database-backed queue driver.

**Automation** — Playwright + Chromium, with a full simulation driver behind
the same interface.

**AI** — OpenAI, Anthropic, Gemini, Groq, or the built-in offline local
provider. No provider is hard-coded.

---

## Development phases

The platform was built in the order the specification lays out, and all twelve
phases are implemented: foundation, contacts, templates, Gmail automation,
campaigns, follow-ups, inbox, AI, safety and intelligence, analytics,
migration, and production concerns (tests, Docker, security hardening,
documentation).

---

## Testing

```bash
npm test          # 37 unit tests
npm run typecheck # strict TypeScript across every package and app
```

Covered: template variable rendering and validation, reply-chain construction,
subject normalisation, sending windows across timezones and DST, retry backoff,
idempotency keys, suppression matching, inbound classification (bounce /
opt-out / out-of-office / reply), AI prompt construction and guardrails, and
local-provider intent classification and drafting.

---

## Responsible use

This platform automates a mailbox you control. It contains nothing designed to
bypass provider security: no CAPTCHA solving, no anti-abuse evasion, no
credential entry, no detection avoidance. Rate limits, sending windows and
suppression exist to keep sending inside provider policy, and opt-out requests
are honoured automatically. Read [SECURITY.md](./SECURITY.md) before connecting
a real mailbox.
