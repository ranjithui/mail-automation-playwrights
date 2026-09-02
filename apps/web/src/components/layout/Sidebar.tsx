import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  Building2,
  ChevronDown,
  Contact2,
  FileText,
  Inbox,
  LayoutDashboard,
  Mail,
  Megaphone,
  Settings,
  ShieldAlert,
  Users,
  Workflow,
  X,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { Badge, Button } from '@/components/ui/primitives';

interface NavItem {
  label: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  end?: boolean;
  badgeKey?: 'inboxUnread' | 'notifications';
  children?: Array<{ label: string; to: string; end?: boolean }>;
}

const NAV: Array<{ section: string | null; items: NavItem[] }> = [
  {
    section: null,
    items: [{ label: 'Dashboard', to: '/', icon: LayoutDashboard, end: true }],
  },
  {
    section: 'Outreach',
    items: [
      {
        label: 'Campaigns',
        to: '/campaigns',
        icon: Megaphone,
        children: [
          { label: 'All campaigns', to: '/campaigns', end: true },
          { label: 'Create campaign', to: '/campaigns/new' },
        ],
      },
      {
        label: 'Contacts',
        to: '/contacts',
        icon: Contact2,
        children: [
          { label: 'All contacts', to: '/contacts', end: true },
          { label: 'Lists', to: '/contacts/lists' },
          { label: 'Suppression', to: '/contacts/suppression' },
        ],
      },
      { label: 'Templates', to: '/templates', icon: FileText },
    ],
  },
  {
    section: 'Conversations',
    items: [
      {
        label: 'Inbox',
        to: '/inbox',
        icon: Inbox,
        badgeKey: 'inboxUnread',
        children: [
          { label: 'All mail', to: '/inbox', end: true },
          { label: 'Unread', to: '/inbox?folder=UNREAD' },
          { label: 'Important', to: '/inbox?folder=IMPORTANT' },
          { label: 'AI inbox', to: '/ai-inbox' },
        ],
      },
      { label: 'AI assistant', to: '/ai-inbox', icon: Bot },
    ],
  },
  {
    section: 'Operations',
    items: [
      { label: 'Email accounts', to: '/email-accounts', icon: Mail },
      {
        label: 'Automation',
        to: '/automation',
        icon: Workflow,
        children: [
          { label: 'Scheduler', to: '/automation', end: true },
          { label: 'Running jobs', to: '/automation/jobs' },
          { label: 'Logs', to: '/automation/logs' },
        ],
      },
      { label: 'Analytics', to: '/analytics', icon: BarChart3 },
      { label: 'Bounces', to: '/bounces', icon: ShieldAlert },
      { label: 'Notifications', to: '/notifications', icon: Bell, badgeKey: 'notifications' },
    ],
  },
  {
    section: 'Workspace',
    items: [
      { label: 'Members', to: '/settings/members', icon: Users },
      { label: 'Migration', to: '/migration', icon: Building2 },
      { label: 'Settings', to: '/settings', icon: Settings, end: true },
    ],
  },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const location = useLocation();
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  const { data: inboxCounts } = useQuery({
    queryKey: ['inbox-counts'],
    queryFn: () => api.get<{ folders: { unread: number } }>('/inbox/counts'),
    refetchInterval: 60_000,
  });

  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ unread: number }>('/notifications?limit=1'),
    refetchInterval: 60_000,
  });

  const badgeFor = (key?: NavItem['badgeKey']) => {
    if (key === 'inboxUnread') return inboxCounts?.folders.unread ?? 0;
    if (key === 'notifications') return notifications?.unread ?? 0;
    return 0;
  };

  // A group opens automatically when the current route lives inside it.
  const isGroupActive = (item: NavItem) =>
    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);

  return (
    <>
      {/* Mobile scrim */}
      <div
        className={cn(
          'fixed inset-0 z-30 bg-slate-950/50 transition-opacity lg:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden
      />

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col border-r border-border bg-surface transition-transform duration-200 lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight text-foreground">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Mail className="size-4" aria-hidden />
            </span>
            MailFlow
          </NavLink>
          <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onClose} aria-label="Close navigation">
            <X />
          </Button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((group) => (
            <div key={group.section ?? 'root'} className="mb-4 last:mb-0">
              {group.section ? (
                <p className="px-3 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.section}
                </p>
              ) : null}

              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const count = badgeFor(item.badgeKey);
                  const isOpen = expanded[item.to] ?? isGroupActive(item);

                  return (
                    <li key={`${group.section}-${item.to}-${item.label}`}>
                      <div className="flex items-center">
                        <NavLink
                          to={item.to}
                          end={item.end}
                          onClick={onClose}
                          className={({ isActive }) =>
                            cn(
                              'group flex min-h-9 flex-1 cursor-pointer items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors duration-150',
                              isActive
                                ? 'bg-primary-muted text-primary'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                            )
                          }
                        >
                          <Icon className="size-4 shrink-0" aria-hidden />
                          <span className="truncate">{item.label}</span>
                          {count > 0 ? (
                            <Badge tone="primary" className="ml-auto num">
                              {count > 99 ? '99+' : count}
                            </Badge>
                          ) : null}
                        </NavLink>

                        {item.children ? (
                          <button
                            type="button"
                            aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${item.label}`}
                            aria-expanded={isOpen}
                            onClick={() => setExpanded((prev) => ({ ...prev, [item.to]: !isOpen }))}
                            className="mr-1 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <ChevronDown className={cn('size-3.5 transition-transform', isOpen && 'rotate-180')} />
                          </button>
                        ) : null}
                      </div>

                      {item.children && isOpen ? (
                        <ul className="ml-[1.4rem] mt-0.5 space-y-0.5 border-l border-border pl-2.5">
                          {item.children.map((child) => (
                            <li key={child.to + child.label}>
                              <NavLink
                                to={child.to}
                                end={child.end}
                                onClick={onClose}
                                className={({ isActive }) =>
                                  cn(
                                    'block cursor-pointer rounded px-2.5 py-1.5 text-xs transition-colors duration-150',
                                    isActive && child.end !== false
                                      ? 'text-primary'
                                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                                  )
                                }
                              >
                                {child.label}
                              </NavLink>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <WorkerStatusFooter />
      </aside>
    </>
  );
}

function WorkerStatusFooter() {
  const { data } = useQuery({
    queryKey: ['health'],
    queryFn: () =>
      api.get<{ queue: string; mailboxDriver: string; ai: string; database: { provider: string } }>('/health'),
    refetchInterval: 120_000,
  });

  return (
    <div className="shrink-0 border-t border-border px-4 py-3">
      <div className="flex items-center gap-2 text-2xs text-muted-foreground">
        <Activity className="size-3" aria-hidden />
        <span className="truncate">
          {data ? `${data.database.provider} · ${data.queue} · ${data.mailboxDriver}` : 'connecting…'}
        </span>
      </div>
      {data?.mailboxDriver === 'simulation' ? (
        <p className="mt-1.5 text-2xs leading-snug text-muted-foreground">
          Simulation driver — no real email is sent.
        </p>
      ) : null}
    </div>
  );
}
