import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Download, Plus, Search, Tag, Trash2, Upload, Users } from 'lucide-react';
import { CONTACT_STATUSES, type ContactRecord } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { relative, titleCase } from '@/lib/utils';
import { Badge, Button, Field, Input, StatusBadge } from '@/components/ui/primitives';
import { Column, DataTable, EmptyState, PageHeader, Pagination } from '@/components/ui/data';
import { Checkbox, Select } from '@/components/ui/controls';
import { ConfirmDialog, Dialog } from '@/components/ui/overlays';
import { RoleGate } from '@/hooks/use-session';
import { ImportWizard } from './ImportWizard';

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function ContactsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [page, setPage] = React.useState(1);
  const [search, setSearch] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [listId, setListId] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [importOpen, setImportOpen] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [bulkDelete, setBulkDelete] = React.useState(false);
  const [sort, setSort] = React.useState<{ key: string; order: 'asc' | 'desc' }>({ key: 'createdAt', order: 'desc' });

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: lists } = useQuery({
    queryKey: ['contact-lists'],
    queryFn: () => api.get<Array<{ id: string; name: string; contactCount: number }>>('/contacts/lists'),
  });

  const query = new URLSearchParams({
    page: String(page),
    pageSize: '25',
    sort: sort.key,
    order: sort.order,
    ...(debounced ? { q: debounced } : {}),
    ...(status ? { status } : {}),
    ...(listId ? { listId } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', query.toString()],
    queryFn: () => api.get<Page<ContactRecord>>(`/contacts?${query.toString()}`),
  });

  const bulk = useMutation({
    mutationFn: (payload: Record<string, unknown>) => api.post<{ affected: number }>('/contacts/bulk', payload),
    onSuccess: (result) => {
      toast.success(`${result.affected} contact(s) updated`);
      setSelected(new Set());
      setBulkDelete(false);
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      void queryClient.invalidateQueries({ queryKey: ['contact-lists'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Bulk action failed'),
  });

  const rows = data?.items ?? [];
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const someSelected = rows.some((row) => selected.has(row.id));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) rows.forEach((row) => next.delete(row.id));
      else rows.forEach((row) => next.add(row.id));
      return next;
    });
  };

  const columns: Column<ContactRecord>[] = [
    {
      key: 'select',
      width: 'w-10',
      header: (
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected && !allSelected}
          onCheckedChange={toggleAll}
          aria-label="Select all contacts on this page"
        />
      ),
      cell: (row) => (
        <span onClick={(event) => event.stopPropagation()}>
          <Checkbox
            checked={selected.has(row.id)}
            onCheckedChange={(checked) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (checked) next.add(row.id);
                else next.delete(row.id);
                return next;
              })
            }
            aria-label={`Select ${row.email}`}
          />
        </span>
      ),
    },
    {
      key: 'lastName',
      header: 'Name',
      sortable: true,
      cell: (row) => (
        <div className="min-w-0">
          <Link to={`/contacts/${row.id}`} className="block truncate font-medium text-foreground hover:text-primary">
            {[row.firstName, row.lastName].filter(Boolean).join(' ') || '—'}
          </Link>
          <p className="truncate font-mono text-2xs text-muted-foreground">{row.email}</p>
        </div>
      ),
    },
    { key: 'title', header: 'Title', width: 'w-44', cell: (row) => <span className="truncate text-muted-foreground">{row.title ?? '—'}</span> },
    {
      key: 'companyName',
      header: 'Company',
      width: 'w-48',
      sortable: true,
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-foreground">{row.companyName ?? '—'}</p>
          {row.industry ? <p className="truncate text-2xs text-muted-foreground">{row.industry}</p> : null}
        </div>
      ),
    },
    {
      key: 'location',
      header: 'Location',
      width: 'w-40',
      cell: (row) => (
        <span className="truncate text-muted-foreground">
          {[row.companyCity, row.companyCountry].filter(Boolean).join(', ') || '—'}
        </span>
      ),
    },
    { key: 'status', header: 'Status', width: 'w-36', sortable: true, cell: (row) => <StatusBadge status={row.status} /> },
    {
      key: 'tags',
      header: 'Tags',
      width: 'w-36',
      cell: (row) =>
        row.tags.length ? (
          <div className="flex flex-wrap gap-1">
            {row.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} tone="outline">
                {tag}
              </Badge>
            ))}
            {row.tags.length > 2 ? <Badge tone="outline">+{row.tags.length - 2}</Badge> : null}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'createdAt',
      header: 'Added',
      width: 'w-28',
      sortable: true,
      cell: (row) => <span className="text-2xs text-muted-foreground">{relative(row.createdAt)}</span>,
    },
  ];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Contacts"
        description="Your CRM-style prospect database with import, filtering and bulk actions."
        actions={
          <RoleGate minimum="USER">
            <Button variant="outline" onClick={() => void api.download('/contacts/export', `contacts-${Date.now()}.csv`)}>
              <Download /> Export
            </Button>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload /> Import
            </Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus /> Add contact
            </Button>
          </RoleGate>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, email, company, title…"
            className="pl-8"
            aria-label="Search contacts"
          />
        </div>
        <div className="w-44">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value === 'ALL' ? '' : value);
              setPage(1);
            }}
            placeholder="Any status"
            options={[{ value: 'ALL', label: 'Any status' }, ...CONTACT_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))]}
          />
        </div>
        <div className="w-52">
          <Select
            value={listId}
            onValueChange={(value) => {
              setListId(value === 'ALL' ? '' : value);
              setPage(1);
            }}
            placeholder="Any list"
            options={[
              { value: 'ALL', label: 'Any list' },
              ...(lists ?? []).map((l) => ({ value: l.id, label: l.name, description: `${l.contactCount} contacts` })),
            ]}
          />
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary-muted px-3 py-2">
          <span className="num text-xs font-medium text-foreground">{selected.size} selected</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Select
              value=""
              onValueChange={(value) => bulk.mutate({ ids: [...selected], action: 'ADD_TO_LIST', listId: value })}
              placeholder="Add to list"
              className="h-8 w-40"
              options={(lists ?? []).map((l) => ({ value: l.id, label: l.name }))}
            />
            <Select
              value=""
              onValueChange={(value) => bulk.mutate({ ids: [...selected], action: 'SET_STATUS', status: value })}
              placeholder="Set status"
              className="h-8 w-36"
              options={CONTACT_STATUSES.map((s) => ({ value: s, label: titleCase(s) }))}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const tag = window.prompt('Tag to add');
                if (tag?.trim()) bulk.mutate({ ids: [...selected], action: 'ADD_TAG', tag: tag.trim() });
              }}
            >
              <Tag /> Tag
            </Button>
            <Button variant="outline" size="sm" onClick={() => bulk.mutate({ ids: [...selected], action: 'SUPPRESS' })}>
              <Ban /> Suppress
            </Button>
            <RoleGate minimum="USER">
              <Button variant="danger" size="sm" onClick={() => setBulkDelete(true)}>
                <Trash2 /> Delete
              </Button>
            </RoleGate>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <DataTable
        columns={columns}
        rows={rows}
        loading={isLoading}
        rowKey={(row) => row.id}
        onRowClick={(row) => navigate(`/contacts/${row.id}`)}
        sort={sort}
        onSortChange={(key) =>
          setSort((prev) => ({ key, order: prev.key === key && prev.order === 'desc' ? 'asc' : 'desc' }))
        }
        emptyState={
          <EmptyState
            icon={Users}
            title={debounced || status || listId ? 'No contacts match' : 'No contacts yet'}
            description={
              debounced || status || listId
                ? 'Try clearing a filter or searching for something else.'
                : 'Import a CSV or XLSX and map the columns — duplicates are detected before anything is written.'
            }
            action={
              <Button variant="primary" onClick={() => setImportOpen(true)}>
                <Upload /> Import contacts
              </Button>
            }
          />
        }
      />

      <Pagination page={data?.page ?? 1} pageSize={data?.pageSize ?? 25} total={data?.total ?? 0} onPageChange={setPage} />

      <ImportWizard open={importOpen} onOpenChange={setImportOpen} lists={lists ?? []} />
      <CreateContactDialog open={createOpen} onOpenChange={setCreateOpen} />

      <ConfirmDialog
        open={bulkDelete}
        onOpenChange={setBulkDelete}
        title={`Delete ${selected.size} contact(s)?`}
        description="Their campaign history and inbox threads are removed with them. Suppression entries are kept so they are not contacted again by mistake."
        confirmLabel="Delete contacts"
        loading={bulk.isPending}
        onConfirm={() => bulk.mutate({ ids: [...selected], action: 'DELETE' })}
      />
    </div>
  );
}

function CreateContactDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = React.useState({ email: '', firstName: '', lastName: '', title: '', companyName: '', industry: '' });

  const create = useMutation({
    mutationFn: () => api.post('/contacts', form),
    onSuccess: () => {
      toast.success('Contact added');
      setForm({ email: '', firstName: '', lastName: '', title: '', companyName: '', industry: '' });
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not add contact'),
  });

  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add contact"
      description="Only the email address is required."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => create.mutate()} loading={create.isPending} disabled={!form.email}>
            Add contact
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email" required className="sm:col-span-2">
          <Input type="email" value={form.email} onChange={set('email')} placeholder="john.smith@company.com" />
        </Field>
        <Field label="First name">
          <Input value={form.firstName} onChange={set('firstName')} />
        </Field>
        <Field label="Last name">
          <Input value={form.lastName} onChange={set('lastName')} />
        </Field>
        <Field label="Title">
          <Input value={form.title} onChange={set('title')} />
        </Field>
        <Field label="Company">
          <Input value={form.companyName} onChange={set('companyName')} />
        </Field>
        <Field label="Industry" className="sm:col-span-2">
          <Input value={form.industry} onChange={set('industry')} />
        </Field>
      </div>
    </Dialog>
  );
}
