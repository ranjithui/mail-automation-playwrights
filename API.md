# API

Base URL `/api`. Cookie authentication (httpOnly); a `Bearer` header is also
accepted. Workspace context comes from the `x-workspace-id` header, falling
back to the `mf_workspace` cookie and then the first membership.

## Envelope

```json
{ "success": true, "data": {} }
```

```json
{ "success": false, "error": { "code": "CAMPAIGN_NOT_FOUND", "message": "Campaign not found" } }
```

Validation failures return `422` with `details` listing `{ path, message }`.
Paginated responses carry `{ items, page, pageSize, total, totalPages }`.

| Status | Meaning |
|---|---|
| 400 / 422 | bad request / validation failure |
| 401 | not authenticated, or the access token expired (the client retries once via `/auth/refresh`) |
| 403 | authenticated, but the role or workspace forbids it |
| 404 | not found, or not in your workspace |
| 409 | conflict (duplicate) |
| 429 | rate limited |

## Endpoints

### Auth — `/api/auth`
`POST /register` · `POST /login` · `POST /refresh` · `POST /logout` ·
`GET /me` · `PATCH /me` · `POST /change-password` ·
`POST /forgot-password` · `POST /reset-password`

### Workspaces — `/api/workspaces`
`GET /` · `POST /` · `POST /:id/activate` ·
`GET|PATCH /current/settings` · `GET|POST /current/members` ·
`PATCH|DELETE /current/members/:memberId`

### Email accounts — `/api/email-accounts`
`GET /` · `GET /driver` · `GET /:id` · `POST /` · `PATCH /:id` · `DELETE /:id` ·
`POST /:id/{connect|reconnect|test|disconnect|restart}` · `POST /:id/sync`

### Contacts — `/api/contacts`
`GET /` (search, status, list, tag, sort, pagination) · `POST /` ·
`GET|PATCH|DELETE /:id` · `POST /bulk` ·
`GET|POST /lists` · `PATCH|DELETE /lists/:id` ·
`POST /import/parse` (multipart) · `POST /import/commit` · `GET /export`

### Templates — `/api/templates`
`GET /` · `GET /variables` · `POST /preview` · `GET /:id` · `POST /` ·
`PATCH /:id` · `POST /:id/duplicate` · `DELETE /:id`

### Attachments — `/api/attachments`
`GET /` · `POST /` (multipart) · `GET /:id/download` · `PATCH /:id` · `DELETE /:id`

### Campaigns — `/api/campaigns`
`GET /` · `POST /` · `GET|PATCH|DELETE /:id` ·
`PUT /:id/steps` · `GET|POST /:id/contacts` ·
`DELETE /:id/contacts/:campaignContactId` ·
`POST /:id/start` · `POST /:id/pause` · `POST /:id/resume` · `POST /:id/stop` ·
`POST /:id/test` · `GET /:id/analytics` · `GET /:id/activity`

### Inbox — `/api/inbox`
`GET /` (folder, operators, filters) · `GET /counts` · `GET /threads/:id` ·
`POST /threads/:id/action` · `POST /threads/:id/reply` ·
`POST /threads/:id/create-contact` · `POST /sync`

### AI — `/api/ai`
`POST /generate-reply` · `POST /edit` · `GET /threads/:threadId/summary` ·
`GET /threads/:threadId/history` · `POST /suggestions/:id/save-as-template` ·
`GET|PUT /settings` · `POST /settings/test` · `GET /analytics`

### Operations
`GET /api/jobs` · `GET /api/jobs/stats` · `GET /api/jobs/runs` ·
`POST /api/jobs/:id/retry` · `POST /api/jobs/:id/cancel` ·
`GET /api/logs` ·
`GET /api/safety/bounces` · `GET|POST /api/safety/suppression` ·
`DELETE /api/safety/suppression/:id` · `GET /api/safety/unsubscribes` ·
`GET /api/notifications` · `POST /api/notifications/:id/read` ·
`POST /api/notifications/read-all` · `POST /api/notifications/digest`

### Dashboard and migration
`GET /api/dashboard` · `GET /api/dashboard/analytics` ·
`POST /api/migration/analyze` · `POST /api/migration/import` ·
`GET /api/migration/mapping`

### Infrastructure
`GET /api/health` — database, queue driver, mailbox driver, AI provider.
`POST /api/internal/events` — worker to API realtime bridge, guarded by a
shared secret and never exposed to the browser.

## Worked examples

Log in and read the dashboard:

```bash
curl -c jar.txt -X POST http://localhost:4000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@mailflow.local","password":"Admin@12345"}'

curl -b jar.txt http://localhost:4000/api/dashboard
```

Start a campaign:

```bash
curl -b jar.txt -X POST http://localhost:4000/api/campaigns/<id>/start \
  -H 'content-type: application/json' -d '{}'
```

Generate three AI reply options for a thread:

```bash
curl -b jar.txt -X POST http://localhost:4000/api/ai/generate-reply \
  -H 'content-type: application/json' \
  -d '{"threadId":"<id>","style":"PROFESSIONAL","length":"MEDIUM","variants":3}'
```

## WebSocket

`ws://host/ws?workspaceId=<id>` — the token comes from the access cookie, or
`?token=` for non-browser clients. Membership is verified on connect.

```json
{ "type": "campaign.progress", "workspaceId": "...", "payload": {}, "at": "ISO-8601" }
```

Types: `campaign.progress`, `campaign.status`, `inbox.message`,
`inbox.updated`, `worker.status`, `ai.status`, `notification`, `job.updated`,
`activity`.

## Rate limits

60-second window: 600 requests in production, 5000 in development.
Credential endpoints are limited to 20 attempts per 15 minutes in production.

## Inbox search operators

`from:` `to:` `subject:` `campaign:` `company:` `status:` `date:` plus free-text
keywords. Quoted values work: `subject:"Q3 proposal" from:john`.
