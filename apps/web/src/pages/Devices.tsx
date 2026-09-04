import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Laptop, Link2, Plus, ShieldOff, Trash2, Unlink } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relative } from '@/lib/utils';
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

/**
 * The pairing code, once it exists.
 *
 * Shown large because it is read off this screen and typed into a terminal on
 * another machine, and with the remaining time visible because a code that has
 * quietly expired is otherwise indistinguishable from one typed wrongly.
 */
function PairingPanel({ pairing, onDone }: { pairing: PairingCode; onDone: () => void }) {
  const [remaining, setRemaining] = React.useState(() =>
    Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000)),
  );

  React.useEffect(() => {
    const tick = setInterval(() => {
      const left = Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [pairing.expiresAt]);

  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Pairing code
            </span>
            <span className="font-mono text-3xl font-semibold tracking-[0.2em]">{pairing.code}</span>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={remaining > 0 ? 'outline' : 'danger'}>
              {remaining > 0 ? `expires in ${minutes}:${seconds}` : 'expired'}
            </Badge>
            <Button
              variant="outline"
              onClick={() => {
                void navigator.clipboard.writeText(pairing.code);
                toast.success('Code copied');
              }}
            >
              <Copy className="size-4" /> Copy
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Done
            </Button>
          </div>
        </div>

        <div className="rounded-md border border-border bg-background p-3 text-sm">
          <p className="mb-2 text-muted-foreground">On the machine that will run the browsers:</p>
          <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs leading-relaxed">
            npm run start:agent
          </pre>
          <p className="mt-2 text-muted-foreground">
            It asks for this server&rsquo;s address and the code above. Single use, and it only works while the
            countdown is running.
          </p>
        </div>
      </CardBody>
    </Card>
  );
}

export function DevicesPage() {
  const queryClient = useQueryClient();
  const [pairing, setPairing] = React.useState<PairingCode | null>(null);
  const [pendingRevoke, setPendingRevoke] = React.useState<Device | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Device | null>(null);
  const [binding, setBinding] = React.useState<Record<string, string>>({});

  // Devices are polled: "online" is derived from when a machine last asked for
  // work, so without a refresh the dot on this page silently goes stale.
  const { data: devices, isLoading } = useQuery({
    queryKey: ['devices'],
    queryFn: () => api.get<Device[]>('/devices'),
    refetchInterval: 15_000,
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

  const createCode = useMutation({
    mutationFn: () => api.post<PairingCode>('/devices/pairing-code'),
    onSuccess: (data) => setPairing(data),
    onError: (error) => fail(error, 'Could not create a pairing code'),
  });

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

  const boundIds = new Set((devices ?? []).flatMap((d) => d.mailboxes.map((m) => m.id)));
  const unbound = (mailboxes ?? []).filter((m) => !boundIds.has(m.id));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Devices"
        description="Machines running the agent. Each one holds the Gmail browser profiles for the mailboxes bound to it - and never a database credential."
        actions={
          <RoleGate minimum="USER">
            <Button onClick={() => createCode.mutate()} disabled={createCode.isPending}>
              {createCode.isPending ? <Spinner className="size-4" /> : <Plus className="size-4" />}
              Add device
            </Button>
          </RoleGate>
        }
      />

      {pairing ? <PairingPanel pairing={pairing} onDone={() => setPairing(null)} /> : null}

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !devices?.length ? (
        <EmptyState
          icon={Laptop}
          title="No devices enrolled"
          description="Add a device to run mailboxes on a machine where somebody can complete Google's sign-in. Until then, mailboxes are driven by the worker process."
        />
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
                          <Badge tone="outline">{mailbox.connection.toLowerCase()}</Badge>
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
