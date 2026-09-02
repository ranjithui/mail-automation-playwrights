import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CampaignProgress, RealtimeEvent } from '@mail/shared';
import { useSession } from './use-session';

type Listener = (event: RealtimeEvent) => void;

interface RealtimeContextValue {
  connected: boolean;
  subscribe: (listener: Listener) => () => void;
  campaignProgress: Record<string, CampaignProgress>;
  workerActivity: { accountId: string; action?: string; detail?: string } | null;
}

const RealtimeContext = React.createContext<RealtimeContextValue | null>(null);

/**
 * Live updates for campaign progress, inbox arrivals, worker status and
 * notifications. Reconnects with backoff and, on every relevant event,
 * invalidates the matching TanStack Query cache so screens stay accurate
 * without polling.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const { user, workspaceId } = useSession();
  const queryClient = useQueryClient();
  const [connected, setConnected] = React.useState(false);
  const [campaignProgress, setCampaignProgress] = React.useState<Record<string, CampaignProgress>>({});
  const [workerActivity, setWorkerActivity] = React.useState<RealtimeContextValue['workerActivity']>(null);

  const listeners = React.useRef(new Set<Listener>());
  const socketRef = React.useRef<WebSocket | null>(null);
  const attemptRef = React.useRef(0);

  const subscribe = React.useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }, []);

  React.useEffect(() => {
    if (!user || !workspaceId) return;

    let closed = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws?workspaceId=${workspaceId}`);
      socketRef.current = socket;

      socket.onopen = () => {
        attemptRef.current = 0;
        setConnected(true);
      };

      socket.onmessage = (raw) => {
        let event: RealtimeEvent;
        try {
          event = JSON.parse(raw.data as string) as RealtimeEvent;
        } catch {
          return;
        }
        if (!event?.type) return;

        for (const listener of listeners.current) listener(event);

        switch (event.type) {
          case 'campaign.progress': {
            const progress = event.payload as CampaignProgress;
            setCampaignProgress((prev) => ({ ...prev, [progress.campaignId]: progress }));
            queryClient.invalidateQueries({ queryKey: ['campaign', progress.campaignId], exact: false });
            break;
          }
          case 'campaign.status':
            queryClient.invalidateQueries({ queryKey: ['campaigns'] });
            break;
          case 'inbox.message': {
            const payload = event.payload as { sender: string; subject: string };
            queryClient.invalidateQueries({ queryKey: ['inbox'] });
            queryClient.invalidateQueries({ queryKey: ['inbox-counts'] });
            toast.info('New reply received', { description: `${payload.sender} — ${payload.subject}` });
            break;
          }
          case 'inbox.updated':
            queryClient.invalidateQueries({ queryKey: ['inbox'] });
            queryClient.invalidateQueries({ queryKey: ['inbox-counts'] });
            queryClient.invalidateQueries({ queryKey: ['thread'] });
            break;
          case 'worker.status':
            setWorkerActivity(event.payload as RealtimeContextValue['workerActivity']);
            queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
            break;
          case 'ai.status':
            queryClient.invalidateQueries({ queryKey: ['thread'] });
            break;
          case 'notification': {
            const payload = event.payload as { title: string; body?: string; severity: string };
            queryClient.invalidateQueries({ queryKey: ['notifications'] });
            if (payload.severity === 'ERROR') toast.error(payload.title, { description: payload.body });
            else if (payload.severity === 'WARNING') toast.warning(payload.title, { description: payload.body });
            else if (payload.severity === 'SUCCESS') toast.success(payload.title, { description: payload.body });
            break;
          }
          case 'activity':
            queryClient.invalidateQueries({ queryKey: ['logs'] });
            break;
          default:
            break;
        }
      };

      const scheduleReconnect = () => {
        setConnected(false);
        if (closed) return;
        attemptRef.current += 1;
        const delay = Math.min(15_000, 1000 * 2 ** Math.min(attemptRef.current, 4));
        reconnectTimer = window.setTimeout(connect, delay);
      };

      socket.onclose = scheduleReconnect;
      socket.onerror = () => socket.close();
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
      socketRef.current = null;
      setConnected(false);
    };
  }, [user, workspaceId, queryClient]);

  const value: RealtimeContextValue = { connected, subscribe, campaignProgress, workerActivity };
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const context = React.useContext(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside RealtimeProvider');
  return context;
}

/** Live progress for one campaign, falling back to the server-rendered value. */
export function useCampaignProgress(campaignId: string | undefined, fallback?: CampaignProgress) {
  const { campaignProgress } = useRealtime();
  if (!campaignId) return fallback;
  return campaignProgress[campaignId] ?? fallback;
}
