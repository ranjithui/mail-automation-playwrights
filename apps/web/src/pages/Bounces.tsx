import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, MailX, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { fullDateTime } from '@/lib/utils';
import { Badge, Button, Input } from '@/components/ui/primitives';
import { Column, DataTable, EmptyState, KpiCard, PageHeader, Pagination } from '@/components/ui/data';
import { SegmentedControl } from '@/components/ui/controls';

interface Bounce {
  id: string;
  email: string;
  type: 'HARD' | 'SOFT';
  reason: string | null;
  rawSnippet: string | null;
  detectedAt: string;
  contactId: string | null;
  contact: { id: string; firstName: string | null; lastName: string | null; companyName: string | null } | null;
}

export function BouncesPage() {
  const [page, setPage] = React.useState(1);
  const [type, setType] = React.useState('');
  const [search, setSearch] = React.useState('');

  const query = new URLSearchParams({
    page: String(page),
    pageSize: '25',
    ...(type ? { type } : {}),
    ...(search ? { q: search } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['bounces', query.toString()],
    queryFn: () => api.get<any>(`/safety/bounces?${query.toString()}`),
  });

  const columns: Column<Bounce>[] = [
    {
      key: 'email',
      header: 'Address',
      cell: (row) => (
        <div className="min-w-0">
          <span className="block truncate font-mono text-xs text-foreground">{row.email}</span>
          {row.contact ? (
            <Link to={`/contacts/${row.contact.id}`} className="block truncate text-2xs text-primary hover:underline">
              {[row.contact.firstName, row.contact.lastName].filter(Boolean).join(' ')}
              {row.contact.companyName ? ` · ${row.contact.companyName}` : ''}
            </Link>
          ) : (
            <span className="text-2xs text-muted-foreground">no linked contact</span>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      width: 'w-24',
      cell: (row) => <Badge tone={row.type === 'HARD' ? 'danger' : 'warning'}>{row.type.toLowerCase()}</Badge>,
    },
    { key: 'reason', header: 'Reason', cell: (row) => <span className="truncate text-xs text-muted-foreground">{row.reason ?? '—'}</span> },
    {
      key: 'snippet',
      header: 'Detail',
      width: 'w-64',
      cell: (row) => (
        <span className="line-clamp-2 text-2xs text-muted-foreground" title={row.rawSnippet ?? undefined}>
          {row.rawSnippet ?? '—'}
        </span>
      ),
    },
    { key: 'detectedAt', header: 'Detected', width: 'w-40', cell: (row) => <span className="whitespace-nowrap text-2xs text-muted-foreground">{fullDateTime(row.detectedAt)}</span> },
  ];

  const stats = data?.stats ?? {};

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Bounce management"
        description="Delivery failures are recorded, not deleted — hard bounces are suppressed automatically and their follow-ups cancelled."
        actions={
          <Button variant="outline" onClick={() => void api.download('/contacts/export', `contacts-${Date.now()}.csv`)}>
            <Download /> Export contacts
          </Button>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <KpiCard label="Total bounces" value={data?.total ?? 0} icon={MailX} tone={data?.total ? 'danger' : 'neutral'} />
        <KpiCard label="Hard" value={stats.HARD ?? 0} tone="danger" hint="Permanently suppressed" />
        <KpiCard label="Soft" value={stats.SOFT ?? 0} tone="warning" hint="Sequence stopped, not suppressed" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          value={type}
          onChange={(value) => {
            setType(value);
            setPage(1);
          }}
          options={[
            { value: '', label: 'All' },
            { value: 'HARD', label: 'Hard' },
            { value: 'SOFT', label: 'Soft' },
          ]}
        />
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Search address"
            className="pl-8"
            aria-label="Search bounces"
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
            icon={MailX}
            title="No bounces"
            description="Delivery failures detected during inbox sync land here. Hard bounces also join the suppression list automatically."
          />
        }
      />

      <Pagination page={data?.page ?? 1} pageSize={data?.pageSize ?? 25} total={data?.total ?? 0} onPageChange={setPage} />
    </div>
  );
}
