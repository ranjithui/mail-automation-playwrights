# Security

## Authentication

- **Passwords** — bcrypt, configurable rounds. Never logged, never returned.
  Minimum ten characters with upper case, lower case and a digit, enforced by
  the same Zod schema on the client and the server.
- **Access tokens** — short-lived JWTs (15 minutes) in `httpOnly`, `sameSite=lax`
  cookies, `secure` in production. Not readable by page scripts.
- **Refresh tokens** — opaque 48-byte random strings, stored only as SHA-256
  hashes, and **rotated on every use**: presenting one immediately revokes it.
- **Password reset** — single-use, one-hour tokens stored as hashes.
  `/auth/forgot-password` always reports success so it cannot be used to
  enumerate accounts.
- **Changing a password** revokes every refresh token for that user.
- Login and password endpoints are rate limited to 20 attempts per 15 minutes
  in production, and both failure modes return the same message.

## Authorisation

Two layers, both server-side.

**Workspace isolation** — `withWorkspace` resolves the active workspace from a
header, cookie or first membership, verifies membership, and puts it on
`req.ctx`. Every workspace-scoped query filters on `req.ctx.workspaceId`. A
handler never receives an unvalidated workspace id, so cross-tenant access is
not something an individual route can get wrong.

**RBAC** — a rank comparison applied by `requireRole()`:

```
OWNER 50 › ADMIN 40 › MANAGER 30 › USER 20 › VIEWER 10
```

| Role | Can |
|---|---|
| OWNER | everything, including ownership transfer |
| ADMIN | members, workspace settings, AI configuration |
| MANAGER | start / pause / stop and delete campaigns and mailboxes |
| USER | create and edit campaigns, contacts, templates; send replies |
| VIEWER | read only |

The UI mirrors this with `<RoleGate>` — it hides what the API would reject, but
the API is the enforcement point.

A workspace can never lose its last owner: demoting or removing the final
`OWNER` is rejected.

## Encryption at rest

AES-256-GCM (`v1.<iv>.<tag>.<ciphertext>`, base64url) protects AI API keys and
mailbox secrets. The key comes from `ENCRYPTION_KEY`; a 64-character hex value
is used directly, anything else is stretched with SHA-256.

Decrypted secrets are never returned to the frontend. The AI settings screen
receives a masked hint (`sk-…9fA2`) and a boolean, never the value.

## What never reaches the browser

Passwords · password hashes · session cookies · refresh tokens · AI API keys ·
encryption keys · browser profiles and storage state · Gmail cookies ·
`secretsJson` on `EmailAccount`.

Browser sessions live entirely inside the worker process. No endpoint exists
that could return them.

## Input handling

- Every request body is validated with Zod before reaching a handler; unknown
  fields are stripped and types coerced.
- Prisma parameterises all queries — no string-concatenated SQL anywhere.
- Uploads are restricted by MIME allow-list and size cap (`MAX_UPLOAD_MB`),
  stored under opaque random filenames, and served only through an authorised
  route. `storage/` is never a static mount, and path traversal is blocked by
  `basename()` on every resolve.
- Email HTML from mailboxes and templates is sanitised before rendering:
  `<script>`, `<iframe>`, `<object>`, `<embed>`, inline `on*` handlers and
  `javascript:` URLs are stripped.
- Helmet sets security headers; CORS is an explicit allow-list from
  `CORS_ORIGINS` with credentials enabled.

## Audit

Every automation action writes an `ActivityLog` row: timestamp, workspace,
campaign, contact, mailbox, job, action, status, duration, error code, retry
count and worker id. Domain events are recorded separately in `EmailEvent`.
Logs are pruned after 90 days by the housekeeping job.

## Responsible automation

This platform automates a mailbox you control. It contains **no** CAPTCHA
solving, **no** bot-detection or anti-abuse evasion, **no** credential entry,
and **no** mechanism for exceeding provider limits.

- The platform never types a password. A human signs in once in a visible
  browser window; the saved session is reused, and when it expires automation
  stops and a person is asked to reconnect.
- Rate limits, sending windows, per-mailbox daily and hourly quotas and
  randomised inter-send delays exist to stay inside provider policy.
- Opt-out requests are honoured automatically — by keyword match during sync
  and again by AI classification — and the address is suppressed permanently.
- Hard bounces are suppressed; soft bounces stop the current sequence.
- AI never sends on its own. Consequential actions require confirmation.

Only connect mailboxes you are authorised to use, and make sure your outbound
sending complies with the law that applies to your recipients (GDPR, CAN-SPAM,
PECR and equivalents).

## Production checklist

- [ ] Generate fresh `JWT_SECRET`, `SESSION_SECRET` and a 64-hex
      `ENCRYPTION_KEY`. Never reuse the development values.
- [ ] `NODE_ENV=production` so cookies are `secure`.
- [ ] Terminate TLS in front of the API and the web app.
- [ ] Set `CORS_ORIGINS` to your real origin only.
- [ ] Use PostgreSQL with automated backups; back up `storage/` too.
- [ ] Restrict database and Redis network access to the app tier.
- [ ] Keep `.env` out of version control (it already is) and store secrets in
      your platform's secret manager.
- [ ] Review the activity log and bounce rate regularly.
- [ ] Rotate AI API keys periodically — re-saving in Settings re-encrypts.
