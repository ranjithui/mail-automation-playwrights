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

## Hosted: Render + Supabase

```
        Render                                   Supabase
┌──────────────────────────┐                  ┌────────────┐
│  dashboard + API         │ ───────────────► │ PostgreSQL │
│  one service, one origin │                  └─────▲──────┘
└──────────────────────────┘                        │
                                                    │ same database
        operator machines (Windows)                 │
┌──────────────────────────┐                        │
│  worker + Chromium       │ ───────────────────────┘
│  one per operator        │
└──────────────────────────┘
```

The split is not arbitrary. Everything except the browser runs in the cloud;
the browser runs where a person is sitting.

**Why the worker is not on Render.** Connecting a mailbox means completing
Google's sign-in — password, 2FA, sometimes a device prompt — in a real browser
window. `connect()` in `packages/playwright/src/gmail-automation.service.ts`
refuses to try when headless, and says so, because there is nobody in a
datacentre to type into it. Google also challenges sign-ins from datacentre
addresses far more aggressively than from a home connection.

**Why one service, not two.** The auth cookies are `SameSite=Lax`. A dashboard
served from a different host never sends them, so sign-in appears to succeed and
every call after it returns 401. `WEB_DIST_DIR` makes the API serve the built
dashboard, which also removes the CORS list and the baked-in `VITE_API_URL`.

**Why a shared database works.** With `REDIS_URL` empty the queue is a table.
Jobs are claimed with an atomic conditional update (`packages/queue`), so two
machines can never take the same job. `WORKER_WORKSPACES` then keeps each
operator to their own work.

### 1. Supabase

Create a project, then *Connect → ORMs → Prisma* and copy the **session pooler**
URI — the pooler host on port 5432. Not the direct connection: it is IPv6-only
on new projects and Render dials IPv4. The transaction pooler on 6543 works too
but then needs `?pgbouncer=true`, and buys nothing for a long-running process.

### 2. Render

Push the repo, then *New → Blueprint* and pick `render.yaml`. It asks for:

| | |
|---|---|
| `DATABASE_URL` | the Supabase string from step 1 |
| `ENCRYPTION_KEY` | 64 hex characters — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `APP_URL`, `API_URL`, `CORS_ORIGINS` | all three the service's own URL, no trailing slash |

The last three are chicken-and-egg: Render only names the service once it
exists. Deploy, copy the URL it gives you (`https://mailflow-xxxx.onrender.com`),
paste it into all three, and redeploy. Anything else and the API refuses its own
dashboard.

The build runs `prisma db push`, so the schema is created on first deploy. There
is no seeded account: the first person to open the URL registers at `/register`
and gets their own workspace.

### 3. One worker per operator

Each person who connects their own Gmail runs the worker on their own machine.
They need the repo, `npm install`, and a `.env`:

```env
DATABASE_PROVIDER=postgresql
DATABASE_URL="<the same Supabase session-pooler string>"
REDIS_URL=

# Only this operator's workspace. Without it this worker would claim other
# people's sends and fail them: the Gmail profile for their mailbox exists on
# their machine, not this one.
WORKER_WORKSPACES=<workspace id>

GMAIL_DRIVER=playwright
# false for the first connect of each mailbox - a window has to open for the
# sign-in. It can go back to true afterwards; the profile is saved.
PLAYWRIGHT_HEADLESS=false

# Only needed if you set an AI provider key in the hosted app: that is the one
# thing this key protects, and only the API ever reads it back. It is listed
# here so the two installs agree, not because the worker decrypts anything.
ENCRYPTION_KEY=<the same 64 hex characters as Render>

# Where to post realtime events, so the hosted dashboard shows what this
# worker is doing while it does it. Left unset it posts to localhost:4000 and
# nothing reaches the browser.
API_URL=https://<your-service>.onrender.com

# Must match the value Render generated (Environment tab). The worker signs its
# events with it and the API rejects any it cannot verify. Sends work either
# way - only the live progress in the dashboard depends on it.
SESSION_SECRET=<copy from Render>

# Unused here: this process issues no tokens.
JWT_SECRET=anything
```

Nothing about a mailbox is encrypted - a Gmail session is a browser profile on
disk, not a stored credential - so a mismatched `ENCRYPTION_KEY` costs you
nothing here. `WORKER_WORKSPACES` can also stay empty until a second workspace
exists; with one workspace there is nothing to scope away from.

Find the workspace id in the browser on the hosted dashboard — it is the
`mf_workspace` cookie, or the `id` in the response to `GET /api/workspaces`.

Then:

```bash
npm run prisma:generate   # once, to build the client for postgres
npm run start:worker
```

It logs `scoped to 1 workspace(s): <id>` at startup. If it says *serving every
workspace in the database* instead, `WORKER_WORKSPACES` did not reach it and it
will take other people's jobs.

Campaigns are launched from the hosted dashboard; the operator's worker picks
them up within a poll interval and drives their own Gmail. Nothing is sent while
their machine is off — the jobs simply wait in the table.

## Agents

An agent is the same idea as the worker above, with the database connection
taken away. It holds Gmail browser profiles and nothing else: it asks the
server for work over HTTPS, does it, and reports back. No database credential
reaches the machine, no port is opened on it, and access is revoked with one
button rather than by rotating a password everywhere.

Use this rather than a worker per operator whenever the machines are not all
yours.

### How it hangs together

The server's processors are unchanged. They still call `MailboxDriver`
methods; for a mailbox bound to a device, `acquireMailbox` hands them a
`RemoteMailboxDriver` instead of a Chromium one, and each call becomes an
`AgentTask` row that the agent leases, runs and answers. The operation name
and its arguments are the payload, so adding a driver method needs no protocol
change.

Four endpoints carry all of it:

| | |
|---|---|
| `POST /api/agent/enrol` | pairing code in, device token out. The only unauthenticated one |
| `GET /api/agent/work` | long-poll, held 25s, leases one operation |
| `POST /api/agent/work/:id` | report it done or failed |
| `POST /api/agent/heartbeat` | liveness and mailbox status |

Plus `GET /api/agent/files/:name`, which is how an agent reads an attachment
it is about to send - and which also closes the gap where a remote machine
could not see files the API had stored.

### Building the executable

```bash
npm run build:agent
```

Produces `dist/agent/` - about 107MB, holding `mailflow-agent.exe`, the
Playwright packages beside it, and a readme. Zip that folder and it runs on a
machine with no Node, no repository and no npm.

The executable *is* node: esbuild flattens the agent into one CommonJS file and
Node's single-executable support injects it into a copy of the node binary.
Playwright is copied alongside rather than bundled, because it finds its driver
and browser registry from paths relative to its own package directory.

It drives the **Chrome already installed** on the machine rather than
Playwright's own Chromium, which saves every operator a 150MB download and
gives Google a browser it recognises. `PLAYWRIGHT_BROWSER_CHANNEL` controls
this; empty falls back to a downloaded Chromium.

To check a machine before trusting it with a mailbox:

```
mailflow-agent.exe --check
```

which reports whether Playwright loads, whether Chrome launches (with its
version), and whether this machine is enrolled.

### Enrolling a machine

1. Dashboard → **Devices** → **Add device**. A pairing code appears, good for
   ten minutes and one use.
2. On the machine that will run the browsers, either double-click
   `mailflow-agent.exe` or, from a checkout:

   ```bash
   npm run start:agent
   ```

   A small panel opens in the browser asking for the server address and the
   code. The device token is then saved to the user profile directory -
   `%APPDATA%/MailFlow Agent/agent.json` on Windows,
   `~/.config/mailflow-agent/agent.json` elsewhere. Not to `.env`: that file
   belongs to the server and carries database credentials.

   The same panel stays up afterwards as a status window: which mailboxes are
   open, and the last dozen operations with how long each took. It lives on
   127.0.0.1 only.
3. Back in **Devices**, bind a mailbox to the machine.
4. **Email accounts → Connect.** A Chromium window opens *on that machine* for
   the sign-in. Set `PLAYWRIGHT_HEADLESS=false` there or the sign-in cannot be
   completed.

### Rules worth knowing

- **One mailbox, one device.** Its browser profile exists on exactly one
  machine, so only that machine is offered work for it.
- **Leases expire** - five minutes for ordinary operations, fifteen for
  `connect`, which waits on a person. This is deliberately shorter than
  `JOB_TIMEOUT_MS`, so a laptop that goes to sleep fails its operation before
  the queue's own watchdog fires.
- **Revoking is immediate**: the device gets 401 on its next poll, at most one
  hold away. Its mailboxes return to the in-process worker and anything queued
  for it fails at once rather than one timeout at a time.
- **Nothing changes for mailboxes without a device.** They are driven by the
  worker exactly as before, which is what makes moving one mailbox at a time
  possible.

### Moving the worker to the server

While you still run a worker locally, that worker creates the agent tasks and
everything works. The end state is different: once every mailbox belongs to a
device, the worker belongs on Render, and `render.yaml` should start both
processes:

```yaml
startCommand: npm start   # API and worker together
```

Do that only after the last mailbox is bound to a device, and stop the local
worker at the same time. Two workers against one database is safe - claiming is
atomic - but a server-side worker will try to launch Chromium for any mailbox
that has no device, and there is no browser there to launch.

### Known limits of this split

- **Attachments do not reach a remote worker.** The API stores an upload on the
  Render disk and the worker resolves it against its own `STORAGE_DIR`, so a
  step with a file attached sends without it. Campaigns without attachments are
  unaffected. Closing this needs an authenticated fetch from the worker back to
  the API.
- **The free instance type sleeps** after ~15 minutes idle and cannot mount a
  disk, which is what `render.yaml` currently selects. Sends are unaffected -
  the worker reaches Supabase directly, and `publish()` treats an unreachable
  API as advisory - but the dashboard takes ~30s to open after a quiet spell,
  and uploaded files do not survive a deploy or a wake. Switch to `starter`
  and restore the disk block when it stops being a test.
- **`prisma db push`, not migrations.** Fine for a fresh database, but move to
  `prisma migrate` before there is data anyone would miss.

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
