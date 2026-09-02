import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bell, CheckCheck, FileClock } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { cn, fullDateTime, relative } from '@/lib/utils';
import { Badge, Button, Card, CardBody } from '@/components/ui/primitives';
import { EmptyState, PageHeader } from '@/components/ui/data';

interface Notification {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string | null;
  linkUrl: string | null;
  isRead: boolean;
  createdAt: string;
}

export function NotificationsPage() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: Notification[]; unread: number }>('/notifications?limit=100'),
    refetchInterval: 30_000,
  });

  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => {
      toast.success('All notifications marked read');
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const digest = useMutation({
    mutationFn: () => api.post('/notifications/digest'),
    onSuccess: () => toast.success('Daily digest queued — it will appear here shortly'),
    onError: (error) => toast.error(error instanceof ApiError ? error.message : 'Could not queue the digest'),
  });

  const tone = (severity: string) =>
    severity === 'ERROR' ? 'danger' : severity === 'WARNING' ? 'warning' : severity === 'SUCCESS' ? 'success' : 'info';

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Notifications"
        description="Campaign outcomes, worker errors, authentication problems and inbound replies worth knowing about."
        actions={
          <>
            <Button variant="outline" onClick={() => digest.mutate()} loading={digest.isPending}>
              <FileClock /> Generate daily digest
            </Button>
            <Button variant="secondary" onClick={() => markAll.mutate()} loading={markAll.isPending} disabled={!data?.unread}>
              <CheckCheck /> Mark all read
            </Button>
          </>
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <Card key={index}>
              <CardBody>
                <div className="skeleton h-4 w-56" />
                <div className="skeleton mt-2 h-3 w-full" />
              </CardBody>
            </Card>
          ))}
        </div>
      ) : !data?.items.length ? (
        <Card>
          <EmptyState
            icon={Bell}
            title="Nothing to report"
            description="You will be told when a campaign completes or fails, when a mailbox session expires, when bounce rate climbs, and when an important reply arrives."
          />
        </Card>
      ) : (
        <div className="space-y-2">
          {data.items.map((notification) => (
            <Card key={notification.id} className={cn(!notification.isRead && 'border-primary/30 bg-primary-muted/30')}>
              <CardBody className="flex flex-wrap items-start gap-3">
                <Badge tone={tone(notification.severity)} className="mt-0.5 shrink-0">
                  {notification.severity.toLowerCase()}
                </Badge>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <p className="text-[13px] font-medium text-foreground">{notification.title}</p>
                    <Badge tone="outline">{notification.type.replace(/_/g, ' ').toLowerCase()}</Badge>
                    {!notification.isRead ? <Badge tone="primary">new</Badge> : null}
                    <span className="ml-auto shrink-0 text-2xs text-muted-foreground" title={fullDateTime(notification.createdAt)}>
                      {relative(notification.createdAt)}
                    </span>
                  </div>
                  {notification.body ? (
                    <p className="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{notification.body}</p>
                  ) : null}
                  {notification.linkUrl ? (
                    <Link
                      to={notification.linkUrl}
                      onClick={() => void api.post(`/notifications/${notification.id}/read`)}
                      className="mt-1.5 inline-block text-xs text-primary hover:underline"
                    >
                      Open →
                    </Link>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
