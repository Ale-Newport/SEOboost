'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Bell, CheckCheck, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiPost, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

export interface NotificationItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  link: string | null;
  isRead: boolean;
  createdAt: string;
  websiteId: string | null;
  websiteName: string | null;
}

const SEVERITY = {
  CRITICAL: { icon: AlertTriangle, className: 'text-destructive', badge: 'destructive' as const },
  WARNING: { icon: TriangleAlert, className: 'text-warning', badge: 'warning' as const },
  SUCCESS: { icon: CircleCheck, className: 'text-success', badge: 'success' as const },
  INFO: { icon: Info, className: 'text-muted-foreground', badge: 'secondary' as const },
} as const;

function humanType(type: string): string {
  return type.replace(/[._-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Group by calendar day so a long inbox stays scannable. */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(date);
}

export function NotificationList({
  notifications,
  unreadCount,
  websites,
  types,
  truncated,
  pageSize,
}: {
  notifications: NotificationItem[];
  unreadCount: number;
  websites: Array<{ id: string; name: string }>;
  types: Array<{ type: string; count: number }>;
  truncated: boolean;
  pageSize: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const unreadOnly = params.get('unread') === 'true';
  const activeType = params.get('type');
  const activeSite = params.get('site');

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null) next.delete(key);
    else next.set(key, value);
    startTransition(() => router.replace(next.size ? `/notifications?${next}` : '/notifications', { scroll: false }));
  };

  const markRead = async (id: string) => {
    setBusy(true);
    try {
      await apiPost(`/api/notifications/${id}/read`, {});
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not mark as read');
    } finally {
      setBusy(false);
    }
  };

  const markAllRead = async () => {
    setBusy(true);
    try {
      await apiPost('/api/notifications/read-all', {});
      toast.success('All notifications marked as read');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not mark all as read');
    } finally {
      setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const groups = new Map<string, NotificationItem[]>();
    for (const notification of notifications) {
      const key = dayLabel(notification.createdAt);
      const list = groups.get(key) ?? [];
      list.push(notification);
      groups.set(key, list);
    }
    return [...groups.entries()];
  }, [notifications]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={unreadOnly ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setParam('unread', unreadOnly ? null : 'true')}
          aria-pressed={unreadOnly}
        >
          Unread only{unreadCount > 0 && ` (${unreadCount})`}
        </Button>

        {websites.length > 1 && (
          <select
            value={activeSite ?? ''}
            onChange={(event) => setParam('site', event.target.value || null)}
            aria-label="Filter by website"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">All websites</option>
            {websites.map((site) => (
              <option key={site.id} value={site.id}>{site.name}</option>
            ))}
          </select>
        )}

        {types.length > 0 && (
          <select
            value={activeType ?? ''}
            onChange={(event) => setParam('type', event.target.value || null)}
            aria-label="Filter by type"
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">All types</option>
            {types.map((row) => (
              <option key={row.type} value={row.type}>{humanType(row.type)} ({row.count})</option>
            ))}
          </select>
        )}

        <div className="ml-auto">
          {unreadCount > 0 && (
            <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={busy || pending}>
              <CheckCheck className="mr-1.5 h-3.5 w-3.5" />
              Mark all read
            </Button>
          )}
        </div>
      </div>

      {notifications.length === 0 ? (
        <EmptyState
          bordered
          icon={Bell}
          title={unreadOnly || activeType || activeSite ? 'Nothing matches these filters' : 'No notifications yet'}
          description={
            unreadOnly || activeType || activeSite
              ? 'Clear the filters to see the full history.'
              : 'The analytics agent raises alerts for traffic and ranking drops, crawl failures and indexing anomalies. Run a crawl and an analysis pass to start populating this.'
          }
        />
      ) : (
        <div className="space-y-5">
          {grouped.map(([day, items]) => (
            <section key={day}>
              <h2 className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {day}
              </h2>
              <ul className="space-y-1.5">
                {items.map((notification) => {
                  const severity = SEVERITY[notification.severity as keyof typeof SEVERITY] ?? SEVERITY.INFO;
                  return (
                    <li key={notification.id}>
                      <Card className={cn(!notification.isRead && 'border-primary/30 bg-primary/[0.03]')}>
                        <CardContent className="flex items-start gap-3 p-3">
                          <severity.icon className={cn('mt-0.5 h-4 w-4 shrink-0', severity.className)} />

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className={cn('text-sm', !notification.isRead && 'font-medium')}>
                                {notification.title}
                              </p>
                              {!notification.isRead && (
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
                              )}
                              <Badge variant="outline" className="text-2xs">{humanType(notification.type)}</Badge>
                              {notification.websiteName && (
                                <span className="text-2xs text-muted-foreground">{notification.websiteName}</span>
                              )}
                            </div>
                            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                              {notification.message}
                            </p>
                            <div className="mt-1.5 flex items-center gap-3">
                              {notification.link && (
                                <Link href={notification.link} className="text-xs font-medium text-primary hover:underline">
                                  Open
                                </Link>
                              )}
                              {!notification.isRead && (
                                <button
                                  type="button"
                                  onClick={() => void markRead(notification.id)}
                                  disabled={busy}
                                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                >
                                  Mark read
                                </button>
                              )}
                              <time
                                dateTime={notification.createdAt}
                                className="ml-auto text-2xs text-muted-foreground"
                              >
                                {new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' }).format(
                                  new Date(notification.createdAt),
                                )}
                              </time>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {truncated && (
            <p className="text-center text-xs text-muted-foreground">
              Showing the most recent {pageSize} notifications. Narrow the filters to see older ones.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
