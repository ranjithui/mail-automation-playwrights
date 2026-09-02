import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, CalendarClock, Cpu, RotateCw, Search, Workflow } from 'lucide-react';
import type { JobSummary } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { fullDateTime, relative, titleCase } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, Input, StatusBadge } from '@/components/ui/primitives';
import { Column, DataTable, EmptyState, KpiCard, PageHeader, Pagination } from '@/components/ui/data';
import { Select } from '@/components/ui/controls';
import { RoleGate } from '@/hooks/use-session';

/* ------------------------------------------------------------- scheduler */

export function AutomationPage() {
  const { data: stats } = useQuery({
    queryKey: ['job-stats'],
    queryFn: () => api.get<{ driver: string; queues: Record<string, Record<string, number>>; totals: Record<string, number> }>('/jobs/stats'),
    refetchInterval: 10_000,
  });

  const { data: campaigns } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.get<any[]>('/campaigns'),
    refetchInterval: 20_000,
  });

  const { data: runs } = useQuery({
    queryKey: ['automation-runs'],
    queryFn: () => api.get<any[]>('/jobs/runs'),
    refetchInterval: 20_000,
  });

  const scheduled = (campaigns ?? []).filter((c) => ['RUNNING', 'SCHEDULED', 'PAUSED'].includes(c.status));

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Scheduler"
        description="The persistent queue that replaces spreadsheet triggers — it survives restarts and never duplicates a send."
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Queue driver" value={<span className="text-base">{stats?.driver ?? '—'}</span>} icon={Cpu} tone="primary" />
        <KpiCard label="Pending" value={stats?.totals?.PENDING ?? 0} />
        <KpiCard label="Delayed" value={stats?.totals?.DELAYED ?? 0} />
        <KpiCard label="Active" value={stats?.totals?.ACTIVE ?? 0} tone="warning" />
        <KpiCard label="Failed" value={stats?.totals?.FAILED ?? 0} tone={stats?.totals?.FAILED ? 'danger' : 'neutral'} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Scheduled campaigns" subtitle="Sending windows currently in force" />
          {!scheduled.length ? (
            <EmptyState compact icon={CalendarClock} title="Nothing scheduled" description="Start a campaign and its schedule appears here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col" className="w-24">Status</th>
                    <th scope="col" className="w-40">Window</th>
                    <th scope="col" className="w-24 text-right">Daily cap</th>
                    <th scope="col" className="w-28">Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduled.map((campaign) => (
                    <tr key={campaign.id}>
                      <td>
                        <Link to={`/campaigns/${campaign.id}`} className="font-medium text-foreground hover:text-primary">
                          {campaign.name}
                        </Link>
                      </td>
                      <td><StatusBadge status={campaign.status} /></td>
                      <td className="num text-2xs text-muted-foreground">
                        {campaign.sendWindowStart}–{campaign.sendWindowEnd}
                        <span className="block">{campaign.timezone}</span>
                      </td>
                      <td className="num text-right">{campaign.dailyLimit}</td>
                      <td className="text-2xs text-muted-foreground">{campaign.lastRunAt ? relative(campaign.lastRunAt) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Queues" subtitle="Job counts by queue and state" />
          <CardBody className="space-y-2">
            {Object.entries(stats?.queues ?? {}).map(([queue, states]) => (
              <div key={queue} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                <span className="font-mono text-2xs text-foreground">{queue}</span>
                <div className="ml-auto flex flex-wrap gap-1">
                  {Object.entries(states).map(([state, count]) => (
                    <Badge key={state} tone={state === 'FAILED' ? 'danger' : state === 'ACTIVE' ? 'warning' : 'outline'} className="num">
                      {state.toLowerCase()} {count}
                    </Badge>
                  ))}
                </div>
              </div>
            ))}
            {!Object.keys(stats?.queues ?? {}).length ? (
              <p className="py-6 text-center text-xs text-muted-foreground">No jobs have been queued yet.</p>
            ) : null}
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Recent automation runs"
          subtitle="Each scheduler pass and what it queued"
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/automation/jobs">Running jobs</Link>
            </Button>
          }
        />
        {!runs?.length ? (
          <EmptyState compact icon={Workflow} title="No runs yet" description="Runs are recorded every time the scheduler evaluates a campaign." />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col" className="w-40">Started</th>
                  <th scope="col">Campaign</th>
                  <th scope="col" className="w-24">Trigger</th>
                  <th scope="col" className="w-24">Status</th>
                  <th scope="col" className="w-20 text-right">Processed</th>
                  <th scope="col" className="w-20 text-right">Skipped</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((run) => (
                  <tr key={run.id}>
                    <td className="whitespace-nowrap text-2xs text-muted-foreground">{fullDateTime(run.startedAt)}</td>
                    <td className="truncate text-foreground">{run.campaign?.name ?? '—'}</td>
                    <td><Badge tone="outline">{run.trigger.toLowerCase()}</Badge></td>
                    <td><StatusBadge status={run.status} /></td>
                    <td className="num text-right">{run.processed}</td>
                    <td className="num text-right">{run.skipped}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ jobs */

export function JobsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('');
  const [queue, setQueue] = React.useState('');

  const query = new URLSearchParams({
    page: String(page),
    pageSize: '25',
    ...(status ? { status } : {}),
    ...(queue ? { queue } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['jobs', query.toString()],
    queryFn: () => api.get<any>(`/jobs?${query.toString()}`),
    refetchInterval: 8_000,
  });

  const { data: stats } = useQuery({
    queryKey: ['job-stats'],
    queryFn: () => api.get<any>('/jobs/stats'),
    refetchInterval: 10_000,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api.post(`/jobs/${id}/retry`),
    onSuccess: () => {
      toast.success('Job requeued');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Retry failed'),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/jobs/${id}/cancel`),
    onSuccess: () => {
      toast.success('Job cancelled');
      void queryClient.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Cancel failed'),
  });

  const columns: Column<JobSummary>[] = [
    { key: 'queue', header: 'Queue', width: 'w-36', cell: (row) => <span className="font-mono text-2xs text-muted-foreground">{row.queue}</span> },
    {
      key: 'name',
      header: 'Job',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-xs text-foreground">{row.name}</p>
          {row.campaignName ? <p className="truncate text-2xs text-muted-foreground">{row.campaignName}</p> : null}
        </div>
      ),
    },
    { key: 'status', header: 'Status', width: 'w-24', cell: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'attempts',
      header: 'Attempts',
      width: 'w-20',
      align: 'right',
      cell: (row) => (
        <span className={`num ${row.attempts > 1 ? 'text-warning' : 'text-muted-foreground'}`}>
          {row.attempts}/{row.maxAttempts}
        </span>
      ),
    },
    { key: 'runAt', header: 'Run at', width: 'w-36', cell: (row) => <span className="text-2xs text-muted-foreground">{fullDateTime(row.runAt)}</span> },
    {
      key: 'error',
      header: 'Error',
      width: 'w-56',
      cell: (row) =>
        row.error ? (
          <div className="min-w-0">
            <Badge tone="danger">{row.errorCode ?? 'ERROR'}</Badge>
            <p className="mt-0.5 truncate text-2xs text-muted-foreground" title={row.error}>
              {row.error}
            </p>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-24',
      align: 'right',
      cell: (row) => (
        <RoleGate minimum="USER">
          <div className="flex justify-end gap-1">
            {['FAILED', 'CANCELLED', 'COMPLETED'].includes(row.status) ? (
              <Button variant="ghost" size="icon-sm" onClick={() => retry.mutate(row.id)} aria-label="Retry job">
                <RotateCw />
              </Button>
            ) : null}
            {['PENDING', 'DELAYED'].includes(row.status) ? (
              <Button variant="ghost" size="icon-sm" onClick={() => cancel.mutate(row.id)} aria-label="Cancel job">
                <Ban />
              </Button>
            ) : null}
          </div>
        </RoleGate>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Running jobs" description="Every queued unit of work, with retries and failure detail." />

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-44">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value === 'ALL' ? '' : value);
              setPage(1);
            }}
            placeholder="Any status"
            options={[
              { value: 'ALL', label: 'Any status' },
              ...['PENDING', 'DELAYED', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED'].map((s) => ({ value: s, label: titleCase(s) })),
            ]}
          />
        </div>
        <div className="w-52">
          <Select
            value={queue}
            onValueChange={(value) => {
              setQueue(value === 'ALL' ? '' : value);
              setPage(1);
            }}
            placeholder="Any queue"
            options={[
              { value: 'ALL', label: 'Any queue' },
              ...Object.keys(stats?.queues ?? {}).map((q) => ({ value: q, label: q })),
            ]}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        loading={isLoading}
        rowKey={(row) => row.id}
        emptyState={<EmptyState icon={Cpu} title="No jobs" description="Start a campaign or sync a mailbox and work appears here." />}
      />

      <Pagination page={data?.page ?? 1} pageSize={data?.pageSize ?? 25} total={data?.total ?? 0} onPageChange={setPage} />
    </div>
  );
}

/* ------------------------------------------------------------------ logs */

export function LogsPage() {
  const [page, setPage] = React.useState(1);
  const [status, setStatus] = React.useState('');
  const [search, setSearch] = React.useState('');

  const query = new URLSearchParams({
    page: String(page),
    pageSize: '50',
    ...(status ? { status } : {}),
    ...(search ? { q: search } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['logs', query.toString()],
    queryFn: () => api.get<any>(`/logs?${query.toString()}`),
    refetchInterval: 15_000,
  });

  const columns: Column<any>[] = [
    { key: 'createdAt', header: 'When', width: 'w-40', cell: (row) => <span className="whitespace-nowrap text-2xs text-muted-foreground">{fullDateTime(row.createdAt)}</span> },
    { key: 'status', header: 'Status', width: 'w-24', cell: (row) => <StatusBadge status={row.status} /> },
    { key: 'action', header: 'Action', width: 'w-52', cell: (row) => <span className="font-mono text-2xs text-muted-foreground">{row.action}</span> },
    { key: 'message', header: 'Message', cell: (row) => <span className="text-xs text-foreground">{row.message ?? '—'}</span> },
    { key: 'campaign', header: 'Campaign', width: 'w-40', cell: (row) => <span className="truncate text-2xs text-muted-foreground">{row.campaignName ?? '—'}</span> },
    {
      key: 'meta',
      header: 'Detail',
      width: 'w-36',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.errorCode ? <Badge tone="danger">{row.errorCode}</Badge> : null}
          {row.durationMs ? <Badge tone="outline" className="num">{row.durationMs}ms</Badge> : null}
          {row.retryCount ? <Badge tone="warning" className="num">retry {row.retryCount}</Badge> : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Activity logs" description="A complete audit trail of every automation action, success or failure." />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="Filter by action, e.g. send.sent"
            className="pl-8"
            aria-label="Filter logs"
          />
        </div>
        <div className="w-44">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value === 'ALL' ? '' : value);
              setPage(1);
            }}
            placeholder="Any status"
            options={[
              { value: 'ALL', label: 'Any status' },
              ...['SUCCESS', 'FAILURE', 'INFO', 'WARNING'].map((s) => ({ value: s, label: titleCase(s) })),
            ]}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={data?.items ?? []}
        loading={isLoading}
        rowKey={(row) => row.id}
        emptyState={<EmptyState title="No activity yet" description="Every send, skip, sync and failure is recorded here." />}
      />

      <Pagination page={data?.page ?? 1} pageSize={data?.pageSize ?? 50} total={data?.total ?? 0} onPageChange={setPage} />
    </div>
  );
}
