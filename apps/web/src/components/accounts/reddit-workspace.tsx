'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Inbox, MessageSquare, PenSquare, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiGet, apiPost } from '@/lib/api-client';
import { reportApiError } from '@/lib/job-feedback';
import { NativeSelect, relativeAge } from './shared';
import type { PersonalAccountWire, RedditComposeResult, RedditIdentityWire, RedditThingWire } from './types';

/**
 * Reddit workspace: karma, inbox (reply, mark read), my history, and subreddit browsing with the
 * community's rules beside the posts. Posts and comments into communities run through the social
 * guardrails — or through a chosen site's social queue — before anything is submitted.
 */

interface Overview {
  account: PersonalAccountWire;
  profile: RedditIdentityWire;
  inbox: RedditThingWire[];
  history: { posts: RedditThingWire[]; comments: RedditThingWire[] };
  subscriptions: Array<{ name: string; title: string | null; subscribers: number | null }>;
}

interface SubredditView {
  subreddit: { name: string; title: string | null; subscribers: number | null; rules: Array<{ title: string; description: string }> };
  policy: { policy: 'ALLOWED' | 'RESTRICTED' | 'FORBIDDEN' | 'UNKNOWN'; summary: string };
  posts: RedditThingWire[];
}

type ComposeTarget =
  | { mode: 'inbox-reply'; thing: RedditThingWire }
  | { mode: 'comment'; thing: RedditThingWire }
  | { mode: 'post'; subreddit: string };

const POLICY_VARIANT = { ALLOWED: 'success', RESTRICTED: 'warning', FORBIDDEN: 'destructive', UNKNOWN: 'muted' } as const;

export function RedditWorkspace({ sites }: { sites: Array<{ id: string; name: string }> }): React.JSX.Element {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [subInput, setSubInput] = useState('');
  const [sort, setSort] = useState<'hot' | 'new'>('hot');
  const [sub, setSub] = useState<SubredditView | null>(null);
  const [loadingSub, setLoadingSub] = useState(false);
  const [compose, setCompose] = useState<ComposeTarget | null>(null);

  useEffect(() => {
    apiGet<Overview>('/api/accounts/reddit/overview')
      .then(setOverview)
      .catch((error: unknown) => setFailed(error instanceof Error ? error.message : 'Could not reach Reddit.'));
  }, []);

  const openSub = useCallback(
    async (name: string, order = sort) => {
      const value = name.trim().replace(/^\/?r\//i, '');
      if (!value) return;
      setLoadingSub(true);
      try {
        setSub(await apiGet<SubredditView>(`/api/accounts/reddit/subreddit?name=${encodeURIComponent(value)}&sort=${order}`));
        setSubInput(value);
      } catch (error) {
        reportApiError(error, 'Could not open that subreddit.');
      } finally {
        setLoadingSub(false);
      }
    },
    [sort],
  );

  const markRead = useCallback(async (ids: string[]) => {
    try {
      await apiPost('/api/accounts/reddit/inbox', { action: 'read', ids });
      setOverview((current) =>
        current ? { ...current, inbox: current.inbox.map((thing) => (ids.includes(thing.name) ? { ...thing, unread: false } : thing)) } : current,
      );
    } catch (error) {
      reportApiError(error, 'Could not mark it read.');
    }
  }, []);

  if (failed) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Reddit is not available</AlertTitle>
        <AlertDescription>{failed}</AlertDescription>
      </Alert>
    );
  }
  if (!overview) return <Skeleton className="h-72 w-full" />;
  const unread = overview.inbox.filter((thing) => thing.unread);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{overview.profile.handle}</CardTitle>
          <CardDescription>
            {overview.profile.totalKarma.toLocaleString()} karma ({overview.profile.linkKarma.toLocaleString()} post ·{' '}
            {overview.profile.commentKarma.toLocaleString()} comment)
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void openSub(subInput);
            }}
          >
            <Input className="min-w-0 flex-1" value={subInput} onChange={(event) => setSubInput(event.target.value)} placeholder="Subreddit, e.g. SideProject" aria-label="Subreddit" />
            <NativeSelect
              aria-label="Sort"
              value={sort}
              onChange={(event) => {
                const next = event.target.value === 'new' ? 'new' : 'hot';
                setSort(next);
                if (sub) void openSub(subInput, next);
              }}
            >
              <option value="hot">Hot</option>
              <option value="new">New</option>
            </NativeSelect>
            <Button type="submit" loading={loadingSub}>
              <Search aria-hidden="true" />
              Browse
            </Button>
          </form>
          {overview.subscriptions.length ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {overview.subscriptions.slice(0, 24).map((entry) => (
                <button key={entry.name} type="button" onClick={() => void openSub(entry.name)}>
                  <Badge variant="outline">{entry.name}</Badge>
                </button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {sub ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{sub.subreddit.name}</CardTitle>
            <CardDescription>
              {[sub.subreddit.title, sub.subreddit.subscribers !== null ? `${sub.subreddit.subscribers.toLocaleString()} members` : null].filter(Boolean).join(' · ')}
            </CardDescription>
            <CardAction>
              <Button size="sm" onClick={() => setCompose({ mode: 'post', subreddit: sub.subreddit.name })}>
                <PenSquare aria-hidden="true" />
                New post
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertTitle className="flex items-center gap-2">
                Self-promotion: <Badge variant={POLICY_VARIANT[sub.policy.policy]}>{sub.policy.policy.toLowerCase()}</Badge>
              </AlertTitle>
              <AlertDescription>{sub.policy.summary}</AlertDescription>
            </Alert>
            {sub.subreddit.rules.length ? (
              <details className="rounded-md border p-3 text-sm">
                <summary className="cursor-pointer font-medium">Community rules ({sub.subreddit.rules.length})</summary>
                <ol className="mt-2 list-decimal space-y-1 pl-5">
                  {sub.subreddit.rules.map((rule) => (
                    <li key={rule.title}>
                      <span className="font-medium">{rule.title}</span>
                      {rule.description ? <span className="text-muted-foreground"> — {rule.description}</span> : null}
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
            <ThingList things={sub.posts} onComment={(thing) => setCompose({ mode: 'comment', thing })} />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Inbox aria-hidden="true" className="size-4" />
              Inbox
            </CardTitle>
            <CardDescription>{unread.length ? `${unread.length} unread` : 'Nothing unread.'}</CardDescription>
            {unread.length ? (
              <CardAction>
                <Button size="sm" variant="ghost" onClick={() => void markRead(unread.map((thing) => thing.name))}>
                  Mark all read
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {overview.inbox.slice(0, 25).map((thing) => (
                <li key={thing.name} className="space-y-1 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`truncate ${thing.unread ? 'font-medium' : 'text-muted-foreground'}`}>
                      {thing.inboxType?.replace(/_/g, ' ') ?? thing.kind} from u/{thing.author ?? 'unknown'} {thing.subreddit ? `in ${thing.subreddit}` : ''}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeAge(thing.createdAt)}</span>
                  </div>
                  {thing.title ? <p className="truncate text-xs text-muted-foreground">{thing.title}</p> : null}
                  <p className="line-clamp-3 whitespace-pre-wrap">{thing.body}</p>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => setCompose({ mode: 'inbox-reply', thing })}>
                      <MessageSquare aria-hidden="true" />
                      Reply
                    </Button>
                    {thing.unread ? (
                      <Button size="sm" variant="ghost" onClick={() => void markRead([thing.name])} aria-label="Mark read">
                        <Check aria-hidden="true" />
                      </Button>
                    ) : null}
                    {thing.url ? (
                      <Button asChild size="sm" variant="ghost">
                        <a href={thing.url} target="_blank" rel="noopener noreferrer">
                          Open
                        </a>
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">My recent activity</CardTitle>
            <CardDescription>Your latest posts and comments with their scores.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ThingList things={overview.history.posts.slice(0, 10)} />
            <ThingList things={overview.history.comments.slice(0, 10)} />
          </CardContent>
        </Card>
      </div>

      <RedditComposer target={compose} handle={overview.profile.handle} sites={sites} onClose={() => setCompose(null)} />
    </div>
  );
}

function ThingList({ things, onComment }: { things: RedditThingWire[]; onComment?: (thing: RedditThingWire) => void }): React.JSX.Element {
  if (things.length === 0) return <p className="text-sm text-muted-foreground">Nothing here yet.</p>;
  return (
    <ul className="divide-y rounded-md border">
      {things.map((thing) => (
        <li key={thing.name} className="flex items-start justify-between gap-2 p-2 text-sm">
          <div className="min-w-0">
            <a className="block truncate hover:underline" href={thing.url ?? '#'} target="_blank" rel="noopener noreferrer">
              {thing.title ?? thing.body?.slice(0, 120) ?? thing.name}
            </a>
            <p className="text-xs text-muted-foreground">
              {[thing.subreddit, thing.author ? `u/${thing.author}` : null, thing.score !== null ? `${thing.score} points` : null, thing.comments !== null ? `${thing.comments} comments` : null, relativeAge(thing.createdAt)]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {onComment ? (
            <Button size="sm" variant="outline" onClick={() => onComment(thing)}>
              Comment
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function RedditComposer({
  target,
  handle,
  sites,
  onClose,
}: {
  target: ComposeTarget | null;
  handle: string;
  sites: Array<{ id: string; name: string }>;
  onClose: () => void;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [websiteId, setWebsiteId] = useState('');
  const [sending, setSending] = useState(false);
  const [blocked, setBlocked] = useState<{ blockers: string[]; warnings: string[] } | null>(null);

  useEffect(() => {
    setTitle('');
    setBody('');
    setWebsiteId('');
    setBlocked(null);
  }, [target]);

  const send = useCallback(async () => {
    if (!target) return;
    setSending(true);
    setBlocked(null);
    try {
      if (target.mode === 'inbox-reply') {
        const result = await apiPost<{ url: string | null }>('/api/accounts/reddit/inbox', { action: 'reply', thingId: target.thing.name, body: body.trim() });
        toast.success('Reply sent', result.url ? { description: result.url } : undefined);
        onClose();
        return;
      }
      const result = await apiPost<RedditComposeResult>('/api/accounts/reddit/compose', {
        kind: target.mode === 'post' ? 'post' : 'comment',
        ...(target.mode === 'post' ? { subreddit: target.subreddit, title: title.trim() } : { thingId: target.thing.name }),
        body: body.trim(),
        ...(websiteId ? { websiteId } : {}),
      });
      if (result.status === 'blocked') {
        setBlocked({ blockers: result.blockers, warnings: result.warnings });
        return;
      }
      if (result.status === 'queued') {
        toast.success('Queued through the site’s social module', {
          description: `${result.copiedAccount ? 'This Reddit account is now the site’s Reddit account. ' : ''}Guardrails run again when it goes out; follow it in Social → Posts.`,
        });
      } else {
        toast.success(target.mode === 'post' ? 'Posted' : 'Comment posted', {
          description: [result.url, ...result.warnings].filter(Boolean).join(' '),
        });
      }
      onClose();
    } catch (error) {
      reportApiError(error, 'Reddit did not accept that.');
    } finally {
      setSending(false);
    }
  }, [target, title, body, websiteId, onClose]);

  const heading =
    target?.mode === 'post' ? `New post in ${target.subreddit}` : target?.mode === 'comment' ? `Comment on “${target.thing.title ?? 'post'}”` : 'Reply';
  const ready = body.trim().length >= 2 && (target?.mode !== 'post' || title.trim().length >= 2);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            Posts publicly as {handle}.{' '}
            {target?.mode === 'inbox-reply'
              ? 'You are answering someone who wrote to you.'
              : 'Answer the question first; if you mention your own product, say you built it — undisclosed self-promotion is blocked.'}
          </DialogDescription>
        </DialogHeader>
        {target?.mode === 'post' ? <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" aria-label="Title" maxLength={300} /> : null}
        <Textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} aria-label="Text" maxLength={10_000} />
        <p className="text-right text-xs text-muted-foreground">{body.length} / 10000</p>
        {target?.mode !== 'inbox-reply' && sites.length ? (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">On behalf of a site (uses its limits and queue):</span>
            <NativeSelect value={websiteId} onChange={(event) => setWebsiteId(event.target.value)} aria-label="Site">
              <option value="">No site — post directly</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        ) : null}
        {blocked ? (
          <Alert variant="destructive">
            <AlertTitle>Held back by the guardrails</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-5">
                {blocked.blockers.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
                {blocked.warnings.map((reason) => (
                  <li key={reason} className="text-muted-foreground">
                    {reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button onClick={() => void send()} loading={sending} disabled={!ready}>
            {target?.mode === 'inbox-reply' ? 'Send reply' : websiteId ? 'Queue for the site' : 'Check and post'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
