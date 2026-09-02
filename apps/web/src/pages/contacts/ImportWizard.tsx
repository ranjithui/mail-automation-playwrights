import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Badge, Button, Field, Input } from '@/components/ui/primitives';
import { Checkbox, Select } from '@/components/ui/controls';
import { Dialog } from '@/components/ui/overlays';

interface ParseResult {
  headers: string[];
  fields: Array<{ key: string; label: string; required?: boolean }>;
  mapping: Record<string, string>;
  preview: Array<Record<string, string>>;
  totalRows: number;
  rows: Array<Record<string, string>>;
  stats: { valid: number; invalid: number; duplicatesInFile: number; alreadyInWorkspace: number };
  errors: Array<{ row: number; message: string }>;
}

/**
 * Upload → detect columns → map → validate → preview → detect duplicates →
 * import. Nothing is written until the final step, and validation errors are
 * always shown before that point.
 */
export function ImportWizard({
  open,
  onOpenChange,
  lists,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lists: Array<{ id: string; name: string }>;
}) {
  const queryClient = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [stage, setStage] = React.useState<'upload' | 'map' | 'done'>('upload');
  const [parsed, setParsed] = React.useState<ParseResult | null>(null);
  const [mapping, setMapping] = React.useState<Record<string, string>>({});
  const [listId, setListId] = React.useState('');
  const [newListName, setNewListName] = React.useState('');
  const [skipDuplicates, setSkipDuplicates] = React.useState(true);
  const [updateExisting, setUpdateExisting] = React.useState(false);
  const [summary, setSummary] = React.useState<{ created: number; updated: number; skipped: number } | null>(null);

  const reset = () => {
    setStage('upload');
    setParsed(null);
    setMapping({});
    setListId('');
    setNewListName('');
    setSummary(null);
  };

  const parse = useMutation({
    mutationFn: (file: File) => {
      const body = new FormData();
      body.append('file', file);
      return api.upload<ParseResult>('/contacts/import/parse', body);
    },
    onSuccess: (result) => {
      setParsed(result);
      setMapping(result.mapping);
      setStage('map');
      if (!Object.values(result.mapping).includes('email')) {
        toast.warning('No email column detected — map one before importing.');
      }
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not read that file'),
  });

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ created: number; updated: number; skipped: number }>('/contacts/import/commit', {
        mapping,
        rows: parsed?.rows ?? [],
        listId: listId || null,
        createList: newListName.trim() || null,
        skipDuplicates,
        updateExisting,
      }),
    onSuccess: (result) => {
      setSummary(result);
      setStage('done');
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      void queryClient.invalidateQueries({ queryKey: ['contact-lists'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Import failed'),
  });

  const hasEmail = Object.values(mapping).includes('email');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title="Import contacts"
      description="CSV or XLSX. Columns are detected automatically and everything is validated before anything is written."
      size="lg"
      footer={
        stage === 'map' ? (
          <>
            <Button variant="outline" onClick={reset}>
              Choose another file
            </Button>
            <Button variant="primary" onClick={() => commit.mutate()} loading={commit.isPending} disabled={!hasEmail}>
              Import {parsed?.stats.valid ?? 0} contact(s)
            </Button>
          </>
        ) : stage === 'done' ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : undefined
      }
    >
      {stage === 'upload' ? (
        <div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/30 px-6 py-12 transition-colors hover:border-primary hover:bg-primary-muted/40"
          >
            <Upload className="size-6 text-muted-foreground" aria-hidden />
            <span className="text-[13px] font-medium text-foreground">Choose a CSV or XLSX file</span>
            <span className="text-xs text-muted-foreground">Up to 20 MB · first row must be the header</span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xlsm,.txt"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) parse.mutate(file);
              event.target.value = '';
            }}
          />
          {parse.isPending ? <p className="mt-3 text-center text-xs text-muted-foreground">Reading file…</p> : null}

          <div className="mt-5 rounded-md border border-border bg-muted/40 p-3">
            <p className="text-xs font-medium text-foreground">Recognised columns</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Email, First Name, Last Name, Title, Company Name, Corporate Phone, Employees, Industry, Keywords,
              Person LinkedIn URL, Website, Company LinkedIn URL, Company Address, City, State, Country, Qualify
              Contact. Anything else is kept as a custom field and stays usable as a template variable.
            </p>
          </div>
        </div>
      ) : null}

      {stage === 'map' && parsed ? (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: 'Valid rows', value: parsed.stats.valid, tone: 'success' as const },
              { label: 'Invalid', value: parsed.stats.invalid, tone: parsed.stats.invalid ? ('danger' as const) : ('neutral' as const) },
              { label: 'Duplicates in file', value: parsed.stats.duplicatesInFile, tone: 'warning' as const },
              { label: 'Already in workspace', value: parsed.stats.alreadyInWorkspace, tone: 'info' as const },
            ].map((stat) => (
              <div key={stat.label} className="rounded-md border border-border p-2.5">
                <p className="text-2xs text-muted-foreground">{stat.label}</p>
                <p className="num mt-0.5 text-lg font-semibold text-foreground">{stat.value}</p>
              </div>
            ))}
          </div>

          {!hasEmail ? (
            <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-muted p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              <p className="text-xs text-foreground">
                Map one column to <strong>Email</strong>. It is the only required field.
              </p>
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs font-medium text-foreground">Column mapping</p>
            <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
              {parsed.headers.map((header) => (
                <div key={header} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                  <span className="truncate font-mono text-2xs text-muted-foreground" title={header}>
                    {header}
                  </span>
                  <span className="text-muted-foreground" aria-hidden>
                    →
                  </span>
                  <Select
                    value={mapping[header] ?? ''}
                    onValueChange={(value) =>
                      setMapping((prev) => {
                        const next = { ...prev };
                        if (value === '__skip') delete next[header];
                        else if (value === '__custom') next[header] = header;
                        else next[header] = value;
                        return next;
                      })
                    }
                    placeholder="Skip this column"
                    className="h-8"
                    options={[
                      { value: '__skip', label: 'Skip this column' },
                      { value: '__custom', label: `Custom field "${header}"` },
                      ...parsed.fields.map((field) => ({
                        value: field.key,
                        label: field.label + (field.required ? ' (required)' : ''),
                      })),
                    ]}
                  />
                </div>
              ))}
            </div>
          </div>

          {parsed.errors.length ? (
            <div className="rounded-md border border-warning/30 bg-warning-muted p-3">
              <p className="text-xs font-medium text-foreground">
                {parsed.stats.invalid} row(s) will be skipped
              </p>
              <ul className="mt-1.5 max-h-24 space-y-0.5 overflow-y-auto text-2xs text-muted-foreground">
                {parsed.errors.map((issue) => (
                  <li key={`${issue.row}-${issue.message}`}>Row {issue.row}: {issue.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <p className="mb-2 text-xs font-medium text-foreground">Preview (first 5 rows)</p>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="data-table">
                <thead>
                  <tr>
                    {parsed.headers.slice(0, 6).map((header) => (
                      <th key={header} scope="col">
                        {mapping[header] ? <Badge tone="primary">{mapping[header]}</Badge> : header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsed.preview.slice(0, 5).map((row, index) => (
                    <tr key={index}>
                      {parsed.headers.slice(0, 6).map((header) => (
                        <td key={header} className="max-w-40 truncate">
                          {row[header]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Add to existing list">
              <Select
                value={listId}
                onValueChange={(value) => {
                  setListId(value === '__none' ? '' : value);
                  if (value !== '__none') setNewListName('');
                }}
                placeholder="No list"
                options={[{ value: '__none', label: 'No list' }, ...lists.map((l) => ({ value: l.id, label: l.name }))]}
              />
            </Field>
            <Field label="Or create a new list">
              <Input
                value={newListName}
                onChange={(event) => {
                  setNewListName(event.target.value);
                  if (event.target.value) setListId('');
                }}
                placeholder="Q4 prospects"
              />
            </Field>
          </div>

          <div className="space-y-2 rounded-md border border-border p-3">
            <Checkbox id="skip-dupes" checked={skipDuplicates} onCheckedChange={setSkipDuplicates} label="Skip contacts that already exist" />
            <Checkbox
              id="update-existing"
              checked={updateExisting}
              onCheckedChange={setUpdateExisting}
              label="Update existing contacts with values from this file"
            />
          </div>
        </div>
      ) : null}

      {stage === 'done' && summary ? (
        <div className="py-6 text-center">
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-success-muted">
            <CheckCircle2 className="size-5 text-success" aria-hidden />
          </div>
          <p className="text-sm font-semibold text-foreground">Import complete</p>
          <div className="mx-auto mt-4 grid max-w-sm grid-cols-3 gap-2">
            {[
              ['Created', summary.created],
              ['Updated', summary.updated],
              ['Skipped', summary.skipped],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-md border border-border p-2.5">
                <p className="text-2xs text-muted-foreground">{label}</p>
                <p className="num text-lg font-semibold text-foreground">{value as number}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export const ImportIcon = FileSpreadsheet;
export const importPanelClass = cn('hidden');
