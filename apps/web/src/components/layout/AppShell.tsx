import * as React from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Check,
  ChevronsUpDown,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  UserCircle2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api } from '@/lib/api';
import { cn, initialsOf, relative } from '@/lib/utils';
import { useSession } from '@/hooks/use-session';
import { useRealtime } from '@/hooks/use-realtime';
import { Avatar, Badge, Button, Input, Separator } from '@/components/ui/primitives';
import {
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '@/components/ui/overlays';
import { Tooltip } from '@/components/ui/controls';
import { Sidebar } from './Sidebar';

function useTheme() {
  const [theme, setTheme] = React.useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('mf-theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('mf-theme', theme);
  }, [theme]);

  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

export function AppShell() {
  const [navOpen, setNavOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onOpenNav={() => setNavOpen(true)} />
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function Topbar({ onOpenNav }: { onOpenNav: () => void }) {
  const { user, workspaceId, workspaceName, role, switchWorkspace, logout } = useSession();
  const { connected } = useRealtime();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-4">
      <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onOpenNav} aria-label="Open navigation">
        <Menu />
      </Button>

      {/* Workspace switcher */}
      <DropdownMenu>
        <DropdownTrigger asChild>
          <button
            type="button"
            className="flex max-w-52 cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-[13px] font-medium transition-colors hover:bg-muted"
          >
            <span className="truncate">{workspaceName ?? 'Workspace'}</span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </DropdownTrigger>
        <DropdownContent align="start" className="w-64">
          <DropdownLabel>Workspaces</DropdownLabel>
          {user?.workspaces.map((workspace) => (
            <DropdownItem key={workspace.id} onSelect={() => void switchWorkspace(workspace.id)}>
              <span className="flex-1 truncate">{workspace.name}</span>
              <Badge tone="outline">{workspace.role.toLowerCase()}</Badge>
              {workspace.id === workspaceId ? <Check className="size-3.5 text-primary" /> : null}
            </DropdownItem>
          ))}
          <DropdownSeparator />
          <DropdownItem onSelect={() => navigate('/settings')}>
            <Settings /> Workspace settings
          </DropdownItem>
        </DropdownContent>
      </DropdownMenu>

      {/* Global search: routes to the inbox operator syntax */}
      <form
        className="relative ml-1 hidden min-w-0 flex-1 max-w-md md:block"
        onSubmit={(event) => {
          event.preventDefault();
          if (search.trim()) navigate(`/inbox?q=${encodeURIComponent(search.trim())}`);
        }}
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search mail —  from:  subject:  campaign:  company:"
          className="h-8 pl-8 text-xs"
          aria-label="Search"
        />
      </form>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip content={connected ? 'Live updates connected' : 'Reconnecting to live updates…'}>
          <span
            className={cn(
              'hidden items-center gap-1.5 rounded-md px-2 py-1 text-2xs font-medium sm:inline-flex',
              connected ? 'text-success' : 'text-muted-foreground',
            )}
          >
            {connected ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
            {connected ? 'Live' : 'Offline'}
          </span>
        </Tooltip>

        <NotificationBell />

        <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label="Toggle colour theme">
            {theme === 'dark' ? <Sun /> : <Moon />}
          </Button>
        </Tooltip>

        <Separator vertical className="mx-1 h-6" />

        <DropdownMenu>
          <DropdownTrigger asChild>
            <button
              type="button"
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 transition-colors hover:bg-muted"
              aria-label="Account menu"
            >
              <Avatar initials={initialsOf(user?.firstName, user?.lastName, user?.email)} className="size-7" />
              <span className="hidden text-left leading-tight sm:block">
                <span className="block max-w-32 truncate text-xs font-medium text-foreground">
                  {user?.firstName} {user?.lastName}
                </span>
                <span className="block text-2xs text-muted-foreground">{role?.toLowerCase()}</span>
              </span>
            </button>
          </DropdownTrigger>
          <DropdownContent className="w-60">
            <div className="px-2 py-1.5">
              <p className="truncate text-[13px] font-medium text-foreground">
                {user?.firstName} {user?.lastName}
              </p>
              <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
              <p className="mt-1 truncate text-2xs text-muted-foreground">{user?.organizationName}</p>
            </div>
            <DropdownSeparator />
            <DropdownItem onSelect={() => navigate('/settings/profile')}>
              <UserCircle2 /> Profile
            </DropdownItem>
            <DropdownItem onSelect={() => navigate('/settings')}>
              <Settings /> Settings
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem destructive onSelect={() => void logout()}>
              <LogOut /> Sign out
            </DropdownItem>
          </DropdownContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

interface NotificationItem {
  id: string;
  title: string;
  body: string | null;
  severity: string;
  linkUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

function NotificationBell() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: NotificationItem[]; unread: number }>('/notifications?limit=12'),
    refetchInterval: 60_000,
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = data?.unread ?? 0;
  const toneFor = (severity: string) =>
    severity === 'ERROR' ? 'danger' : severity === 'WARNING' ? 'warning' : severity === 'SUCCESS' ? 'success' : 'info';

  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={`Notifications (${unread} unread)`}>
          <Bell />
          {unread > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-danger text-[9px] font-semibold text-danger-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownTrigger>
      <DropdownContent className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold">Notifications</span>
          {unread > 0 ? (
            <button
              type="button"
              onClick={() => markAll.mutate()}
              className="cursor-pointer text-xs text-primary hover:underline"
            >
              Mark all read
            </button>
          ) : null}
        </div>

        <div className="max-h-80 overflow-y-auto p-1">
          {!data?.items.length ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing to report.</p>
          ) : (
            data.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  void api.post(`/notifications/${item.id}/read`);
                  if (item.linkUrl) navigate(item.linkUrl);
                }}
                className={cn(
                  'flex w-full cursor-pointer gap-2 rounded p-2 text-left transition-colors hover:bg-muted',
                  !item.isRead && 'bg-primary-muted/40',
                )}
              >
                <Badge tone={toneFor(item.severity)} className="mt-0.5 shrink-0">
                  {item.severity.toLowerCase()}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{item.title}</span>
                  {item.body ? (
                    <span className="mt-0.5 block whitespace-pre-line text-2xs leading-snug text-muted-foreground line-clamp-3">
                      {item.body}
                    </span>
                  ) : null}
                  <span className="mt-1 block text-2xs text-muted-foreground">{relative(item.createdAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="border-t border-border p-1">
          <Link
            to="/notifications"
            className="block cursor-pointer rounded px-2 py-1.5 text-center text-xs text-primary transition-colors hover:bg-muted"
          >
            View all notifications
          </Link>
        </div>
      </DropdownContent>
    </DropdownMenu>
  );
}
