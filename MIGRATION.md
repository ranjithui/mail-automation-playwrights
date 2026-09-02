# Migration from the Apps Script system

The legacy platform is a Google Sheets workbook (`Main1`…`Main10`, `Process`,
`AutoProcess`, `Dashboard`) driven by Apps Script, where every prospect is a row
and follow-up state lives in fixed columns.

## How to run it

1. In Google Sheets: **File → Download → CSV** for each tab you want to bring
   across. Keep the tab name as the file name (`Main1.csv`, `Main2.csv`, …) —
   the file name decides whether a campaign is created.
2. Add at least one mailbox in **Email accounts** first. Thread metadata cannot
   be attached without one.
3. Open **Migration**, upload the CSVs, and review the analysis. Nothing is
   written at this stage.
4. Press **Run migration**.

Migrated campaigns are created **PAUSED** so you can review the sequence before
anything sends.

## Mapping

| Legacy | Becomes |
|---|---|
| `Main<N>` sheet | `ContactList` + `Campaign` (named "Main<N> (migrated)") |
| Row | `Contact` + `CampaignContact` |
| `TemplateID` | `EmailTemplate` referenced by a `CampaignStep` |
| `Status` | `CampaignContact.status` |
| `ThreadId` | `EmailThread.gmailThreadId` |
| `RfcMessageId` | `EmailMessage.messageId` |
| `LastMessageHtml` | `EmailMessage.bodyHtml` |
| `FollowUp1/2/3` dates and templates | `CampaignStep` 2–4 plus `CampaignContactStep` ledger rows |
| `Process` / `AutoProcess` triggers | `ScheduledJob` + the `campaign-scheduler` queue |
| `Dashboard` sheet | computed analytics — not stored |

Column headers are matched loosely, so `First Name`, `firstname` and
`first_name` all resolve to the same field.

Legacy statuses map as follows: `sent → SENT`, `replied → REPLIED`,
`followup1|2|3 → FOLLOWUP_PENDING`, `bounced → BOUNCED`,
`unsubscribed → UNSUBSCRIBED`, `completed|done → COMPLETED`,
`error|failed → FAILED`, anything unrecognised → `NEW`.

## Why migrated conversations continue rather than restart

`ThreadId`, `RfcMessageId` and `LastMessageHtml` are carried into
`EmailThread` and `EmailMessage`. A follow-up sent after migration therefore
opens the original Gmail conversation and replies inside it, with the previous
message quoted — the prospect sees one continuous thread, not a new email that
ignores everything already said.

## Why nothing is re-sent

For every contact the migration reconstructs the idempotency ledger: one
`CampaignContactStep` row marked `SENT` for each step the old system had
already completed (derived from `SentCount` / `Status`). Because that table is
unique on `(campaignContactId, stepId)`, a migrated contact who already
received the initial email and follow-up 1 **cannot** be sent them again — the
constraint makes it physically impossible, not merely unlikely.

## What changes, and why

| Old behaviour | New behaviour | Reason |
|---|---|---|
| Fixed `FollowUp1/2/3` columns | Ordered `CampaignStep[]`, unbounded | adding a fourth follow-up was a schema change; now it is a UI action |
| `PropertiesService` progress | `ScheduledJob` + `CampaignContactStep` | progress survives restarts and is queryable |
| Time-based triggers | Persistent scheduler that reschedules itself | no six-minute execution limit, no lost runs |
| `Utilities.sleep()` for pacing | Queued jobs with `runAt` offsets | pacing without holding execution time |
| Spreadsheet as the store | PostgreSQL / SQLite via Prisma | referential integrity, indexes, concurrency |
| Per-sheet manual status edits | Automatic reply, bounce and opt-out handling | a reply cancels follow-ups without anyone remembering to |
| Digest email from the script | `notification` queue + in-app digest | same content, no quota cost |

## Behaviour that could not be reproduced exactly

Following the specification's requirement to document rather than silently
drop:

| Existing function | Current behaviour | New implementation | Limitation | Recommended alternative |
|---|---|---|---|---|
| `DriveApp` attachment lookup by Drive file id | Attachments referenced by Drive id | Files uploaded into workspace storage and referenced by `Attachment.id` | Drive ids are not resolvable after migration | Re-upload the files once in **Templates → Attachments**; they are then reusable across every campaign |
| `GmailApp.search()` label-based queries | Arbitrary Gmail search over the whole mailbox | Incremental thread sync with `newer_than:` plus in-app search over synced data | Search covers what has been synced, not the entire historical mailbox | Raise the sync limit, or run a one-off wide sync from Email accounts |
| Spreadsheet formulas in `Dashboard` | Live sheet formulas | Computed analytics endpoints | Custom formulas are not carried over | Recreate the specific metric in Analytics, or query the database directly |
| Manual row colouring as status | Visual-only state in the sheet | Typed `status` columns and badges | Colour conventions are not machine-readable and are not imported | Map the convention to a status or a tag before exporting |

## After migrating

1. Open each migrated campaign and check the sequence — steps are created with
   sensible defaults (day 0, +3, +7, +14) but no template attached.
2. Attach templates to each step, or point the steps at templates you recreate
   from the old `TemplateID` documents.
3. Confirm the mailbox, sending window and daily limit.
4. Run a **test draft** against the first contact and check the merge fields.
5. Only then press **Start**.

Re-running a migration is safe: contacts are upserted by email, campaign
contacts and ledger rows by their unique keys.
