import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Inbox,
  MailCheck,
  MailX,
  MessageSquareReply,
  PencilLine,
  Send,
  Users,
} from 'lucide-react';
import type { DashboardResponse } from '@mail/shared';
import { api } from '@/lib/api';
import { compactNumber, pct, relative } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, ProgressBar, StatusBadge } from '@/components/ui/primitives';
import { EmptyState, ErrorState, KpiCard, PageHeader } from '@/components/ui/data';
import { SegmentedControl } from '@/components/ui/controls';
import { ComparisonBarChart, DistributionChart, TrendChart } from '@/components/charts';
import { useSession } from '@/hooks/use-session';

export function DashboardPage() {
  const { user } = useSession();
  const [days, setDays] = React.useState<'7' | '30' | '90'>('30');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard', days],
    queryFn: () => api.get<DashboardResponse>(`/dashboard?days=${days}`),
    refetchInterval: 30_000,
  });

  const kpis = data?.kpis;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={`Good to see you, ${user?.firstName ?? 'there'}`}
        description="Everything happening across your campaigns, mailboxes and inbox."
        actions={
          <>
            <SegmentedControl
              value={days}
              onChange={setDays}
              options={[
                { value: '7', label: '7d' },
                { value: '30', label: '30d' },
                { value: '90', label: '90d' },
              ]}
            />
            <Button variant="primary" asChild>
              <Link to="/campaigns/new">New campaign</Link>
            </Button>
          </>
        }
      />

      {error ? <ErrorState error={error} onRetry={() => void refetch()} /> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        <KpiCard label="Contacts" value={compactNumber(kpis?.totalContacts)} icon={Users} loading={isLoading} />
        <KpiCard label="Emails sent" value={compactNumber(kpis?.emailsSent)} icon={Send} tone="primary" loading={isLoading} />
        <KpiCard label="Drafts" value={compactNumber(kpis?.draftsCreated)} icon={PencilLine} loading={isLoading} />
        <KpiCard
          label="Replies"
          value={compactNumber(kpis?.replies)}
          hint={kpis ? `${pct(kpis.replyRate)} reply rate` : undefined}
          icon={MessageSquareReply}
          tone="success"
          loading={isLoading}
        />
        <KpiCard label="Follow-ups" value={compactNumber(kpis?.followUps)} icon={MailCheck} loading={isLoading} />
        <KpiCard
          label="Bounces"
          value={compactNumber(kpis?.bounces)}
          hint={kpis ? `${pct(kpis.bounceRate)} bounce rate` : undefined}
          icon={MailX}
          tone={kpis && kpis.bounceRate > 5 ? 'danger' : 'neutral'}
          loading={isLoading}
        />
        <KpiCard label="Unsubscribes" value={compactNumber(kpis?.unsubscribes)} icon={AlertTriangle} loading={isLoading} />
        <KpiCard
          label="Failed"
          value={compactNumber(kpis?.failed)}
          icon={AlertTriangle}
          tone={kpis?.failed ? 'warning' : 'neutral'}
          loading={isLoading}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Email activity" subtitle={`Sends, replies and bounces over the last ${days} days`} />
          <CardBody className="pt-2">
            <TrendChart
              data={data?.activity ?? []}
              series={[
                { key: 'sent', label: 'Sent', colorIndex: 0 },
                { key: 'replies', label: 'Replies', colorIndex: 4 },
                { key: 'bounces', label: 'Bounces', colorIndex: 2 },
              ]}
              caption="Daily email activity"
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Inbox"
            subtitle="What needs a person"
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/inbox">
                  Open <ArrowUpRight />
                </Link>
              </Button>
            }
          />
          <CardBody className="space-y-3">
            {[
              { label: 'Unread', value: data?.inboxActivity.unread ?? 0, to: '/inbox?folder=UNREAD', tone: 'primary' as const },
              { label: 'Requires attention', value: data?.inboxActivity.requiresAttention ?? 0, to: '/ai-inbox', tone: 'danger' as const },
              { label: 'Awaiting reply', value: data?.inboxActivity.awaitingReply ?? 0, to: '/inbox?folder=WAITING', tone: 'warning' as const },
              { label: 'AI reply available', value: data?.inboxActivity.aiAvailable ?? 0, to: '/inbox?folder=AI_SUGGESTED', tone: 'success' as const },
            ].map((row) => (
              <Link
                key={row.label}
                to={row.to}
                className="flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 transition-colors hover:bg-muted"
              >
                <span className="text-[13px] text-foreground">{row.label}</span>
                <Badge tone={row.value ? row.tone : 'neutral'} className="num">
                  {row.value}
                </Badge>
              </Link>
            ))}

            <div className="rounded-md border border-border bg-muted/40 p-3">
              <div className="flex items-center gap-2">
                <Bot className="size-4 text-primary" aria-hidden />
                <p className="text-xs font-medium text-foreground">AI insights</p>
              </div>
              <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between">
                  <dt>Messages analysed</dt>
                  <dd className="num text-foreground">{data?.aiInsights.analyzed ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Replies suggested</dt>
                  <dd className="num text-foreground">{data?.aiInsights.suggestionsGenerated ?? 0}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Suggestions sent</dt>
                  <dd className="num text-foreground">{data?.aiInsights.suggestionsSent ?? 0}</dd>
                </div>
              </dl>
            </div>
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Campaign performance"
            subtitle="Progress and reply rate by campaign"
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/campaigns">
                  All campaigns <ArrowUpRight />
                </Link>
              </Button>
            }
          />
          {!data?.campaignPerformance.length ? (
            <EmptyState
              compact
              icon={Send}
              title="No campaigns yet"
              description="Create your first sequence and it will show up here as soon as it starts sending."
              action={
                <Button variant="primary" asChild>
                  <Link to="/campaigns/new">Create campaign</Link>
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col" className="w-28">Status</th>
                    <th scope="col" className="w-40">Progress</th>
                    <th scope="col" className="w-20 text-right">Sent</th>
                    <th scope="col" className="w-20 text-right">Replies</th>
                    <th scope="col" className="w-24 text-right">Reply rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaignPerformance.map((campaign) => (
                    <tr key={campaign.id}>
                      <td>
                        <Link to={`/campaigns/${campaign.id}`} className="font-medium text-foreground hover:text-primary">
                          {campaign.name}
                        </Link>
                      </td>
                      <td>
                        <StatusBadge status={campaign.status} />
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <ProgressBar value={campaign.progress} className="flex-1" label={`${campaign.name} progress`} />
                          <span className="num w-10 shrink-0 text-right text-xs text-muted-foreground">
                            {Math.round(campaign.progress)}%
                          </span>
                        </div>
                      </td>
                      <td className="num text-right">{campaign.sent}</td>
                      <td className="num text-right">{campaign.replies}</td>
                      <td className="num text-right">{pct(campaign.replyRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Reply intent" subtitle="How prospects are responding" />
          <CardBody>
            <DistributionChart
              data={(data?.aiInsights.byIntent ?? [])
                .filter((i) => i.count > 0)
                .slice(0, 6)
                .map((i) => ({ name: i.intent.replace(/_/g, ' ').toLowerCase(), value: i.count }))}
              caption="Reply intent distribution"
            />
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title="Mailbox performance"
            subtitle="Volume and daily quota per connected mailbox"
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/email-accounts">
                  Manage <ArrowUpRight />
                </Link>
              </Button>
            }
          />
          {!data?.mailboxPerformance.length ? (
            <EmptyState
              compact
              icon={Inbox}
              title="No mailboxes connected"
              description="Add a mailbox to start sending and receiving."
              action={
                <Button variant="primary" asChild>
                  <Link to="/email-accounts">Add mailbox</Link>
                </Button>
              }
            />
          ) : (
            <CardBody className="space-y-3">
              {data.mailboxPerformance.map((mailbox) => (
                <div key={mailbox.id} className="rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs text-foreground">{mailbox.email}</span>
                    <StatusBadge status={mailbox.connection} dot />
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <ProgressBar
                      value={(mailbox.sentToday / Math.max(1, mailbox.dailyLimit)) * 100}
                      tone={mailbox.sentToday / Math.max(1, mailbox.dailyLimit) > 0.85 ? 'warning' : 'primary'}
                      className="flex-1"
                      label={`${mailbox.email} daily quota`}
                    />
                    <span className="num shrink-0 text-2xs text-muted-foreground">
                      {mailbox.sentToday} / {mailbox.dailyLimit} today
                    </span>
                  </div>
                  <p className="num mt-1.5 text-2xs text-muted-foreground">
                    {mailbox.sent} thread(s) · {mailbox.replies} with replies
                  </p>
                </div>
              ))}
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader
            title="Recent activity"
            subtitle="Latest automation events"
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link to="/automation/logs">
                  All logs <ArrowUpRight />
                </Link>
              </Button>
            }
          />
          <CardBody className="space-y-2.5">
            {!data?.recentActivity.length ? (
              <p className="py-6 text-center text-xs text-muted-foreground">Nothing has run yet.</p>
            ) : (
              data.recentActivity.map((entry) => (
                <div key={entry.id} className="flex items-start gap-2.5 border-b border-border/60 pb-2.5 last:border-0 last:pb-0">
                  <StatusBadge status={entry.status} className="mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{entry.action.replace(/[._]/g, ' ')}</p>
                    {entry.message ? (
                      <p className="mt-0.5 line-clamp-2 text-2xs leading-snug text-muted-foreground">{entry.message}</p>
                    ) : null}
                    <p className="mt-0.5 text-2xs text-muted-foreground">{relative(entry.createdAt)}</p>
                  </div>
                </div>
              ))
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
