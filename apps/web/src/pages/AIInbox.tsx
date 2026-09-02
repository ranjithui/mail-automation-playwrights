import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Bot, CalendarClock, Clock, DollarSign, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Paginated, ThreadListItem } from '@mail/shared';
import { api } from '@/lib/api';
import { cn, mailTime } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, StatusBadge } from '@/components/ui/primitives';
import { EmptyState, KpiCard, PageHeader } from '@/components/ui/data';
import { DistributionChart } from '@/components/charts';

const BUCKETS = [
  { key: 'attention', label: 'Requires attention', icon: AlertCircle, query: 'priority=HIGH', tone: 'danger' as const, hint: 'High-priority replies nobody has read yet.' },
  { key: 'pricing', label: 'Pricing requests', icon: DollarSign, query: 'intent=ASKING_PRICING', tone: 'primary' as const, hint: 'Prospects asking what it costs.' },
  { key: 'meeting', label: 'Meeting requests', icon: CalendarClock, query: 'intent=MEETING_REQUEST', tone: 'primary' as const, hint: 'People who want time in the calendar.' },
  { key: 'interested', label: 'Interested', icon: ThumbsUp, query: 'intent=INTERESTED', tone: 'success' as const, hint: 'Positive signals worth acting on quickly.' },
  { key: 'not-interested', label: 'Not interested', icon: ThumbsDown, query: 'intent=NOT_INTERESTED', tone: 'neutral' as const, hint: 'Closed out — follow-ups already cancelled.' },
  { key: 'waiting', label: 'Waiting for response', icon: Clock, query: 'folder=WAITING', tone: 'warning' as const, hint: 'Sent, no answer yet.' },
];

export function AIInboxPage() {
  const [active, setActive] = React.useState(BUCKETS[0]);

  const { data: counts } = useQuery({
    queryKey: ['inbox-counts'],
    queryFn: () => api.get<any>('/inbox/counts'),
    refetchInterval: 45_000,
  });

  const { data: analytics } = useQuery({
    queryKey: ['ai-analytics'],
    queryFn: () => api.get<any>('/ai/analytics'),
  });

  const { data: threads, isLoading } = useQuery({
    queryKey: ['inbox', 'ai', active.query],
    queryFn: () => api.get<Paginated<ThreadListItem>>(`/inbox?pageSize=25&${active.query}`),
  });

  const countFor = (key: string) => {
    const smart = counts?.smart ?? {};
    return (
      {
        attention: smart.requiresAttention,
        pricing: smart.pricingRequests,
        meeting: smart.meetingRequests,
        interested: smart.interested,
        'not-interested': smart.notInterested,
        waiting: smart.waitingForResponse,
      }[key] ?? 0
    );
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="AI inbox"
        description="Replies grouped by what the sender actually wants, so the highest-value conversations surface first."
        actions={
          <Button variant="outline" asChild>
            <Link to="/settings">AI settings</Link>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Messages analysed" value={analytics?.analyzed ?? 0} icon={Bot} tone="primary" />
        <KpiCard label="Replies suggested" value={analytics?.suggestionsGenerated ?? 0} />
        <KpiCard label="Suggestions sent" value={analytics?.suggestionsSent ?? 0} tone="success" />
        <KpiCard label="Needs attention" value={counts?.smart?.requiresAttention ?? 0} tone="danger" icon={AlertCircle} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[280px_1fr_320px]">
        <nav className="space-y-1.5" aria-label="Smart inbox buckets">
          {BUCKETS.map((bucket) => {
            const Icon = bucket.icon;
            const count = countFor(bucket.key);
            return (
              <button
                key={bucket.key}
                type="button"
                onClick={() => setActive(bucket)}
                className={cn(
                  'flex w-full cursor-pointer items-start gap-2.5 rounded-md border p-3 text-left transition-colors',
                  active.key === bucket.key ? 'border-primary bg-primary-muted' : 'border-border bg-surface hover:bg-muted',
                )}
              >
                <Icon className={cn('mt-0.5 size-4 shrink-0', active.key === bucket.key ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground">{bucket.label}</span>
                    <Badge tone={count ? bucket.tone : 'neutral'} className="num ml-auto">
                      {count}
                    </Badge>
                  </span>
                  <span className="mt-0.5 block text-2xs leading-snug text-muted-foreground">{bucket.hint}</span>
                </span>
              </button>
            );
          })}
        </nav>

        <Card>
          <CardHeader title={active.label} subtitle={active.hint} />
          {isLoading ? (
            <CardBody className="space-y-3">
              {Array.from({ length: 5 }).map((_, index) => (
                <div key={index} className="skeleton h-12" />
              ))}
            </CardBody>
          ) : !threads?.items.length ? (
            <EmptyState compact icon={Bot} title="Nothing in this bucket" description="Conversations land here as soon as the AI worker classifies them." />
          ) : (
            <ul className="divide-y divide-border">
              {threads.items.map((thread) => (
                <li key={thread.id}>
                  <Link
                    to={`/inbox?thread=${thread.id}`}
                    className="block cursor-pointer px-4 py-3 transition-colors hover:bg-muted"
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-medium text-foreground">
                        {thread.contact?.name ?? thread.participants[0]}
                      </span>
                      {thread.contact?.companyName ? (
                        <span className="truncate text-2xs text-muted-foreground">{thread.contact.companyName}</span>
                      ) : null}
                      <span className="num ml-auto shrink-0 text-2xs text-muted-foreground">{mailTime(thread.lastMessageAt)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-foreground">{thread.subject}</p>
                    {thread.snippet ? <p className="mt-0.5 line-clamp-2 text-2xs text-muted-foreground">{thread.snippet}</p> : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {thread.ai?.intent ? <StatusBadge status={thread.ai.intent} /> : null}
                      {thread.ai?.priority ? <StatusBadge status={thread.ai.priority} /> : null}
                      {thread.campaign ? <Badge tone="outline">{thread.campaign.name}</Badge> : null}
                      {thread.ai?.hasSuggestion ? (
                        <Badge tone="success">
                          <Bot className="size-2.5" /> AI reply ready
                        </Badge>
                      ) : null}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Intent breakdown" subtitle="Across every analysed reply" />
          <CardBody>
            <DistributionChart
              data={(analytics?.byIntent ?? [])
                .filter((item: any) => item.count > 0)
                .map((item: any) => ({ name: item.intent.replace(/_/g, ' ').toLowerCase(), value: item.count }))}
              caption="Reply intent breakdown"
            />

            <div className="mt-4 space-y-1.5 border-t border-border pt-3">
              <p className="text-xs font-medium text-foreground">Priority</p>
              {(analytics?.byPriority ?? []).map((item: any) => (
                <div key={item.priority} className="flex items-center justify-between text-xs">
                  <StatusBadge status={item.priority} />
                  <span className="num text-muted-foreground">{item.count}</span>
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
