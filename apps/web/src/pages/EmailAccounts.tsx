import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Chrome,
  Link2,
  Link2Off,
  Mail,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  Zap,
} from 'lucide-react';
import type { EmailAccountSummary } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { relative } from '@/lib/utils';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, ProgressBar, StatusBadge, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader } from '@/components/ui/data';
import { ConfirmDialog, Dialog } from '@/components/ui/overlays';
import { Tooltip } from '@/components/ui/controls';
import { RoleGate } from '@/hooks/use-session';
import { useRealtime } from '@/hooks/use-realtime';

export function EmailAccountsPage() {
  const queryClient = useQueryClient();
  const { workerActivity } = useRealtime();
  const [addOpen, setAddOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<EmailAccountSummary | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['email-accounts'],
    queryFn: () => api.get<EmailAccountSummary[]>('/email-accounts'),
    refetchInterval: 20_000,
  });

  const { data: driver } = useQuery({
    queryKey: ['mailbox-driver'],
    queryFn: () => api.get<{ driver: string; headless: boolean; description: string }>('/email-accounts/driver'),
  });

  const action = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.post(`/email-accounts/${id}/${name}`, {}),
    onSuccess: (_result, variables) => {
      toast.success(`${variables.name} queued`);
      void queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Action failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/email-accounts/${id}`),
    onSuccess: () => {
      toast.success('Mailbox removed');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not remove mailbox'),
  });

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Email accounts"
        description="Connected mailboxes, their browser sessions and daily quota."
        actions={
          <RoleGate minimum="USER">
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus /> Add mailbox
            </Button>
          </RoleGate>
        }
      />

      {driver ? (
        <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3">
          <Chrome className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground">
              Mailbox driver: <span className="font-mono">{driver.driver}</span>
              {driver.driver === 'playwright' ? ` · ${driver.headless ? 'headless' : 'headed'}` : ''}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{driver.description}</p>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, index) => (
            <Card key={index}>
              <CardBody>
                <div className="skeleton h-4 w-48" />
                <div className="skeleton mt-3 h-3 w-full" />
              </CardBody>
            </Card>
          ))}
        </div>
      ) : !data?.length ? (
        <Card>
          <EmptyState
            icon={Mail}
            title="No mailboxes connected"
            description="Add the mailbox you are permitted to send from. Sessions and cookies stay in the worker and are never exposed to this interface."
            action={
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <Plus /> Add mailbox
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.map((account) => {
            const quota = account.sentToday / Math.max(1, account.dailyLimit);
            const busy = workerActivity?.accountId === account.id;
            return (
              <Card key={account.id}>
                <CardHeader
                  title={account.displayName}
                  subtitle={<span className="font-mono">{account.email}</span>}
                  actions={<StatusBadge status={account.connection} dot />}
                />
                <CardBody className="space-y-4">
                  {account.lastError ? (
                    <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-muted p-2.5">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
                      <div className="min-w-0">
                        <p className="text-2xs font-medium text-foreground">{account.lastErrorCode ?? 'Error'}</p>
                        <p className="mt-0.5 break-words text-2xs text-muted-foreground">{account.lastError}</p>
                      </div>
                    </div>
                  ) : null}

                  <div>
                    <div className="mb-1 flex items-center justify-between text-2xs text-muted-foreground">
                      <span>Daily quota</span>
                      <span className="num">
                        {account.sentToday} / {account.dailyLimit}
                      </span>
                    </div>
                    <ProgressBar
                      value={quota * 100}
                      tone={quota > 0.9 ? 'danger' : quota > 0.75 ? 'warning' : 'primary'}
                      label={`${account.email} daily quota`}
                    />
                  </div>

                  <dl className="grid grid-cols-2 gap-2 text-2xs">
                    {[
                      ['Browser', account.browserStatus],
                      ['Session', account.sessionStatus],
                      ['Active campaigns', String(account.activeCampaigns)],
                      ['Hourly limit', String(account.hourlyLimit)],
                      ['Last connected', account.lastConnectedAt ? relative(account.lastConnectedAt) : 'never'],
                      ['Last activity', account.lastActivityAt ? relative(account.lastActivityAt) : '—'],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-2 rounded border border-border px-2 py-1.5">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="truncate text-right font-medium text-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>

                  {busy && workerActivity?.action ? (
                    <p className="flex items-center gap-1.5 text-2xs text-primary">
                      <Zap className="size-3 animate-pulse" aria-hidden />
                      {workerActivity.action}
                      {workerActivity.detail ? `: ${workerActivity.detail}` : ''}
                    </p>
                  ) : null}

                  <RoleGate minimum="USER">
                    <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
                      <Button variant="primary" size="sm" onClick={() => action.mutate({ id: account.id, name: 'connect' })}>
                        <Link2 /> Connect
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => action.mutate({ id: account.id, name: 'test' })}>
                        <Zap /> Test
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => action.mutate({ id: account.id, name: 'restart' })}>
                        <RotateCw /> Restart
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => action.mutate({ id: account.id, name: 'sync' })}>
                        <RefreshCw /> Sync inbox
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => action.mutate({ id: account.id, name: 'disconnect' })}>
                        <Link2Off /> Disconnect
                      </Button>
                      <Tooltip content="Remove this mailbox">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="ml-auto"
                          onClick={() => setPendingDelete(account)}
                          aria-label={`Remove ${account.email}`}
                        >
                          <Trash2 />
                        </Button>
                      </Tooltip>
                    </div>
                  </RoleGate>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      <AddMailboxDialog open={addOpen} onOpenChange={setAddOpen} />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Remove ${pendingDelete?.email}?`}
        description="Campaigns using this mailbox lose their sender and will not send until another one is attached. Threads and history are kept."
        confirmLabel="Remove mailbox"
        loading={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </div>
  );
}

function AddMailboxDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({
    email: '',
    displayName: '',
    dailyLimit: 200,
    hourlyLimit: 40,
    signatureHtml: '',
  });

  const create = useMutation({
    mutationFn: () => api.post('/email-accounts', form),
    onSuccess: () => {
      toast.success('Mailbox added');
      setForm({ email: '', displayName: '', dailyLimit: 200, hourlyLimit: 40, signatureHtml: '' });
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not add mailbox'),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add mailbox"
      description="Only add mailboxes you are authorised to send from."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.email || !form.displayName}>
            Add mailbox
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Email address" required>
          <Input
            type="email"
            value={form.email}
            onChange={(event) => setForm((p) => ({ ...p, email: event.target.value }))}
            placeholder="sales@company.com"
          />
        </Field>
        <Field label="Display name" required hint="Shown as the sender name on outgoing mail.">
          <Input
            value={form.displayName}
            onChange={(event) => setForm((p) => ({ ...p, displayName: event.target.value }))}
            placeholder="Alex Morgan | Sales"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Daily limit" hint="Stay inside your provider's policy.">
            <Input
              type="number"
              min={1}
              value={form.dailyLimit}
              onChange={(event) => setForm((p) => ({ ...p, dailyLimit: Number(event.target.value) }))}
            />
          </Field>
          <Field label="Hourly limit">
            <Input
              type="number"
              min={1}
              value={form.hourlyLimit}
              onChange={(event) => setForm((p) => ({ ...p, hourlyLimit: Number(event.target.value) }))}
            />
          </Field>
        </div>
        <Field label="Signature (HTML)" hint="Appended to every outgoing message from this mailbox.">
          <Textarea
            rows={3}
            value={form.signatureHtml}
            onChange={(event) => setForm((p) => ({ ...p, signatureHtml: event.target.value }))}
            className="font-mono text-xs"
            placeholder="<p>Alex Morgan<br>Head of Sales</p>"
          />
        </Field>

        <p className="rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed text-muted-foreground">
          With the Playwright driver you sign in once yourself in a visible browser window; the session is then reused
          by the worker. Credentials are never entered by the platform, and cookies and browser profiles never reach
          this interface.
        </p>
      </div>
    </Dialog>
  );
}
