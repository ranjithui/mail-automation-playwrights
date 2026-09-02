import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, Clock, FlaskConical, Pause, Pencil, Play, Square, Zap } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fullDateTime, pct, relative } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, ProgressBar, Spinner, StatusBadge } from '@/components/ui/primitives';
import { Column, DataTable, EmptyState, ErrorState, KpiCard, PageHeader, Pagination } from '@/components/ui/data';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { ComparisonBarChart, TrendChart } from '@/components/charts';
import { RoleGate } from '@/hooks/use-session';
import { useCampaignProgress, useRealtime } from '@/hooks/use-realtime';

export function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { workerActivity } = useRealtime();
  const [contactPage, setContactPage] = React.useState(1);

  const { data: campaign, isLoading, error, refetch } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get<any>(`/campaigns/${id}`),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });

  const { data: analytics } = useQuery({
    queryKey: ['campaign', id, 'analytics'],
    queryFn: () => api.get<any>(`/campaigns/${id}/analytics`),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });

  const { data: contacts, isLoading: contactsLoading } = useQuery({
    queryKey: ['campaign', id, 'contacts', contactPage],
    queryFn: () => api.get<any>(`/campaigns/${id}/contacts?page=${contactPage}&pageSize=25`),
    enabled: Boolean(id),
  });

  const { data: activity } = useQuery({
    queryKey: ['campaign', id, 'activity'],
    queryFn: () => api.get<any[]>(`/campaigns/${id}/activity`),
    enabled: Boolean(id),
    refetchInterval: 20_000,
  });

  const progress = useCampaignProgress(id, campaign?.progress);

  const control = useMutation({
    mutationFn: (action: 'start' | 'pause' | 'resume' | 'stop') => api.post(`/campaigns/${id}/${action}`, {}),
    onSuccess: (_data, action) => {
      toast.success(`Campaign ${action === 'stop' ? 'stopped' : `${action}ed`}`);
      void queryClient.invalidateQueries({ queryKey: ['campaign', id] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Action failed'),
  });

  const runNow = useMutation({
    mutationFn: () => api.post<{ queued: number; skipped: number; reason?: string }>(`/campaigns/${id}/run-now`, {}),
    onSuccess: (data) => {
      if (data.queued) toast.success(`${data.queued} message(s) queued now`);
      else toast.warning(data.reason ? `Nothing queued - ${data.reason}` : 'Nothing was due to send');
      void queryClient.invalidateQueries({ queryKey: ['campaign', id] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Run now failed'),
  });

  const test = useMutation({
    mutationFn: () => api.post<{ queued: number }>(`/campaigns/${id}/test`, { target: 'FIRST_CONTACT' }),
    onSuccess: (data) => toast.success(`${data.queued} test draft queued`),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Test failed'),
  });

  if (error) return <div className="p-6"><ErrorState error={error} onRetry={() => void refetch()} /></div>;
  if (isLoading || !campaign) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  const contactColumns: Column<any>[] = [
    {
      key: 'contact',
      header: 'Contact',
      cell: (row) => (
        <div className="min-w-0">
          <Link to={`/contacts/${row.contact.id}`} className="block truncate font-medium text-foreground hover:text-primary">
            {[row.contact.firstName, row.contact.lastName].filter(Boolean).join(' ') || row.contact.email}
          </Link>
          <p className="truncate font-mono text-2xs text-muted-foreground">{row.contact.email}</p>
        </div>
      ),
    },
    { key: 'company', header: 'Company', width: 'w-44', cell: (row) => <span className="truncate text-muted-foreground">{row.contact.companyName ?? '—'}</span> },
    { key: 'status', header: 'Status', width: 'w-32', cell: (row) => <StatusBadge status={row.status} /> },
    { key: 'step', header: 'Step', width: 'w-16', align: 'right', cell: (row) => <span className="num">{row.currentStep}</span> },
    {
      key: 'next',
      header: 'Next step',
      width: 'w-32',
      cell: (row) => <span className="text-2xs text-muted-foreground">{row.nextStepAt ? relative(row.nextStepAt) : '—'}</span>,
    },
    {
      key: 'progress',
      header: 'Sequence',
      width: 'w-40',
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.steps.map((step: any) => (
            <Badge
              key={`${row.id}-${step.stepOrder}`}
              tone={
                step.status === 'SENT' ? 'success' : step.status === 'FAILED' ? 'danger' : step.status === 'CANCELLED' ? 'neutral' : 'info'
              }
              title={`${step.stepName}: ${step.status}`}
            >
              {step.stepOrder}
            </Badge>
          ))}
          {!row.steps.length ? <span className="text-2xs text-muted-foreground">not started</span> : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={campaign.name}
        description={campaign.description ?? undefined}
        breadcrumb={
          <Link to="/campaigns" className="hover:text-foreground">
            ← Campaigns
          </Link>
        }
        actions={
          <RoleGate minimum="MANAGER">
            <Button variant="outline" size="sm" onClick={() => test.mutate()} loading={test.isPending}>
              <FlaskConical /> Test draft
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => runNow.mutate()}
              loading={runNow.isPending}
              title="Dispatch everything that is due right now, ignoring the sending window"
            >
              <Zap /> Run now
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link to={`/campaigns/${id}/edit`}>
                <Pencil /> Edit
              </Link>
            </Button>
            {campaign.status === 'RUNNING' ? (
              <Button variant="secondary" onClick={() => control.mutate('pause')} loading={control.isPending}>
                <Pause /> Pause
              </Button>
            ) : campaign.status === 'PAUSED' ? (
              <Button variant="primary" onClick={() => control.mutate('resume')} loading={control.isPending}>
                <Play /> Resume
              </Button>
            ) : (
              <Button variant="primary" onClick={() => control.mutate('start')} loading={control.isPending}>
                <Play /> Start
              </Button>
            )}
            {['RUNNING', 'PAUSED'].includes(campaign.status) ? (
              <Button variant="outline" onClick={() => control.mutate('stop')}>
                <Square /> Stop
              </Button>
            ) : null}
          </RoleGate>
        }
      />

      {/* Live monitor */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <StatusBadge status={campaign.status} dot />
              <span className="text-xs text-muted-foreground">
                {campaign.emailAccount ? (
                  <span className="font-mono">{campaign.emailAccount.email}</span>
                ) : (
                  'no mailbox attached'
                )}
                {' · '}
                {campaign.sendImmediately
                  ? 'immediate — sending window ignored'
                  : `${campaign.sendWindowStart}–${campaign.sendWindowEnd} ${campaign.timezone}`}
              </span>
            </div>
            {campaign.status === 'RUNNING' && workerActivity?.action ? (
              <span className="flex items-center gap-1.5 text-xs text-primary">
                <Activity className="size-3.5 animate-pulse" aria-hidden />
                {workerActivity.action}
                {workerActivity.detail ? `: ${workerActivity.detail}` : ''}
              </span>
            ) : null}
          </div>

          {/* A RUNNING campaign that queues nothing is almost always waiting on
              its own configuration, not broken. Say which. */}
          {campaign.hold ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-muted px-3 py-2">
              <Clock className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  Running, but not sending right now — {campaign.hold.reason.replace(/_/g, ' ').toLowerCase()}
                </p>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  {campaign.hold.detail}
                  {campaign.hold.nextAttemptAt
                    ? ` Next attempt ${fullDateTime(campaign.hold.nextAttemptAt)}.`
                    : ''}
                </p>
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-3">
            <ProgressBar
              value={progress?.percent ?? 0}
              className="h-2 flex-1"
              tone={campaign.status === 'FAILED' ? 'danger' : campaign.status === 'PAUSED' ? 'warning' : 'primary'}
              label="Campaign progress"
            />
            <span className="num shrink-0 text-sm font-semibold text-foreground">{Math.round(progress?.percent ?? 0)}%</span>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {[
              ['Processed', progress?.processed ?? 0],
              ['Sent', progress?.sent ?? 0],
              ['Drafted', progress?.drafted ?? 0],
              ['Failed', progress?.failed ?? 0],
              ['Skipped', progress?.skipped ?? 0],
              ['Replies', progress?.replies ?? 0],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-md border border-border px-3 py-2">
                <p className="text-2xs text-muted-foreground">{label}</p>
                <p className="num text-lg font-semibold leading-tight text-foreground">{value as number}</p>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="sequence">Sequence</TabsTrigger>
          <TabsTrigger value="analytics">Analytics</TabsTrigger>
          <TabsTrigger value="replies">Inbox replies</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-4">
            <KpiCard label="Sent" value={analytics?.events?.SENT ?? 0} tone="primary" />
            <KpiCard label="Replies" value={analytics?.events?.REPLY_RECEIVED ?? 0} tone="success" />
            <KpiCard label="Bounces" value={analytics?.events?.BOUNCED ?? 0} tone="danger" />
            <KpiCard label="Drafts" value={analytics?.events?.DRAFT_CREATED ?? 0} />
          </div>
          <Card className="mt-4">
            <CardHeader title="Daily activity" subtitle="Sends, replies and bounces for this campaign" />
            <CardBody>
              <TrendChart
                data={analytics?.timeline ?? []}
                series={[
                  { key: 'sent', label: 'Sent', colorIndex: 0 },
                  { key: 'replies', label: 'Replies', colorIndex: 4 },
                  { key: 'bounces', label: 'Bounces', colorIndex: 2 },
                ]}
                caption="Campaign daily activity"
              />
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="contacts">
          <DataTable
            columns={contactColumns}
            rows={contacts?.items ?? []}
            loading={contactsLoading}
            rowKey={(row) => row.id}
            emptyState={<EmptyState title="No contacts in this campaign" description="Attach a contact list from the campaign wizard." />}
          />
          <Pagination
            className="mt-3"
            page={contacts?.page ?? 1}
            pageSize={contacts?.pageSize ?? 25}
            total={contacts?.total ?? 0}
            onPageChange={setContactPage}
          />
        </TabsContent>

        <TabsContent value="sequence">
          <div className="space-y-3">
            {campaign.steps.map((step: any, index: number) => (
              <Card key={step.id}>
                <CardBody className="flex flex-wrap items-center gap-3">
                  <Badge tone={index === 0 ? 'primary' : 'neutral'}>{index === 0 ? 'Initial' : `Follow-up ${index}`}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-foreground">{step.name}</p>
                    <p className="truncate text-2xs text-muted-foreground">
                      {step.template ? step.template.subject : 'no template'}
                      {step.replyInThread ? ' · replies in thread' : ' · new email'}
                      {step.attachments?.length ? ` · ${step.attachments.length} attachment(s)` : ''}
                    </p>
                  </div>
                  <Badge tone="outline">{index === 0 ? 'immediately' : `+${step.delayDays}d ${step.delayHours}h`}</Badge>
                  <Badge tone={step.enabled ? 'success' : 'neutral'}>{step.enabled ? 'enabled' : 'disabled'}</Badge>
                  <span className="num text-2xs text-muted-foreground">{step.processed} processed</span>
                </CardBody>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="analytics">
          <Card>
            <CardHeader title="Step performance" subtitle="Where contacts are in the sequence" />
            <CardBody>
              <ComparisonBarChart
                data={analytics?.stepPerformance ?? []}
                categoryKey="name"
                layout="vertical"
                height={Math.max(220, (analytics?.stepPerformance?.length ?? 1) * 52)}
                series={[
                  { key: 'sent', label: 'Sent', colorIndex: 0 },
                  { key: 'failed', label: 'Failed', colorIndex: 2 },
                  { key: 'cancelled', label: 'Cancelled', colorIndex: 3 },
                  { key: 'pending', label: 'Pending', colorIndex: 1 },
                ]}
                caption="Per-step outcomes"
              />
            </CardBody>
          </Card>
        </TabsContent>

        <TabsContent value="replies">
          {!analytics?.replies?.length ? (
            <EmptyState title="No replies yet" description="Inbound replies attributed to this campaign show up here." />
          ) : (
            <div className="space-y-2">
              {analytics.replies.map((reply: any) => (
                <Link
                  key={reply.id}
                  to={`/inbox?thread=${reply.id}`}
                  className="block cursor-pointer rounded-md border border-border bg-surface p-3 transition-colors hover:bg-muted"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground">{reply.subject}</span>
                    <span className="shrink-0 text-2xs text-muted-foreground">{relative(reply.lastMessageAt)}</span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">{reply.contact?.email}</p>
                  {reply.snippet ? <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{reply.snippet}</p> : null}
                </Link>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {!activity?.length ? (
            <EmptyState title="Nothing logged yet" description="Every send, skip and failure is recorded here." />
          ) : (
            <Card>
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col" className="w-40">When</th>
                      <th scope="col" className="w-24">Status</th>
                      <th scope="col" className="w-48">Action</th>
                      <th scope="col">Message</th>
                      <th scope="col" className="w-24">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.map((entry) => (
                      <tr key={entry.id}>
                        <td className="whitespace-nowrap text-2xs text-muted-foreground">{fullDateTime(entry.createdAt)}</td>
                        <td><StatusBadge status={entry.status} /></td>
                        <td className="font-mono text-2xs text-muted-foreground">{entry.action}</td>
                        <td className="text-xs">{entry.message}</td>
                        <td className="num text-2xs text-muted-foreground">{entry.durationMs ? `${entry.durationMs}ms` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="settings">
          <Card>
            <CardHeader title="Configuration" subtitle="Edit these in the campaign wizard" />
            <CardBody>
              <dl className="grid gap-2 text-xs sm:grid-cols-2">
                {[
                  ['Mode', campaign.mode === 'SEND' ? 'Send automatically' : 'Create drafts only'],
                  ['Timezone', campaign.timezone],
                  ['Sending window', campaign.sendImmediately ? 'Immediate (ignored)' : `${campaign.sendWindowStart}–${campaign.sendWindowEnd}`],
                  ['Send immediately', campaign.sendImmediately ? 'Yes' : 'No'],
                  ['Sending days', (campaign.sendDays ?? []).map((d: number) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(', ')],
                  ['Daily limit', `${campaign.dailyLimit} per day`],
                  ['Delay', `${campaign.minDelaySec}–${campaign.maxDelaySec}s${campaign.randomDelay ? ' (randomised)' : ''}`],
                  ['Stop on reply', campaign.stopOnReply ? 'Yes' : 'No'],
                  ['Reply rate', pct(analytics?.progress ? (analytics.progress.replies / Math.max(1, analytics.progress.sent)) * 100 : 0)],
                  ['Created', fullDateTime(campaign.createdAt)],
                  ['Created by', campaign.createdBy ? `${campaign.createdBy.firstName} ${campaign.createdBy.lastName}` : '—'],
                ].map(([label, value]) => (
                  <div key={label as string} className="flex justify-between gap-3 rounded border border-border px-3 py-2">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-medium text-foreground">{value as string}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
