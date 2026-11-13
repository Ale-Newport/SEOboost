'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, Check, Eye, EyeOff, GitFork, MessageSquare, Plus, Search, Star, StarOff } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { apiGet, apiPost } from '@/lib/api-client';
import { reportApiError } from '@/lib/job-feedback';
import { GitHubHtml, relativeAge, shortDate } from './shared';
import type {
  GitHubCommentWire,
  GitHubIdentityWire,
  GitHubIssueWire,
  GitHubNotificationWire,
  GitHubRepoDetailWire,
  GitHubRepoWire,
  PersonalAccountWire,
} from './types';

/**
 * GitHub workspace: profile, notifications, my repositories, and any repository looked up by URL
 * or `owner/name`. Every write is one confirmed click that posts as the linked account.
 */

interface Overview {
  account: PersonalAccountWire;
  profile: GitHubIdentityWire;
  repos: GitHubRepoWire[];
  notifications: GitHubNotificationWire[];
}

interface RepoView {
  repo: GitHubRepoDetailWire;
  issues: GitHubIssueWire[];
}

export function GitHubWorkspace({ initialRef }: { initialRef: string | null }): React.JSX.Element {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [refInput, setRefInput] = useState(initialRef ?? '');
  const [repo, setRepo] = useState<RepoView | null>(null);
  const [repoRef, setRepoRef] = useState<string | null>(null);
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [thread, setThread] = useState<{ issue: GitHubIssueWire & { bodyHtml: string }; comments: GitHubCommentWire[] } | null>(null);
  const [composer, setComposer] = useState<{ mode: 'issue' } | { mode: 'comment'; number: number } | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  useEffect(() => {
    apiGet<Overview>('/api/accounts/github/overview')
      .then(setOverview)
      .catch((error: unknown) => setFailed(error instanceof Error ? error.message : 'Could not reach GitHub.'));
  }, []);

  const openRepo = useCallback(async (ref: string) => {
    const value = ref.trim();
    if (!value) return;
    setLoadingRepo(true);
    try {
      setRepo(await apiGet<RepoView>(`/api/accounts/github/repo?ref=${encodeURIComponent(value)}`));
      setRepoRef(value);
      const url = new URL(window.location.href);
      url.searchParams.set('repo', value);
      window.history.replaceState(null, '', url.toString());
    } catch (error) {
      reportApiError(error, 'Could not load that repository.');
    } finally {
      setLoadingRepo(false);
    }
  }, []);

  useEffect(() => {
    if (initialRef) void openRepo(initialRef);
  }, [initialRef, openRepo]);

  const act = useCallback(
    async (action: 'star' | 'unstar' | 'watch' | 'unwatch' | 'fork') => {
      if (!repo || !repoRef || !overview) return;
      if (action === 'fork') {
        const ok = await confirm({
          title: `Fork ${repo.repo.fullName}?`,
          description: `A copy is created under @${overview.profile.login}.`,
          confirmLabel: 'Fork',
        });
        if (!ok) return;
      }
      try {
        const result = await apiPost<{ done: string; url: string | null }>('/api/accounts/github/repo', { ref: repoRef, action });
        toast.success(
          { star: 'Starred', unstar: 'Star removed', watch: 'Watching', unwatch: 'No longer watching', fork: 'Fork requested' }[action],
          result.url ? { description: result.url } : undefined,
        );
        setRepo((current) =>
          current
            ? {
                ...current,
                repo: {
                  ...current.repo,
                  starred: action === 'star' ? true : action === 'unstar' ? false : current.repo.starred,
                  stars: current.repo.stars + (action === 'star' ? 1 : action === 'unstar' ? -1 : 0),
                  watching: action === 'watch' ? true : action === 'unwatch' ? false : current.repo.watching,
                },
              }
            : current,
        );
      } catch (error) {
        reportApiError(error, 'GitHub did not accept that.');
      }
    },
    [repo, repoRef, overview, confirm],
  );

  const openThread = useCallback(
    async (number: number) => {
      if (!repoRef) return;
      try {
        setThread(await apiGet(`/api/accounts/github/issues?ref=${encodeURIComponent(repoRef)}&number=${number}`));
      } catch (error) {
        reportApiError(error, 'Could not load that thread.');
      }
    },
    [repoRef],
  );

  const markRead = useCallback(async (id: string) => {
    try {
      await apiPost('/api/accounts/github/notifications', { threadId: id });
      setOverview((current) =>
        current ? { ...current, notifications: current.notifications.map((entry) => (entry.id === id ? { ...entry, unread: false } : entry)) } : current,
      );
    } catch (error) {
      reportApiError(error, 'Could not mark it read.');
    }
  }, []);

  if (failed) {
    return (
      <Alert variant="destructive">
        <AlertTitle>GitHub is not available</AlertTitle>
        <AlertDescription>{failed}</AlertDescription>
      </Alert>
    );
  }
  if (!overview) return <Skeleton className="h-72 w-full" />;
  const unread = overview.notifications.filter((entry) => entry.unread);

  return (
    <div className="space-y-6">
      {confirmDialog}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">@{overview.profile.login}</CardTitle>
          <CardDescription>
            {[overview.profile.name, overview.profile.email, `${overview.profile.publicRepos} public repos`, `${overview.profile.followers} followers`]
              .filter(Boolean)
              .join(' · ')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void openRepo(refInput);
            }}
          >
            <Input
              value={refInput}
              onChange={(event) => setRefInput(event.target.value)}
              placeholder="owner/name or https://github.com/owner/name"
              aria-label="Repository"
            />
            <Button type="submit" loading={loadingRepo}>
              <Search aria-hidden="true" />
              Open
            </Button>
          </form>
        </CardContent>
      </Card>

      {repo ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              <a className="hover:underline" href={repo.repo.htmlUrl} target="_blank" rel="noopener noreferrer">
                {repo.repo.fullName}
              </a>
            </CardTitle>
            <CardDescription>{repo.repo.description ?? 'No description.'}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-1.5 text-xs">
              <Badge variant="secondary">★ {repo.repo.stars.toLocaleString()}</Badge>
              <Badge variant="secondary">{repo.repo.forks.toLocaleString()} forks</Badge>
              <Badge variant="secondary">{repo.repo.openIssues} open issues/PRs</Badge>
              {repo.repo.language ? <Badge variant="outline">{repo.repo.language}</Badge> : null}
              {repo.repo.license ? <Badge variant="outline">{repo.repo.license}</Badge> : null}
              {repo.repo.latestRelease ? (
                <a href={repo.repo.latestRelease.url} target="_blank" rel="noopener noreferrer">
                  <Badge variant="info">
                    {repo.repo.latestRelease.tag} · {shortDate(repo.repo.latestRelease.publishedAt)}
                  </Badge>
                </a>
              ) : null}
              {repo.repo.topics.map((topic) => (
                <Badge key={topic} variant="muted">
                  {topic}
                </Badge>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={repo.repo.starred ? 'secondary' : 'outline'} onClick={() => void act(repo.repo.starred ? 'unstar' : 'star')}>
                {repo.repo.starred ? <StarOff aria-hidden="true" /> : <Star aria-hidden="true" />}
                {repo.repo.starred ? 'Unstar' : 'Star'}
              </Button>
              <Button size="sm" variant={repo.repo.watching ? 'secondary' : 'outline'} onClick={() => void act(repo.repo.watching ? 'unwatch' : 'watch')}>
                {repo.repo.watching ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                {repo.repo.watching ? 'Unwatch' : 'Watch'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void act('fork')}>
                <GitFork aria-hidden="true" />
                Fork
              </Button>
              <Button size="sm" variant="outline" onClick={() => setComposer({ mode: 'issue' })}>
                <Plus aria-hidden="true" />
                New issue
              </Button>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold">Open issues and pull requests</h3>
              {repo.issues.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing open.</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {repo.issues.map((issue) => (
                    <li key={issue.number} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                      <button type="button" className="min-w-0 flex-1 text-left hover:underline" onClick={() => void openThread(issue.number)}>
                        <span className="mr-2 text-muted-foreground">#{issue.number}</span>
                        {issue.title}
                      </button>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {issue.isPullRequest ? <Badge variant="outline">PR</Badge> : null}
                        <MessageSquare aria-hidden="true" className="size-3" />
                        {issue.comments} · {relativeAge(issue.updatedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {repo.repo.readmeHtml ? (
              <details className="rounded-md border p-3">
                <summary className="cursor-pointer text-sm font-semibold">README</summary>
                <div className="mt-3">
                  <GitHubHtml html={repo.repo.readmeHtml} />
                </div>
              </details>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Bell aria-hidden="true" className="size-4" />
              Notifications
            </CardTitle>
            <CardDescription>{unread.length ? `${unread.length} unread` : 'You are all caught up.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {overview.notifications.slice(0, 20).map((entry) => (
                <li key={entry.id} className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0">
                    <a className={`block truncate hover:underline ${entry.unread ? 'font-medium' : 'text-muted-foreground'}`} href={entry.url ?? '#'} target="_blank" rel="noopener noreferrer">
                      {entry.title}
                    </a>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.repo} · {entry.type} · {entry.reason.replace(/_/g, ' ')} · {relativeAge(entry.updatedAt)}
                    </p>
                  </div>
                  {entry.unread ? (
                    <Button size="sm" variant="ghost" onClick={() => void markRead(entry.id)} aria-label="Mark read">
                      <Check aria-hidden="true" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">My repositories</CardTitle>
            <CardDescription>Most recently pushed first.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {overview.repos.slice(0, 20).map((entry) => (
                <li key={entry.fullName} className="flex items-center justify-between gap-2 text-sm">
                  <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => { setRefInput(entry.fullName); void openRepo(entry.fullName); }}>
                    {entry.fullName}
                  </button>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    ★ {entry.stars} {entry.isPrivate ? '· private' : ''}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Dialog open={thread !== null} onOpenChange={(open) => !open && setThread(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          {thread ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  #{thread.issue.number} {thread.issue.title}
                </DialogTitle>
                <DialogDescription>
                  {thread.issue.isPullRequest ? 'Pull request' : 'Issue'} by @{thread.issue.author ?? 'unknown'} · {thread.issue.state} ·{' '}
                  <a className="text-primary hover:underline" href={thread.issue.url} target="_blank" rel="noopener noreferrer">
                    open on GitHub
                  </a>
                </DialogDescription>
              </DialogHeader>
              <GitHubHtml html={thread.issue.bodyHtml || '<p><em>No description.</em></p>'} />
              <div className="space-y-3 border-t pt-3">
                {thread.comments.map((comment) => (
                  <div key={comment.id} className="rounded-md border p-2">
                    <p className="mb-1 text-xs text-muted-foreground">
                      @{comment.author ?? 'unknown'} · {relativeAge(comment.createdAt)}
                    </p>
                    <GitHubHtml html={comment.bodyHtml} />
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button onClick={() => setComposer({ mode: 'comment', number: thread.issue.number })}>
                  <MessageSquare aria-hidden="true" />
                  Comment
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <GitHubComposer
        target={composer}
        repoRef={repoRef}
        login={overview.profile.login}
        onClose={() => setComposer(null)}
        onDone={async (number) => {
          setComposer(null);
          if (number) await openThread(number);
        }}
      />
    </div>
  );
}

function GitHubComposer({
  target,
  repoRef,
  login,
  onClose,
  onDone,
}: {
  target: { mode: 'issue' } | { mode: 'comment'; number: number } | null;
  repoRef: string | null;
  login: string;
  onClose: () => void;
  onDone: (number: number | null) => Promise<void>;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setTitle('');
    setBody('');
    setPreview(false);
  }, [target]);

  const send = useCallback(async () => {
    if (!target || !repoRef) return;
    setSending(true);
    try {
      if (target.mode === 'issue') {
        const result = await apiPost<{ number: number; url: string }>('/api/accounts/github/issues', { ref: repoRef, title: title.trim(), body: body.trim() });
        toast.success(`Issue #${result.number} opened`, { description: result.url });
        await onDone(result.number);
      } else {
        const result = await apiPost<{ url: string }>('/api/accounts/github/comments', { ref: repoRef, number: target.number, body: body.trim() });
        toast.success('Comment posted', { description: result.url });
        await onDone(target.number);
      }
    } catch (error) {
      reportApiError(error, 'GitHub did not accept that.');
    } finally {
      setSending(false);
    }
  }, [target, repoRef, title, body, onDone]);

  const ready = body.trim().length >= 2 && (target?.mode !== 'issue' || title.trim().length >= 2);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{target?.mode === 'issue' ? `New issue in ${repoRef ?? ''}` : `Comment on #${target?.mode === 'comment' ? target.number : ''}`}</DialogTitle>
          <DialogDescription>Posts publicly as @{login}. Markdown is supported.</DialogDescription>
        </DialogHeader>
        {target?.mode === 'issue' ? <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" aria-label="Title" /> : null}
        {preview ? (
          <div className="min-h-32 whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{body || 'Nothing to preview.'}</div>
        ) : (
          <Textarea rows={8} value={body} onChange={(event) => setBody(event.target.value)} aria-label="Text" />
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setPreview((value) => !value)}>
            {preview ? 'Edit' : 'Preview'}
          </Button>
          <Button onClick={() => void send()} loading={sending} disabled={!ready}>
            Post as @{login}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
