'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  Archive,
  FileText,
  Folder,
  Inbox,
  Mail,
  MailPlus,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import { toast } from '@/components/ui/toast';
import { apiDelete, apiGet, apiPatch, apiPost, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { AddAccountDialog } from './add-account-dialog';
import { ComposeDialog } from './compose-dialog';
import { MessageReader } from './message-reader';
import {
  displayName,
  type ComposeTarget,
  type MailAccountView,
  type MailFolderView,
  type MailMessageView,
  type MailOverviewView,
  type MailPageView,
  type MailSummaryView,
} from './types';

/**
 * The mail client: mailboxes and folders · message list · reader.
 *
 * Everything is fetched live from the provider through the API; nothing about a message is
 * cached server-side. On narrow screens the three panes collapse into one, driven by what is
 * selected, so a phone shows the list and then the message — never three squeezed columns.
 */

const FOLDER_ICON: Record<string, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  junk: ShieldAlert,
  archive: Archive,
  all: Mail,
  flagged: Star,
};

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

function shortDate(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? TIME.format(date) : DAY.format(date);
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function MailView({ initial }: { initial: MailOverviewView }): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { confirm, confirmDialog } = useConfirm();

  const [accounts, setAccounts] = useState(initial.accounts);
  const [accountId, setAccountId] = useState<string | null>(initial.accounts.find((a) => a.isDefault)?.id ?? initial.accounts[0]?.id ?? null);
  const [folders, setFolders] = useState<MailFolderView[]>([]);
  const [folder, setFolder] = useState<string | null>(null);
  const [page, setPage] = useState<MailPageView | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<MailMessageView | null>(null);
  const [blockedImages, setBlockedImages] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const requestSeq = useRef(0);

  const account = accounts.find((row) => row.id === accountId) ?? null;
  /** A mailbox added by address but not yet given its password: nothing to open until it is. */
  const pendingSetup = Boolean(account && account.provider === 'IMAP_SMTP' && !account.hasPassword);

  function startAdding(email = ''): void {
    setAddEmail(email);
    setAdding(true);
  }

  // One-shot banners from the Gmail OAuth redirect.
  useEffect(() => {
    const connected = searchParams.get('connected');
    const error = searchParams.get('error');
    if (!connected && !error) return;
    if (connected) toast.success('Mailbox connected', { description: connected });
    if (error) toast.error(error);
    router.replace(pathname);
    router.refresh();
  }, [searchParams, router, pathname]);

  useEffect(() => setAccounts(initial.accounts), [initial.accounts]);

  const loadFolders = useCallback(async (id: string) => {
    setFolders([]);
    setFolder(null);
    setPage(null);
    setListError(null);
    try {
      const { folders: list } = await apiGet<{ folders: MailFolderView[] }>(`/api/mail/accounts/${id}/folders`);
      setFolders(list);
      setFolder(list.find((entry) => entry.specialUse === 'inbox')?.path ?? list[0]?.path ?? null);
    } catch (err) {
      setListError(errorText(err, 'Could not open this mailbox.'));
    }
  }, []);

  useEffect(() => {
    if (accountId && !pendingSetup) void loadFolders(accountId);
  }, [accountId, pendingSetup, loadFolders]);

  const loadMessages = useCallback(
    async (opts: { append?: boolean } = {}) => {
      if (!accountId || !folder) return;
      const seq = ++requestSeq.current;
      setLoadingList(true);
      setListError(null);
      try {
        const params = new URLSearchParams({ folder });
        if (activeQuery) params.set('q', activeQuery);
        if (opts.append && page?.nextCursor) params.set('cursor', page.nextCursor);
        const next = await apiGet<MailPageView>(`/api/mail/accounts/${accountId}/messages?${params.toString()}`);
        if (seq !== requestSeq.current) return; // a newer folder/search won the race
        setPage((current) => (opts.append && current ? { ...next, messages: [...current.messages, ...next.messages] } : next));
      } catch (err) {
        if (seq === requestSeq.current) setListError(errorText(err, 'Could not load messages.'));
      } finally {
        if (seq === requestSeq.current) setLoadingList(false);
      }
    },
    [accountId, folder, activeQuery, page?.nextCursor],
  );

  useEffect(() => {
    setSelectedId(null);
    setMessage(null);
    void loadMessages();
    // Reload only when the folder, account or search changes, not when the cursor moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, folder, activeQuery]);

  const openMessage = useCallback(
    async (summary: MailSummaryView, images = false) => {
      if (!accountId || !folder) return;
      setSelectedId(summary.id);
      setLoadingMessage(true);
      if (!images) setMessage(null);
      try {
        const params = new URLSearchParams({ folder, ...(images ? { images: '1' } : {}) });
        const result = await apiGet<{ message: MailMessageView; blockedImages: number }>(
          `/api/mail/accounts/${accountId}/messages/${encodeURIComponent(summary.id)}?${params.toString()}`,
        );
        setMessage(result.message);
        setBlockedImages(result.blockedImages);
        setPage((current) =>
          current ? { ...current, messages: current.messages.map((row) => (row.id === summary.id ? { ...row, seen: true } : row)) } : current,
        );
      } catch (err) {
        toast.error(errorText(err, 'Could not open the message.'));
        setSelectedId(null);
      } finally {
        setLoadingMessage(false);
      }
    },
    [accountId, folder],
  );

  async function flag(update: { seen?: boolean; flagged?: boolean }): Promise<void> {
    if (!accountId || !folder || !message) return;
    try {
      await apiPost(`/api/mail/accounts/${accountId}/messages/flags`, { folder, ids: [message.id], ...update });
      setMessage({ ...message, ...(update.seen !== undefined ? { seen: update.seen } : {}), ...(update.flagged !== undefined ? { flagged: update.flagged } : {}) });
      setPage((current) =>
        current ? { ...current, messages: current.messages.map((row) => (row.id === message.id ? { ...row, ...update } : row)) } : current,
      );
      if (update.seen === false) {
        setSelectedId(null);
        setMessage(null);
      }
    } catch (err) {
      toast.error(errorText(err, 'Could not update the message.'));
    }
  }

  async function move(to: 'archive' | 'trash'): Promise<void> {
    if (!accountId || !folder || !message) return;
    try {
      await apiPost(`/api/mail/accounts/${accountId}/messages/move`, { folder, ids: [message.id], to });
      toast.success(to === 'archive' ? 'Archived' : 'Moved to Trash');
      setPage((current) => (current ? { ...current, messages: current.messages.filter((row) => row.id !== message.id) } : current));
      setSelectedId(null);
      setMessage(null);
    } catch (err) {
      toast.error(errorText(err, 'Could not move the message.'));
    }
  }

  async function removeAccount(target: MailAccountView): Promise<void> {
    const ok = await confirm({
      title: `Remove ${target.email}?`,
      description: 'The app forgets this mailbox and its stored password. Nothing is deleted from the mailbox itself.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    try {
      await apiDelete(`/api/mail/accounts/${target.id}`);
      const rest = accounts.filter((row) => row.id !== target.id);
      setAccounts(rest);
      if (accountId === target.id) setAccountId(rest[0]?.id ?? null);
      router.refresh();
    } catch (err) {
      toast.error(errorText(err, 'Could not remove the mailbox.'));
    }
  }

  async function makeDefault(target: MailAccountView): Promise<void> {
    try {
      await apiPatch(`/api/mail/accounts/${target.id}`, { isDefault: true });
      setAccounts((rows) => rows.map((row) => ({ ...row, isDefault: row.id === target.id })));
    } catch (err) {
      toast.error(errorText(err, 'Could not change the default mailbox.'));
    }
  }

  const header = (
    <PageHeader
      title="Mail"
      description="Read, reply and send from your own mailboxes. Messages stay with your provider; the app fetches them when you look."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => startAdding()}>
            <Plus aria-hidden="true" />
            Add mailbox
          </Button>
          <Button onClick={() => setCompose({ mode: 'new' })} disabled={accounts.length === 0}>
            <MailPlus aria-hidden="true" />
            Compose
          </Button>
        </div>
      }
    />
  );

  const dialogs = (
    <>
      {confirmDialog}
      <AddAccountDialog
        open={adding}
        onOpenChange={setAdding}
        initialEmail={addEmail}
        gmailOAuthAvailable={initial.gmailOAuthAvailable}
        onSaved={(saved) => {
          setAccounts((rows) => [...rows.filter((row) => row.id !== saved.id), saved]);
          setAccountId(saved.id);
          router.refresh();
        }}
      />
      <ComposeDialog
        target={compose}
        accounts={accounts.filter((row) => row.hasPassword || row.provider === 'GMAIL_OAUTH')}
        defaultAccountId={accountId}
        onClose={() => setCompose(null)}
        onSent={() => {
          if (folders.find((entry) => entry.path === folder)?.specialUse === 'sent') void loadMessages();
        }}
      />
    </>
  );

  if (accounts.length === 0) {
    return (
      <div className="space-y-6 px-4 py-6 md:px-6">
        {header}
        <EmptyState
          icon={Mail}
          title="No mailbox connected yet"
          description="Connect a mailbox with an app password. Gmail, Outlook, iCloud and Yahoo are detected automatically; any other provider works with its IMAP and SMTP servers."
          action={
            <Button onClick={() => startAdding()}>
              <Plus aria-hidden="true" />
              Add mailbox
            </Button>
          }
        />
        {dialogs}
      </div>
    );
  }

  const showReader = selectedId !== null;

  return (
    <div className="space-y-4 px-4 py-6 md:px-6">
      {header}
      <div className="grid h-[calc(100dvh-13rem)] min-h-[520px] overflow-hidden rounded-lg border border-border bg-card lg:grid-cols-[220px_minmax(280px,380px)_minmax(0,1fr)]">
        {/* Mailboxes and folders */}
        <nav aria-label="Mailboxes" className={cn('min-h-0 overflow-y-auto border-border p-2 lg:border-r', 'hidden lg:block')}>
          {accounts.map((row) => (
            <div key={row.id} className="mb-3">
              <button
                type="button"
                onClick={() => setAccountId(row.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  row.id === accountId ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/60',
                )}
              >
                <Mail aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{row.displayName || row.email}</span>
                {row.status === 'ERROR' ? <AlertTriangle aria-label="Needs attention" className="size-3.5 text-destructive" /> : null}
              </button>
              {row.id === accountId ? (
                <>
                  <ul className="mt-1 space-y-0.5">
                    {folders.map((entry) => {
                      const Icon = (entry.specialUse && FOLDER_ICON[entry.specialUse]) || Folder;
                      return (
                        <li key={entry.path}>
                          <button
                            type="button"
                            onClick={() => setFolder(entry.path)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md py-1 pl-6 pr-2 text-left text-sm',
                              entry.path === folder ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                            )}
                          >
                            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {entry.unread ? <span className="text-xs tabular-nums">{entry.unread}</span> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="mt-1 flex flex-wrap gap-x-3 pl-6 text-xs">
                    {!row.isDefault ? (
                      <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => void makeDefault(row)}>
                        Make default
                      </button>
                    ) : (
                      <span className="text-muted-foreground">Default</span>
                    )}
                    <button type="button" className="text-muted-foreground hover:text-destructive" onClick={() => void removeAccount(row)}>
                      Remove
                    </button>
                  </div>
                  {row.lastError ? <p className="mt-1 pl-6 text-xs text-destructive">{row.lastError}</p> : null}
                </>
              ) : null}
            </div>
          ))}
        </nav>

        {/* Message list */}
        <section aria-label="Messages" className={cn('flex min-h-0 flex-col border-border lg:border-r', showReader ? 'hidden lg:flex' : 'flex')}>
          <div className="space-y-2 border-b border-border p-2">
            {/* Mailbox picker for narrow screens, where the folder pane is hidden. */}
            <div className="flex gap-2 lg:hidden">
              <select
                aria-label="Mailbox"
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={accountId ?? ''}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.email}
                  </option>
                ))}
              </select>
              <select
                aria-label="Folder"
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                value={folder ?? ''}
                onChange={(event) => setFolder(event.target.value)}
              >
                {folders.map((entry) => (
                  <option key={entry.path} value={entry.path}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                setActiveQuery(query.trim());
              }}
            >
              <div className="relative min-w-0 flex-1">
                <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input aria-label="Search mail" className="pl-8" placeholder={account?.provider === 'GMAIL_OAUTH' || account?.imapHost === 'imap.gmail.com' ? 'Search (Gmail syntax works)' : 'Search'} value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label="Refresh" onClick={() => void loadMessages()} disabled={loadingList}>
                <RefreshCw aria-hidden="true" className={loadingList ? 'animate-spin' : ''} />
              </Button>
            </form>
            {activeQuery ? (
              <p className="text-xs text-muted-foreground">
                Results for “{activeQuery}” ·{' '}
                <button type="button" className="text-primary hover:underline" onClick={() => { setQuery(''); setActiveQuery(''); }}>
                  Clear
                </button>
              </p>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {pendingSetup && account ? (
              <div className="space-y-3 p-4 text-sm">
                <p className="text-foreground">
                  <strong>{account.email}</strong> is added but not connected yet.
                </p>
                <p className="text-muted-foreground">Create an app password for it and paste it once — that is the whole setup.</p>
                <Button size="sm" onClick={() => startAdding(account.email)}>
                  Finish connecting
                </Button>
              </div>
            ) : listError ? (
              <div className="space-y-2 p-4 text-sm">
                <p className="text-destructive">{listError}</p>
                {account?.status === 'ERROR' ? (
                  <Button size="sm" variant="secondary" onClick={() => startAdding(account.email)}>
                    Update the app password
                  </Button>
                ) : null}
              </div>
            ) : page && page.messages.length === 0 && !loadingList ? (
              <p className="p-6 text-center text-sm text-muted-foreground">{activeQuery ? 'No messages match.' : 'This folder is empty.'}</p>
            ) : (
              <ul>
                {(page?.messages ?? []).map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => void openMessage(row)}
                      className={cn(
                        'block w-full border-b border-border px-3 py-2.5 text-left',
                        row.id === selectedId ? 'bg-accent' : 'hover:bg-accent/50',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        {!row.seen ? <span aria-label="Unread" className="size-2 shrink-0 rounded-full bg-primary" /> : null}
                        <span className={cn('min-w-0 flex-1 truncate text-sm', row.seen ? 'text-foreground' : 'font-semibold text-foreground')}>
                          {displayName(row.from)}
                        </span>
                        {row.hasAttachments ? <Paperclip aria-label="Has attachments" className="size-3 text-muted-foreground" /> : null}
                        {row.flagged ? <Star aria-label="Starred" className="size-3 fill-current text-warning" /> : null}
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{shortDate(row.date)}</span>
                      </span>
                      <span className={cn('mt-0.5 block truncate text-sm', row.seen ? 'text-muted-foreground' : 'text-foreground')}>
                        {row.subject || '(no subject)'}
                      </span>
                      {row.snippet ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{row.snippet}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {loadingList ? <p className="p-4 text-center text-xs text-muted-foreground">Loading…</p> : null}
            {page?.nextCursor && !loadingList ? (
              <div className="p-3 text-center">
                <Button variant="ghost" size="sm" onClick={() => void loadMessages({ append: true })}>
                  Load older messages
                </Button>
              </div>
            ) : null}
            {page && page.total !== null && page.messages.length > 0 ? (
              <p className="px-3 pb-3 text-center text-[11px] text-muted-foreground">
                <Badge variant="secondary" className="font-normal">
                  {page.messages.length} of {page.total}
                </Badge>
              </p>
            ) : null}
          </div>
        </section>

        {/* Reader */}
        <section aria-label="Message" className={cn('min-h-0', showReader ? 'block' : 'hidden lg:block')}>
          <MessageReader
            message={message}
            blockedImages={blockedImages}
            loading={loadingMessage}
            onBack={() => {
              setSelectedId(null);
              setMessage(null);
            }}
            onCompose={(mode) => folder && message && setCompose({ mode, original: { folder, message } })}
            onArchive={() => void move('archive')}
            onTrash={() => void move('trash')}
            onToggleSeen={() => void flag({ seen: false })}
            onToggleFlag={() => message && void flag({ flagged: !message.flagged })}
            onLoadImages={() => {
              const summary = page?.messages.find((row) => row.id === selectedId);
              if (summary) void openMessage(summary, true);
            }}
          />
        </section>
      </div>
      {dialogs}
    </div>
  );
}
