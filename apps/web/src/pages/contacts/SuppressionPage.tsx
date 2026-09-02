import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Search, ShieldBan, Trash2 } from 'lucide-react';
import { SUPPRESSION_TYPES } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { relative, titleCase } from '@/lib/utils';
import { Badge, Button, Field, Input } from '@/components/ui/primitives';
import { Column, DataTable, EmptyState, KpiCard, PageHeader, Pagination } from '@/components/ui/data';
import { Select } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/overlays';
import { RoleGate } from '@/hooks/use-session';

interface SuppressionEntry {
  id: string;
  value: string;
  scope: string;
  type: string;
  reason: string | null;
  createdAt: string;
}

export function SuppressionPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [type, setType] = React.useState('');
  const [addOpen, setAddOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<SuppressionEntry | null>(null);
  const [form, setForm] = React.useState({ value: '', scope: 'EMAIL', type: 'MANUAL_BLOCK', reason: '' });

  const query = new URLSearchParams({
    page: String(page),
    pageSize: '50',
    ...(search ? { q: search } : {}),
    ...(type ? { type } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['suppression', query.toString()],
    queryFn: () => api.get<any>(`/safety/suppression?${query.toString()}`),
  });

  const add = useMutation({
    mutationFn: () => api.post('/safety/suppression', form),
    onSuccess: () => {
      toast.success('Added to suppression list');
      setForm({ value: '', scope: 'EMAIL', type: 'MANUAL_BLOCK', reason: '' });
      setAddOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['suppression'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not add entry'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/safety/suppression/${id}`),
    onSuccess: () => {
      toast.success('Removed from suppression list');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['suppression'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not remove entry'),
  });

  const columns: Column<SuppressionEntry>[] = [
    {
      key: 'value',
      header: 'Address or domain',
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-xs text-foreground">{row.value}</span>
          <Badge tone="outline">{row.scope.toLowerCase()}</Badge>
        </div>
      ),
    },
    { key: 'type', header: 'Reason type', width: 'w-40', cell: (row) => <Badge tone={row.type === 'BOUNCE' ? 'danger' : row.type === 'UNSUBSCRIBE' ? 'warning' : 'neutral'}>{titleCase(row.type)}</Badge> },
    { key: 'reason', header: 'Detail', cell: (row) => <span className="truncate text-xs text-muted-foreground">{row.reason ?? '—'}</span> },
    { key: 'createdAt', header: 'Added', width: 'w-32', cell: (row) => <span className="text-2xs text-muted-foreground">{relative(row.createdAt)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-12',
      align: 'right',
      cell: (row) => (
        <RoleGate minimum="MANAGER">
          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${row.value}`} onClick={() => setPendingDelete(row)}>
            <Trash2 />
          </Button>
        </RoleGate>
      ),
    },
  ];

  const stats = data?.stats ?? {};

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Suppression"
        description="Checked before every single send. Nothing here is ever contacted again."
        actions={
          <RoleGate minimum="USER">
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus /> Add entry
            </Button>
          </RoleGate>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Total" value={data?.total ?? 0} icon={ShieldBan} />
        {SUPPRESSION_TYPES.map((suppressionType) => (
          <KpiCard
            key={suppressionType}
            label={titleCase(suppressionType)}
            value={stats[suppressionType] ?? 0}
            tone={suppressionType === 'BOUNCE' ? 'danger' : suppressionType === 'UNSUBSCRIBE' ? 'warning' : 'neutral'}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search address or domain"
            className="pl-8"
            aria-label="Search suppression list"
          />
        </div>
        <div className="w-48">
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value === 'ALL' ? '' : value);
              setPage(1);
            }}
            placeholder="Any reason"
            options={[{ value: 'ALL', label: 'Any reason' }, ...SUPPRESSION_TYPES.map((t) => ({ value: t, label: titleCase(t) }))]}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        loading={isLoading}
        rowKey={(row) => row.id}
        emptyState={
          <EmptyState
            icon={ShieldBan}
            title="Nothing suppressed"
            description="Bounces and opt-out replies are added here automatically. You can also block an address or a whole domain by hand."
          />
        }
      />

      <Pagination page={data?.page ?? 1} pageSize={data?.pageSize ?? 50} total={data?.total ?? 0} onPageChange={setPage} />

      <Dialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add suppression entry"
        description="Block a single address or an entire domain."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => add.mutate()} loading={add.isPending} disabled={!form.value.trim()}>
              Add entry
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Address or domain" required hint="Use just the domain (example.com) to block everyone there.">
            <Input value={form.value} onChange={(event) => setForm((p) => ({ ...p, value: event.target.value }))} placeholder="person@example.com" />
          </Field>
          <Field label="Scope">
            <Select
              value={form.scope}
              onValueChange={(value) => setForm((p) => ({ ...p, scope: value }))}
              options={[
                { value: 'EMAIL', label: 'Single address' },
                { value: 'DOMAIN', label: 'Whole domain' },
              ]}
            />
          </Field>
          <Field label="Reason type">
            <Select
              value={form.type}
              onValueChange={(value) => setForm((p) => ({ ...p, type: value }))}
              options={SUPPRESSION_TYPES.map((t) => ({ value: t, label: titleCase(t) }))}
            />
          </Field>
          <Field label="Note">
            <Input value={form.reason} onChange={(event) => setForm((p) => ({ ...p, reason: event.target.value }))} placeholder="Why this was blocked" />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Remove ${pendingDelete?.value}?`}
        description="Campaigns will be able to contact this address again. Bounce and unsubscribe history is kept either way."
        confirmLabel="Remove entry"
        loading={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </div>
  );
}
