import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardList,
  CopyPlus,
  FlaskConical,
  GripVertical,
  Mail,
  Rocket,
  Trash2,
  Users,
} from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { WEEKDAYS, TIMEZONES, cn } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Textarea } from '@/components/ui/primitives';
import { Checkbox, SegmentedControl, Select, Switch } from '@/components/ui/controls';
import { EmptyState, PageHeader } from '@/components/ui/data';

interface WizardState {
  name: string;
  description: string;
  emailAccountId: string;
  contactListId: string;
  mode: 'SEND' | 'DRAFT_ONLY';
  timezone: string;
  sendWindowStart: string;
  sendWindowEnd: string;
  sendDays: number[];
  sendImmediately: boolean;
  dailyLimit: number;
  minDelaySec: number;
  maxDelaySec: number;
  randomDelay: boolean;
  stopOnReply: boolean;
}

interface StepDraft {
  id?: string;
  key: string;
  name: string;
  templateId: string;
  delayDays: number;
  delayHours: number;
  replyInThread: boolean;
  enabled: boolean;
}

const STEPS = [
  { id: 1, label: 'Campaign', hint: 'Name and intent' },
  { id: 2, label: 'Mailbox', hint: 'Who sends' },
  { id: 3, label: 'Contacts', hint: 'Who receives' },
  { id: 4, label: 'Sequence', hint: 'What is sent' },
  { id: 5, label: 'Schedule', hint: 'When it sends' },
  { id: 6, label: 'Review', hint: 'Check everything' },
  { id: 7, label: 'Test', hint: 'Draft one email' },
  { id: 8, label: 'Launch', hint: 'Go live' },
];

const DEFAULTS: WizardState = {
  name: '',
  description: '',
  emailAccountId: '',
  contactListId: '',
  mode: 'SEND',
  timezone: 'Asia/Kolkata',
  sendWindowStart: '09:30',
  sendWindowEnd: '17:30',
  sendDays: [1, 2, 3, 4, 5],
  sendImmediately: false,
  dailyLimit: 100,
  minDelaySec: 30,
  maxDelaySec: 60,
  randomDelay: true,
  stopOnReply: true,
};

let stepCounter = 0;
const newStepKey = () => `step-${(stepCounter += 1)}`;

export function CampaignWizardPage() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [current, setCurrent] = React.useState(1);
  const [campaignId, setCampaignId] = React.useState<string | null>(params.id ?? null);
  const [state, setState] = React.useState<WizardState>(DEFAULTS);
  const [steps, setSteps] = React.useState<StepDraft[]>([
    { key: newStepKey(), name: 'Initial email', templateId: '', delayDays: 0, delayHours: 0, replyInThread: false, enabled: true },
  ]);
  const [testResult, setTestResult] = React.useState<string | null>(null);

  const set = <K extends keyof WizardState>(key: K, value: WizardState[K]) =>
    setState((prev) => ({ ...prev, [key]: value }));

  const { data: mailboxes } = useQuery({
    queryKey: ['email-accounts'],
    queryFn: () => api.get<Array<{ id: string; email: string; displayName: string; connection: string; dailyLimit: number; sentToday: number }>>('/email-accounts'),
  });

  const { data: lists } = useQuery({
    queryKey: ['contact-lists'],
    queryFn: () => api.get<Array<{ id: string; name: string; contactCount: number }>>('/contacts/lists'),
  });

  const { data: templates } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<Array<{ id: string; name: string; subject: string; category: string }>>('/templates'),
  });

  // Editing an existing campaign hydrates the wizard from the server.
  const { data: existing } = useQuery({
    queryKey: ['campaign', params.id],
    queryFn: () => api.get<any>(`/campaigns/${params.id}`),
    enabled: Boolean(params.id),
  });

  React.useEffect(() => {
    if (!existing) return;
    setState({
      name: existing.name,
      description: existing.description ?? '',
      emailAccountId: existing.emailAccountId ?? '',
      contactListId: existing.contactListId ?? '',
      mode: existing.mode,
      timezone: existing.timezone,
      sendWindowStart: existing.sendWindowStart,
      sendWindowEnd: existing.sendWindowEnd,
      sendDays: existing.sendDays ?? [1, 2, 3, 4, 5],
      sendImmediately: existing.sendImmediately ?? false,
      dailyLimit: existing.dailyLimit,
      minDelaySec: existing.minDelaySec,
      maxDelaySec: existing.maxDelaySec,
      randomDelay: existing.randomDelay,
      stopOnReply: existing.stopOnReply,
    });
    setSteps(
      (existing.steps ?? []).map((s: any) => ({
        id: s.id,
        key: s.id,
        name: s.name,
        templateId: s.templateId ?? '',
        delayDays: s.delayDays,
        delayHours: s.delayHours,
        replyInThread: s.replyInThread,
        enabled: s.enabled,
      })),
    );
  }, [existing]);

  const saveCampaign = useMutation({
    mutationFn: async () => {
      const payload = { ...state, emailAccountId: state.emailAccountId || null, contactListId: state.contactListId || null };
      if (campaignId) {
        await api.patch(`/campaigns/${campaignId}`, payload);
        return campaignId;
      }
      const created = await api.post<{ id: string }>('/campaigns', payload);
      setCampaignId(created.id);
      return created.id;
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save campaign'),
  });

  const saveSteps = useMutation({
    mutationFn: async (id: string) =>
      api.put(`/campaigns/${id}/steps`, {
        steps: steps.map((step, index) => ({
          id: step.id,
          name: step.name,
          type: index === 0 ? 'INITIAL' : 'FOLLOWUP',
          templateId: step.templateId || null,
          delayDays: step.delayDays,
          delayHours: step.delayHours,
          replyInThread: step.replyInThread,
          enabled: step.enabled,
        })),
      }),
  });

  const attachContacts = useMutation({
    mutationFn: (id: string) => api.post<{ added: number; skipped: number }>(`/campaigns/${id}/contacts`, { listId: state.contactListId }),
  });

  const runTest = useMutation({
    mutationFn: (id: string) => api.post<{ queued: number }>(`/campaigns/${id}/test`, { target: 'FIRST_CONTACT' }),
    onSuccess: (data) => {
      setTestResult(`Queued ${data.queued} draft. Watch Automation → Running jobs, then check the mailbox.`);
      toast.success('Test draft queued');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Test failed'),
  });

  const launch = useMutation({
    mutationFn: (id: string) => api.post(`/campaigns/${id}/start`, {}),
    onSuccess: () => {
      toast.success('Campaign launched');
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
      navigate(`/campaigns/${campaignId}`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not launch'),
  });

  const selectedList = lists?.find((l) => l.id === state.contactListId);
  const selectedMailbox = mailboxes?.find((m) => m.id === state.emailAccountId);

  const validate = (step: number): string | null => {
    if (step === 1 && state.name.trim().length < 2) return 'Give the campaign a name';
    if (step === 2 && !state.emailAccountId) return 'Choose a mailbox to send from';
    if (step === 3 && !state.contactListId) return 'Choose a contact list';
    if (step === 4) {
      if (!steps.length) return 'Add at least one step';
      if (steps.some((s) => !s.name.trim())) return 'Every step needs a name';
      if (!steps.some((s) => s.enabled)) return 'Enable at least one step';
    }
    if (step === 5) {
      if (!state.sendDays.length) return 'Pick at least one sending day';
      if (state.maxDelaySec < state.minDelaySec) return 'Maximum delay must be at least the minimum';
    }
    return null;
  };

  const goNext = async () => {
    const problem = validate(current);
    if (problem) {
      toast.error(problem);
      return;
    }

    // Persist progressively so a half-finished wizard is never lost.
    if (current <= 5) {
      const id = await saveCampaign.mutateAsync();
      if (current === 4) await saveSteps.mutateAsync(id);
      if (current === 3) {
        const result = await attachContacts.mutateAsync(id);
        toast.success(`${result.added} contact(s) added${result.skipped ? `, ${result.skipped} skipped` : ''}`);
      }
    }
    setCurrent((step) => Math.min(8, step + 1));
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title={params.id ? 'Edit campaign' : 'New campaign'}
        description="Eight steps from a contact list to a live sequence."
        breadcrumb={
          <Link to="/campaigns" className="hover:text-foreground">
            ← Back to campaigns
          </Link>
        }
      />

      <WizardProgress current={current} onSelect={(step) => step < current && setCurrent(step)} />

      <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader
            title={`Step ${current} — ${STEPS[current - 1].label}`}
            subtitle={STEPS[current - 1].hint}
          />
          <CardBody className="space-y-5">
            {current === 1 ? (
              <>
                <Field label="Campaign name" htmlFor="name" required hint="Shown throughout the app and in activity logs.">
                  <Input
                    id="name"
                    value={state.name}
                    onChange={(event) => set('name', event.target.value)}
                    placeholder="SaaS Outreach — Q3"
                  />
                </Field>
                <Field label="Description" htmlFor="description" hint="Optional. Useful when several people share the workspace.">
                  <Textarea
                    id="description"
                    rows={3}
                    value={state.description}
                    onChange={(event) => set('description', event.target.value)}
                    placeholder="Decision makers at mid-market SaaS companies."
                  />
                </Field>
                <Field label="Sending mode" hint="Draft only writes messages into the mailbox without sending them.">
                  <SegmentedControl
                    value={state.mode}
                    onChange={(value) => set('mode', value)}
                    options={[
                      { value: 'SEND', label: 'Send automatically' },
                      { value: 'DRAFT_ONLY', label: 'Create drafts only' },
                    ]}
                  />
                </Field>
              </>
            ) : null}

            {current === 2 ? (
              !mailboxes?.length ? (
                <EmptyState
                  compact
                  icon={Mail}
                  title="No mailboxes yet"
                  description="Add a mailbox before you can send anything."
                  action={
                    <Button variant="primary" asChild>
                      <Link to="/email-accounts">Add a mailbox</Link>
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-2">
                  {mailboxes.map((mailbox) => (
                    <button
                      key={mailbox.id}
                      type="button"
                      onClick={() => set('emailAccountId', mailbox.id)}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors',
                        state.emailAccountId === mailbox.id
                          ? 'border-primary bg-primary-muted'
                          : 'border-border hover:bg-muted',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-foreground">{mailbox.displayName}</span>
                        <span className="block truncate font-mono text-2xs text-muted-foreground">{mailbox.email}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone={mailbox.connection === 'CONNECTED' ? 'success' : 'neutral'}>
                          {mailbox.connection.toLowerCase()}
                        </Badge>
                        <span className="num text-2xs text-muted-foreground">
                          {mailbox.sentToday}/{mailbox.dailyLimit}
                        </span>
                        {state.emailAccountId === mailbox.id ? <Check className="size-4 text-primary" /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              )
            ) : null}

            {current === 3 ? (
              !lists?.length ? (
                <EmptyState
                  compact
                  icon={Users}
                  title="No contact lists"
                  description="Import a CSV or XLSX first, then come back."
                  action={
                    <Button variant="primary" asChild>
                      <Link to="/contacts">Import contacts</Link>
                    </Button>
                  }
                />
              ) : (
                <div className="space-y-2">
                  {lists.map((list) => (
                    <button
                      key={list.id}
                      type="button"
                      onClick={() => set('contactListId', list.id)}
                      className={cn(
                        'flex w-full cursor-pointer items-center justify-between gap-3 rounded-md border p-3 text-left transition-colors',
                        state.contactListId === list.id ? 'border-primary bg-primary-muted' : 'border-border hover:bg-muted',
                      )}
                    >
                      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{list.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Badge tone="outline" className="num">
                          {list.contactCount} contacts
                        </Badge>
                        {state.contactListId === list.id ? <Check className="size-4 text-primary" /> : null}
                      </span>
                    </button>
                  ))}
                  <p className="pt-1 text-xs text-muted-foreground">
                    Suppressed and opted-out addresses are filtered out automatically when the list is attached.
                  </p>
                </div>
              )
            ) : null}

            {current === 4 ? (
              <SequenceBuilder steps={steps} setSteps={setSteps} templates={templates ?? []} />
            ) : null}

            {current === 5 ? (
              <div className="space-y-5">
                <div className="rounded-md border border-border p-3">
                  <Switch
                    id="sendImmediately"
                    checked={state.sendImmediately}
                    onCheckedChange={(value) => {
                      set('sendImmediately', value);
                      // Immediate means immediate: a long inter-send gap would
                      // defeat the point, so tighten it when switching on.
                      if (value && state.minDelaySec > 15) {
                        set('minDelaySec', 5);
                        set('maxDelaySec', 10);
                      }
                    }}
                    label="Send immediately, ignore the sending window"
                    description="Dispatch as soon as the campaign starts, at any hour and on any day. Suppression, daily limit and reply checks still apply."
                  />
                </div>

                <div className={cn('grid gap-4 sm:grid-cols-2', state.sendImmediately && 'opacity-50')}>
                  <Field label="Timezone" hint="Sending window is evaluated in this timezone.">
                    <Select
                      value={state.timezone}
                      onValueChange={(value) => set('timezone', value)}
                      options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
                    />
                  </Field>
                  <Field label="Daily limit" hint="Maximum messages queued per day for this campaign.">
                    <Input
                      type="number"
                      min={1}
                      value={state.dailyLimit}
                      onChange={(event) => set('dailyLimit', Number(event.target.value))}
                    />
                  </Field>
                  <Field label="Window start">
                    <Input value={state.sendWindowStart} onChange={(event) => set('sendWindowStart', event.target.value)} placeholder="09:30" />
                  </Field>
                  <Field label="Window end">
                    <Input value={state.sendWindowEnd} onChange={(event) => set('sendWindowEnd', event.target.value)} placeholder="17:30" />
                  </Field>
                </div>

                <Field label="Sending days" className={cn(state.sendImmediately && 'opacity-50')}>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((day) => {
                      const active = state.sendDays.includes(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() =>
                            set(
                              'sendDays',
                              active ? state.sendDays.filter((d) => d !== day.value) : [...state.sendDays, day.value].sort(),
                            )
                          }
                          className={cn(
                            'cursor-pointer rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                            active ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted',
                          )}
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Minimum delay (seconds)" hint="Gap between consecutive sends.">
                    <Input
                      type="number"
                      min={5}
                      value={state.minDelaySec}
                      onChange={(event) => set('minDelaySec', Number(event.target.value))}
                    />
                  </Field>
                  <Field label="Maximum delay (seconds)">
                    <Input
                      type="number"
                      min={5}
                      value={state.maxDelaySec}
                      onChange={(event) => set('maxDelaySec', Number(event.target.value))}
                    />
                  </Field>
                </div>

                <div className="space-y-3 rounded-md border border-border p-3">
                  <Switch
                    id="randomDelay"
                    checked={state.randomDelay}
                    onCheckedChange={(value) => set('randomDelay', value)}
                    label="Randomise the delay"
                    description="Spread sends unevenly between the minimum and maximum rather than at a fixed cadence."
                  />
                  <Switch
                    id="stopOnReply"
                    checked={state.stopOnReply}
                    onCheckedChange={(value) => set('stopOnReply', value)}
                    label="Stop follow-ups when someone replies"
                    description="Strongly recommended. Pending steps are cancelled the moment a reply is detected."
                  />
                </div>
              </div>
            ) : null}

            {current === 6 ? (
              <ReviewPanel
                state={state}
                steps={steps}
                mailbox={selectedMailbox}
                list={selectedList}
                templates={templates ?? []}
              />
            ) : null}

            {current === 7 ? (
              <div className="space-y-4">
                <div className="rounded-md border border-border bg-muted/40 p-4">
                  <div className="flex items-start gap-3">
                    <FlaskConical className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <div>
                      <p className="text-[13px] font-medium text-foreground">Draft one email before going live</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        This renders step 1 for your first contact and saves it as a draft in the mailbox. Nothing is
                        sent. Open the draft, check the merge fields, then come back and launch.
                      </p>
                    </div>
                  </div>
                </div>

                <Button
                  variant="primary"
                  onClick={() => campaignId && runTest.mutate(campaignId)}
                  loading={runTest.isPending}
                  disabled={!campaignId}
                >
                  <FlaskConical /> Create test draft
                </Button>

                {testResult ? (
                  <p className="rounded-md border border-success/30 bg-success-muted p-3 text-xs text-foreground">{testResult}</p>
                ) : null}
              </div>
            ) : null}

            {current === 8 ? (
              <div className="space-y-4">
                <div className="rounded-md border border-primary/30 bg-primary-muted p-4">
                  <div className="flex items-start gap-3">
                    <Rocket className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <div>
                      <p className="text-[13px] font-medium text-foreground">Ready to launch</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        The scheduler will queue step 1 for every contact inside the sending window, spaced by your
                        configured delay. You can pause or stop at any time and pending work stops immediately.
                      </p>
                    </div>
                  </div>
                </div>

                <dl className="grid gap-2 text-xs sm:grid-cols-2">
                  {[
                    ['Contacts', selectedList ? `${selectedList.contactCount} in ${selectedList.name}` : '—'],
                    ['Mailbox', selectedMailbox?.email ?? '—'],
                    ['Steps', `${steps.filter((s) => s.enabled).length} enabled`],
                    ['Window', state.sendImmediately ? 'Immediate (window ignored)' : `${state.sendWindowStart}–${state.sendWindowEnd} ${state.timezone}`],
                    ['Daily limit', `${state.dailyLimit} per day`],
                    ['Mode', state.mode === 'SEND' ? 'Send automatically' : 'Create drafts only'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between rounded border border-border px-3 py-2">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="font-medium text-foreground">{value}</dd>
                    </div>
                  ))}
                </dl>

                <Button
                  variant="accent"
                  size="lg"
                  className="w-full"
                  onClick={() => campaignId && launch.mutate(campaignId)}
                  loading={launch.isPending}
                  disabled={!campaignId}
                >
                  <Rocket /> Launch campaign
                </Button>
              </div>
            ) : null}
          </CardBody>

          <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <Button variant="outline" onClick={() => setCurrent((s) => Math.max(1, s - 1))} disabled={current === 1}>
              <ArrowLeft /> Back
            </Button>
            <div className="flex items-center gap-2">
              {campaignId ? (
                <Button variant="ghost" size="sm" asChild>
                  <Link to={`/campaigns/${campaignId}`}>Save &amp; exit</Link>
                </Button>
              ) : null}
              {current < 8 ? (
                <Button
                  variant="primary"
                  onClick={() => void goNext()}
                  loading={saveCampaign.isPending || saveSteps.isPending || attachContacts.isPending}
                >
                  Continue <ArrowRight />
                </Button>
              ) : null}
            </div>
          </div>
        </Card>

        <aside className="space-y-4">
          <Card>
            <CardHeader title="Summary" subtitle="Updates as you go" />
            <CardBody className="space-y-2.5 text-xs">
              {[
                ['Name', state.name || '—'],
                ['Mode', state.mode === 'SEND' ? 'Send' : 'Draft only'],
                ['Mailbox', selectedMailbox?.email ?? '—'],
                ['List', selectedList ? `${selectedList.name} (${selectedList.contactCount})` : '—'],
                ['Steps', String(steps.length)],
                ['Window', state.sendImmediately ? 'immediate' : `${state.sendWindowStart}–${state.sendWindowEnd}`],
                ['Timezone', state.timezone],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-3">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="truncate text-right font-medium text-foreground">{value}</span>
                </div>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Before you launch" />
            <CardBody>
              <ul className="space-y-2 text-xs text-muted-foreground">
                {[
                  'Merge fields render correctly on a real contact.',
                  'Follow-ups reply inside the thread rather than starting a new one.',
                  'The sending window matches the recipients’ working hours, not yours.',
                  'The daily limit stays inside your provider’s policy.',
                ].map((tip) => (
                  <li key={tip} className="flex gap-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                    {tip}
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function WizardProgress({ current, onSelect }: { current: number; onSelect: (step: number) => void }) {
  return (
    <ol className="flex gap-1 overflow-x-auto pb-1">
      {STEPS.map((step) => {
        const done = step.id < current;
        const active = step.id === current;
        return (
          <li key={step.id} className="min-w-28 flex-1">
            <button
              type="button"
              onClick={() => onSelect(step.id)}
              disabled={step.id > current}
              className={cn(
                'w-full rounded-md border px-2.5 py-2 text-left transition-colors',
                active
                  ? 'border-primary bg-primary-muted'
                  : done
                    ? 'cursor-pointer border-border bg-surface hover:bg-muted'
                    : 'border-dashed border-border bg-transparent opacity-60',
              )}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold',
                    done ? 'bg-success text-success-foreground' : active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {done ? <Check className="size-2.5" /> : step.id}
                </span>
                <span className={cn('truncate text-2xs font-medium', active ? 'text-primary' : 'text-foreground')}>
                  {step.label}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function SequenceBuilder({
  steps,
  setSteps,
  templates,
}: {
  steps: StepDraft[];
  setSteps: React.Dispatch<React.SetStateAction<StepDraft[]>>;
  templates: Array<{ id: string; name: string; subject: string }>;
}) {
  const update = (key: string, patch: Partial<StepDraft>) =>
    setSteps((prev) => prev.map((step) => (step.key === key ? { ...step, ...patch } : step)));

  const move = (index: number, direction: -1 | 1) => {
    setSteps((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const cumulativeDay = (index: number) =>
    steps.slice(0, index + 1).reduce((sum, step, i) => sum + (i === 0 ? 0 : step.delayDays), 0);

  return (
    <div className="space-y-3">
      {steps.map((step, index) => (
        <div key={step.key} className={cn('rounded-md border p-3', step.enabled ? 'border-border' : 'border-dashed border-border opacity-70')}>
          <div className="flex flex-wrap items-center gap-2">
            <GripVertical className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <Badge tone={index === 0 ? 'primary' : 'neutral'}>
              {index === 0 ? 'Initial' : `Follow-up ${index}`}
            </Badge>
            <Badge tone="outline">Day {cumulativeDay(index)}</Badge>

            <div className="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move step up">
                ↑
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => move(index, 1)}
                disabled={index === steps.length - 1}
                aria-label="Move step down"
              >
                ↓
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Duplicate step"
                onClick={() =>
                  setSteps((prev) => {
                    const copy = { ...prev[index], key: newStepKey(), id: undefined, name: `${prev[index].name} (copy)` };
                    const next = [...prev];
                    next.splice(index + 1, 0, copy);
                    return next;
                  })
                }
              >
                <CopyPlus />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete step"
                disabled={steps.length === 1}
                onClick={() => setSteps((prev) => prev.filter((s) => s.key !== step.key))}
              >
                <Trash2 />
              </Button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Step name">
              <Input value={step.name} onChange={(event) => update(step.key, { name: event.target.value })} />
            </Field>
            <Field label="Template">
              <Select
                value={step.templateId}
                onValueChange={(value) => update(step.key, { templateId: value })}
                placeholder="Choose a template"
                options={templates.map((t) => ({ value: t.id, label: t.name, description: t.subject }))}
              />
            </Field>
            {index > 0 ? (
              <>
                <Field label="Delay (days after previous step)">
                  <Input
                    type="number"
                    min={0}
                    value={step.delayDays}
                    onChange={(event) => update(step.key, { delayDays: Number(event.target.value) })}
                  />
                </Field>
                <Field label="Extra hours">
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    value={step.delayHours}
                    onChange={(event) => update(step.key, { delayHours: Number(event.target.value) })}
                  />
                </Field>
              </>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4">
            <Checkbox
              id={`${step.key}-enabled`}
              checked={step.enabled}
              onCheckedChange={(value) => update(step.key, { enabled: value })}
              label="Enabled"
            />
            {index > 0 ? (
              <Checkbox
                id={`${step.key}-thread`}
                checked={step.replyInThread}
                onCheckedChange={(value) => update(step.key, { replyInThread: value })}
                label="Reply inside the existing Gmail thread"
              />
            ) : null}
          </div>
        </div>
      ))}

      <Button
        variant="outline"
        onClick={() =>
          setSteps((prev) => [
            ...prev,
            {
              key: newStepKey(),
              name: `Follow-up ${prev.length}`,
              templateId: '',
              delayDays: prev.length <= 1 ? 3 : 7,
              delayHours: 0,
              replyInThread: true,
              enabled: true,
            },
          ])
        }
      >
        <ClipboardList /> Add step
      </Button>
      <p className="text-xs text-muted-foreground">
        There is no cap on the number of follow-ups — the old three-step spreadsheet limit does not exist here.
      </p>
    </div>
  );
}

function ReviewPanel({
  state,
  steps,
  mailbox,
  list,
  templates,
}: {
  state: WizardState;
  steps: StepDraft[];
  mailbox?: { email: string; displayName: string };
  list?: { name: string; contactCount: number };
  templates: Array<{ id: string; name: string }>;
}) {
  const problems: string[] = [];
  if (!mailbox) problems.push('No mailbox selected.');
  if (!list) problems.push('No contact list selected.');
  if (steps.some((s) => s.enabled && !s.templateId)) problems.push('At least one enabled step has no template.');
  if (state.dailyLimit > 200) problems.push('A daily limit above 200 is aggressive for a single mailbox.');

  return (
    <div className="space-y-4">
      {problems.length ? (
        <div className="rounded-md border border-warning/30 bg-warning-muted p-3">
          <p className="text-xs font-medium text-foreground">Worth checking before you launch</p>
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            {problems.map((problem) => (
              <li key={problem}>• {problem}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-md border border-success/30 bg-success-muted p-3 text-xs text-foreground">
          Everything looks consistent. Run a test draft next.
        </div>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col" className="w-12">#</th>
              <th scope="col">Step</th>
              <th scope="col" className="w-52">Template</th>
              <th scope="col" className="w-24">Delay</th>
              <th scope="col" className="w-24">Thread</th>
              <th scope="col" className="w-20">State</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step, index) => (
              <tr key={step.key}>
                <td className="num text-muted-foreground">{index + 1}</td>
                <td className="font-medium text-foreground">{step.name}</td>
                <td className="text-muted-foreground">
                  {templates.find((t) => t.id === step.templateId)?.name ?? <Badge tone="warning">none</Badge>}
                </td>
                <td className="num text-muted-foreground">{index === 0 ? 'immediately' : `+${step.delayDays}d`}</td>
                <td className="text-muted-foreground">{step.replyInThread ? 'reply' : 'new email'}</td>
                <td>
                  <Badge tone={step.enabled ? 'success' : 'neutral'}>{step.enabled ? 'on' : 'off'}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
