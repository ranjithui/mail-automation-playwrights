import http from 'node:http';
import { createLogger, env } from '@mail/config';
import { prisma } from '@mail/database';
import { driverName } from '@mail/queue';
import { createApp } from './app.js';
import { attachWebSocket } from './ws.js';

const log = createLogger('api');

async function main() {
  const app = createApp();
  const server = http.createServer(app);
  attachWebSocket(server);

  server.listen(env.API_PORT, () => {
    log.info(`API listening on http://localhost:${env.API_PORT}`);
    log.info(`database=${env.DATABASE_PROVIDER}  queue=${driverName()}  mailbox=${env.GMAIL_DRIVER}  ai=${env.AI_PROVIDER}`);
  });

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    server.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  log.error('failed to start API', error);
  process.exit(1);
});
