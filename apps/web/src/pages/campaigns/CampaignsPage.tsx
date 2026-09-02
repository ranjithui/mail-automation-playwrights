import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MoreHorizontal, Pause, Play, Plus, Search, Square, Trash2 } from 'lucide-react';
import type { CampaignStatus } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { relative } from '@/lib/utils';
import { Badge, Button, Input, ProgressBar, StatusBadge } from '@/components/ui/primitives';
import { Column, DataTable, EmptyState, PageHeader } from '@/components/ui/data';
import { SegmentedControl } from '@/components/ui/controls';
import {
  ConfirmDialog,
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '@/components/ui/overlays';
import { RoleGate } from '@/hooks/use-session';
import { useRealtime } from '@/hooks/use-realtime';

interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  status: CampaignStatus;
  mode: string;
  emailAccount: { id: string; email: string } | null;
  contactList: { id: string; name: string } | null;
  contactCount: number;
  stepCount: number;
  replies: number;
  bounces: number;
  progress: number;
  lastRunAt: string | null;
  updatedAt: string;
}

const FILTERS = [
  { value: 'ALL', label: 'All' },
  { value: 'RUNNING', label: 'Running' },
  { value: 'PAUSED', label: 'Paused' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'COMPLETED', label: 'Completed' },
] as const;

export function CampaignsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { campaignProgress } = useRealtime();

  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]['value']>('ALL');
  const [search, setSearch] = React.useState('');
  const [pendingDelete, setPendingDelete] = React.useState<CampaignRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.get<CampaignRow[]>('/campaigns'),
    refetchInterval: 20_000,
  });

  const control = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'pause' | 'resume' | 'stop' }) =>
      api.post(`/campaigns/${id}/${action}`, {}),
    onSuccess: (_data, variables) => {
      toast.success(`Campaign ${variables.action === 'stop' ? 'stopped' : `${variables.action}ed`}`);
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Action failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/campaigns/${id}`),
    onSuccess: () => {
      toast.success('Campaign deleted');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Delete failed'),
  });

  const rows = React.useMemo(() => {
    let list = data ?? [];
    if (filter !== 'ALL') list = list.filter((c) => c.status === filter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (c) => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [data, filter, search]);

  const columns: Column<CampaignRow>[] = [
    {
      key: 'name',
      header: 'Campaign',
      cell: (row) => (
        <div className="min-w-0">
          <Link to={`/campaigns/${row.id}`} className="block truncate font-medium text-foreground hover:text-primary">
            {row.name}
          </Link>
          <p className="truncate text-2xs text-muted-foreground">
            {row.stepCount} step{row.stepCount === 1 ? '' : 's'}
            {row.contactList ? ` · ${row.contactList.name}` : ''}
            {row.mode === 'DRAFT_ONLY' ? ' · draft only' : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-28',
      cell: (row) => <StatusBadge status={row.status} dot />,
    },
    {
      key: 'mailbox',
      header: 'Mailbox',
      width: 'w-52',
      cell: (row) =>
        row.emailAccount ? (
          <span className="font-mono text-2xs text-muted-foreground">{row.emailAccount.email}</span>
        ) : (
          <Badge tone="warning">not attached</Badge>
        ),
    },
    {
      key: 'progress',
      header: 'Progress',
      width: 'w-44',
      cell: (row) => {
        const live = campaignProgress[row.id];
        const value = live?.percent ?? row.progress;
        return (
          <div className="flex items-center gap-2">
            <ProgressBar
              value={value}
              className="flex-1"
              tone={row.status === 'FAILED' ? 'danger' : row.status === 'PAUSED' ? 'warning' : 'primary'}
              label={`${row.name} progress`}
            />
            <span className="num w-9 shrink-0 text-right text-2xs text-muted-foreground">{Math.round(value)}%</span>
          </div>
        );
      },
    },
    { key: 'contacts', header: 'Contacts', width: 'w-20', align: 'right', cell: (row) => <span className="num">{row.contactCount}</span> },
    { key: 'replies', header: 'Replies', width: 'w-20', align: 'right', cell: (row) => <span className="num">{row.replies}</span> },
    {
      key: 'updated',
      header: 'Last run',
      width: 'w-28',
      cell: (row) => <span className="text-2xs text-muted-foreground">{row.lastRunAt ? relative(row.lastRunAt) : '—'}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-12',
      align: 'right',
      cell: (row) => (
        <RoleGate minimum="MANAGER">
          <DropdownMenu>
            <DropdownTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Actions for ${row.name}`}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal />
              </Button>
            </DropdownTrigger>
            <DropdownContent>
              <DropdownItem onSelect={() => navigate(`/campaigns/${row.id}`)}>Open</DropdownItem>
              <DropdownItem onSelect={() => navigate(`/campaigns/${row.id}/edit`)}>Edit sequence</DropdownItem>
              <DropdownSeparator />
              {row.status === 'RUNNING' ? (
                <DropdownItem onSelect={() => control.mutate({ id: row.id, action: 'pause' })}>
                  <Pause /> Pause
                </DropdownItem>
              ) : row.status === 'PAUSED' ? (
                <DropdownItem onSelect={() => control.mutate({ id: row.id, action: 'resume' })}>
                  <Play /> Resume
                </DropdownItem>
              ) : (
                <DropdownItem onSelect={() => control.mutate({ id: row.id, action: 'start' })}>
                  <Play /> Start
                </DropdownItem>
              )}
              {['RUNNING', 'PAUSED', 'SCHEDULED'].includes(row.status) ? (
                <DropdownItem onSelect={() => control.mutate({ id: row.id, action: 'stop' })}>
                  <Square /> Stop
                </DropdownItem>
              ) : null}
              <DropdownSeparator />
              <DropdownItem destructive onSelect={() => setPendingDelete(row)}>
                <Trash2 /> Delete
              </DropdownItem>
            </DropdownContent>
          </DropdownMenu>
        </RoleGate>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Campaigns"
        description="Sequences, schedules and their live progress."
        actions={
          <RoleGate minimum="USER">
            <Button variant="primary" asChild>
              <Link to="/campaigns/new">
                <Plus /> New campaign
              </Link>
            </Button>
          </RoleGate>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((f) => ({
            value: f.value,
            label: `${f.label}${f.value !== 'ALL' && data ? ` (${data.filter((c) => c.status === f.value).length})` : ''}`,
          }))}
        />
        <div className="relative min-w-52 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search campaigns"
            className="pl-8"
            aria-label="Search campaigns"
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={isLoading}
        rowKey={(row) => row.id}
        onRowClick={(row) => navigate(`/campaigns/${row.id}`)}
        emptyState={
          <EmptyState
            title={search || filter !== 'ALL' ? 'No campaigns match' : 'No campaigns yet'}
            description={
              search || filter !== 'ALL'
                ? 'Try a different search or filter.'
                : 'Import contacts, build a sequence and let the worker do the sending.'
            }
            action={
              <Button variant="primary" asChild>
                <Link to="/campaigns/new">
                  <Plus /> Create campaign
                </Link>
              </Button>
            }
          />
        }
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name}"?`}
        description="The campaign, its sequence and all progress records are removed. Contacts and their inbox threads are kept."
        confirmLabel="Delete campaign"
        loading={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </div>
  );
}
