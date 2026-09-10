'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNowStrict } from 'date-fns';
import { Bell, CheckCheck, CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from '@/components/ui/toast';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Unread notification inbox.
 *
 * Polling rather than a socket: notifications are produced by background jobs on a minutes
 * timescale, so a 60s poll is indistinguishable to the operator and costs one connection-free
 * request instead of a long-lived one per open tab. Hidden tabs poll not at all.
 */

const NOTIFICATIONS_ENDPOINT = '/api/notifications';
/** One row at a time: the API marks a single notification read by id. */
const markReadEndpoint = (id: string) => `/api/notifications/${encodeURIComponent(id)}/read`;
const MARK_ALL_READ_ENDPOINT = '/api/notifications/read-all';
const POLL_MS = 60_000;
const PREVIEW_LIMIT = 8;

const severitySchema = z.enum(['INFO', 'SUCCESS', 'WARNING', 'CRITICAL']).catch('INFO');

const notificationSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    message: z.string().nullish(),
    severity: severitySchema,
    link: z.string().nullish(),
    isRead: z.boolean().catch(false),
    createdAt: z.string(),
    /** The list endpoint nests the site; `websiteName` is accepted for any flatter caller. */
    website: z.object({ name: z.string() }).nullish(),
    websiteName: z.string().nullish(),
  })
  .transform((row) => ({
    id: row.id,
    title: row.title,
    message: row.message,
    severity: row.severity,
    link: row.link,
    isRead: row.isRead,
    createdAt: row.createdAt,
    websiteName: row.website?.name ?? row.websiteName ?? null,
  }));

/**
 * `GET /api/notifications` answers with `{ items, total, unread, … }`. The other shapes are kept
 * so a response that arrives flatter still renders instead of reading as an outage.
 */
const responseSchema = z.union([
  z.array(notificationSchema),
  z.object({
    items: z.array(notificationSchema),
    unread: z.number().optional(),
    unreadCount: z.number().optional(),
  }),
  z.object({ notifications: z.array(notificationSchema), unreadCount: z.number().optional() }),
]);

type NotificationItem = z.infer<typeof notificationSchema>;
type Severity = z.infer<typeof severitySchema>;

interface Inbox {
  items: NotificationItem[];
  unreadCount: number;
}

function normalise(payload: unknown): Inbox | null {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (Array.isArray(value)) {
    return { items: value, unreadCount: value.filter((item) => !item.isRead).length };
  }
  const items = 'items' in value ? value.items : value.notifications;
  const reported = 'unread' in value ? value.unread ?? value.unreadCount : value.unreadCount;
  // The server's count covers rows beyond this page, which is capped at PREVIEW_LIMIT — so
  // counting what we can see would understate a fuller inbox. Only fall back when it is absent.
  return { items, unreadCount: reported ?? items.filter((item) => !item.isRead).length };
}

const SEVERITY_ICON: Record<Severity, LucideIcon> = {
  INFO: Info,
  SUCCESS: CircleCheck,
  WARNING: TriangleAlert,
  CRITICAL: CircleAlert,
};

const SEVERITY_TONE: Record<Severity, string> = {
  INFO: 'text-info',
  SUCCESS: 'text-success',
  WARNING: 'text-warning',
  CRITICAL: 'text-destructive',
};

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** Notification links come from the server; only same-origin paths are followed. */
function safeHref(href: string | null | undefined): string | null {
  if (!href) return null;
  return href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') ? href : null;
}

/** The inbox rows, extracted so a stale-but-real reading renders the same way a fresh one does. */
function NotificationList({
  items,
  onOpen,
}: {
  items: NotificationItem[];
  onOpen: (item: NotificationItem) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {items.map((item) => {
        const Icon = SEVERITY_ICON[item.severity];
        return (
          <li key={item.id}>
            <button
              type="button"
              onClick={() => onOpen(item)}
              className={cn(
                'flex w-full items-start gap-2.5 px-3.5 py-3 text-left transition-colors',
                'hover:bg-accent/60 focus-visible:outline-none focus-visible:bg-accent/60',
                item.isRead && 'opacity-60',
              )}
            >
              <Icon
                className={cn('mt-0.5 size-4 shrink-0', SEVERITY_TONE[item.severity])}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium leading-tight text-foreground">
                    {item.title}
                  </span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {relativeTime(item.createdAt)}
                  </span>
                </span>
                {item.message ? (
                  <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                    {item.message}
                  </span>
                ) : null}
                {item.websiteName ? (
                  <span className="mt-1 block truncate text-2xs text-muted-foreground">
                    {item.websiteName}
                  </span>
                ) : null}
              </span>
              {!item.isRead ? (
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" aria-label="Unread" />
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [inbox, setInbox] = React.useState<Inbox>({ items: [], unreadCount: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  /*
   * A 404 means this installation does not serve the notification inbox at all, which is not an
   * error the operator can act on — the bell removes itself and stops polling rather than
   * sitting in the top bar with a permanent failure inside it.
   */
  const [unavailable, setUnavailable] = React.useState(false);
  /** A dead session is recovered from once, not once per poll. */
  const recoveredRef = React.useRef(false);

  const load = React.useCallback(async () => {
    try {
      const payload = await apiGet<unknown>(
        `${NOTIFICATIONS_ENDPOINT}?unreadOnly=true&pageSize=${PREVIEW_LIMIT}`,
      );
      const next = normalise(payload);
      if (!next) {
        setError('Notifications could not be read.');
        return;
      }
      setInbox(next);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setUnavailable(true);
        return;
      }
      if (err instanceof ApiError && err.status === 401) {
        /*
         * The session died while this tab sat open. "Authentication required" in a bell is not
         * something anyone can act on; re-rendering the shell is, because its server component
         * re-checks the session and redirects to the login page.
         */
        setUnavailable(true);
        if (!recoveredRef.current) {
          recoveredRef.current = true;
          router.refresh();
        }
        return;
      }
      // A failed poll must not blank an inbox we already showed, so only the banner changes.
      setError(err instanceof ApiError ? err.message : 'Notifications are unavailable.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    if (unavailable) return;
    let disposed = false;

    const tick = () => {
      // A background tab has nobody looking at it; skip the request entirely.
      if (document.hidden || disposed) return;
      void load();
    };

    tick();
    const interval = window.setInterval(tick, POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load, unavailable]);

  const markRead = async (id: string) => {
    const snapshot = inbox;
    setInbox({
      items: inbox.items.map((item) => (item.id === id ? { ...item, isRead: true } : item)),
      unreadCount: Math.max(0, inbox.unreadCount - 1),
    });
    try {
      await apiPost(markReadEndpoint(id), {});
    } catch (err) {
      setInbox(snapshot);
      toast.error(err instanceof ApiError ? err.message : 'Could not mark that as read.');
    }
  };

  const markAllRead = async () => {
    const snapshot = inbox;
    setBusy(true);
    setInbox({ items: inbox.items.map((item) => ({ ...item, isRead: true })), unreadCount: 0 });
    try {
      // No `websiteId`: the bell is portfolio-wide, and so is what it just showed as read.
      await apiPost(MARK_ALL_READ_ENDPOINT, {});
    } catch (err) {
      setInbox(snapshot);
      toast.error(err instanceof ApiError ? err.message : 'Could not mark everything as read.');
    } finally {
      setBusy(false);
    }
  };

  const openNotification = (item: NotificationItem) => {
    const href = safeHref(item.link);
    if (!item.isRead) void markRead(item.id);
    if (!href) return;
    setOpen(false);
    router.push(href);
  };

  const unread = inbox.unreadCount;

  if (unavailable) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        >
          <Bell className="size-4" aria-hidden="true" />
          {unread > 0 ? (
            <span className="tabular absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[0.5625rem] font-semibold leading-none text-destructive-foreground">
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
          <p className="text-sm font-semibold">Notifications</p>
          {unread > 0 ? (
            <button
              type="button"
              onClick={() => void markAllRead()}
              disabled={busy}
              className={cn(
                'flex items-center gap-1.5 rounded-sm text-2xs font-medium text-muted-foreground transition-colors',
                'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:opacity-50',
              )}
            >
              <CheckCheck className="size-3.5" aria-hidden="true" />
              Mark all read
            </button>
          ) : null}
        </div>

        <div className="max-h-[22rem] overflow-y-auto">
          {loading ? (
            <p className="px-3.5 py-10 text-center text-sm text-muted-foreground" role="status">
              Loading notifications…
            </p>
          ) : error && inbox.items.length > 0 ? (
            /* A poll failed but we still hold a real reading; show it, and say it is stale. */
            <>
              <p
                className="border-b border-border px-3.5 py-2 text-2xs leading-relaxed text-muted-foreground"
                role="status"
              >
                {error} Showing the last successful reading.
              </p>
              <NotificationList items={inbox.items} onOpen={openNotification} />
            </>
          ) : error ? (
            <div className="px-3.5 py-8 text-center" role="alert">
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : inbox.items.length === 0 ? (
            <p className="px-3.5 py-10 text-center text-sm leading-relaxed text-muted-foreground">
              Nothing unread. Crawl results, score drops and finished AI actions land here.
            </p>
          ) : (
            <NotificationList items={inbox.items} onOpen={openNotification} />
          )}
        </div>

        <div className="border-t border-border p-1.5">
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className={cn(
              'flex items-center justify-center rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors',
              'hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
