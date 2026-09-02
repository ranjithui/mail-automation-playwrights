import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, FileText, Monitor, Paperclip, Pencil, Plus, Smartphone, Trash2, Upload } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn, fileSize, relative, sanitizeEmailHtml } from '@/lib/utils';
import { Badge, Button, Card, CardBody, Field, Input, Spinner, Textarea } from '@/components/ui/primitives';
import { EmptyState, PageHeader } from '@/components/ui/data';
import { SegmentedControl, Select, Tooltip } from '@/components/ui/controls';
import { ConfirmDialog, Sheet } from '@/components/ui/overlays';
import { RoleGate } from '@/hooks/use-session';

interface Template {
  id: string;
  name: string;
  category: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
  description: string | null;
  usedInSteps: number;
  variables: string[];
  attachments: Array<{ id: string; filename: string; size: number; mimeType: string }>;
  updatedAt: string;
}

export function TemplatesPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState<Template | 'new' | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<Template | null>(null);
  const [category, setCategory] = React.useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.get<Template[]>('/templates'),
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post(`/templates/${id}/duplicate`),
    onSuccess: () => {
      toast.success('Template duplicated');
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Duplicate failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/templates/${id}`),
    onSuccess: () => {
      toast.success('Template deleted');
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Delete failed'),
  });

  const categories = React.useMemo(() => [...new Set((data ?? []).map((t) => t.category))].sort(), [data]);
  const templates = category ? (data ?? []).filter((t) => t.category === category) : data ?? [];

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Templates"
        description="Reusable subjects and bodies with merge fields, previewed exactly as they will send."
        actions={
          <RoleGate minimum="USER">
            <Button variant="primary" onClick={() => setEditing('new')}>
              <Plus /> New template
            </Button>
          </RoleGate>
        }
      />

      {categories.length > 1 ? (
        <SegmentedControl
          value={category}
          onChange={setCategory}
          options={[{ value: '', label: 'All' }, ...categories.map((c) => ({ value: c, label: c.toLowerCase() }))]}
        />
      ) : null}

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index}>
              <CardBody>
                <div className="skeleton h-4 w-40" />
                <div className="skeleton mt-2 h-3 w-full" />
                <div className="skeleton mt-2 h-3 w-3/4" />
              </CardBody>
            </Card>
          ))}
        </div>
      ) : !templates.length ? (
        <Card>
          <EmptyState
            icon={FileText}
            title="No templates yet"
            description="Write once, then reuse across every sequence step. Merge fields fill in from each contact."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus /> Create template
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <Card key={template.id} className="flex flex-col">
              <CardBody className="flex flex-1 flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-foreground">{template.name}</p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{template.subject}</p>
                  </div>
                  <Badge tone="outline">{template.category.toLowerCase()}</Badge>
                </div>

                <div
                  className="email-body line-clamp-4 flex-1 rounded border border-border bg-muted/30 p-2.5 text-2xs"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(template.bodyHtml) }}
                />

                {template.variables.length ? (
                  <div className="flex flex-wrap gap-1">
                    {template.variables.slice(0, 4).map((variable) => (
                      <Badge key={variable} tone="primary" className="font-mono">
                        {variable}
                      </Badge>
                    ))}
                    {template.variables.length > 4 ? <Badge tone="outline">+{template.variables.length - 4}</Badge> : null}
                  </div>
                ) : null}

                <div className="flex items-center gap-2 border-t border-border pt-2.5 text-2xs text-muted-foreground">
                  {template.usedInSteps ? <span>used in {template.usedInSteps} step(s)</span> : <span>unused</span>}
                  {template.attachments.length ? (
                    <span className="flex items-center gap-1">
                      <Paperclip className="size-3" aria-hidden /> {template.attachments.length}
                    </span>
                  ) : null}
                  <span className="ml-auto">{relative(template.updatedAt)}</span>
                </div>

                <RoleGate minimum="USER">
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => setEditing(template)}>
                      <Pencil /> Edit
                    </Button>
                    <Tooltip content="Duplicate">
                      <Button variant="ghost" size="icon-sm" onClick={() => duplicate.mutate(template.id)} aria-label={`Duplicate ${template.name}`}>
                        <Copy />
                      </Button>
                    </Tooltip>
                    <Tooltip content="Delete">
                      <Button variant="ghost" size="icon-sm" onClick={() => setPendingDelete(template)} aria-label={`Delete ${template.name}`}>
                        <Trash2 />
                      </Button>
                    </Tooltip>
                  </div>
                </RoleGate>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {editing ? <TemplateEditor template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name}"?`}
        description={
          pendingDelete?.usedInSteps
            ? `This template is used by ${pendingDelete.usedInSteps} sequence step(s). Those steps will lose their content and need a new template before they can send.`
            : 'The template is removed. Emails already sent are unaffected.'
        }
        confirmLabel="Delete template"
        loading={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete.id)}
      />
    </div>
  );
}

function TemplateEditor({ template, onClose }: { template: Template | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [form, setForm] = React.useState({
    name: template?.name ?? '',
    category: template?.category ?? 'OUTREACH',
    subject: template?.subject ?? '',
    bodyHtml: template?.bodyHtml ?? '<p>Hi {{First Name | there}},</p>\n<p></p>',
    description: template?.description ?? '',
    attachmentIds: template?.attachments.map((a) => a.id) ?? [],
  });
  const [device, setDevice] = React.useState<'desktop' | 'mobile'>('desktop');

  const { data: variables } = useQuery({
    queryKey: ['template-variables'],
    queryFn: () => api.get<{ standard: string[]; custom: string[] }>('/templates/variables'),
  });

  const { data: attachments } = useQuery({
    queryKey: ['attachments'],
    queryFn: () => api.get<Array<{ id: string; filename: string; size: number; mimeType: string }>>('/attachments'),
  });

  const { data: preview, isFetching: previewing } = useQuery({
    queryKey: ['template-preview', form.subject, form.bodyHtml],
    queryFn: () => api.post<any>('/templates/preview', { subject: form.subject, bodyHtml: form.bodyHtml }),
    enabled: Boolean(form.subject || form.bodyHtml),
  });

  const save = useMutation({
    mutationFn: () =>
      template ? api.patch(`/templates/${template.id}`, form) : api.post('/templates', form),
    onSuccess: () => {
      toast.success(template ? 'Template updated' : 'Template created');
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
      onClose();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Save failed'),
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return api.upload<{ id: string; filename: string }>('/attachments', body);
    },
    onSuccess: (result) => {
      setForm((prev) => ({ ...prev, attachmentIds: [...prev.attachmentIds, result.id] }));
      void queryClient.invalidateQueries({ queryKey: ['attachments'] });
      toast.success(`${result.filename} uploaded`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Upload failed'),
  });

  const insertVariable = (variable: string) =>
    setForm((prev) => ({ ...prev, bodyHtml: `${prev.bodyHtml}{{${variable}}}` }));

  return (
    <Sheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={template ? `Edit "${template.name}"` : 'New template'}
      description="Merge fields render live on the right using a sample contact."
      width="max-w-5xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!form.name || !form.subject}>
            {template ? 'Save changes' : 'Create template'}
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={form.name} onChange={(event) => setForm((p) => ({ ...p, name: event.target.value }))} />
            </Field>
            <Field label="Category">
              <Select
                value={form.category}
                onValueChange={(value) => setForm((p) => ({ ...p, category: value }))}
                options={['OUTREACH', 'FOLLOWUP', 'REPLY', 'GENERAL', 'AI'].map((c) => ({ value: c, label: c.toLowerCase() }))}
              />
            </Field>
          </div>

          <Field label="Subject" required hint="Merge fields work here too.">
            <Input value={form.subject} onChange={(event) => setForm((p) => ({ ...p, subject: event.target.value }))} />
          </Field>

          <Field label="Body (HTML)" required>
            <Textarea
              rows={14}
              value={form.bodyHtml}
              onChange={(event) => setForm((p) => ({ ...p, bodyHtml: event.target.value }))}
              className="font-mono text-xs"
            />
          </Field>

          <div>
            <p className="mb-1.5 text-xs font-medium text-foreground">Insert a variable</p>
            <div className="flex max-h-28 flex-wrap gap-1 overflow-y-auto">
              {[...(variables?.standard ?? []), ...(variables?.custom ?? [])].map((variable) => (
                <button
                  key={variable}
                  type="button"
                  onClick={() => insertVariable(variable)}
                  className="cursor-pointer rounded border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground transition-colors hover:bg-primary-muted hover:text-primary"
                >
                  {`{{${variable}}}`}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-xs font-medium text-foreground">Attachments</p>
              <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} loading={upload.isPending}>
                <Upload /> Upload
              </Button>
              <input
                ref={fileRef}
                type="file"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) upload.mutate(file);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="space-y-1">
              {!attachments?.length ? (
                <p className="text-2xs text-muted-foreground">No files uploaded yet. PDF, DOCX, XLSX, PPTX, images and ZIP are supported.</p>
              ) : (
                attachments.map((file) => {
                  const attached = form.attachmentIds.includes(file.id);
                  return (
                    <button
                      key={file.id}
                      type="button"
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          attachmentIds: attached
                            ? prev.attachmentIds.filter((id) => id !== file.id)
                            : [...prev.attachmentIds, file.id],
                        }))
                      }
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors',
                        attached ? 'border-primary bg-primary-muted' : 'border-border hover:bg-muted',
                      )}
                    >
                      <Paperclip className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-2xs text-foreground">{file.filename}</span>
                      <span className="num shrink-0 text-2xs text-muted-foreground">{fileSize(file.size)}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-foreground">Live preview</p>
            <SegmentedControl
              value={device}
              onChange={setDevice}
              options={[
                { value: 'desktop', label: 'Desktop', icon: <Monitor className="size-3" /> },
                { value: 'mobile', label: 'Mobile', icon: <Smartphone className="size-3" /> },
              ]}
            />
          </div>

          {preview?.issues?.length ? (
            <div className="rounded-md border border-warning/30 bg-warning-muted p-2.5">
              <p className="text-2xs font-medium text-foreground">Check these variables</p>
              <ul className="mt-1 space-y-0.5 text-2xs text-muted-foreground">
                {preview.issues.map((issue: any) => (
                  <li key={`${issue.variable}-${issue.reason}`}>
                    <span className="font-mono">{`{{${issue.variable}}}`}</span>{' '}
                    {issue.reason === 'UNKNOWN_VARIABLE' ? 'is not a known field' : 'is empty for the sample contact'}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className={cn('mx-auto w-full rounded-lg border border-border bg-surface', device === 'mobile' && 'max-w-sm')}>
            <div className="border-b border-border px-3 py-2">
              <p className="text-2xs text-muted-foreground">Subject</p>
              <p className="truncate text-[13px] font-medium text-foreground">
                {previewing ? <Spinner className="size-3" /> : preview?.subject || '—'}
              </p>
            </div>
            <div
              className="email-body max-h-[420px] overflow-y-auto px-3 py-3"
              dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(preview?.bodyHtml ?? '') }}
            />
          </div>

          {preview?.context ? (
            <div className="rounded-md border border-border bg-muted/40 p-2.5">
              <p className="text-2xs font-medium text-foreground">Sample contact used for this preview</p>
              <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-2xs">
                {Object.entries(preview.context)
                  .slice(0, 8)
                  .map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-2">
                      <dt className="truncate text-muted-foreground">{key}</dt>
                      <dd className="truncate text-right text-foreground">{String(value) || '—'}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
