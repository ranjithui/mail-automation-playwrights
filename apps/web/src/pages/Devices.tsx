import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Download, Laptop, Link2, Plus, ShieldOff, Trash2, Unlink } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn, relative } from '@/lib/utils';
import { Badge, Button, Card, CardBody, Spinner } from '@/components/ui/primitives';
import { EmptyState, PageHeader } from '@/components/ui/data';
import { Select } from '@/components/ui/controls';
import { ConfirmDialog } from '@/components/ui/overlays';
import { RoleGate } from '@/hooks/use-session';

interface Device {
  id: string;
  name: string;
  platform: string;
  agentVersion: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revoked: boolean;
  online: boolean;
  mailboxes: Array<{ id: string; email: string; connection: string }>;
}

interface Mailbox {
  id: string;
  email: string;
}

interface PairingCode {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
}

interface AgentInfo {
  downloadUrl: string | null;
  serverUrl: string;
}

/** Remembers that this browser has already fetched the installer. */
const DOWNLOADED_KEY = 'mailflow.agentDownloaded';

function Copyable({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded border border-border bg-muted px-2 py-1 font-mono text-xs">
        {value}
      </code>
      <Button
        variant="ghost"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          toast.success(`${label} copied`);
        }}
      >
        <Copy className="size-4" />
      </Button>
    </div>
  );
}

/**
 * One line of the setup checklist.
 *
 * `done` is derived from what the server actually reports rather than from
 * what the operator has clicked, so the list cannot claim a machine is enrolled
 * when it is not - which is the only thing that makes a checklist worth more
 * than a numbered list in a document.
 */
function Step({
  index,
  done,
  active,
  title,
  children,
}: {
  index: number;
  done: boolean;
  active: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <div
        className={cn(
          'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
          done
            ? 'border-success bg-success text-success-foreground'
            : active
              ? 'border-primary text-primary'
              : 'border-border text-muted-foreground',
        )}
        aria-hidden
      >
        {done ? <Check className="size-3.5" strokeWidth={3} /> : index}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pb-5">
        <span
          className={cn(
            'text-sm font-medium',
            done ? 'text-muted-foreground line-through decoration-1' : undefined,
          )}
        >
          {title}
        </span>
        {done ? null : children}
      </div>
    </li>
  );
}

function SetupFlow({
  info,
  devices,
  knownIds,
  onClose,
}: {
  info?: AgentInfo;
  devices: Device[];
  /** Devices that already existed when this flow opened. */
  knownIds: Set<string>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = React.useState<PairingCode | null>(null);
  const [downloaded, setDownloaded] = React.useState(
    () => localStorage.getItem(DOWNLOADED_KEY) === '1',
  );
  const [remaining, setRemaining] = React.useState(0);
  const [mailboxChoice, setMailboxChoice] = React.useState('');

  // The machine that appeared while this flow was open - the one being set up.
  const enrolled = devices.find((d) => !knownIds.has(d.id));
  const bound = enrolled?.mailboxes.length ? enrolled.mailboxes[0] : null;
  const connected = bound?.connection === 'CONNECTED';

  const { data: mailboxes } = useQuery({
    queryKey: ['email-accounts'],
    queryFn: () => api.get<Mailbox[]>('/email-accounts'),
  });

  React.useEffect(() => {
    if (!pairing) return;
    const tick = () =>
      setRemaining(Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const createCode = useMutation({
    mutationFn: () => api.post<PairingCode>('/devices/pairing-code'),
    onSuccess: setPairing,
    onError: (error) =>
      toast.error(error instanceof ApiError ? error.message : 'Could not create a pairing code'),
  });

  const bind = useMutation({
    mutationFn: (emailAccountId: string) =>
      api.post(`/devices/${enrolled?.id}/mailboxes`, { emailAccountId }),
    onSuccess: () => {
      toast.success('Mailbox moved to that machine');
      void queryClient.invalidateQueries({ queryKey: ['devices'] });
      void queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not bind'),
  });

  const boundIds = new Set(devices.flatMap((d) => d.mailboxes.map((m) => m.id)));
  const unbound = (mailboxes ?? []).filter((m) => !boundIds.has(m.id));

  const codeLive = Boolean(pairing) && remaining > 0;
  const steps = [downloaded, Boolean(pairing), Boolean(enrolled), Boolean(bound), connected];
  const activeIndex = steps.findIndex((s) => !s);
  const allDone = activeIndex === -1;

  return (
    <Card className={cn(allDone ? 'border-success/50' : 'border-primary/40')}>
      <CardBody className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="font-medium">
              {allDone ? 'This machine is ready' : 'Set up a machine'}
            </span>
            <span className="text-xs text-muted-foreground">
              {allDone
                ? 'It will send mail for as long as the agent is running.'
                : `Step ${activeIndex + 1} of 5`}
            </span>
          </div>
          <Button variant={allDone ? 'primary' : 'ghost'} onClick={onClose}>
            {allDone ? 'Finish' : 'Close'}
          </Button>
        </div>

        <ol className="flex flex-col">
          <Step index={1} done={downloaded} active={activeIndex === 0} title="Get the agent onto that machine">
            <p className="text-sm text-muted-foreground">
              It holds the Gmail browser profiles. Nothing else needs installing.
            </p>
            {info?.downloadUrl ? (
              <a
                href={info.downloadUrl}
                onClick={() => {
                  localStorage.setItem(DOWNLOADED_KEY, '1');
                  setDownloaded(true);
                }}
              >
                <Button variant="outline">
                  <Download className="size-4" /> Download the agent
                </Button>
              </a>
            ) : (
              <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
                <p className="text-sm text-muted-foreground">
                  No download has been published yet. Build one from a checkout on the same kind of
                  machine it will run on, then set <code className="font-mono">AGENT_DOWNLOAD_URL</code>:
                </p>
                <Copyable value="npm run build:agent" label="Command" />
                <Button variant="outline" onClick={() => setDownloaded(true)}>
                  I have it on that machine
                </Button>
              </div>
            )}
          </Step>

          <Step index={2} done={Boolean(pairing)} active={activeIndex === 1} title="Create a pairing code">
            <p className="text-sm text-muted-foreground">
              Good for ten minutes, and only once.
            </p>
            <Button onClick={() => createCode.mutate()} disabled={createCode.isPending}>
              {createCode.isPending ? <Spinner className="size-4" /> : <Plus className="size-4" />}
              Create a code
            </Button>
          </Step>

          <Step index={3} done={Boolean(enrolled)} active={activeIndex === 2} title="Run it and paste the code">
            {pairing ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-2xl font-semibold tracking-[0.2em]">{pairing.code}</span>
                  <Badge tone={codeLive ? 'outline' : 'danger'}>
                    {codeLive
                      ? `expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`
                      : 'expired'}
                  </Badge>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard.writeText(pairing.code);
                      toast.success('Code copied');
                    }}
                  >
                    <Copy className="size-4" /> Copy
                  </Button>
                  {codeLive ? null : (
                    <Button variant="outline" onClick={() => createCode.mutate()}>
                      New code
                    </Button>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  Open the agent on that machine. It asks for two things:
                </p>
                <Copyable value={info?.serverUrl ?? window.location.origin} label="Server address" />
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="size-3.5" /> Waiting for it to appear&hellip;
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Create a code first.</p>
            )}
          </Step>

          <Step index={4} done={Boolean(bound)} active={activeIndex === 3} title="Give it a mailbox">
            {enrolled ? (
              unbound.length ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Select
                    value={mailboxChoice}
                    onValueChange={setMailboxChoice}
                    options={[
                      { value: '', label: 'Choose a mailbox…' },
                      ...unbound.map((m) => ({ value: m.id, label: m.email })),
                    ]}
                  />
                  <Button
                    variant="outline"
                    disabled={!mailboxChoice || bind.isPending}
                    onClick={() => bind.mutate(mailboxChoice)}
                  >
                    <Link2 className="size-4" /> Bind to {enrolled.name}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Every mailbox already belongs to a machine. Release one below, or add another under
                  Email accounts.
                </p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">Waiting for the machine to enrol.</p>
            )}
          </Step>

          <Step index={5} done={connected} active={activeIndex === 4} title="Sign in to Gmail there">
            {bound ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Press Connect on <span className="font-mono">{bound.email}</span> under Email accounts. A
                  Chrome window opens <em>on that machine</em> for the sign-in.
                </p>
                <p className="text-sm text-muted-foreground">
                  Currently <Badge tone="outline">{bound.connection.toLowerCase()}</Badge>
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Bind a mailbox first.</p>
            )}
          </Step>
        </ol>
      </CardBody>
    </Card>
  );
}

export function DevicesPage() {
  const queryClient = useQueryClient();
  const [setupOpen, setSetupOpen] = React.useState(false);
  const [knownIds, setKnownIds] = React.useState<Set<string>>(new Set());
  const [pendingRevoke, setPendingRevoke] = React.useState<Device | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Device | null>(null);
  const [binding, setBinding] = React.useState<Record<string, string>>({});

  // Polled, because "online" is derived from when a machine last asked for work
  // and the checklist below advances on its own as that machine does things.
  // Faster while somebody is watching a setup happen.
  const { data: devices, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/devices'),
    refetchInterval: setupOpen ? 3_000 : 20_000,
  });

  const { data: info } = useQuery({
    queryKey: ['devices', 'agent-info'],
    queryFn: () => api.get<AgentInfo>('/devices/agent-info'),
    staleTime: 5 * 60_000,
  });

  const { data: mailboxes } = useQuery({
    queryKey: ['email-accounts'],
    queryFn: () => api.get<Mailbox[]>('/email-accounts'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['devices'] });
    void queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
  };

  const fail = (error: unknown, fallback: string) =>
    toast.error(error instanceof ApiError ? error.message : fallback);

  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/devices/${id}/revoke`),
    onSuccess: () => {
      toast.success('Device revoked');
      invalidate();
    },
    onError: (error) => fail(error, 'Revoke failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/devices/${id}`),
    onSuccess: () => {
      toast.success('Device removed');
      invalidate();
    },
    onError: (error) => fail(error, 'Delete failed'),
  });

  const bind = useMutation({
    mutationFn: ({ deviceId, emailAccountId }: { deviceId: string; emailAccountId: string }) =>
      api.post(`/devices/${deviceId}/mailboxes`, { emailAccountId }),
    onSuccess: () => {
      toast.success('Mailbox moved to that machine. Press Connect to sign in there.');
      invalidate();
    },
    onError: (error) => fail(error, 'Could not bind the mailbox'),
  });

  const unbind = useMutation({
    mutationFn: ({ deviceId, emailAccountId }: { deviceId: string; emailAccountId: string }) =>
      api.delete(`/devices/${deviceId}/mailboxes/${emailAccountId}`),
    onSuccess: () => {
      toast.success('Mailbox returned to the local worker');
      invalidate();
    },
    onError: (error) => fail(error, 'Could not release the mailbox'),
  });

  const openSetup = () => {
    // Snapshotting first is what lets the checklist recognise which machine is
    // the new one, on an installation that already has several.
    setKnownIds(new Set((devices ?? []).map((d) => d.id)));
    setSetupOpen(true);
  };

  const boundIds = new Set((devices ?? []).flatMap((d) => d.mailboxes.map((m) => m.id)));
  const unbound = (mailboxes ?? []).filter((m) => !boundIds.has(m.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Devices"
        description="Machines running the agent. Each one holds the Gmail browser profiles for the mailboxes bound to it - and never a database credential."
        actions={
          <RoleGate minimum="USER">
            {!setupOpen ? (
              <Button onClick={openSetup}>
                <Plus className="size-4" /> Add device
              </Button>
            ) : null}
          </RoleGate>
        }
      />

      {setupOpen ? (
        <SetupFlow
          info={info}
          devices={devices ?? []}
          knownIds={knownIds}
          onClose={() => setSetupOpen(false)}
        />
      ) : null}

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !devices?.length ? (
        setupOpen ? null : (
          <EmptyState
            icon={Laptop}
            title="No devices enrolled"
            description="Add a device to run mailboxes on a machine where somebody can complete Google's sign-in. Until then, mailboxes are driven by the worker process."
          />
        )
      ) : (
        <div className="flex flex-col gap-4">
          {devices.map((device) => (
            <Card key={device.id}>
              <CardBody className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{device.name}</span>
                      {device.revoked ? (
                        <Badge tone="danger">revoked</Badge>
                      ) : device.online ? (
                        <Badge tone="success">online</Badge>
                      ) : (
                        <Badge tone="outline">offline</Badge>
                      )}
                    </div>
                    <span className="font-mono text-xs text-muted-foreground">
                      {device.platform}
                      {device.agentVersion ? ` · agent ${device.agentVersion}` : ''}
                      {device.lastSeenAt ? ` · last seen ${relative(device.lastSeenAt)}` : ' · never seen'}
                    </span>
                  </div>

                  <RoleGate minimum="USER">
                    <div className="flex items-center gap-2">
                      {!device.revoked ? (
                        <Button variant="outline" onClick={() => setPendingRevoke(device)}>
                          <ShieldOff className="size-4" /> Revoke
                        </Button>
                      ) : null}
                      <Button variant="ghost" onClick={() => setPendingDelete(device)}>
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </RoleGate>
                </div>

                <div className="flex flex-col gap-2">
                  {device.mailboxes.length ? (
                    device.mailboxes.map((mailbox) => (
                      <div
                        key={mailbox.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
                      >
                        <span className="font-mono text-sm">{mailbox.email}</span>
                        <div className="flex items-center gap-2">
                          <Badge tone={mailbox.connection === 'CONNECTED' ? 'success' : 'outline'}>
                            {mailbox.connection.toLowerCase()}
                          </Badge>
                          <RoleGate minimum="USER">
                            <Button
                              variant="ghost"
                              onClick={() =>
                                unbind.mutate({ deviceId: device.id, emailAccountId: mailbox.id })
                              }
                            >
                              <Unlink className="size-4" /> Release
                            </Button>
                          </RoleGate>
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No mailboxes yet. Bind one below and it will be driven from this machine.
                    </p>
                  )}
                </div>

                {!device.revoked && unbound.length ? (
                  <RoleGate minimum="USER">
                    <div className="flex flex-wrap items-end gap-2">
                      <Select
                        value={binding[device.id] ?? ''}
                        onValueChange={(value) => setBinding((p) => ({ ...p, [device.id]: value }))}
                        options={[
                          { value: '', label: 'Choose a mailbox…' },
                          ...unbound.map((m) => ({ value: m.id, label: m.email })),
                        ]}
                      />
                      <Button
                        variant="outline"
                        disabled={!binding[device.id] || bind.isPending}
                        onClick={() =>
                          bind.mutate({ deviceId: device.id, emailAccountId: binding[device.id] })
                        }
                      >
                        <Link2 className="size-4" /> Bind
                      </Button>
                    </div>
                  </RoleGate>
                ) : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(pendingRevoke)}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
        title={`Revoke ${pendingRevoke?.name ?? 'this device'}?`}
        description="Its token stops working within about half a minute, its mailboxes return to the local worker, and anything queued for it fails now rather than after a timeout. Enrol it again to undo this."
        confirmLabel="Revoke"
        onConfirm={() => {
          if (pendingRevoke) revoke.mutate(pendingRevoke.id);
          setPendingRevoke(null);
        }}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Remove ${pendingDelete?.name ?? 'this device'}?`}
        description="The record and its history go. Any mailboxes it holds return to the local worker."
        confirmLabel="Remove"
        onConfirm={() => {
          if (pendingDelete) remove.mutate(pendingDelete.id);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}
