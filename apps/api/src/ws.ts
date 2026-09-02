/**
 * WebSocket fan-out.
 *
 * Clients connect to /ws with their access token and active workspace, and the
 * server pushes campaign progress, inbox arrivals, worker status, AI progress
 * and notifications. Subscriptions are workspace-scoped and membership is
 * verified at connection time, so one tenant can never observe another.
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { createLogger } from '@mail/config';
import { prisma } from '@mail/database';
import { registerBroadcaster } from '@mail/core';
import type { RealtimeEvent } from '@mail/shared';
import { verifyAccessToken } from './lib/auth.js';
import { ACCESS_COOKIE } from './lib/auth.js';

const log = createLogger('ws');

interface Client {
  socket: WebSocket;
  userId: string;
  workspaceId: string;
}

const clients = new Set<Client>();

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function attachWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (socket, request) => {
    try {
      const url = new URL(request.url ?? '/ws', 'http://localhost');
      const token = url.searchParams.get('token') ?? cookieValue(request.headers.cookie, ACCESS_COOKIE);
      const workspaceId = url.searchParams.get('workspaceId');

      const payload = token ? verifyAccessToken(token) : null;
      if (!payload || !workspaceId) {
        socket.close(4401, 'unauthorized');
        return;
      }

      const membership = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: payload.sub } },
      });
      if (!membership) {
        socket.close(4403, 'forbidden');
        return;
      }

      const client: Client = { socket, userId: payload.sub, workspaceId };
      clients.add(client);
      log.debug(`client connected (${clients.size} total)`);

      socket.send(JSON.stringify({ type: 'connected', workspaceId, at: new Date().toISOString() }));

      // Heartbeat so dead connections are reaped rather than leaking.
      const ping = setInterval(() => {
        if (socket.readyState === socket.OPEN) socket.ping();
      }, 30_000);

      socket.on('close', () => {
        clearInterval(ping);
        clients.delete(client);
      });
      socket.on('error', () => {
        clearInterval(ping);
        clients.delete(client);
      });
    } catch (error) {
      log.error('connection setup failed', error);
      socket.close(1011, 'server error');
    }
  });

  registerBroadcaster(broadcast);
  log.info('websocket server attached at /ws');
  return wss;
}

export function broadcast(event: RealtimeEvent) {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.workspaceId !== event.workspaceId) continue;
    if (client.socket.readyState !== client.socket.OPEN) continue;
    try {
      client.socket.send(message);
    } catch {
      clients.delete(client);
    }
  }
}

export const connectedClients = () => clients.size;
