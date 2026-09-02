import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Copy,
  FileText,
  History,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { AI_REPLY_LENGTHS, AI_REPLY_STYLES } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { cn, plainToHtml, relative, titleCase } from '@/lib/utils';
import { Badge, Button, Field, Spinner, Textarea } from '@/components/ui/primitives';
import { SegmentedControl, Select, Tooltip } from '@/components/ui/controls';
import { RoleGate } from '@/hooks/use-session';

const QUICK_EDITS = [
  { action: 'SHORTEN', label: 'Shorter' },
  { action: 'EXPAND', label: 'Expand' },
  { action: 'MAKE_PROFESSIONAL', label: 'Professional' },
  { action: 'MAKE_FRIENDLY', label: 'Friendly' },
  { action: 'IMPROVE_GRAMMAR', label: 'Fix grammar' },
  { action: 'MAKE_PERSUASIVE', label: 'More persuasive' },
  { action: 'REMOVE_SALES_LANGUAGE', label: 'Less salesy' },
  { action: 'ADD_MEETING_CTA', label: 'Add meeting CTA' },
] as const;

interface Suggestion {
  id: string;
  style: string;
  length: string;
  suggestion: string;
  provider: string;
  model: string | null;
  promptVersion: string;
  selected: boolean;
  sent: boolean;
  createdAt: string;
}

/**
 * The composer.
 *
 * AI never sends on its own: the default action is "Save draft", and sending
 * requires a second, explicit click on a separate button.
 */
export function AiReplyAssistant({ thread, onSent }: { thread: any; onSent: () => void }) {
  const queryClient = useQueryClient();

  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [style, setStyle] = React.useState('PROFESSIONAL');
  const [length, setLength] = React.useState('MEDIUM');
  const [instructions, setInstructions] = React.useState('');
  const [variants, setVariants] = React.useState<Suggestion[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = React.useState<string | null>(null);
  const [showHistory, setShowHistory] = React.useState(false);

  const { data: settings } = useQuery({
    queryKey: ['ai-settings'],
    queryFn: () => api.get<any>('/ai/settings'),
  });

  const { data: history } = useQuery({
    queryKey: ['ai-history', thread.id],
    queryFn: () => api.get<Suggestion[]>(`/ai/threads/${thread.id}/history`),
    enabled: showHistory,
  });

  // Any suggestion the worker pre-generated shows up as soon as the panel opens.
  React.useEffect(() => {
    if (thread.suggestions?.length && !variants.length) {
      setVariants(thread.suggestions.slice(0, 3));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.suggestions]);

  const generate = useMutation({
    mutationFn: (count: number) =>
      api.post<{ suggestions: Suggestion[]; provider: string }>('/ai/generate-reply', {
        threadId: thread.id,
        style,
        length,
        customInstructions: instructions || undefined,
        variants: count,
      }),
    onSuccess: (data) => {
      setVariants(data.suggestions);
      if (data.suggestions[0]) {
        setDraft(data.suggestions[0].suggestion);
        setActiveSuggestionId(data.suggestions[0].id);
      }
      setOpen(true);
      toast.success(`${data.suggestions.length} suggestion(s) from ${data.provider}`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Generation failed'),
  });

  const edit = useMutation({
    mutationFn: (action: string) =>
      api.post<Suggestion>('/ai/edit', { threadId: thread.id, draft, action }),
    onSuccess: (data) => {
      setDraft(data.suggestion);
      setActiveSuggestionId(data.id);
      toast.success('Draft updated');
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Edit failed'),
  });

  const submit = useMutation({
    mutationFn: (mode: 'DRAFT' | 'SEND') =>
      api.post(`/inbox/threads/${thread.id}/reply`, {
        bodyHtml: plainToHtml(draft),
        mode,
        suggestionId: activeSuggestionId ?? undefined,
      }),
    onSuccess: (_data, mode) => {
      toast.success(mode === 'SEND' ? 'Reply queued for sending' : 'Draft saved to the mailbox');
      setDraft('');
      setVariants([]);
      setActiveSuggestionId(null);
      setOpen(false);
      onSent();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not queue reply'),
  });

  const saveAsTemplate = useMutation({
    mutationFn: () => api.post(`/ai/suggestions/${activeSuggestionId}/save-as-template`, {}),
    onSuccess: () => {
      toast.success('Saved as a template');
      void queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not save template'),
  });

  const aiEnabled = settings?.enableAIReply !== false;

  if (!open) {
    return (
      <div className="shrink-0 border-t border-border bg-surface px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-2">
          <Button variant="primary" onClick={() => setOpen(true)}>
            <Send /> Reply
          </Button>
          <RoleGate minimum="USER">
            <Button
              variant="outline"
              onClick={() => generate.mutate(3)}
              loading={generate.isPending}
              disabled={!aiEnabled}
            >
              <Sparkles /> Generate AI reply
            </Button>
          </RoleGate>
          {thread.suggestions?.length ? (
            <Badge tone="success">
              <Bot className="size-2.5" /> {thread.suggestions.length} suggestion(s) ready
            </Badge>
          ) : null}
          {!aiEnabled ? <span className="text-2xs text-muted-foreground">AI replies are disabled for this workspace.</span> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="max-h-[62vh] shrink-0 overflow-y-auto border-t border-border bg-surface">
      <div className="mx-auto max-w-3xl px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-primary" aria-hidden />
            <h3 className="text-[13px] font-semibold text-foreground">AI reply assistant</h3>
            {settings ? (
              <Badge tone="outline">
                {settings.provider}
                {settings.model ? ` · ${settings.model}` : ''}
              </Badge>
            ) : null}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Collapse composer">
            <ChevronDown />
          </Button>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Tone">
            <Select
              value={style}
              onValueChange={setStyle}
              options={AI_REPLY_STYLES.map((s) => ({ value: s, label: titleCase(s) }))}
            />
          </Field>
          <Field label="Length">
            <SegmentedControl
              value={length}
              onChange={setLength}
              options={AI_REPLY_LENGTHS.map((l) => ({ value: l, label: titleCase(l) }))}
              className="w-full"
            />
          </Field>
          <Field label="Custom instructions" hint="e.g. keep it under 80 words and ask for a meeting next week">
            <Textarea
              rows={1}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              className="min-h-9"
              placeholder="Optional"
            />
          </Field>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => generate.mutate(1)} loading={generate.isPending} disabled={!aiEnabled}>
            <Sparkles /> Generate
          </Button>
          <Button variant="outline" size="sm" onClick={() => generate.mutate(3)} loading={generate.isPending} disabled={!aiEnabled}>
            <Wand2 /> 3 options
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowHistory((v) => !v)}>
            <History /> History
          </Button>
        </div>

        {variants.length > 1 ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {variants.map((variant) => (
              <button
                key={variant.id}
                type="button"
                onClick={() => {
                  setDraft(variant.suggestion);
                  setActiveSuggestionId(variant.id);
                }}
                className={cn(
                  'cursor-pointer rounded-md border p-2.5 text-left transition-colors',
                  activeSuggestionId === variant.id ? 'border-primary bg-primary-muted' : 'border-border hover:bg-muted',
                )}
              >
                <Badge tone={activeSuggestionId === variant.id ? 'primary' : 'outline'}>{titleCase(variant.style)}</Badge>
                <p className="mt-1.5 line-clamp-4 whitespace-pre-line text-2xs leading-snug text-muted-foreground">
                  {variant.suggestion}
                </p>
              </button>
            ))}
          </div>
        ) : null}

        {showHistory ? (
          <div className="mt-3 max-h-40 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
            {!history?.length ? (
              <p className="py-3 text-center text-2xs text-muted-foreground">Nothing generated for this thread yet.</p>
            ) : (
              history.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setDraft(item.suggestion);
                    setActiveSuggestionId(item.id);
                  }}
                  className="w-full cursor-pointer rounded border border-border p-2 text-left transition-colors hover:bg-muted"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="outline">{titleCase(item.style)}</Badge>
                    <Badge tone="outline">{item.promptVersion}</Badge>
                    {item.sent ? <Badge tone="success">sent</Badge> : null}
                    <span className="num ml-auto text-2xs text-muted-foreground">{relative(item.createdAt)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-2xs text-muted-foreground">{item.suggestion}</p>
                </button>
              ))
            )}
          </div>
        ) : null}

        <div className="mt-3">
          <Field label="Reply">
            <Textarea
              rows={8}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write your reply, or generate a draft and edit it here."
              className="font-sans"
            />
          </Field>
        </div>

        {draft ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK_EDITS.map((item) => (
              <Button
                key={item.action}
                variant="outline"
                size="sm"
                onClick={() => edit.mutate(item.action)}
                loading={edit.isPending && edit.variables === item.action}
                disabled={!aiEnabled}
              >
                {item.label}
              </Button>
            ))}
            <Button variant="outline" size="sm" onClick={() => generate.mutate(1)} disabled={!aiEnabled}>
              <RefreshCw /> Regenerate
            </Button>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Tooltip content="Writes the reply into the mailbox as a draft. Nothing is sent.">
            <Button variant="primary" onClick={() => submit.mutate('DRAFT')} loading={submit.isPending} disabled={!draft.trim()}>
              <Save /> Save draft
            </Button>
          </Tooltip>

          <RoleGate minimum="USER">
            <Button variant="accent" onClick={() => submit.mutate('SEND')} loading={submit.isPending} disabled={!draft.trim()}>
              <Send /> Send reply
            </Button>
          </RoleGate>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard.writeText(draft);
              toast.success('Copied to clipboard');
            }}
            disabled={!draft.trim()}
          >
            <Copy /> Copy
          </Button>

          {activeSuggestionId ? (
            <Button variant="ghost" size="sm" onClick={() => saveAsTemplate.mutate()} loading={saveAsTemplate.isPending}>
              <FileText /> Save as template
            </Button>
          ) : null}

          <span className="ml-auto text-2xs text-muted-foreground">
            {generate.isPending || edit.isPending ? (
              <span className="flex items-center gap-1.5">
                <Spinner className="size-3" /> thinking…
              </span>
            ) : (
              'Nothing is sent until you press Send.'
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

export { ChevronUp };
