import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role, SessionUser } from '@mail/shared';
import { ROLE_RANK } from '@mail/shared';
import { api, setActiveWorkspace, setUnauthorizedHandler } from '@/lib/api';

interface SessionContextValue {
  user: SessionUser | null;
  loading: boolean;
  role: Role | null;
  workspaceId: string | null;
  workspaceName: string | null;
  can: (minimum: Role) => boolean;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = React.createContext<SessionContextValue | null>(null);

function readWorkspaceCookie(): string | null {
  const match = /(?:^|;\s*)mf_workspace=([^;]+)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(() => {
    const stored = readWorkspaceCookie();
    if (stored) setActiveWorkspace(stored);
    return stored;
  });

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });

  // The API decides the effective workspace; mirror it so every subsequent
  // request carries the right x-workspace-id header.
  React.useEffect(() => {
    if (data?.activeWorkspaceId && data.activeWorkspaceId !== workspaceId) {
      setWorkspaceId(data.activeWorkspaceId);
      setActiveWorkspace(data.activeWorkspaceId);
    }
  }, [data?.activeWorkspaceId, workspaceId]);

  React.useEffect(() => {
    setUnauthorizedHandler(() => {
      queryClient.setQueryData(['session'], null);
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  const user = data ?? null;
  const role = (user?.workspaces.find((w) => w.id === workspaceId)?.role ?? null) as Role | null;

  const value: SessionContextValue = {
    user,
    loading: isLoading,
    role,
    workspaceId,
    workspaceName: user?.workspaces.find((w) => w.id === workspaceId)?.name ?? null,
    can: (minimum) => (role ? ROLE_RANK[role] >= ROLE_RANK[minimum] : false),
    refresh: async () => {
      await refetch();
    },
    switchWorkspace: async (id) => {
      await api.post(`/workspaces/${id}/activate`);
      setActiveWorkspace(id);
      setWorkspaceId(id);
      // Every cached list is workspace-scoped, so drop all of it.
      await queryClient.invalidateQueries();
      await refetch();
    },
    logout: async () => {
      await api.post('/auth/logout').catch(() => undefined);
      setActiveWorkspace(null);
      queryClient.clear();
      window.location.href = '/login';
    },
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const context = React.useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}

/** Gate a control on role without scattering rank comparisons through the UI. */
export function RoleGate({
  minimum,
  children,
  fallback = null,
}: {
  minimum: Role;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}) {
  const { can } = useSession();
  return <>{can(minimum) ? children : fallback}</>;
}
