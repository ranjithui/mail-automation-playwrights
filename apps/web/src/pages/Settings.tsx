import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, KeyRound, Plus, Save, ShieldCheck, Trash2, Users, Zap } from 'lucide-react';
import { AI_PROVIDERS, AI_REPLY_LENGTHS, AI_REPLY_STYLES, ROLES } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { TIMEZONES, relative, titleCase } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input } from '@/components/ui/primitives';
import { Column, DataTable, EmptyState, PageHeader } from '@/components/ui/data';
import { Select, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/overlays';
import { RoleGate, useSession } from '@/hooks/use-session';

export function SettingsPage() {
  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Settings" description="Workspace configuration, AI provider and security." />

      <Tabs defaultValue="workspace">
        <TabsList>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          <TabsTrigger value="ai">
            <Bot className="size-3.5" /> AI
          </TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="workspace">
          <WorkspaceSettings />
        </TabsContent>
        <TabsContent value="ai">
          <AISettings />
        </TabsContent>
        <TabsContent value="security">
          <SecurityPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WorkspaceSettings() {
  const queryClient = useQueryClient();
  const { refresh } = useSession();
  const [form, setForm] = React.useState<Record<string, unknown> | null>(null);

  const { data } = useQuery({
    queryKey: ['workspace-settings'],
    queryFn: () => api.get<any>('/workspaces/current/settings'),
  });

  React.useEffect(() => {
    if (data && !form) {
      setForm({
        name: data.name,
        timezone: data.timezone,
        sendWindowStart: data.sendWindowStart ?? '09:30',
        sendWindowEnd: data.sendWindowEnd ?? '17:30',
        defaultDailyLimit: data.defaultDailyLimit ?? 100,
        skipWhenOutOfOffice: data.skipWhenOutOfOffice ?? true,
        notifyOnReply: data.notifyOnReply ?? true,
        notifyOnFailure: data.notifyOnFailure ?? true,
      });
    }
  }, [data, form]);

  const save = useMutation({
    mutationFn: () => api.patch('/workspaces/current/settings', form),
    onSuccess: async () => {
      toast.success('Workspace settings saved');
      await queryClient.invalidateQueries({ queryKey: ['workspace-settings'] });
      await refresh();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Save failed'),
  });

  const set = (key: string, value: unknown) => setForm((prev) => ({ ...(prev ?? {}), [key]: value }));

  if (!form) return <div className="skeleton h-64" />;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="General" subtitle="Applies across this workspace" />
        <CardBody className="space-y-4">
          <Field label="Workspace name">
            <Input value={String(form.name ?? '')} onChange={(event) => set('name', event.target.value)} />
          </Field>
          <Field label="Default timezone" hint="New campaigns inherit this.">
            <Select
              value={String(form.timezone ?? '')}
              onValueChange={(value) => set('timezone', value)}
              options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default window start">
              <Input value={String(form.sendWindowStart ?? '')} onChange={(event) => set('sendWindowStart', event.target.value)} />
            </Field>
            <Field label="Default window end">
              <Input value={String(form.sendWindowEnd ?? '')} onChange={(event) => set('sendWindowEnd', event.target.value)} />
            </Field>
          </div>
          <Field label="Default daily limit">
            <Input
              type="number"
              min={1}
              value={Number(form.defaultDailyLimit ?? 100)}
              onChange={(event) => set('defaultDailyLimit', Number(event.target.value))}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Behaviour" subtitle="How automation reacts to what it finds" />
        <CardBody className="space-y-4">
          <Switch
            id="ooo"
            checked={Boolean(form.skipWhenOutOfOffice)}
            onCheckedChange={(value) => set('skipWhenOutOfOffice', value)}
            label="Defer follow-ups on out-of-office replies"
            description="An auto-responder pushes the next step out by three days instead of counting as a reply."
          />
          <Switch
            id="notify-reply"
            checked={Boolean(form.notifyOnReply)}
            onCheckedChange={(value) => set('notifyOnReply', value)}
            label="Notify me about new replies"
          />
          <Switch
            id="notify-failure"
            checked={Boolean(form.notifyOnFailure)}
            onCheckedChange={(value) => set('notifyOnFailure', value)}
            label="Notify me about worker failures"
          />

          <RoleGate minimum="ADMIN" fallback={<p className="text-xs text-muted-foreground">Only admins can change workspace settings.</p>}>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
              <Save /> Save settings
            </Button>
          </RoleGate>
        </CardBody>
      </Card>
    </div>
  );
}

function AISettings() {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState<any>(null);
  const [apiKey, setApiKey] = React.useState('');

  const { data } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api.get<any>('/ai/settings'),
  });

  React.useEffect(() => {
    if (data && !form) setForm(data);
  }, [data, form]);

  const save = useMutation({
    mutationFn: () => api.put('/ai/settings', { ...form, apiKey: apiKey || undefined }),
    onSuccess: () => {
      toast.success('AI settings saved');
      setApiKey('');
      void queryClient.invalidateQueries({ queryKey: ['ai-settings'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Save failed'),
  });

  const test = useMutation({
    mutationFn: () => api.post<any>('/ai/settings/test'),
    onSuccess: (result) => {
      if (result.ok) toast.success(`${result.provider} responded — sample intent: ${result.sample.intent}`);
      else toast.error(`${result.provider}: ${result.message}`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Test failed'),
  });

  const set = (key: string, value: unknown) => setForm((prev: any) => ({ ...prev, [key]: value }));

  if (!form) return <div className="skeleton h-64" />;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Provider" subtitle="Swap models without touching any other setting" />
        <CardBody className="space-y-4">
          <Field label="AI provider" hint="`local` is a rule-based provider that needs no API key and sends nothing externally.">
            <Select
              value={form.provider}
              onValueChange={(value) => set('provider', value)}
              options={AI_PROVIDERS.map((p) => ({
                value: p,
                label: p === 'local' ? 'local (offline, no key needed)' : p,
              }))}
            />
          </Field>

          {form.provider !== 'local' ? (
            <>
              <Field label="Model" hint="Leave blank to use the provider default.">
                <Input value={form.model ?? ''} onChange={(event) => set('model', event.target.value)} placeholder="gpt-4o-mini" />
              </Field>
              <Field
                label="API key"
                hint={form.hasApiKey ? `A key is stored (${form.apiKeyMask}). Enter a new one to replace it.` : 'Encrypted with AES-256-GCM and never returned to this interface.'}
              >
                <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={form.hasApiKey ? '••••••••' : 'sk-…'} />
              </Field>
            </>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Temperature">
              <Input
                type="number"
                step="0.1"
                min={0}
                max={2}
                value={form.temperature}
                onChange={(event) => set('temperature', Number(event.target.value))}
              />
            </Field>
            <Field label="Max tokens">
              <Input
                type="number"
                min={64}
                max={8000}
                value={form.maxTokens}
                onChange={(event) => set('maxTokens', Number(event.target.value))}
              />
            </Field>
          </div>

          <div className="flex gap-2">
            <RoleGate minimum="ADMIN" fallback={<p className="text-xs text-muted-foreground">Only admins can change AI settings.</p>}>
              <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
                <Save /> Save
              </Button>
              <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
                <Zap /> Test provider
              </Button>
            </RoleGate>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Behaviour and cost control" subtitle="Decide exactly how much the AI does" />
        <CardBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default reply tone">
              <Select
                value={form.defaultStyle}
                onValueChange={(value) => set('defaultStyle', value)}
                options={AI_REPLY_STYLES.map((s) => ({ value: s, label: titleCase(s) }))}
              />
            </Field>
            <Field label="Default reply length">
              <Select
                value={form.defaultLength}
                onValueChange={(value) => set('defaultLength', value)}
                options={AI_REPLY_LENGTHS.map((l) => ({ value: l, label: titleCase(l) }))}
              />
            </Field>
          </div>

          <Field label="Analyse which messages" hint="Narrower scopes cost less when using a hosted provider.">
            <Select
              value={form.analyzeScope}
              onValueChange={(value) => set('analyzeScope', value)}
              options={[
                { value: 'CAMPAIGN_REPLIES', label: 'Campaign replies only', description: 'Recommended default' },
                { value: 'UNREAD', label: 'Unread messages only' },
                { value: 'HIGH_PRIORITY', label: 'Unread campaign replies only' },
                { value: 'ALL', label: 'Every inbound message', description: 'Highest cost' },
              ]}
            />
          </Field>

          <div className="space-y-3 rounded-md border border-border p-3">
            <Switch id="intent" checked={form.enableIntentDetection} onCheckedChange={(v) => set('enableIntentDetection', v)} label="Intent detection" description="Classify what each reply is asking for." />
            <Switch id="summary" checked={form.enableThreadSummary} onCheckedChange={(v) => set('enableThreadSummary', v)} label="Thread summaries" />
            <Switch id="reply" checked={form.enableAIReply} onCheckedChange={(v) => set('enableAIReply', v)} label="AI reply drafting" />
            <Switch
              id="auto"
              checked={form.autoGenerateReplies}
              onCheckedChange={(v) => set('autoGenerateReplies', v)}
              label="Pre-generate a reply for each inbound message"
              description="Drafts only. Nothing is ever sent without a person pressing Send."
            />
            <Switch
              id="external"
              checked={form.externalAIEnabled}
              onCheckedChange={(v) => set('externalAIEnabled', v)}
              label="Allow external AI providers"
              description="Turn off to pin the workspace to the offline local provider, whatever else is configured."
            />
          </div>

          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <ShieldCheck className="size-3.5 text-success" aria-hidden /> What is sent to the provider
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Only the contact’s name, company, title and industry, the campaign name and step, the conversation in
              this thread, and your instructions. Never passwords, cookies, session tokens or unrelated mail.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

function SecurityPanel() {
  const [form, setForm] = React.useState({ currentPassword: '', newPassword: '' });

  const change = useMutation({
    mutationFn: () => api.post('/auth/change-password', form),
    onSuccess: () => {
      toast.success('Password changed — sign in again with the new one');
      setTimeout(() => (window.location.href = '/login'), 1200);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not change password'),
  });

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Change password" subtitle="Signing out of every other session" />
        <CardBody className="space-y-4">
          <Field label="Current password" required>
            <Input
              type="password"
              autoComplete="current-password"
              value={form.currentPassword}
              onChange={(event) => setForm((p) => ({ ...p, currentPassword: event.target.value }))}
            />
          </Field>
          <Field label="New password" required hint="At least 10 characters with upper case, lower case and a number.">
            <Input
              type="password"
              autoComplete="new-password"
              value={form.newPassword}
              onChange={(event) => setForm((p) => ({ ...p, newPassword: event.target.value }))}
            />
          </Field>
          <Button
            variant="primary"
            onClick={() => change.mutate()}
            loading={change.isPending}
            disabled={!form.currentPassword || !form.newPassword}
          >
            <KeyRound /> Change password
          </Button>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="How your data is protected" />
        <CardBody>
          <ul className="space-y-2 text-xs text-muted-foreground">
            {[
              'Passwords are hashed with bcrypt and never stored or logged in plain text.',
              'Access tokens are short-lived JWTs in httpOnly cookies; refresh tokens are stored only as hashes and rotate on every use.',
              'AI API keys and mailbox secrets are encrypted at rest with AES-256-GCM and never returned to the browser.',
              'Browser sessions, cookies and profiles stay inside the worker process.',
              'Every workspace is isolated at the query layer — a request can only ever reach workspaces you belong to.',
              'Attachments are served through an authorised route, never from a public static directory.',
              'Every action is written to an immutable activity log.',
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- members */

export function MembersPage() {
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [pendingRemove, setPendingRemove] = React.useState<any>(null);
  const [form, setForm] = React.useState({ email: '', firstName: '', lastName: '', password: '', role: 'USER' });

  const { data, isLoading } = useQuery({
    queryKey: ['members'],
    queryFn: () => api.get<any[]>('/workspaces/current/members'),
  });

  const invite = useMutation({
    mutationFn: () => api.post('/workspaces/current/members', form),
    onSuccess: () => {
      toast.success('Member added');
      setForm({ email: '', firstName: '', lastName: '', password: '', role: 'USER' });
      setInviteOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not add member'),
  });

  const updateRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => api.patch(`/workspaces/current/members/${id}`, { role }),
    onSuccess: () => {
      toast.success('Role updated');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not update role'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/workspaces/current/members/${id}`),
    onSuccess: () => {
      toast.success('Member removed');
      setPendingRemove(null);
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not remove member'),
  });

  const columns: Column<any>[] = [
    {
      key: 'name',
      header: 'Member',
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {row.firstName} {row.lastName}
            {row.id === user?.id ? <Badge tone="outline" className="ml-2">you</Badge> : null}
          </p>
          <p className="truncate font-mono text-2xs text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: 'w-40',
      cell: (row) => (
        <RoleGate minimum="ADMIN" fallback={<Badge tone="primary">{row.role.toLowerCase()}</Badge>}>
          <Select
            value={row.role}
            onValueChange={(value) => updateRole.mutate({ id: row.id, role: value })}
            className="h-8"
            options={ROLES.map((r) => ({ value: r, label: titleCase(r) }))}
          />
        </RoleGate>
      ),
    },
    { key: 'lastLogin', header: 'Last sign-in', width: 'w-36', cell: (row) => <span className="text-2xs text-muted-foreground">{row.lastLoginAt ? relative(row.lastLoginAt) : 'never'}</span> },
    { key: 'joined', header: 'Joined', width: 'w-32', cell: (row) => <span className="text-2xs text-muted-foreground">{relative(row.joinedAt)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-12',
      align: 'right',
      cell: (row) => (
        <RoleGate minimum="ADMIN">
          {row.role !== 'OWNER' && row.id !== user?.id ? (
            <Button variant="ghost" size="icon-sm" onClick={() => setPendingRemove(row)} aria-label={`Remove ${row.email}`}>
              <Trash2 />
            </Button>
          ) : null}
        </RoleGate>
      ),
    },
  ];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Workspace members"
        description="Roles are workspace-specific: OWNER › ADMIN › MANAGER › USER › VIEWER."
        actions={
          <RoleGate minimum="ADMIN">
            <Button variant="primary" onClick={() => setInviteOpen(true)}>
              <Plus /> Add member
            </Button>
          </RoleGate>
        }
      />

      <DataTable
        columns={columns}
        rows={data ?? []}
        loading={isLoading}
        rowKey={(row) => row.id}
        emptyState={<EmptyState icon={Users} title="No members" description="Add teammates and give them the least access they need." />}
      />

      <Card>
        <CardHeader title="What each role can do" />
        <CardBody>
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col" className="w-28">Role</th>
                  <th scope="col">Permissions</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['OWNER', 'Everything, including transferring ownership and deleting the workspace.'],
                  ['ADMIN', 'Manage members, workspace settings and AI configuration.'],
                  ['MANAGER', 'Start, pause and stop campaigns; delete campaigns and mailboxes.'],
                  ['USER', 'Create and edit campaigns, contacts, templates; send replies.'],
                  ['VIEWER', 'Read-only access to everything in the workspace.'],
                ].map(([role, description]) => (
                  <tr key={role}>
                    <td><Badge tone="primary">{role.toLowerCase()}</Badge></td>
                    <td className="text-xs text-muted-foreground">{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>

      <Dialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        title="Add a member"
        description="No mail provider is configured on this install, so you set the initial password and share it yourself."
        footer={
          <>
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => invite.mutate()} loading={invite.isPending} disabled={!form.email || !form.password}>
              Add member
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name" required>
            <Input value={form.firstName} onChange={(event) => setForm((p) => ({ ...p, firstName: event.target.value }))} />
          </Field>
          <Field label="Last name" required>
            <Input value={form.lastName} onChange={(event) => setForm((p) => ({ ...p, lastName: event.target.value }))} />
          </Field>
          <Field label="Email" required className="sm:col-span-2">
            <Input type="email" value={form.email} onChange={(event) => setForm((p) => ({ ...p, email: event.target.value }))} />
          </Field>
          <Field label="Initial password" required hint="At least 10 characters with upper case, lower case and a number.">
            <Input type="password" value={form.password} onChange={(event) => setForm((p) => ({ ...p, password: event.target.value }))} />
          </Field>
          <Field label="Role">
            <Select value={form.role} onValueChange={(value) => setForm((p) => ({ ...p, role: value }))} options={ROLES.map((r) => ({ value: r, label: titleCase(r) }))} />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingRemove)}
        onOpenChange={(open) => !open && setPendingRemove(null)}
        title={`Remove ${pendingRemove?.email}?`}
        description="They lose access to this workspace immediately. Their account and any other workspace memberships are untouched."
        confirmLabel="Remove member"
        loading={remove.isPending}
        onConfirm={() => pendingRemove && remove.mutate(pendingRemove.id)}
      />
    </div>
  );
}

/* --------------------------------------------------------------- profile */

export function ProfilePage() {
  const { user, refresh } = useSession();
  const [form, setForm] = React.useState({
    firstName: user?.firstName ?? '',
    lastName: user?.lastName ?? '',
    timezone: user?.timezone ?? 'Asia/Kolkata',
  });

  const save = useMutation({
    mutationFn: () => api.patch('/auth/me', form),
    onSuccess: async () => {
      toast.success('Profile updated');
      await refresh();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Save failed'),
  });

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader title="Profile" description="Your personal details across every workspace." />

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Details" />
          <CardBody className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="First name">
                <Input value={form.firstName} onChange={(event) => setForm((p) => ({ ...p, firstName: event.target.value }))} />
              </Field>
              <Field label="Last name">
                <Input value={form.lastName} onChange={(event) => setForm((p) => ({ ...p, lastName: event.target.value }))} />
              </Field>
            </div>
            <Field label="Email" hint="Contact an owner to change your sign-in address.">
              <Input value={user?.email ?? ''} disabled />
            </Field>
            <Field label="Timezone">
              <Select value={form.timezone} onValueChange={(value) => setForm((p) => ({ ...p, timezone: value }))} options={TIMEZONES.map((tz) => ({ value: tz, label: tz }))} />
            </Field>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
              <Save /> Save profile
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Workspace access" />
          <CardBody className="space-y-2">
            {user?.workspaces.map((workspace) => (
              <div key={workspace.id} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <span className="min-w-0 truncate text-[13px] text-foreground">{workspace.name}</span>
                <Badge tone="primary">{workspace.role.toLowerCase()}</Badge>
              </div>
            ))}
            <p className="pt-2 text-xs text-muted-foreground">Organization: {user?.organizationName}</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
