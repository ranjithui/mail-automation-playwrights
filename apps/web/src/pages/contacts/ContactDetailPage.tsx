import * as React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Mail, MessageSquare, Save, Sparkles } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { fullDateTime, initialsOf, relative } from '@/lib/utils';
import { Avatar, Badge, Button, Card, CardBody, CardHeader, Field, Input, Spinner, StatusBadge, Textarea } from '@/components/ui/primitives';
import { EmptyState, ErrorState, PageHeader } from '@/components/ui/data';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { RoleGate } from '@/hooks/use-session';

const TIMELINE_TONES: Record<string, 'primary' | 'success' | 'danger' | 'warning' | 'neutral'> = {
  CONTACT_ADDED: 'neutral',
  SENT: 'primary',
  DRAFT_CREATED: 'neutral',
  REPLY_RECEIVED: 'success',
  BOUNCED: 'danger',
  UNSUBSCRIBED: 'danger',
  FAILED: 'danger',
  SKIPPED: 'warning',
  OPENED: 'primary',
};

export function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [notes, setNotes] = React.useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api.get<any>(`/contacts/${id}`),
    enabled: Boolean(id),
  });

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch(`/contacts/${id}`, patch),
    onSuccess: () => {
      toast.success('Contact updated');
      void queryClient.invalidateQueries({ queryKey: ['contact', id] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Update failed'),
  });

  if (error) return <div className="p-6"><ErrorState error={error} onRetry={() => void refetch()} /></div>;
  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  const name = [data.firstName, data.lastName].filter(Boolean).join(' ') || data.email;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={name}
        breadcrumb={
          <Link to="/contacts" className="hover:text-foreground">
            ← Contacts
          </Link>
        }
        description={[data.title, data.companyName].filter(Boolean).join(' · ') || undefined}
        actions={<StatusBadge status={data.status} dot />}
      />

      <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardBody className="space-y-4">
              <div className="flex items-center gap-3">
                <Avatar initials={initialsOf(data.firstName, data.lastName, data.email)} className="size-11 text-sm" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                  <a href={`mailto:${data.email}`} className="block truncate font-mono text-2xs text-primary hover:underline">
                    {data.email}
                  </a>
                </div>
              </div>

              <dl className="space-y-2 text-xs">
                {[
                  ['Title', data.title],
                  ['Phone', data.corporatePhone],
                  ['Industry', data.industry],
                  ['Employees', data.employees],
                  ['Qualification', data.qualifyContact],
                  ['Last contacted', data.lastContactedAt ? relative(data.lastContactedAt) : null],
                  ['Last replied', data.lastRepliedAt ? relative(data.lastRepliedAt) : null],
                ]
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label as string} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="truncate text-right font-medium text-foreground">{value as string}</dd>
                    </div>
                  ))}
              </dl>

              {data.tags?.length ? (
                <div className="flex flex-wrap gap-1">
                  {data.tags.map((tag: string) => (
                    <Badge key={tag} tone="outline">
                      {tag}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Company" />
            <CardBody className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <Building2 className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="font-medium text-foreground">{data.companyName ?? '—'}</span>
              </div>
              {[
                ['Website', data.website],
                ['Address', data.companyAddress],
                ['City', data.companyCity],
                ['State', data.companyState],
                ['Country', data.companyCountry],
              ]
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label as string} className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="truncate text-right text-foreground">{value as string}</span>
                  </div>
                ))}
              {data.companyLinkedinUrl || data.personLinkedinUrl ? (
                <div className="flex gap-2 pt-1">
                  {data.personLinkedinUrl ? (
                    <a href={data.personLinkedinUrl} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
                      Person LinkedIn
                    </a>
                  ) : null}
                  {data.companyLinkedinUrl ? (
                    <a href={data.companyLinkedinUrl} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
                      Company LinkedIn
                    </a>
                  ) : null}
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Notes" />
            <CardBody className="space-y-2">
              <Textarea
                rows={5}
                value={notes ?? data.notes ?? ''}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Context worth remembering about this contact…"
              />
              <RoleGate minimum="USER">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => save.mutate({ notes: notes ?? '' })}
                  loading={save.isPending}
                  disabled={notes === null}
                >
                  <Save /> Save note
                </Button>
              </RoleGate>
            </CardBody>
          </Card>
        </div>

        <Tabs defaultValue="timeline">
          <TabsList>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="threads">Threads</TabsTrigger>
            <TabsTrigger value="fields">All fields</TabsTrigger>
          </TabsList>

          <TabsContent value="timeline">
            <Card>
              <CardHeader title="Contact timeline" subtitle="Every automation event, newest first" />
              <CardBody>
                {!data.timeline?.length ? (
                  <EmptyState compact title="Nothing yet" description="Events appear once this contact enters a campaign." />
                ) : (
                  <ol className="relative space-y-4 border-l border-border pl-5">
                    {data.timeline.map((event: any) => (
                      <li key={event.id} className="relative">
                        <span
                          className={`absolute -left-[1.4rem] top-1 size-2.5 rounded-full ring-4 ring-surface bg-${TIMELINE_TONES[event.type] ?? 'neutral'}`}
                          style={{ backgroundColor: 'currentColor' }}
                          aria-hidden
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={TIMELINE_TONES[event.type] ?? 'neutral'}>{event.label}</Badge>
                          {event.campaignName ? <span className="text-2xs text-muted-foreground">{event.campaignName}</span> : null}
                          {event.detail ? <span className="text-2xs text-muted-foreground">· {event.detail}</span> : null}
                        </div>
                        <p className="mt-0.5 text-2xs text-muted-foreground">{fullDateTime(event.createdAt)}</p>
                      </li>
                    ))}
                  </ol>
                )}
              </CardBody>
            </Card>
          </TabsContent>

          <TabsContent value="campaigns">
            {!data.campaigns?.length ? (
              <EmptyState icon={Sparkles} title="Not in any campaign" description="Add this contact to a list, then attach the list to a campaign." />
            ) : (
              <div className="space-y-2">
                {data.campaigns.map((campaign: any) => (
                  <Card key={campaign.id}>
                    <CardBody className="flex flex-wrap items-center gap-3">
                      <Link to={`/campaigns/${campaign.id}`} className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground hover:text-primary">
                        {campaign.name}
                      </Link>
                      <StatusBadge status={campaign.campaignStatus} />
                      <StatusBadge status={campaign.status} />
                      <Badge tone="outline">Step {campaign.currentStep}</Badge>
                      <span className="text-2xs text-muted-foreground">
                        {campaign.repliedAt ? `replied ${relative(campaign.repliedAt)}` : campaign.nextStepAt ? `next ${relative(campaign.nextStepAt)}` : 'no next step'}
                      </span>
                    </CardBody>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="threads">
            {!data.threads?.length ? (
              <EmptyState icon={MessageSquare} title="No conversations" description="Threads appear once an email is sent to this contact." />
            ) : (
              <div className="space-y-2">
                {data.threads.map((thread: any) => (
                  <Link
                    key={thread.id}
                    to={`/inbox?thread=${thread.id}`}
                    className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-surface p-3 transition-colors hover:bg-muted"
                  >
                    <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{thread.subject}</span>
                    <StatusBadge status={thread.status} />
                    <span className="shrink-0 text-2xs text-muted-foreground">{relative(thread.lastMessageAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="fields">
            <Card>
              <CardHeader title="All fields" subtitle="Everything available as a template variable" />
              <CardBody>
                <dl className="grid gap-2 text-xs sm:grid-cols-2">
                  {Object.entries({
                    'First Name': data.firstName,
                    'Last Name': data.lastName,
                    Title: data.title,
                    'Company Name': data.companyName,
                    Email: data.email,
                    'Corporate Phone': data.corporatePhone,
                    Employees: data.employees,
                    Industry: data.industry,
                    Keywords: data.keywords,
                    'Person Linkedin Url': data.personLinkedinUrl,
                    Website: data.website,
                    'Company Linkedin Url': data.companyLinkedinUrl,
                    'Company Address': data.companyAddress,
                    'Company City': data.companyCity,
                    'Company State': data.companyState,
                    'Company Country': data.companyCountry,
                    'Qualify Contact': data.qualifyContact,
                    ...(data.custom ?? {}),
                  }).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-3 rounded border border-border px-3 py-2">
                      <dt className="font-mono text-2xs text-muted-foreground">{`{{${key}}}`}</dt>
                      <dd className="truncate text-right text-foreground">{(value as string) || '—'}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
