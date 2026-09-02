# Database

Prisma ORM. The same model set runs on **PostgreSQL** (production) and
**SQLite** (zero-install development).

## Generated schema

`prisma/schema.prisma` is **generated** — do not edit it. Edit
`prisma/schema.template.prisma`, then:

```bash
npm run prisma:generate   # substitutes the datasource provider + generates the client
npm run prisma:push       # applies the schema
```

`scripts/prepare-prisma.mjs` substitutes the provider from `DATABASE_PROVIDER`.

## Portability rules

Two deliberate constraints keep one schema valid on both engines:

1. **No native enums.** Enum-like columns are `String`, with the allowed values
   defined once in `packages/shared/src/enums.ts` and enforced by Zod on every
   write. SQLite has no enum type; this avoids maintaining two divergent
   schemas.
2. **No scalar lists or `Json` columns.** Arrays and structured blobs are
   stored as JSON text in `*Json` columns (`tagsJson`, `participantsJson`,
   `payloadJson`, …) and read through `parseJson` / `parseList`, which never
   throw on malformed input.

Both are invisible above the data layer: the API returns real arrays and typed
unions.

## Model groups

**Identity and tenancy** — `Organization`, `Workspace`, `User`,
`WorkspaceMember` (role), `RefreshToken`, `PasswordResetToken`.

**Mailboxes** — `EmailAccount` (limits, connection state, encrypted
`secretsJson`), `EmailSession` (browser and session state, current job).

**Contacts** — `Contact` (the full field set from the source system plus
`customJson`), `ContactList`, `ContactListMember`.

**Content** — `EmailTemplate`, `Attachment`, `TemplateAttachment`,
`StepAttachment`.

**Campaigns** — `Campaign`, `CampaignStep` (ordered, unbounded),
`CampaignContact` (per-contact position in the sequence),
`CampaignContactStep` (the idempotency ledger).

**Inbox** — `EmailThread` (unique on `emailAccountId + gmailThreadId`),
`EmailMessage` (`messageId` is the RFC 822 Message-ID used for true in-thread
replies), `EmailAttachment`.

**Operations** — `ScheduledJob`, `AutomationRun`, `EmailEvent`, `ActivityLog`,
`Notification`.

**Safety** — `Bounce`, `Unsubscribe`, `SuppressionList`.

**AI** — `AIReplySuggestion` (append-only history), `AIAnalysis` (one per
message), `SystemSetting` (encrypted AI configuration).

## Constraints that carry meaning

| Constraint | Why it exists |
|---|---|
| `CampaignContactStep @@unique([campaignContactId, stepId])` | makes a duplicate send physically impossible |
| `CampaignContactStep.idempotencyKey @unique` | second guard, and the key the queue dedupes on |
| `ScheduledJob.dedupeKey @unique` | enqueueing the same work twice is a no-op |
| `EmailThread @@unique([emailAccountId, gmailThreadId])` | one row per Gmail conversation per mailbox |
| `AIAnalysis.messageId @unique` | analysis is idempotent per message |
| `Contact @@unique([workspaceId, email])` | a contact exists once per workspace |
| `SuppressionList @@unique([workspaceId, value])` | address or domain, one entry each |

## Indexes

Hot paths are indexed: `CampaignContact(nextStepAt)` for the scheduler sweep,
`CampaignContactStep(status, scheduledFor)`, `ScheduledJob(status, runAt)` and
`(queue, status)` for the queue poll, `EmailThread(workspaceId, lastMessageAt)`
for the inbox list, and `EmailEvent(workspaceId, type, createdAt)` for
analytics roll-ups.

## Deletion policy

Bounced and unsubscribed contacts are **never deleted** — their history stays
auditable while suppression blocks future sends. Deleting a campaign cascades
its steps and progress but leaves contacts and inbox threads intact.

## Useful commands

```bash
npm run prisma:studio   # browse the data
npm run db:seed         # re-seed demo data (idempotent)
npm run db:reset        # drop, rebuild, re-seed
```
