import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, CheckCircle2, Database, FileSpreadsheet, Upload } from 'lucide-react';
import Papa from 'papaparse';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { EmptyState, PageHeader } from '@/components/ui/data';
import { Checkbox, Select } from '@/components/ui/controls';
import { RoleGate } from '@/hooks/use-session';

interface SheetInput {
  name: string;
  rows: Array<Record<string, string>>;
}

/**
 * Migration from the Apps Script workbook.
 *
 * Export each sheet (Main1..Main10, Process, AutoProcess) as CSV and drop them
 * all in here. The file name becomes the sheet name, which is what decides
 * whether a campaign is created.
 */
export function MigrationPage() {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [sheets, setSheets] = React.useState<SheetInput[]>([]);
  const [analysis, setAnalysis] = React.useState<any>(null);
  const [summary, setSummary] = React.useState<any>(null);
  const [createCampaigns, setCreateCampaigns] = React.useState(true);
  const [emailAccountId, setEmailAccountId] = React.useState('');

  const { data: mapping } = useQuery({
    queryKey: ['migration-mapping'],
    queryFn: () => api.get<Array<{ legacy: string; target: string }>>('/migration/mapping'),
  });

  const { data: mailboxes } = useQuery({
    queryKey: ['email-accounts'],
    queryFn: () => api.get<Array<{ id: string; email: string }>>('/email-accounts'),
  });

  const analyze = useMutation({
    mutationFn: (input: SheetInput[]) => api.post<any>('/migration/analyze', { sheets: input, createCampaigns }),
    onSuccess: (result) => setAnalysis(result),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not analyse those sheets'),
  });

  const run = useMutation({
    mutationFn: () =>
      api.post<any>('/migration/import', {
        sheets,
        createCampaigns,
        emailAccountId: emailAccountId || null,
      }),
    onSuccess: (result) => {
      setSummary(result);
      toast.success('Migration complete');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Migration failed'),
  });

  const handleFiles = async (files: FileList) => {
    const parsed: SheetInput[] = [];
    for (const file of Array.from(files)) {
      const text = await file.text();
      const result = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: 'greedy',
        transformHeader: (header) => header.trim(),
      });
      parsed.push({ name: file.name.replace(/\.[^.]+$/, ''), rows: result.data.filter(Boolean) });
    }
    setSheets(parsed);
    setSummary(null);
    analyze.mutate(parsed);
  };

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Migration"
        description="Bring the Google Sheets + Apps Script system across, including Gmail thread metadata so conversations continue rather than restart."
      />

      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="1. Upload the exported sheets" subtitle="File > Download > CSV for each tab. Keep the tab name as the file name." />
            <CardBody>
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-muted/30 px-6 py-10 transition-colors hover:border-primary hover:bg-primary-muted/40"
              >
                <Upload className="size-6 text-muted-foreground" aria-hidden />
                <span className="text-[13px] font-medium text-foreground">Choose one or more CSV files</span>
                <span className="text-xs text-muted-foreground">Main1.csv, Main2.csv, Process.csv…</span>
              </button>
              <input
                ref={inputRef}
                type="file"
                accept=".csv"
                multiple
                className="sr-only"
                onChange={(event) => {
                  if (event.target.files?.length) void handleFiles(event.target.files);
                  event.target.value = '';
                }}
              />

              {sheets.length ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {sheets.map((sheet) => (
                    <Badge key={sheet.name} tone="primary">
                      <FileSpreadsheet className="size-2.5" /> {sheet.name} ({sheet.rows.length})
                    </Badge>
                  ))}
                </div>
              ) : null}
            </CardBody>
          </Card>

          {analysis ? (
            <Card>
              <CardHeader title="2. Review what will be created" subtitle="Nothing is written until you press Run migration." />
              <div className="overflow-x-auto">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Sheet</th>
                      <th scope="col" className="w-20 text-right">Rows</th>
                      <th scope="col" className="w-24 text-right">With email</th>
                      <th scope="col" className="w-24 text-right">With thread</th>
                      <th scope="col">Creates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.sheets.map((sheet: any) => (
                      <tr key={sheet.sheet}>
                        <td className="font-medium text-foreground">{sheet.sheet}</td>
                        <td className="num text-right">{sheet.rows}</td>
                        <td className="num text-right">{sheet.withEmail}</td>
                        <td className="num text-right">{sheet.withThread}</td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {sheet.willCreate.map((item: string) => (
                              <Badge key={item} tone="outline">
                                {item}
                              </Badge>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <CardBody className="space-y-4 border-t border-border">
                <Checkbox
                  id="create-campaigns"
                  checked={createCampaigns}
                  onCheckedChange={setCreateCampaigns}
                  label="Create a campaign and contact list for each Main sheet"
                />
                <div className="max-w-sm">
                  <Select
                    value={emailAccountId}
                    onValueChange={setEmailAccountId}
                    placeholder="Attach a mailbox (needed for thread metadata)"
                    options={(mailboxes ?? []).map((m) => ({ value: m.id, label: m.email }))}
                  />
                </div>

                <RoleGate minimum="MANAGER" fallback={<p className="text-xs text-muted-foreground">Only managers and above can run a migration.</p>}>
                  <Button variant="accent" onClick={() => run.mutate()} loading={run.isPending}>
                    <Database /> Run migration
                  </Button>
                </RoleGate>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon={FileSpreadsheet}
                title="Nothing uploaded yet"
                description="Upload the exported CSVs and a full breakdown of what will be created appears here first."
              />
            </Card>
          )}

          {summary ? (
            <Card>
              <CardHeader title="3. Result" subtitle="Migrated campaigns start PAUSED so you can review before anything sends." />
              <CardBody className="space-y-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 text-success" aria-hidden />
                  <p className="text-[13px] font-medium text-foreground">Migration complete</p>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ['Contacts created', summary.contacts.created],
                    ['Contacts updated', summary.contacts.updated],
                    ['Campaigns', summary.campaigns],
                    ['Lists', summary.lists],
                    ['Campaign contacts', summary.campaignContacts],
                    ['Threads', summary.threads],
                    ['Messages', summary.messages],
                    ['Skipped rows', summary.skipped],
                  ].map(([label, value]) => (
                    <div key={label as string} className="rounded-md border border-border p-2.5">
                      <p className="text-2xs text-muted-foreground">{label}</p>
                      <p className="num text-lg font-semibold text-foreground">{value as number}</p>
                    </div>
                  ))}
                </div>

                {summary.notes?.length ? (
                  <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                    {summary.notes.map((note: string) => (
                      <li key={note}>• {note}</li>
                    ))}
                  </ul>
                ) : null}
              </CardBody>
            </Card>
          ) : null}
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader title="How the old model maps across" />
            <CardBody className="space-y-2">
              {(mapping ?? []).map((row) => (
                <div key={row.legacy} className="rounded-md border border-border p-2.5">
                  <p className="font-mono text-2xs text-muted-foreground">{row.legacy}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-foreground">
                    <ArrowRight className="size-3 shrink-0 text-primary" aria-hidden />
                    {row.target}
                  </p>
                </div>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="What changes" />
            <CardBody>
              <ul className="space-y-2 text-xs text-muted-foreground">
                <li>
                  The fixed FollowUp1/2/3 columns become ordinary sequence steps — you can add a fourth, fifth or
                  fifteenth without touching the schema.
                </li>
                <li>
                  Script properties and time-based triggers are replaced by a durable job ledger, so progress survives
                  a restart and a completed step is never re-sent.
                </li>
                <li>
                  ThreadId and RfcMessageId carry over, so migrated conversations continue as real Gmail replies rather
                  than starting a new thread.
                </li>
                <li>Rows already marked sent get ledger entries, so migration cannot re-send anything.</li>
              </ul>
            </CardBody>
          </Card>
        </aside>
      </div>
    </div>
  );
}
