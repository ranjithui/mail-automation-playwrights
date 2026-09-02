# Deployment

## Topology

Three deployable units plus two stores:

```
        ┌──────────┐        ┌──────────┐
        │   web    │        │  worker  │  (1..n, scale by mailbox count)
        │  static  │        │  Node    │
        └────┬─────┘        └────┬─────┘
             │ HTTPS             │
             ▼                   ▼
        ┌─────────────────────────────┐
        │            api              │  (1..n, stateless behind a LB)
        └──────┬───────────────┬──────┘
               ▼               ▼
        ┌────────────┐  ┌────────────┐
        │ PostgreSQL │  │   Redis    │
        └────────────┘  └────────────┘
```

`web` builds to static files. `api` is stateless and scales horizontally.
`worker` holds browser sessions, so scale it by mailbox count rather than
request volume — one worker can serve several mailboxes, but a mailbox should
be served by one worker at a time.

## Docker

```bash
docker compose up
```

Starts postgres, redis, api, worker and web. The compose file reads
`JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `AI_PROVIDER`, `AI_API_KEY`
and `GMAIL_DRIVER` from your environment, with development defaults.

The worker image is `mcr.microsoft.com/playwright` so Chromium and its system
dependencies are already present.

## Manual deployment

```bash
npm ci
npm run prisma:generate
npm run prisma:push        # or: npx prisma migrate deploy
npm run db:seed            # first install only
npm run build              # builds the web app to apps/web/dist

npm run start:api
npm run start:worker
```

Serve `apps/web/dist` from any static host or CDN, with a rewrite so all paths
fall through to `index.html` (it is a single-page app). Point it at the API
with `VITE_API_URL` at build time, or proxy `/api` and `/ws` to the API from
the same origin — the latter is simpler and avoids CORS entirely.

Run both Node processes under a supervisor (systemd, PM2, Kubernetes) so they
restart on failure. Restarts are safe: the job ledger means a worker resumes
exactly where it stopped, and completed steps are never repeated.

## Production environment

```env
NODE_ENV=production
LOG_LEVEL=info

DATABASE_PROVIDER=postgresql
DATABASE_URL="postgresql://user:pass@host:5432/mailflow?schema=public&connection_limit=10"
REDIS_URL=redis://host:6379

JWT_SECRET=<64 random hex>
SESSION_SECRET=<64 random hex>
ENCRYPTION_KEY=<64 hex = 32 bytes>

APP_URL=https://app.example.com
API_URL=https://api.example.com
CORS_ORIGINS=https://app.example.com

GMAIL_DRIVER=playwright
PLAYWRIGHT_HEADLESS=true

AI_PROVIDER=anthropic
AI_API_KEY=<key>
```

Generate secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Migrations

Development uses `prisma db push`. For production, generate real migrations:

```bash
npm run prisma:prepare
npx prisma migrate dev --name <change>    # authoring
npx prisma migrate deploy                 # applying
```

Remember that `prisma/schema.prisma` is generated — edit
`prisma/schema.template.prisma` and run `npm run prisma:prepare` first.

## Health and monitoring

`GET /api/health` reports database latency, queue driver, mailbox driver and AI
provider. Use it as the load-balancer probe.

Watch:

| Signal | Where | Why |
|---|---|---|
| Failed jobs | `/api/jobs/stats` → `totals.FAILED` | send or sync failures |
| Bounce rate | Bounces screen | list quality and deliverability |
| Mailbox connection | Email accounts screen | expired sessions stop automation |
| Queue depth | `totals.PENDING` + `DELAYED` | worker capacity |
| Notifications | in-app | campaign failures, auth expiry, worker errors |

The worker logs one line per job with duration; the API logs unhandled errors
with a stack.

## Backup

- **PostgreSQL** — `pg_dump` on a schedule; it holds everything transactional.
- **`storage/attachments`** — uploaded files, not reproducible from the
  database.
- **`storage/sessions`** — browser sessions. Losing these only means
  reconnecting each mailbox interactively.
- **`.env`** — keep `ENCRYPTION_KEY` safe: without it, stored AI keys and
  mailbox secrets are unrecoverable.

## Scaling notes

- Move to `REDIS_URL` before running more than one worker: the database driver
  works with several workers thanks to atomic claim + stale-lock recovery, but
  BullMQ dispatches with less polling overhead.
- Raise `QUEUE_CONCURRENCY` carefully. Each concurrent send drives a browser;
  provider limits, not CPU, are usually the binding constraint.
- Add a mailbox before raising a mailbox's daily limit. Spreading volume across
  several senders is safer than pushing one harder.
- The API is stateless apart from WebSocket connections; with more than one
  API instance behind a load balancer, enable sticky sessions or move realtime
  fan-out onto Redis pub/sub.
