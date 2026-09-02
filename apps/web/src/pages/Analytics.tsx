import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';
import { api } from '@/lib/api';
import { pct } from '@/lib/utils';
import { Badge, Card, CardBody, CardHeader, StatusBadge } from '@/components/ui/primitives';
import { EmptyState, KpiCard, PageHeader } from '@/components/ui/data';
import { SegmentedControl } from '@/components/ui/controls';
import { ComparisonBarChart, DistributionChart, TrendChart } from '@/components/charts';

export function AnalyticsPage() {
  const [days, setDays] = React.useState<'7' | '30' | '90'>('30');

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => api.get<any>(`/dashboard/analytics?days=${days}`),
    refetchInterval: 60_000,
  });

  const totals = React.useMemo(() => {
    const timeline = data?.timeline ?? [];
    return timeline.reduce(
      (acc: any, row: any) => ({
        sent: acc.sent + (row.sent ?? 0),
        replies: acc.replies + (row.replies ?? 0),
        bounces: acc.bounces + (row.bounces ?? 0),
        drafts: acc.drafts + (row.drafts ?? 0),
        failed: acc.failed + (row.failed ?? 0),
      }),
      { sent: 0, replies: 0, bounces: 0, drafts: 0, failed: 0 },
    );
  }, [data]);

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Analytics"
        description="Performance across campaigns, mailboxes and AI-assisted replies."
        actions={
          <SegmentedControl
            value={days}
            onChange={setDays}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
            ]}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Sent" value={totals.sent} tone="primary" loading={isLoading} />
        <KpiCard label="Replies" value={totals.replies} hint={`${pct((totals.replies / Math.max(1, totals.sent)) * 100)} reply rate`} tone="success" loading={isLoading} />
        <KpiCard label="Bounces" value={totals.bounces} hint={`${pct((totals.bounces / Math.max(1, totals.sent)) * 100)} bounce rate`} tone={totals.bounces ? 'danger' : 'neutral'} loading={isLoading} />
        <KpiCard label="Drafts" value={totals.drafts} loading={isLoading} />
        <KpiCard label="Failed" value={totals.failed} tone={totals.failed ? 'warning' : 'neutral'} loading={isLoading} />
      </div>

      <Card>
        <CardHeader title="Volume over time" subtitle="Everything the workers processed, by day" />
        <CardBody>
          <TrendChart
            height={300}
            data={data?.timeline ?? []}
            series={[
              { key: 'sent', label: 'Sent', colorIndex: 0 },
              { key: 'replies', label: 'Replies', colorIndex: 4 },
              { key: 'drafts', label: 'Drafts', colorIndex: 1 },
              { key: 'bounces', label: 'Bounces', colorIndex: 2 },
            ]}
            caption="Daily volume"
          />
        </CardBody>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Campaign comparison" subtitle="Sends and replies side by side" />
          <CardBody>
            {!data?.campaigns?.length ? (
              <EmptyState compact icon={BarChart3} title="No campaign data" description="Analytics appear once a campaign starts sending." />
            ) : (
              <ComparisonBarChart
                data={data.campaigns.slice(0, 8)}
                categoryKey="name"
                layout="vertical"
                height={Math.max(220, Math.min(8, data.campaigns.length) * 46)}
                series={[
                  { key: 'sent', label: 'Sent', colorIndex: 0 },
                  { key: 'replies', label: 'Replies', colorIndex: 4 },
                  { key: 'bounces', label: 'Bounces', colorIndex: 2 },
                ]}
                caption="Campaign comparison"
              />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Contact status" subtitle="Where every contact currently sits" />
          <CardBody>
            <DistributionChart
              data={(data?.contactStatus ?? [])
                .filter((row: any) => row.count > 0)
                .map((row: any) => ({ name: row.status.replace(/_/g, ' ').toLowerCase(), value: row.count }))}
              caption="Contact status distribution"
            />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Campaign detail" subtitle="Reply and bounce rate per campaign" />
        {!data?.campaigns?.length ? (
          <EmptyState compact title="Nothing to compare yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Campaign</th>
                  <th scope="col" className="w-28">Status</th>
                  <th scope="col" className="w-20 text-right">Sent</th>
                  <th scope="col" className="w-20 text-right">Replies</th>
                  <th scope="col" className="w-24 text-right">Reply rate</th>
                  <th scope="col" className="w-20 text-right">Bounces</th>
                  <th scope="col" className="w-24 text-right">Bounce rate</th>
                </tr>
              </thead>
              <tbody>
                {data.campaigns.map((campaign: any) => (
                  <tr key={campaign.id}>
                    <td className="truncate font-medium text-foreground">{campaign.name}</td>
                    <td><StatusBadge status={campaign.status} /></td>
                    <td className="num text-right">{campaign.sent}</td>
                    <td className="num text-right">{campaign.replies}</td>
                    <td className="num text-right">
                      <Badge tone={campaign.replyRate >= 10 ? 'success' : campaign.replyRate >= 3 ? 'info' : 'neutral'}>
                        {pct(campaign.replyRate)}
                      </Badge>
                    </td>
                    <td className="num text-right">{campaign.bounces}</td>
                    <td className="num text-right">
                      <Badge tone={campaign.bounceRate > 5 ? 'danger' : 'neutral'}>{pct(campaign.bounceRate)}</Badge>
                    </td>
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
