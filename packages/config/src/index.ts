/**
 * Typed, validated environment. Import `env` anywhere on the server; it is
 * parsed once at module load so a misconfigured deployment fails fast at boot
 * instead of halfway through a campaign.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '../../..');

dotenv.config({ path: path.join(ROOT_DIR, '.env') });

const bool = (fallback: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return fallback;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_PROVIDER: z.enum(['sqlite', 'postgresql']).default('sqlite'),
  DATABASE_URL: z.string().min(1).default('file:./data/mailflow.db'),

  REDIS_URL: z.string().optional().default(''),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().min(250).default(2000),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  /**
   * Watchdog for a single job. A handler that never returns used to hold its
   * concurrency slot forever; with every slot held the worker stopped picking
   * up anything at all, campaigns included. Kept below the stale-lock window
   * so a job is always failed before it looks abandoned.
   */
  JOB_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(8 * 60_000),
  /**
   * Workspaces this worker may run jobs for, comma separated.
   *
   * Empty - the default - means all of them, which is what a single all-in-one
   * install wants. It starts to matter once the browsers live on the operators'
   * own machines: a mailbox's Chromium profile exists on exactly one of them,
   * so a worker that claimed a send for someone else's workspace would reach
   * for a profile it does not have and fail that job on their behalf.
   */
  WORKER_WORKSPACES: z.string().default(''),

  JWT_SECRET: z.string().min(8).default('dev-only-jwt-secret-change-me'),
  SESSION_SECRET: z.string().min(8).default('dev-only-session-secret-change-me'),
  ENCRYPTION_KEY: z.string().min(16).default('0'.repeat(64)),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),

  APP_URL: z.string().default('http://localhost:5173'),
  API_URL: z.string().default('http://localhost:4000'),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_PORT: z.coerce.number().int().default(5173),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /**
   * Directory holding the built dashboard, served by the API process itself.
   *
   * Empty in development, where Vite serves the SPA on its own port and proxies
   * /api to this one. Set it in production so a single origin answers both: the
   * auth cookies are SameSite=Lax, so a dashboard on another host never sends
   * them and every call after an apparently successful sign-in returns 401.
   */
  WEB_DIST_DIR: z.string().default(''),

  GMAIL_DRIVER: z.enum(['simulation', 'playwright']).default('simulation'),
  /**
   * Automatic mailbox polling interval. 0 disables it entirely, which is the
   * default for the browser driver: a headless Chromium waking up on a timer
   * is the single biggest source of surprise for an operator. The manual
   * "Sync mailboxes" button and campaign sends are unaffected.
   */
  INBOX_SYNC_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  /** Consecutive sync failures before a mailbox stops being polled. */
  INBOX_SYNC_FAILURE_LIMIT: z.coerce.number().int().min(1).default(3),
  PLAYWRIGHT_HEADLESS: bool(true),
  /**
   * Which browser build to drive. Empty means Playwright's own Chromium, which
   * is what a checkout gets from `playwright install`.
   *
   * "chrome" drives the Google Chrome already on the machine instead. That is
   * how the packaged agent ships: it saves a 150MB download on every operator's
   * machine, and Google treats a real Chrome install more kindly than a fresh
   * automation build it has never seen sign in before.
   */
  PLAYWRIGHT_BROWSER_CHANNEL: z.string().trim().default(''),
  PLAYWRIGHT_SLOWMO_MS: z.coerce.number().int().min(0).default(0),
  PLAYWRIGHT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  /**
   * Check the sent folder before composing, and skip the send when the same
   * subject already went to the same address today. Kept configurable, but
   * turning it off means a retried job re-delivers the message.
   */
  SEND_DUPLICATE_GUARD: bool(true),
  PLAYWRIGHT_STORAGE_DIR: z.string().default('./storage/sessions'),
  SCREENSHOT_DIR: z.string().default('./storage/screenshots'),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_DIR: z.string().default('./storage/attachments'),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(200).default(25),

  AI_PROVIDER: z.enum(['local', 'openai', 'anthropic', 'gemini', 'groq']).default('local'),
  AI_MODEL: z.string().optional().default(''),
  AI_API_KEY: z.string().optional().default(''),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
  AI_MAX_TOKENS: z.coerce.number().int().min(64).max(8000).default(800),

  SEED_OWNER_EMAIL: z.string().default('admin@mailflow.local'),
  SEED_OWNER_PASSWORD: z.string().default('Admin@12345'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] invalid environment:\n', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

const raw = parsed.data;

const absolute = (p: string) => (path.isAbsolute(p) ? p : path.resolve(ROOT_DIR, p));

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  workerWorkspaces: raw.WORKER_WORKSPACES.split(',').map((s) => s.trim()).filter(Boolean),
  webDistDir: raw.WEB_DIST_DIR ? absolute(raw.WEB_DIST_DIR) : '',
  storageDir: absolute(raw.STORAGE_DIR),
  screenshotDir: absolute(raw.SCREENSHOT_DIR),
  sessionDir: absolute(raw.PLAYWRIGHT_STORAGE_DIR),
  useRedis: Boolean(raw.REDIS_URL && raw.REDIS_URL.trim()),
  maxUploadBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,
};

export type Env = typeof env;

for (const dir of [env.storageDir, env.screenshotDir, env.sessionDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

/** Tiny leveled logger. Structured enough to grep, small enough to have no deps. */
export function createLogger(scope: string) {
  const threshold = LEVELS[env.LOG_LEVEL];
  const emit = (level: keyof typeof LEVELS, message: string, meta?: unknown) => {
    if (LEVELS[level] < threshold) return;
    const stamp = new Date().toISOString();
    const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (meta !== undefined) console[level === 'debug' ? 'log' : level](line, meta);
    else console[level === 'debug' ? 'log' : level](line);
  };
  return {
    debug: (m: string, meta?: unknown) => emit('debug', m, meta),
    info: (m: string, meta?: unknown) => emit('info', m, meta),
    warn: (m: string, meta?: unknown) => emit('warn', m, meta),
    error: (m: string, meta?: unknown) => emit('error', m, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
