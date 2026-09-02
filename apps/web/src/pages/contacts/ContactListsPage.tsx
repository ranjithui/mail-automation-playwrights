import * as React from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { List, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { relative } from '@/lib/utils';
import { Badge, Button, Card, CardBody, Field, Input, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader } from '@/components/ui/data';
import { ConfirmDialog, Dialog } from '@/components/ui/overlays';
import { RoleGate } from '@/hooks/use-session';

interface ContactList {
  id: string;
  name: string;
  description: string | null;
  contactCount: number;
  campaignCount: number;
  createdAt: string;
}

export function ContactListsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<ContactList | null>(null);
  const [form, setForm] = React.useState({ name: '', description: '' });

  const { data, isLoading } = useQuery({
    queryKey: ['contact-lists'],
    queryFn: () => api.get<ContactList[]>('/contacts/lists'),
  });

  const create = useMutation({
    mutationFn: () => api.post('/contacts/lists', form),
    onSuccess: () => {
      toast.success('List created');
      setForm({ name: '', description: '' });
      setCreateOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['contact-lists'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not create list'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/contacts/lists/${id}`),
    onSuccess: () => {
      toast.success('List deleted');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['contact-lists'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Delete failed'),
  });

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Contact lists"
        description="Group prospects so a campaign can target them in one step."
        actions={
          <RoleGate minimum="USER">
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus /> New list
            </Button>
          </RoleGate>
        }
      />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Card key={index}>
              <CardBody>
                <div className="skeleton h-4 w-32" />
                <div className="skeleton mt-2 h-3 w-48" />
              </CardBody>
            </Card>
          ))}
        </div>
      ) : !data?.length ? (
        <Card>
          <EmptyState
            icon={List}
            title="No lists yet"
            description="Create a list, then import contacts straight into it."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus /> Create list
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((list) => (
            <Card key={list.id}>
              <CardBody className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      to={`/contacts?listId=${list.id}`}
                      className="block truncate text-[13px] font-semibold text-foreground hover:text-primary"
                    >
                      {list.name}
                    </Link>
                    {list.description ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{list.description}</p>
                    ) : null}
                  </div>
                  <RoleGate minimum="USER">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${list.name}`}
                      onClick={() => setPendingDelete(list)}
                    >
                      <Trash2 />
                    </Button>
                  </RoleGate>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="primary" className="num">
                    {list.contactCount} contacts
                  </Badge>
                  {list.campaignCount ? (
                    <Badge tone="outline" className="num">
                      {list.campaignCount} campaign(s)
                    </Badge>
                  ) : null}
                  <span className="ml-auto text-2xs text-muted-foreground">{relative(list.createdAt)}</span>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="New contact list"
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.name.trim()}>
              Create list
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name" required>
            <Input value={form.name} onChange={(event) => setForm((p) => ({ ...p, name: event.target.value }))} placeholder="Q4 enterprise prospects" />
          </Field>
          <Field label="Description">
            <Textarea
              rows={3}
              value={form.description}
              onChange={(event) => setForm((p) => ({ ...p, description: event.target.value }))}
              placeholder="Who is in this list and why."
            />
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name}"?`}
        description="The list is removed but the contacts inside it are kept. Campaigns already using it keep their contacts."
        confirmLabel="Delete list"
        loading={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </div>
  );
}
