# MASTER DEVELOPMENT PROMPT
## Enterprise Mail Automation SaaS
### React + Vite + Node.js + PostgreSQL + Redis + Playwright + AI

---

# 1. PROJECT OBJECTIVE

Build a production-ready, multi-user **Mail Automation SaaS Platform** by using my existing Google Apps Script mail automation project as the **functional reference and baseline specification**.

The attached Apps Script already contains important functionality including:

- New email automation
- Gmail reply/follow-up automation
- True Gmail thread handling
- Trimmed Gmail reply chains
- Multiple campaign sheets
- Templates
- Attachments
- 3-level follow-ups
- Scheduling
- Daily automation
- Dashboard
- Bounce cleanup
- Progress tracking
- Automatic resume
- Notifications
- Draft creation
- Template preview
- Thread ID/RFC Message ID tracking
- Campaign status tracking

The existing system specifically supports NEW, FOLLOWUP1, FOLLOWUP2 and FOLLOWUP3 processing.

The new system must preserve these capabilities while replacing the Google Sheets + Apps Script architecture with a scalable SaaS architecture.

## IMPORTANT

Do NOT simply convert the Apps Script code into React.

Instead:

1. Analyze the existing Apps Script.
2. Extract all business functionality.
3. Redesign the architecture.
4. Build a proper backend.
5. Build a proper database.
6. Build a Playwright automation worker.
7. Build a modern React/Vite SaaS frontend.
8. Add Inbox management.
9. Add AI-powered reply suggestions.
10. Add reliable scheduling and queues.
11. Add multi-user and multi-mailbox support.
12. Add migration capability from the existing spreadsheet system.

The final product must be a professional SaaS application.

---

# 2. TARGET PRODUCT

The final application should provide:

```text
Dashboard
Campaign Management
Contact Management
Contact Lists
Email Templates
Email Accounts
Email Automation
Follow-Up Sequences
Inbox
AI Reply Assistant
Email Threads
Attachments
Scheduling
Automation Queue
Analytics
Bounce Management
Suppression Management
Notifications
Activity Logs
Workspace Management
User Management
Settings
```

---

# 3. RECOMMENDED ARCHITECTURE

Use this architecture:

```text
                         ┌──────────────────────────┐
                         │      React + Vite        │
                         │      TypeScript          │
                         │      SaaS Frontend       │
                         └────────────┬─────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────┐
                         │       Node.js API        │
                         │      TypeScript          │
                         └────────────┬─────────────┘
                                      │
                ┌─────────────────────┼─────────────────────┐
                │                     │                     │
                ▼                     ▼                     ▼
        ┌─────────────┐       ┌──────────────┐      ┌──────────────┐
        │ PostgreSQL  │       │ Redis/BullMQ │      │ AI Service   │
        │ Prisma      │       │ Job Queue    │      │ AI Provider  │
        └─────────────┘       └──────┬───────┘      └──────────────┘
                                     │
                                     ▼
                           ┌────────────────────┐
                           │ Playwright Worker  │
                           │ Gmail Automation   │
                           └─────────┬──────────┘
                                     │
                                     ▼
                           ┌────────────────────┐
                           │ Gmail Web Account  │
                           └────────────────────┘
```

Do NOT run Playwright directly inside the React frontend.

Do NOT make the React application responsible for browser automation.

---

# 4. TECHNOLOGY STACK

## Frontend

Use:

- React
- Vite
- TypeScript
- React Router
- Tailwind CSS
- shadcn/ui
- TanStack Query
- React Hook Form
- Zod
- Recharts
- Lucide Icons

## Backend

Use:

- Node.js
- TypeScript
- Fastify or Express
- REST API
- WebSocket support

## Database

Use:

- PostgreSQL
- Prisma ORM

## Queue

Use:

- Redis
- BullMQ

## Browser Automation

Use:

- Playwright
- Chromium

## AI

Create a provider abstraction supporting:

- OpenAI
- Anthropic
- Google Gemini
- Groq
- Future local models

Do not hard-code one AI provider.

---

# 5. PROJECT STRUCTURE

Use a monorepo.

```text
mail-automation/
│
├── apps/
│   ├── web/
│   │   └── src/
│   │
│   ├── api/
│   │   └── src/
│   │
│   └── worker/
│       └── src/
│
├── packages/
│   ├── database/
│   ├── shared/
│   ├── playwright/
│   └── config/
│
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
│
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
├── .env.example
│
├── README.md
├── ARCHITECTURE.md
├── DATABASE.md
├── API.md
├── PLAYWRIGHT.md
├── SECURITY.md
├── DEPLOYMENT.md
└── MIGRATION.md
```

Use pnpm workspaces.

---

# 6. MULTI-USER SAAS ARCHITECTURE

The application must be multi-user from the beginning.

Entities:

```text
Organization
Workspace
User
Role
Email Account
Campaign
Contact
Template
Automation
```

Every workspace must have isolated:

- Contacts
- Campaigns
- Email accounts
- Templates
- Attachments
- Inbox
- Threads
- Logs
- Analytics
- Settings

---

# 7. USER ROLES

Support:

```text
OWNER
ADMIN
MANAGER
USER
VIEWER
```

Permissions must be workspace-specific.

---

# 8. AUTHENTICATION

Implement:

- Registration
- Login
- Logout
- Forgot password
- Reset password
- Protected routes
- Session management
- Role-based access

Use secure authentication.

Never expose passwords or session secrets to the frontend.

---

# 9. DATABASE DESIGN

Use PostgreSQL + Prisma.

Minimum entities:

```text
User
Organization
Workspace
EmailAccount
EmailSession
Campaign
CampaignStep
Contact
ContactList
CampaignContact
EmailTemplate
Attachment
EmailThread
EmailMessage
EmailAttachment
ScheduledJob
AutomationRun
EmailEvent
Bounce
Unsubscribe
SuppressionList
ActivityLog
Notification
AIReplySuggestion
AIAnalysis
SystemSetting
```

---

# 10. EMAIL ACCOUNT MANAGEMENT

Users should be able to connect permitted Gmail/Google Workspace mailboxes.

Email account information:

```text
Email Address
Display Name
Status
Connection Status
Last Successful Connection
Last Error
Daily Sending Limit
Sent Today
Active Campaigns
```

Support multiple connected accounts where appropriate.

Example:

```text
sales@company.com
marketing@company.com
support@company.com
```

---

# 11. PLAYWRIGHT GMAIL AUTOMATION

Create a dedicated:

```text
GmailAutomationService
```

Methods:

```typescript
connect()
checkSession()
openInbox()
openCompose()
fillRecipient()
fillSubject()
fillBody()
attachFile()
saveDraft()
sendMessage()
searchConversation()
openConversation()
replyToConversation()
getLatestMessage()
getThreadId()
detectBounce()
markAsRead()
markAsUnread()
archiveThread()
logout()
```

Playwright must use reliable selectors.

Prefer:

```text
ARIA selectors
Role selectors
Label selectors
Text selectors
Stable attributes
Fallback selectors
```

Do not depend on one fragile CSS selector.

Every browser action must support:

- Timeout
- Retry
- Error logging
- Screenshot on failure
- Error classification

---

# 12. BROWSER SESSION MANAGEMENT

Create isolated browser contexts.

Each connected mailbox should have its own session.

Never expose:

- Cookies
- Session tokens
- Browser profiles
- Passwords

to the frontend.

Store sensitive session information securely.

---

# 13. CAMPAIGN MANAGEMENT

Create a professional campaign system.

Campaign fields:

```text
Campaign Name
Description
Workspace
Email Account
Contact List
Start Date
Timezone
Sending Window
Daily Limit
Minimum Delay
Maximum Delay
Random Delay
Status
Tracking
Created By
Created At
Updated At
```

Statuses:

```text
DRAFT
SCHEDULED
RUNNING
PAUSED
COMPLETED
FAILED
CANCELLED
```

---

# 14. CAMPAIGN CREATION WIZARD

Create a multi-step campaign wizard.

### Step 1

Campaign information.

### Step 2

Select email account.

### Step 3

Import/select contacts.

### Step 4

Build email sequence.

### Step 5

Select schedule.

### Step 6

Review campaign.

### Step 7

Test.

### Step 8

Launch.

---

# 15. CONTACT MANAGEMENT

Create a CRM-style contact system.

Support fields such as:

```text
First Name
Last Name
Title
Company Name
Email
Corporate Phone
Employees
Industry
Keywords
Person LinkedIn URL
Website
Company LinkedIn URL
Company Address
Company City
Company State
Company Country
Qualify Contact
```

These fields reflect the data-driven structure already used by the existing system.

Support custom fields.

---

# 16. CONTACT FEATURES

Implement:

- Search
- Filter
- Sort
- Pagination
- Import
- Export
- Tags
- Status
- Campaign history
- Email history
- Notes
- Bulk selection
- Bulk operations

Statuses:

```text
NEW
QUEUED
SENT
REPLIED
FOLLOWUP_PENDING
COMPLETED
BOUNCED
UNSUBSCRIBED
FAILED
PAUSED
```

---

# 17. CSV / EXCEL IMPORT

Support:

```text
CSV
XLSX
```

Import process:

```text
Upload
 ↓
Detect Columns
 ↓
Map Columns
 ↓
Validate
 ↓
Preview
 ↓
Detect Duplicates
 ↓
Import
```

Show validation errors before importing.

---

# 18. EMAIL TEMPLATE SYSTEM

Create:

```text
Templates
```

Features:

- Create
- Edit
- Duplicate
- Delete
- Preview
- Test
- Categories
- Subject
- HTML body
- Plain-text body
- Attachments

---

# 19. TEMPLATE VARIABLES

Support:

```text
{{First Name}}
{{Last Name}}
{{Company Name}}
{{Title}}
{{Industry}}
{{Website}}
{{Company City}}
{{Company Country}}
```

Also support custom fields.

Validate variables before sending.

---

# 20. TEMPLATE PREVIEW

Create live preview.

Example:

```text
First Name: John
Company Name: ABC Technologies
Industry: SaaS
```

Render:

```text
Hi John,

I noticed that ABC Technologies is working in SaaS.
```

Support:

```text
Desktop Preview
Mobile Preview
```

---

# 21. NEW EMAIL AUTOMATION

Support:

```text
Create Draft
Send Automatically
```

Workflow:

```text
Campaign
 ↓
Contacts
 ↓
Template
 ↓
Preview
 ↓
Test
 ↓
Schedule
 ↓
Queue
 ↓
Playwright
 ↓
Gmail
```

---

# 22. DRAFT MODE

Implement:

```text
Test First Contact
Create Drafts for Selected
Create Drafts for Entire Campaign
```

Display:

```text
Draft Created
Draft Failed
Skipped
```

The existing project already supports test-first-row draft generation and bulk draft creation.

---

# 23. FOLLOW-UP SEQUENCE

Preserve the existing three-level follow-up functionality.

Existing model:

```text
Initial Email
 ↓
Follow-Up 1
 ↓
Follow-Up 2
 ↓
Follow-Up 3
```

The existing Apps Script stores separate dates, templates, statuses and thread IDs for each step.

New system should replace this fixed spreadsheet structure with a flexible sequence builder.

---

# 24. SEQUENCE BUILDER

Allow:

```text
Add Step
Delete Step
Duplicate Step
Change Delay
Change Template
Change Attachment
Enable/Disable Step
```

Example:

```text
Step 1
Initial Email
Day 0

↓

Step 2
Follow-Up
Day 3

↓

Step 3
Follow-Up
Day 7

↓

Step 4
Final Follow-Up
Day 14
```

Do not hard-code a maximum of three follow-ups in the database.

Allow future expansion.

---

# 25. SMART FOLLOW-UP RULES

Before sending follow-ups check:

```text
Has recipient replied?
Has recipient unsubscribed?
Has recipient bounced?
Is contact suppressed?
Is campaign active?
Is mailbox connected?
```

If recipient replies:

```text
STOP FUTURE FOLLOW-UPS
```

---

# 26. TRUE GMAIL THREAD REPLY

Follow-ups should be replies within the existing Gmail conversation whenever possible.

The existing system already stores:

```text
ThreadId
RfcMessageId
LastMessageHtml
```

for this purpose.

New database:

```text
EmailThread
----------------
id
workspaceId
campaignId
contactId
emailAccountId
gmailThreadId
subject
lastMessageId
lastMessageAt
status
```

---

# 27. EMAIL CHAIN

Preserve Gmail-style conversation history.

The current implementation constructs a trimmed reply chain from previous Gmail messages.

The new system must preserve the conversation context when replying.

---

# 28. ATTACHMENTS

Support:

```text
PDF
DOCX
XLSX
PPTX
Images
ZIP
```

Features:

- Upload
- Preview
- Rename
- Delete
- Reuse
- Attach to campaign
- Attach to sequence step

Private attachments must not be publicly accessible.

---

# 29. SCHEDULER

Implement a persistent scheduler.

Support:

```text
Run Now
Scheduled Date
Scheduled Time
Daily
Weekly
Custom Schedule
Timezone
Sending Window
```

Example:

```text
Timezone:
Asia/Kolkata

Sending Window:
09:30–17:30
```

---

# 30. QUEUE SYSTEM

Use:

```text
Redis + BullMQ
```

Queues:

```text
email-send
email-followup
campaign-scheduler
browser-worker
inbox-sync
bounce-check
ai-analysis
ai-reply
notification
analytics
```

Every email should be represented as an individual job.

---

# 31. DELAY CONTROL

Allow configurable:

```text
Minimum Delay
Maximum Delay
Random Delay
Daily Limit
Hourly Limit
Mailbox Limit
```

Example:

```text
Minimum: 30 sec
Maximum: 60 sec
Randomization: ON
```

Respect provider limits and policies.

Do not build mechanisms to bypass Gmail security, anti-abuse systems, CAPTCHAs, or provider restrictions.

---

# 32. CAMPAIGN PAUSE / RESUME

Every campaign must support:

```text
PAUSE
RESUME
STOP
```

When paused, new jobs should not execute.

When resumed, continue from pending jobs.

---

# 33. IDEMPOTENCY

Prevent duplicate sends.

Before sending:

```text
Campaign
+
Contact
+
Sequence Step
```

must be checked.

Never resend an already completed job because a worker restarted.

---

# 34. WORKER RECOVERY

If a Playwright worker crashes:

```text
Job remains persistent
 ↓
Detect stale job
 ↓
Retry
 ↓
Continue
```

Do not lose campaign progress.

---

# 35. INBOX MODULE

Add a major navigation item:

```text
Inbox
```

The Inbox must display received emails from connected Gmail accounts.

Sections:

```text
All Mail
Unread
Important
Replied
Waiting for Reply
AI Suggested
Archived
```

---

# 36. INBOX UI

Use a three-panel interface:

```text
┌──────────────┬─────────────────────────┬─────────────────────┐
│ Inbox        │ Email List              │ Email Thread        │
│              │                         │                     │
│ All          │ John Smith              │ John Smith          │
│ Unread       │ Re: Proposal            │                     │
│ Important    │ 10:32 AM                │ Message...          │
│ Replied      │                         │                     │
│ AI Suggested │ Sarah Wilson            │                     │
│ Archived     │ Re: Partnership         │                     │
└──────────────┴─────────────────────────┴─────────────────────┘
```

---

# 37. INBOX EMAIL LIST

Display:

```text
Sender
Email
Subject
Preview
Time
Read/Unread
Attachment
Campaign
AI Status
```

---

# 38. EMAIL THREAD VIEW

Display:

```text
Sender
Recipients
CC
Subject
Timestamp
Body
Attachments
Conversation History
```

Actions:

```text
Reply
Reply All
Forward
Archive
Mark Read
Mark Unread
Star
Add Label
Add Note
```

---

# 39. INBOX SYNCHRONIZATION

Create:

```text
InboxSyncService
```

Methods:

```typescript
syncInbox()
fetchMessages()
fetchThread()
fetchMessage()
markAsRead()
markAsUnread()
archiveThread()
starThread()
getAttachments()
```

Use Playwright for Gmail browser interaction where required.

Use background workers.

Do not reload the entire mailbox repeatedly.

Use incremental synchronization.

---

# 40. INBOX DATABASE

Create:

```text
EmailThread
-------------------------
id
workspaceId
emailAccountId
gmailThreadId
subject
participants
lastMessageAt
lastMessageDirection
status
isRead
isStarred
createdAt
updatedAt
```

And:

```text
EmailMessage
-------------------------
id
threadId
gmailMessageId
messageId
sender
recipients
cc
bcc
subject
bodyText
bodyHtml
direction
receivedAt
sentAt
isRead
hasAttachments
createdAt
```

And:

```text
EmailAttachment
-------------------------
id
messageId
filename
mimeType
size
storagePath
gmailAttachmentId
```

---

# 41. EMAIL DIRECTION

Classify:

```text
INBOUND
OUTBOUND
```

This must be used for conversation rendering, analytics and AI processing.

---

# 42. CONTACT ↔ INBOX

When an email arrives:

```text
Sender Email
 ↓
Find Contact
 ↓
Contact Found?
```

If found:

```text
Attach email to Contact
```

If not:

```text
Show New Contact
```

Allow creating a contact directly from Inbox.

---

# 43. CAMPAIGN ↔ INBOX

If an incoming email belongs to a campaign:

```text
Email
 ↓
Thread
 ↓
Contact
 ↓
Campaign
```

Display:

```text
Campaign: SaaS Outreach
Sequence Step: Follow-Up 2
```

---

# 44. AUTOMATIC FOLLOW-UP CANCELLATION

This is mandatory.

When an inbound reply arrives:

```text
Incoming Email
 ↓
Identify Contact
 ↓
Identify Campaign
 ↓
Identify Thread
 ↓
Mark Contact REPLIED
 ↓
Cancel Pending Follow-Ups
```

Example:

```text
Follow-Up 2 → Scheduled
Follow-Up 3 → Scheduled

Prospect replies

Follow-Up 2 → Cancelled
Follow-Up 3 → Cancelled
```

---

# 45. AI REPLY ASSISTANT

Add an AI assistant inside the email thread.

Example:

```text
┌──────────────────────────────────────┐
│ AI Reply Assistant                   │
├──────────────────────────────────────┤
│ Suggested Reply                      │
│                                      │
│ Hi John,                             │
│                                      │
│ Thanks for getting back to me...     │
│                                      │
│ [Regenerate] [Shorter]               │
│ [Professional] [Friendly]            │
│                                      │
│ [Insert Reply]                       │
└──────────────────────────────────────┘
```

---

# 46. AI REPLY GENERATION

When the user clicks:

```text
Generate AI Reply
```

the AI should analyze:

```text
Latest Incoming Email
Previous Conversation
Contact Information
Company Information
Campaign
Original Email
Follow-Up History
User's Custom Instructions
```

---

# 47. AI CONTEXT

Use structured context:

```json
{
  "contact": {
    "name": "John Smith",
    "company": "ABC Technologies",
    "title": "CEO",
    "industry": "SaaS"
  },
  "campaign": {
    "name": "SaaS Outreach",
    "sequenceStep": 2
  },
  "conversation": [],
  "latestMessage": "",
  "originalMessage": ""
}
```

Send only required information to external AI providers.

---

# 48. AI REPLY STYLES

Support:

```text
Professional
Friendly
Concise
Persuasive
Executive
Technical
Follow-Up
Thank You
Meeting Request
Pricing Response
Information Request
```

---

# 49. AI REPLY LENGTH

Support:

```text
Short
Medium
Detailed
```

Allow custom instructions.

Example:

```text
Keep the response under 80 words and ask for a meeting next week.
```

---

# 50. MULTIPLE AI SUGGESTIONS

Generate up to three options:

```text
Professional
Friendly
Concise
```

User selects one.

---

# 51. AI REPLY ACTIONS

Support:

```text
Insert Reply
Copy
Edit
Regenerate
Save as Template
```

Never automatically send AI replies by default.

Default:

```text
Incoming Email
 ↓
AI Suggestion
 ↓
User Review
 ↓
User Edit
 ↓
Save Draft
 ↓
User Sends
```

---

# 52. AI REPLY COMPOSER

Composer:

```text
To
Subject
Body
Attachments
AI Assistant
Templates
```

Actions:

```text
Save Draft
Send Reply
```

---

# 53. AI EDITING ACTIONS

Support:

```text
Regenerate
Shorten
Expand
Make Professional
Make Friendly
Improve Grammar
Make More Persuasive
Remove Sales Language
Add Meeting CTA
```

These modify the draft only.

---

# 54. AI INTENT DETECTION

Classify incoming emails:

```text
INTERESTED
NOT_INTERESTED
ASKING_PRICING
ASKING_INFORMATION
MEETING_REQUEST
REQUEST_CALLBACK
NEEDS_FOLLOWUP
POSITIVE
NEGATIVE
OUT_OF_OFFICE
UNSUBSCRIBE
BOUNCE
OTHER
```

---

# 55. AI SENTIMENT

Optional:

```text
Positive
Neutral
Negative
```

Treat this as an assistive classification, not an absolute fact.

---

# 56. AI PRIORITY

Classify:

```text
HIGH
MEDIUM
LOW
```

Example:

```text
High Priority
Prospect requested pricing.
```

Allow manual override.

---

# 57. SMART INBOX

Add:

```text
AI Inbox
```

Sections:

```text
Requires Attention
Pricing Requests
Meeting Requests
Interested
Not Interested
Waiting for Response
```

---

# 58. AI REPLY INDICATOR

Inbox list should display:

```text
AI Reply Available
```

Example:

```text
John Smith
Re: Website Proposal

Could you share the pricing?

[AI Reply]
```

---

# 59. AI REPLY HISTORY

Store every generated suggestion.

Entity:

```text
AIReplySuggestion
-------------------------
id
workspaceId
threadId
messageId
contactId
style
length
promptVersion
suggestion
selected
edited
sent
createdAt
```

Never overwrite previous suggestions.

---

# 60. AI PROVIDER ABSTRACTION

Create:

```typescript
interface AIProvider {
  generateReply(context: ReplyContext): Promise<ReplySuggestion>;
  classifyIntent(context: EmailContext): Promise<IntentResult>;
  summarizeThread(context: EmailContext): Promise<string>;
}
```

Providers:

```text
OpenAI
Anthropic
Gemini
Groq
Local Model
```

---

# 61. AI SETTINGS

Add:

```text
Settings
→ AI
```

Fields:

```text
AI Provider
API Key
Model
Temperature
Max Tokens
Default Reply Style
Default Reply Length
Enable Intent Detection
Enable Thread Summary
Enable AI Reply
```

Encrypt API keys.

Never expose them to React.

---

# 62. AI THREAD SUMMARY

Show:

```text
AI Summary
```

Example:

```text
John is interested in the service.
He requested pricing and delivery timeline.
Recommended next action: send pricing and offer a meeting.
```

---

# 63. AI NEXT ACTION

AI may suggest:

```text
Schedule a Meeting
Send Pricing
Send Information
Follow Up Later
No Action
```

These are advisory.

Require user confirmation before executing consequential actions.

---

# 64. AI MEETING DETECTION

If a prospect requests a meeting:

```text
Meeting Request Detected
```

Show:

```text
[Create Calendar Event]
```

Do not automatically create calendar events without user confirmation.

---

# 65. AI UNSUBSCRIBE DETECTION

Detect phrases such as:

```text
Remove me
Stop emailing
Unsubscribe
Do not contact me
```

Classify as:

```text
UNSUBSCRIBE
```

Then:

```text
Add to Suppression List
Stop Future Campaigns
Cancel Follow-Ups
```

---

# 66. OUT-OF-OFFICE DETECTION

Detect:

```text
OUT_OF_OFFICE
```

Extract when reliably available:

```text
Return Date
Alternative Contact
```

Avoid sending normal follow-ups while OOO unless workspace settings permit it.

---

# 67. INBOX SEARCH

Support:

```text
from:
to:
subject:
campaign:
company:
status:
date:
```

Also provide normal keyword search.

---

# 68. INBOX FILTERS

Support:

```text
Unread
Read
Starred
Has Attachment
AI Reply Available
Requires Attention
Interested
Pricing
Meeting Request
Unsubscribe
Campaign
Email Account
Date
```

---

# 69. REAL-TIME INBOX

Use WebSockets.

Architecture:

```text
Gmail
 ↓
Inbox Sync Worker
 ↓
PostgreSQL
 ↓
WebSocket
 ↓
React Inbox
```

New incoming messages should appear without a full page refresh.

---

# 70. AI PROCESSING QUEUE

AI should run asynchronously.

```text
Incoming Email
 ↓
Inbox Sync
 ↓
Database
 ↓
AI Queue
 ↓
AI Worker
 ↓
Intent
Sentiment
Priority
Summary
Reply Suggestion
 ↓
Database
 ↓
React
```

Do not block Inbox synchronization while AI is processing.

---

# 71. AI COST CONTROL

Allow:

```text
AI Analysis ON/OFF

Generate Reply Automatically ON/OFF

Analyze Only:
High Priority

Analyze Only:
Campaign Replies

Analyze Only:
Unread Emails
```

Do not automatically analyze every email unless explicitly enabled.

---

# 72. AI PRIVACY

Minimize data sent to external AI.

Never send:

```text
Passwords
Cookies
Session Tokens
Authentication Data
Unrelated Emails
Unnecessary Personal Information
```

Allow workspace administrators to disable external AI.

---

# 73. AI PROMPT SERVICE

Do not store prompts inside React components.

Create:

```text
ReplyPromptService
```

Example:

```typescript
buildReplyPrompt({
  contact,
  campaign,
  thread,
  latestMessage,
  style,
  length,
  customInstructions
});
```

Version prompts:

```text
reply-v1
reply-v2
reply-v3
```

Store prompt version with AI result.

---

# 74. AI GUARDRAILS

AI must:

- Use only supplied information
- Not invent pricing
- Not invent services
- Not promise unavailable features
- Not invent meeting availability
- Not fabricate information
- Respect unsubscribe requests
- Avoid sending automatically
- Preserve user's intended meaning

If information is missing:

```text
Additional information is required before generating a reliable response.
```

---

# 75. BOUNCE MANAGEMENT

The existing system includes bounce cleanup.

Create:

```text
Bounce Management
```

Features:

- Detect bounce
- Store reason
- Mark contact bounced
- Suppress future sends
- Search
- Filter
- Export
- History

Do not simply delete bounced contacts.

---

# 76. SUPPRESSION MANAGEMENT

Create centralized suppression.

Types:

```text
BOUNCE
UNSUBSCRIBE
MANUAL_BLOCK
DOMAIN_BLOCK
COMPLAINT
```

Before every email:

```text
Check SuppressionList
```

If suppressed:

```text
SKIP
```

---

# 77. NOTIFICATIONS

Support:

```text
Campaign Completed
Campaign Failed
Authentication Expired
Worker Error
High Bounce Rate
New Important Reply
AI Reply Available
```

Channels:

```text
In-App
Email
```

---

# 78. DAILY DIGEST

Replace the Apps Script digest with backend notifications.

Include:

```text
Campaigns Processed
Emails Sent
Drafts Created
Follow-Ups
Replies
Bounces
Failures
Paused Campaigns
```

The current Apps Script already produces daily execution statistics and error summaries.

---

# 79. DASHBOARD

Create KPI cards:

```text
Total Contacts
Emails Sent
Drafts Created
Replies
Follow-Ups
Bounces
Unsubscribes
Failed
```

Charts:

```text
Emails Sent Per Day
Replies Per Day
Campaign Performance
Bounce Rate
Response Rate
Mailbox Performance
AI-Assisted Replies
```

---

# 80. LIVE CAMPAIGN MONITOR

Display:

```text
Campaign: SaaS Outreach

████████████░░░░ 62%

Processed: 620
Sent: 580
Failed: 12
Skipped: 28
Replies: 21

Current Contact:
John Smith

Current Action:
Opening Gmail conversation...
```

Use WebSockets.

---

# 81. ACTIVITY LOGS

Each action must record:

```text
Timestamp
Workspace
Campaign
Contact
Email Account
Job
Action
Status
Duration
Error
Retry Count
Worker
```

Example:

```text
Opening Gmail
Compose Opened
Recipient Entered
Email Sent
SUCCESS
```

---

# 82. ERROR TYPES

Create structured errors:

```text
AUTH_ERROR
SESSION_EXPIRED
GMAIL_NOT_AVAILABLE
SELECTOR_NOT_FOUND
ATTACHMENT_ERROR
THREAD_NOT_FOUND
SEND_FAILED
BOUNCE
RATE_LIMIT
TIMEOUT
NETWORK_ERROR
UNKNOWN_ERROR
```

Every failure should:

1. Log error
2. Capture screenshot
3. Retry if appropriate
4. Update status
5. Continue other jobs where possible

---

# 83. RETRY

Use exponential backoff.

Example:

```text
Attempt 1
 ↓
30 sec
 ↓
Attempt 2
 ↓
2 min
 ↓
Attempt 3
 ↓
10 min
```

Make retry count configurable.

---

# 84. CONTACT TIMELINE

Each contact should display:

```text
Contact Added
 ↓
Campaign Added
 ↓
Email Draft Created
 ↓
Email Sent
 ↓
Follow-Up Scheduled
 ↓
Follow-Up Sent
 ↓
Reply Received
 ↓
AI Reply Suggested
 ↓
Reply Sent
```

---

# 85. CONTACT DETAIL PAGE

Sections:

```text
Contact Information
Company Information
Campaigns
Email Timeline
Gmail Thread
AI Analysis
Notes
Status
```

---

# 86. CAMPAIGN DETAIL PAGE

Sections:

```text
Overview
Contacts
Sequence
Templates
Schedule
Analytics
Inbox Replies
AI Insights
Activity
Errors
Settings
```

---

# 87. EMAIL ACCOUNT PAGE

Display:

```text
Email Address
Connection Status
Browser Status
Sent Today
Daily Limit
Active Campaigns
Last Activity
```

Actions:

```text
Connect
Reconnect
Test
Pause
Disconnect
```

---

# 88. BROWSER SESSION PAGE

Display:

```text
Account
Browser Status
Session Status
Last Activity
Current Campaign
Current Job
Error
```

Actions:

```text
Start
Stop
Restart
Reconnect
```

---

# 89. API STRUCTURE

Create:

```text
/api/auth
/api/users
/api/workspaces
/api/email-accounts
/api/campaigns
/api/campaigns/:id
/api/campaigns/:id/start
/api/campaigns/:id/pause
/api/campaigns/:id/resume
/api/campaigns/:id/stop
/api/campaigns/:id/analytics
/api/contacts
/api/contact-lists
/api/templates
/api/attachments
/api/email-threads
/api/email-messages
/api/inbox
/api/jobs
/api/logs
/api/bounces
/api/suppression
/api/notifications
/api/ai
/api/dashboard
```

---

# 90. API RESPONSE FORMAT

Success:

```json
{
  "success": true,
  "data": {}
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "CAMPAIGN_NOT_FOUND",
    "message": "Campaign not found"
  }
}
```

---

# 91. SECURITY

Implement:

- Password hashing
- Secure sessions
- HTTP-only cookies where appropriate
- CSRF protection where applicable
- Rate limiting
- Input validation
- XSS protection
- SQL injection protection
- File upload validation
- Workspace isolation
- RBAC
- Audit logging
- Encryption of sensitive credentials

Never expose:

```text
Passwords
Session Cookies
OAuth Secrets
Encryption Keys
AI API Keys
Browser Profiles
```

---

# 92. FILE STORAGE

Attachments must use secure storage.

Possible:

```text
Local Storage
S3-compatible Storage
Google Cloud Storage
Azure Blob
```

Design the application so storage can be changed later.

---

# 93. REACT NAVIGATION

Sidebar:

```text
Dashboard

Campaigns
  ├── All Campaigns
  ├── Create Campaign
  └── Sequences

Contacts
  ├── All Contacts
  ├── Lists
  └── Suppression

Inbox
  ├── All Mail
  ├── Unread
  ├── Important
  └── AI Inbox

Templates

Email Accounts

Automation
  ├── Scheduler
  ├── Running Jobs
  └── Logs

Analytics

Bounces

Notifications

Settings
```

---

# 94. UI DESIGN

Create a professional enterprise SaaS interface.

Use:

- Clean layout
- Consistent spacing
- Professional typography
- Rounded cards
- Subtle borders
- Status badges
- Responsive tables
- Skeleton loaders
- Empty states
- Toast notifications
- Confirmation dialogs
- Error states

Avoid:

- Excessive gradients
- Excessive animations
- Clutter
- Amateur dashboard design

---

# 95. MAIN DASHBOARD

Top:

```text
Workspace Selector
Search
Notifications
User Profile
```

Dashboard:

```text
KPI Cards
Campaign Performance
Email Activity
Inbox Activity
AI Insights
Mailbox Performance
Recent Activity
```

---

# 96. REACT COMPONENT STRUCTURE

Use reusable components:

```text
components/
  layout/
  dashboard/
  campaigns/
  contacts/
  inbox/
  templates/
  email-accounts/
  automation/
  analytics/
  ai/
  common/
  forms/
  tables/
  dialogs/
```

Do not create one giant React component.

---

# 97. STATE MANAGEMENT

Use:

```text
TanStack Query
```

for server state.

Do not create a giant global state object.

---

# 98. FORM VALIDATION

Use:

```text
React Hook Form
+
Zod
```

Validate frontend and backend.

---

# 99. REAL-TIME SYSTEM

Use WebSockets for:

```text
Campaign Progress
Inbox Updates
Worker Status
AI Processing Status
Notifications
```

---

# 100. MIGRATION FROM EXISTING APPS SCRIPT

The existing system uses:

```text
Main1
Main2
...
Main10

Process

AutoProcess

Dashboard
```

Do not reproduce these as permanent architecture.

Instead map them to:

```text
Main1 → Campaign / Contact List

TemplateID → EmailTemplate

Status → CampaignContact status

ThreadId → EmailThread.gmailThreadId

RfcMessageId → EmailMessage.messageId

LastMessageHtml → EmailMessage.bodyHtml
```

The existing system uses spreadsheet columns for campaign scheduling, templates, statuses, thread IDs and attachments.

---

# 101. DO NOT REPRODUCE APPS SCRIPT LIMITATIONS

Do not use:

```text
SpreadsheetApp
GmailApp
DriveApp
PropertiesService
ScriptApp
Utilities.sleep()
```

as the core architecture.

Replace them with:

```text
PostgreSQL
Playwright
Secure File Storage
Redis
BullMQ
Persistent Scheduler
Worker Services
```

The existing system currently uses Apps Script properties for progress and time-based triggers for daily/resume execution.

---

# 102. PROGRESS TRACKING

Campaign jobs must persist:

```text
Job ID
Campaign ID
Contact ID
Step ID
Status
Started At
Completed At
Retry Count
Error
Worker ID
```

If the application restarts:

```text
Resume pending jobs
```

Do not duplicate completed jobs.

---

# 103. TESTING

Create unit tests for:

```text
Template Variables
Scheduling
Sequence Logic
Suppression
Retry
Idempotency
AI Prompt Construction
Intent Classification
```

Integration tests for:

```text
API
Database
Redis
Queues
Scheduler
```

Playwright tests for controlled Gmail test accounts where permitted.

---

# 104. DOCKER

Create:

```text
docker-compose.yml
```

Services:

```text
web
api
worker
postgres
redis
```

Running:

```text
docker compose up
```

should start the development environment.

---

# 105. ENVIRONMENT VARIABLES

Create:

```text
.env.example
```

Example:

```env
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
SESSION_SECRET=
ENCRYPTION_KEY=
APP_URL=
API_URL=
PLAYWRIGHT_HEADLESS=true
LOG_LEVEL=info
AI_PROVIDER=
AI_MODEL=
AI_API_KEY=
```

Never commit real secrets.

---

# 106. DOCUMENTATION

Create:

```text
README.md
ARCHITECTURE.md
DATABASE.md
API.md
PLAYWRIGHT.md
AI.md
INBOX.md
SECURITY.md
DEPLOYMENT.md
MIGRATION.md
```

---

# 107. DEVELOPMENT PHASES

Do not build the entire platform in one step.

## Phase 1 — Foundation

Build:

- Monorepo
- React/Vite
- Backend
- PostgreSQL
- Prisma
- Redis
- Authentication
- Workspace
- Basic dashboard

## Phase 2 — Contacts

Build:

- Contact management
- Lists
- CSV/XLSX import
- Search
- Filters
- Bulk operations

## Phase 3 — Templates

Build:

- Template management
- Variables
- Preview
- Attachments

## Phase 4 — Gmail Automation

Build:

- Email account management
- Playwright
- Browser sessions
- Gmail connection
- Draft creation
- Send

## Phase 5 — Campaigns

Build:

- Campaign creation
- Contact assignment
- Sequence builder
- Scheduler
- Queue
- Pause/resume

## Phase 6 — Follow-Ups

Build:

- Gmail thread detection
- Reply automation
- Follow-Up 1
- Follow-Up 2
- Follow-Up 3
- Smart cancellation

## Phase 7 — Inbox

Build:

- Gmail inbox synchronization
- Email list
- Thread view
- Search
- Filters
- Contact integration
- Campaign integration
- Real-time updates

## Phase 8 — AI

Build:

- AI provider abstraction
- Intent detection
- Thread summaries
- AI reply suggestions
- AI reply composer
- AI editing
- AI history
- AI settings

## Phase 9 — Safety & Intelligence

Build:

- Bounce detection
- Suppression
- Unsubscribe detection
- OOO detection
- Smart follow-up cancellation
- Priority classification

## Phase 10 — Analytics

Build:

- Dashboard
- Campaign analytics
- Inbox analytics
- AI analytics
- Mailbox analytics
- Activity logs
- Notifications

## Phase 11 — Migration

Build:

- Google Sheets import
- Main1–Main10 migration
- Process migration
- AutoProcess migration
- Template migration
- Thread metadata migration

## Phase 12 — Production

Build:

- Testing
- Docker
- Security hardening
- Monitoring
- Backup
- Deployment
- Documentation

---

# 108. ACCEPTANCE CRITERIA

The complete system is ready only when:

## Authentication

- Registration works
- Login works
- Logout works
- Protected routes work
- RBAC works

## Contacts

- CSV import works
- XLSX import works
- Column mapping works
- Search works
- Filters work
- Bulk actions work

## Templates

- Create template
- Edit template
- Preview template
- Variables work
- Attachments work

## Campaigns

- Create campaign
- Select mailbox
- Select contacts
- Configure sequence
- Schedule
- Start
- Pause
- Resume
- Stop

## Gmail

- Browser session works
- Compose works
- Recipient works
- Subject works
- Body works
- Attachment works
- Draft works
- Send works
- Thread search works
- Reply works

## Follow-Ups

- Follow-Up 1 works
- Follow-Up 2 works
- Follow-Up 3 works
- Reply stops future follow-ups
- Bounce stops follow-ups
- Unsubscribe stops future sends

## Inbox

- Inbox synchronization works
- Received emails appear
- Read/unread works
- Thread display works
- Attachments work
- Search works
- Filters work
- Contact linking works
- Campaign linking works
- Real-time updates work

## AI

- AI analysis works
- Intent detection works
- Priority detection works
- Thread summary works
- AI reply suggestions work
- Multiple styles work
- Regeneration works
- Editing works
- Insert Reply works
- AI history works
- Provider switching works
- AI can be disabled

## Automation

- Scheduler works
- Queue works
- Retry works
- Pause/resume works
- Worker recovery works
- Duplicate sends are prevented
- Follow-up cancellation works

## Safety

- Suppression works
- Unsubscribe detection works
- Bounce detection works
- AI does not automatically send by default
- User approval is required
- Provider limits are respected
- Credentials remain secure

## Analytics

- Dashboard updates
- Campaign analytics work
- Inbox analytics work
- AI analytics work
- Activity logs work
- Notifications work

---

# 109. IMPORTANT IMPLEMENTATION RULE

Before writing production code:

1. Analyze the attached Apps Script.
2. Create a complete feature inventory.
3. Identify every existing function and its purpose.
4. Map existing functions to the new architecture.
5. Create database schema.
6. Create API architecture.
7. Create Playwright architecture.
8. Create Inbox architecture.
9. Create AI architecture.
10. Create frontend route map.
11. Create migration mapping.
12. Present the implementation plan.
13. Implement Phase 1.
14. Test Phase 1.
15. Continue phase-by-phase.

Do not silently remove functionality.

If an existing Apps Script function cannot be reproduced exactly, document:

```text
Existing Function
Current Behavior
New Implementation
Limitation
Recommended Alternative
```

---

# 110. FINAL PRODUCT ARCHITECTURE

The final product should be:

```text
                         MAIL AUTOMATION SAAS
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
   CAMPAIGNS                    INBOX                     AI
        │                         │                         │
        ▼                         ▼                         ▼
   Sequences                  Gmail Sync              AI Analysis
   Scheduling                 Threads                 AI Reply
   Follow-Ups                 Contacts                Summaries
   Sending                    Attachments             Intent
        │                         │                     Priority
        └──────────────┬──────────┴──────────┬──────────────┘
                       │                     │
                       ▼                     ▼
                  JOB QUEUE             DATABASE
                       │                     │
                       ▼                     ▼
                PLAYWRIGHT              PostgreSQL
                   WORKERS
                       │
                       ▼
                     GMAIL
```

The final system must be:

```text
Multi-user
Multi-workspace
Multi-mailbox
Campaign-based
Sequence-based
Queue-based
Scheduler-driven
Browser-automation based
Inbox-enabled
AI-assisted
Database-backed
Recoverable
Observable
Secure
Scalable
```

---

# 111. FINAL DEVELOPMENT INSTRUCTION

Build this as a **real production SaaS platform**, not as a demo.

The attached Apps Script is the reference for existing business functionality. Preserve its important behavior, including campaign processing, draft creation, follow-ups, Gmail thread handling, attachments, scheduling, bounce management, progress handling and notifications.

However, redesign the implementation around:

```text
React/Vite
+
Node.js
+
PostgreSQL
+
Redis/BullMQ
+
Playwright Workers
+
AI Provider Abstraction
+
Real-Time WebSockets
```

The most important user workflow should be:

```text
Import Contacts
      ↓
Create Campaign
      ↓
Build Email Sequence
      ↓
Select Gmail Account
      ↓
Test
      ↓
Schedule
      ↓
Queue
      ↓
Playwright
      ↓
Gmail
      ↓
Prospect Replies
      ↓
Inbox
      ↓
AI Analysis
      ↓
AI Reply Suggestion
      ↓
User Reviews
      ↓
Create Draft
      ↓
User Sends
      ↓
Reply Detected
      ↓
Future Follow-Ups Automatically Cancelled
      ↓
Analytics Updated
```

This workflow should be treated as the core product experience.