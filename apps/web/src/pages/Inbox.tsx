import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  Bot,
  Building2,
  CheckCheck,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Reply,
  Search,
  Send,
  Star,
  UserPlus,
} from 'lucide-react';
import type { Paginated, ThreadListItem } from '@mail/shared';
import { api, ApiError } from '@/lib/api';
import { cn, mailTime, fullDateTime, initialsOf, sanitizeEmailHtml } from '@/lib/utils';
import { Avatar, Badge, Button, Input, Spinner, StatusBadge } from '@/components/ui/primitives';
import { EmptyState } from '@/components/ui/data';
import { Tooltip } from '@/components/ui/controls';
import { AiReplyAssistant } from '@/components/inbox/AiReplyAssistant';

const FOLDERS = [
  { value: 'ALL', label: 'All mail', icon: InboxIcon, countKey: 'all' },
  { value: 'UNREAD', label: 'Unread', icon: Mail, countKey: 'unread' },
  { value: 'IMPORTANT', label: 'Important', icon: Star, countKey: 'important' },
  { value: 'REPLIED', label: 'Replied', icon: Reply, countKey: 'replied' },
  { value: 'WAITING', label: 'Waiting for reply', icon: Send, countKey: 'waiting' },
  { value: 'AI_SUGGESTED', label: 'AI suggested', icon: Bot, countKey: 'aiSuggested' },
  { value: 'ARCHIVED', label: 'Archived', icon: Archive, countKey: 'archived' },
] as const;

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();

  const folder = params.get('folder') ?? 'ALL';
  const selectedId = params.get('thread');
  const [search, setSearch] = React.useState(params.get('q') ?? '');
  const [debounced, setDebounced] = React.useState(params.get('q') ?? '');

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(search), 350);
    return () => clearTimeout(timer);
  }, [search]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const { data: counts } = useQuery({
    queryKey: ['inbox-counts'],
    queryFn: () => api.get<any>('/inbox/counts'),
    refetchInterval: 45_000,
  });

  const listQuery = new URLSearchParams({
    folder,
    pageSize: '40',
    ...(debounced ? { q: debounced } : {}),
  });

  const { data: threads, isLoading } = useQuery({
    queryKey: ['inbox', listQuery.toString()],
    queryFn: () => api.get<Paginated<ThreadListItem>>(`/inbox?${listQuery.toString()}`),
    refetchInterval: 30_000,
  });

  const sync = useMutation({
    mutationFn: () => api.post<{ queued: number }>('/inbox/sync'),
    onSuccess: (data) => toast.success(`Sync queued for ${data.queued} mailbox(es)`),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Sync failed'),
  });

  // Auto-select the first thread on wide screens so the reading pane is never
  // empty when there is something to read.
  React.useEffect(() => {
    if (selectedId || !threads?.items.length) return;
    if (window.innerWidth < 1024) return;
    setParam('thread', threads.items[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads?.items, selectedId]);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col lg:flex-row">
      {/* Panel 1 — folders */}
      <nav className="hidden w-52 shrink-0 flex-col border-r border-border bg-surface lg:flex" aria-label="Inbox folders">
        <div className="border-b border-border px-3 py-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => sync.mutate()}
            loading={sync.isPending}
          >
            <RefreshCw /> Sync mailboxes
          </Button>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {FOLDERS.map((item) => {
            const Icon = item.icon;
            const count = counts?.folders?.[item.countKey] ?? 0;
            const active = folder === item.value;
            return (
              <li key={item.value}>
                <button
                  type="button"
                  onClick={() => {
                    setParam('folder', item.value === 'ALL' ? null : item.value);
                    setParam('thread', null);
                  }}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150',
                    active ? 'bg-primary-muted font-medium text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{item.label}</span>
                  {count > 0 ? <span className="num ml-auto text-2xs">{count}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="border-t border-border p-2">
          <Link
            to="/ai-inbox"
            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Bot className="size-4" aria-hidden /> AI inbox
          </Link>
        </div>
      </nav>

      {/* Panel 2 — thread list */}
      <section
        className={cn(
          'flex min-h-0 w-full shrink-0 flex-col border-r border-border bg-surface lg:w-96',
          selectedId ? 'hidden lg:flex' : 'flex',
        )}
        aria-label="Email list"
      >
        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="from:  subject:  campaign:  company:  status:"
              className="pl-8"
              aria-label="Search inbox"
            />
          </div>
          <p className="mt-1.5 text-2xs text-muted-foreground">
            {threads ? `${threads.total} conversation${threads.total === 1 ? '' : 's'}` : 'loading…'}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-px p-2">
              {Array.from({ length: 8 }).map((_, index) => (
                <div key={index} className="space-y-2 p-2">
                  <div className="skeleton h-3 w-32" />
                  <div className="skeleton h-3 w-full" />
                </div>
              ))}
            </div>
          ) : !threads?.items.length ? (
            <EmptyState
              compact
              icon={InboxIcon}
              title="Nothing here"
              description={debounced ? 'No conversation matches that search.' : 'Replies appear here as soon as a mailbox sync picks them up.'}
              action={
                <Button variant="outline" size="sm" onClick={() => sync.mutate()} loading={sync.isPending}>
                  <RefreshCw /> Sync now
                </Button>
              }
            />
          ) : (
            <ul>
              {threads.items.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => setParam('thread', thread.id)}
                    className={cn(
                      'w-full cursor-pointer border-b border-border/70 px-3 py-2.5 text-left transition-colors duration-150',
                      selectedId === thread.id ? 'bg-primary-muted' : 'hover:bg-muted',
                      !thread.isRead && selectedId !== thread.id && 'bg-surface',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <Avatar
                        initials={initialsOf(null, null, thread.contact?.name ?? thread.participants[0])}
                        className="mt-0.5 size-7 text-2xs"
                        tone={thread.isRead ? 'muted' : 'primary'}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className={cn('truncate text-[13px]', thread.isRead ? 'text-foreground' : 'font-semibold text-foreground')}>
                            {thread.contact?.name ?? thread.participants.find((p) => p !== thread.emailAccount.email) ?? 'Unknown'}
                          </span>
                          <span className="num ml-auto shrink-0 text-2xs text-muted-foreground">{mailTime(thread.lastMessageAt)}</span>
                        </div>

                        <p className={cn('truncate text-xs', thread.isRead ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                          {thread.subject}
                        </p>
                        {thread.snippet ? (
                          <p className="mt-0.5 line-clamp-1 text-2xs text-muted-foreground">{thread.snippet}</p>
                        ) : null}

                        <div className="mt-1.5 flex flex-wrap items-center gap-1">
                          {!thread.isRead ? <Badge tone="primary">unread</Badge> : null}
                          {thread.isStarred ? <Star className="size-3 fill-accent text-accent" aria-label="Starred" /> : null}
                          {thread.hasAttachments ? <Paperclip className="size-3 text-muted-foreground" aria-label="Has attachment" /> : null}
                          {thread.campaign ? <Badge tone="outline">{thread.campaign.name}</Badge> : null}
                          {thread.ai?.intent ? <StatusBadge status={thread.ai.intent} /> : null}
                          {thread.ai?.priority === 'HIGH' ? <Badge tone="danger">high</Badge> : null}
                          {thread.ai?.hasSuggestion ? (
                            <Badge tone="success">
                              <Bot className="size-2.5" /> AI reply
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Panel 3 — thread reader */}
      <section className={cn('min-h-0 min-w-0 flex-1 bg-background', selectedId ? 'flex' : 'hidden lg:flex')} aria-label="Email thread">
        {selectedId ? (
          <ThreadReader threadId={selectedId} onBack={() => setParam('thread', null)} onChanged={() => queryClient.invalidateQueries({ queryKey: ['inbox'] })} />
        ) : (
          <div className="flex w-full items-center justify-center">
            <EmptyState icon={MailOpen} title="Select a conversation" description="Pick a thread on the left to read it, see its AI analysis and draft a reply." />
          </div>
        )}
      </section>
    </div>
  );
}

function ThreadReader({ threadId, onBack, onChanged }: { threadId: string; onBack: () => void; onChanged: () => void }) {
  const queryClient = useQueryClient();

  const { data: thread, isLoading } = useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.get<any>(`/inbox/threads/${threadId}`),
    refetchInterval: 20_000,
  });

  const action = useMutation({
    mutationFn: (name: string) => api.post(`/inbox/threads/${threadId}/action`, { action: name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      void queryClient.invalidateQueries({ queryKey: ['inbox-counts'] });
      onChanged();
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Action failed'),
  });

  const createContact = useMutation({
    mutationFn: () => api.post(`/inbox/threads/${threadId}/create-contact`),
    onSuccess: () => {
      toast.success('Contact created from this thread');
      void queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not create contact'),
  });

  // Opening a thread marks it read, exactly like a mail client.
  React.useEffect(() => {
    if (thread && !thread.isRead) action.mutate('MARK_READ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id]);

  if (isLoading || !thread) {
    return (
      <div className="flex w-full items-center justify-center">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 w-full flex-col">
      <header className="shrink-0 border-b border-border bg-surface px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Button variant="ghost" size="sm" className="mb-1 lg:hidden" onClick={onBack}>
              ← Back
            </Button>
            <h2 className="truncate text-sm font-semibold text-foreground">{thread.subject}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted-foreground">
              {thread.contact ? (
                <Link to={`/contacts/${thread.contact.id}`} className="flex items-center gap-1 text-primary hover:underline">
                  {thread.contact.name}
                </Link>
              ) : (
                <span className="font-mono">{thread.participants[0]}</span>
              )}
              {thread.contact?.companyName ? (
                <span className="flex items-center gap-1">
                  <Building2 className="size-3" aria-hidden /> {thread.contact.companyName}
                </span>
              ) : null}
              {thread.campaign ? (
                <Link to={`/campaigns/${thread.campaign.id}`} className="text-primary hover:underline">
                  {thread.campaign.name}
                </Link>
              ) : null}
              {thread.sequenceStep ? <Badge tone="outline">{thread.sequenceStep}</Badge> : null}
              <span className="font-mono">via {thread.emailAccount.email}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {!thread.contact ? (
              <Tooltip content="Create a contact from this sender">
                <Button variant="ghost" size="icon-sm" onClick={() => createContact.mutate()} aria-label="Create contact">
                  <UserPlus />
                </Button>
              </Tooltip>
            ) : null}
            <Tooltip content={thread.isStarred ? 'Unstar' : 'Star'}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => action.mutate(thread.isStarred ? 'UNSTAR' : 'STAR')}
                aria-label={thread.isStarred ? 'Unstar thread' : 'Star thread'}
              >
                <Star className={cn(thread.isStarred && 'fill-accent text-accent')} />
              </Button>
            </Tooltip>
            <Tooltip content="Mark unread">
              <Button variant="ghost" size="icon-sm" onClick={() => action.mutate('MARK_UNREAD')} aria-label="Mark unread">
                <Mail />
              </Button>
            </Tooltip>
            <Tooltip content={thread.status === 'ARCHIVED' ? 'Move back to inbox' : 'Archive'}>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => action.mutate(thread.status === 'ARCHIVED' ? 'UNARCHIVE' : 'ARCHIVE')}
                aria-label={thread.status === 'ARCHIVED' ? 'Unarchive thread' : 'Archive thread'}
              >
                {thread.status === 'ARCHIVED' ? <ArchiveRestore /> : <Archive />}
              </Button>
            </Tooltip>
          </div>
        </div>

        {thread.analysis ? (
          <div className="mt-3 rounded-md border border-border bg-muted/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Bot className="size-3.5 text-primary" aria-hidden />
              <span className="text-xs font-medium text-foreground">AI summary</span>
              <StatusBadge status={thread.analysis.intent} />
              <StatusBadge status={thread.analysis.priority} />
              <StatusBadge status={thread.analysis.sentiment} />
              <span className="num ml-auto text-2xs text-muted-foreground">
                {Math.round((thread.analysis.confidence ?? 0) * 100)}% confidence · {thread.analysis.provider}
              </span>
            </div>
            {thread.analysis.summary ? (
              <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{thread.analysis.summary}</p>
            ) : null}
            {thread.analysis.nextAction && thread.analysis.nextAction !== 'NO_ACTION' ? (
              <p className="mt-1.5 text-2xs text-muted-foreground">
                Suggested next action:{' '}
                <span className="font-medium text-foreground">{thread.analysis.nextAction.replace(/_/g, ' ').toLowerCase()}</span>
                {' '}— advisory only, nothing happens without you.
              </p>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-3">
          {thread.messages.map((message: any) => (
            <MessageBlock key={message.id} message={message} mailboxEmail={thread.emailAccount.email} />
          ))}
        </div>
      </div>

      <AiReplyAssistant thread={thread} onSent={() => { onChanged(); void queryClient.invalidateQueries({ queryKey: ['thread', threadId] }); }} />
    </div>
  );
}

function MessageBlock({ message, mailboxEmail }: { message: any; mailboxEmail: string }) {
  const [expanded, setExpanded] = React.useState(true);
  const outbound = message.direction === 'OUTBOUND';

  return (
    <article className={cn('rounded-lg border bg-surface', outbound ? 'border-border' : 'border-primary/25')}>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
      >
        <Avatar
          initials={initialsOf(null, null, message.senderName ?? message.sender)}
          className="size-8 text-2xs"
          tone={outbound ? 'muted' : 'primary'}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {message.senderName ?? message.sender}
            </span>
            <Badge tone={outbound ? 'neutral' : 'primary'}>{outbound ? 'sent' : 'received'}</Badge>
            {message.isDraft ? <Badge tone="warning">draft</Badge> : null}
            <span className="num ml-auto shrink-0 text-2xs text-muted-foreground">
              {fullDateTime(message.sentAt ?? message.receivedAt ?? message.createdAt)}
            </span>
          </div>
          <p className="truncate font-mono text-2xs text-muted-foreground">
            {message.sender === mailboxEmail ? `to ${message.recipients.join(', ') || '—'}` : `to ${mailboxEmail}`}
          </p>
          {!expanded && message.snippet ? (
            <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{message.snippet}</p>
          ) : null}
        </div>
      </button>

      {expanded ? (
        <div className="border-t border-border px-4 py-3">
          {message.bodyHtml ? (
            <div className="email-body" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(message.bodyHtml) }} />
          ) : (
            <pre className="email-body whitespace-pre-wrap font-sans">{message.bodyText}</pre>
          )}

          {message.attachments?.length ? (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
              {message.attachments.map((attachment: any) => (
                <span
                  key={attachment.id}
                  className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-2xs text-muted-foreground"
                >
                  <Paperclip className="size-3" aria-hidden />
                  {attachment.filename}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export { CheckCheck };
