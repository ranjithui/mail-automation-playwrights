import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { createLogger, env } from '@mail/config';
import { prisma } from '@mail/database';
import { INTERNAL_EVENT_HEADER, internalToken } from '@mail/core';
import { driverName } from '@mail/queue';
import { AppError, errorMiddleware, handler, ok } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { workspaceRouter } from './routes/workspaces.js';
import { contactRouter } from './routes/contacts.js';
import { attachmentRouter, templateRouter } from './routes/templates.js';
import { campaignRouter } from './routes/campaigns.js';
import { emailAccountRouter } from './routes/email-accounts.js';
import { inboxRouter } from './routes/inbox.js';
import { aiRouter } from './routes/ai.js';
import { dashboardRouter } from './routes/dashboard.js';
import { jobRouter, logRouter, notificationRouter, safetyRouter } from './routes/operations.js';
import { migrationRouter } from './routes/migration.js';
import { broadcast } from './ws.js';

const log = createLogger('api');

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.use(
    helmet({
      // The API serves JSON and authorised file downloads only; the SPA is
      // served by Vite (dev) or a static host (prod), so CSP lives there.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
        // Vite hops to the next free port when 5173 is taken, so in development
        // any loopback origin is accepted rather than forcing a CORS_ORIGINS edit.
        if (!env.isProduction && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true, limit: '5mb' }));
  app.use(cookieParser());

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: env.isProduction ? 600 : 5000,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  );

  app.get(
    '/api/health',
    handler(async (_req, res) => {
      const started = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      return ok(res, {
        status: 'ok',
        database: { provider: env.DATABASE_PROVIDER, latencyMs: Date.now() - started },
        queue: driverName(),
        mailboxDriver: env.GMAIL_DRIVER,
        ai: env.AI_PROVIDER,
        version: '1.0.0',
        time: new Date().toISOString(),
      });
    }),
  );

  /**
   * Internal bridge: the worker runs in its own process and posts realtime
   * events here rather than requiring Redis pub/sub for local development.
   * Guarded by the shared session secret and never exposed to the browser.
   */
  app.post('/api/internal/events', (req, res) => {
    if (req.header(INTERNAL_EVENT_HEADER) !== internalToken()) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Invalid internal token' } });
    }
    broadcast(req.body);
    return res.json({ success: true, data: { delivered: true } });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/workspaces', workspaceRouter);
  app.use('/api/email-accounts', emailAccountRouter);
  app.use('/api/contacts', contactRouter);
  app.use('/api/templates', templateRouter);
  app.use('/api/attachments', attachmentRouter);
  app.use('/api/campaigns', campaignRouter);
  app.use('/api/inbox', inboxRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/jobs', jobRouter);
  app.use('/api/logs', logRouter);
  app.use('/api/safety', safetyRouter);
  app.use('/api/notifications', notificationRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/migration', migrationRouter);

  app.use('/api', (req, _res, next) => next(AppError.notFound(`Route ${req.method} ${req.path}`, 'ROUTE_NOT_FOUND')));
  app.use(errorMiddleware);

  log.debug('express application constructed');
  return app;
}
