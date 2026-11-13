'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { ExternalLink, Github, KeyRound, Mail, MessageCircle, Unlink } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { apiDelete, apiGet, apiPost } from '@/lib/api-client';
import { reportApiError } from '@/lib/job-feedback';
import { NativeSelect, relativeAge, useLinkFlash } from './shared';
import type { AccountsOverviewWire, PersonalAccountWire, PersonalProviderValue } from './types';

/**
 * Accounts: the operator's own GitHub and Reddit (linked once, used across the app) and a pointer
 * to their mailboxes. Linking is one click on the platform's own page once the installation's
 * developer app exists; GitHub can also take a personal access token straight away.
 */

const LABEL: Record<PersonalProviderValue, string> = { GITHUB: 'GitHub', REDDIT: 'Reddit' };

function StatusBadge({ account }: { account: PersonalAccountWire }): React.JSX.Element {
  if (account.status === 'CONNECTED') return <Badge variant="success">linked</Badge>;
  if (account.status === 'EXPIRED') return <Badge variant="warning">needs relinking</Badge>;
  return <Badge variant="destructive">{account.status.toLowerCase()}</Badge>;
}

export function AccountsView(): React.JSX.Element {
  const [data, setData] = useState<AccountsOverviewWire | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const load = useCallback(async () => {
    try {
      setData(await apiGet<AccountsOverviewWire>('/api/accounts'));
      setFailed(null);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : 'Could not load your accounts.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useLinkFlash(load);

  const unlink = useCallback(
    async (account: PersonalAccountWire) => {
      const ok = await confirm({
        title: `Unlink ${LABEL[account.provider]} ${account.handle ?? ''}?`,
        description: 'The stored token is deleted from this app. Sites that use a copy of this Reddit account keep it until you disconnect it there.',
        confirmLabel: 'Unlink',
        destructive: true,
      });
      if (!ok) return;
      try {
        await apiDelete(`/api/accounts/linked/${account.id}`);
        toast.success(`${LABEL[account.provider]} unlinked`);
        await load();
      } catch (error) {
        reportApiError(error, 'Could not unlink the account.');
      }
    },
    [confirm, load],
  );

  if (failed) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Accounts could not load</AlertTitle>
        <AlertDescription>{failed}</AlertDescription>
      </Alert>
    );
  }
  if (!data) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="space-y-6">
      {confirmDialog}
      <Alert>
        <AlertTitle>Your accounts, used only when you click</AlertTitle>
        <AlertDescription>
          Linking happens on GitHub&rsquo;s or Reddit&rsquo;s own page — this app never sees your password, and it never
          creates accounts, votes or stars on its own. Every post, comment, star or reply you make here is a single click
          of yours.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        <ProviderCard provider="GITHUB" data={data} onChanged={load} onUnlink={unlink} />
        <ProviderCard provider="REDDIT" data={data} onChanged={load} onUnlink={unlink} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail aria-hidden="true" className="size-4" />
            Mailboxes
          </CardTitle>
          <CardDescription>
            {data.mailboxes === 0
              ? 'No mailbox added yet. Read, reply to and send email from inside the app.'
              : `${data.mailboxes} mailbox${data.mailboxes === 1 ? '' : 'es'} added.`}
          </CardDescription>
          <CardAction>
            <Button asChild size="sm" variant="secondary">
              <Link href="/mail">Open mail</Link>
            </Button>
          </CardAction>
        </CardHeader>
      </Card>
    </div>
  );
}

function ProviderCard({
  provider,
  data,
  onChanged,
  onUnlink,
}: {
  provider: PersonalProviderValue;
  data: AccountsOverviewWire;
  onChanged: () => Promise<void>;
  onUnlink: (account: PersonalAccountWire) => Promise<void>;
}): React.JSX.Element {
  const ids = useId();
  const accounts = data.accounts.filter((account) => account.provider === provider);
  const oauth = data.oauth[provider];
  const Icon = provider === 'GITHUB' ? Github : MessageCircle;
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [siteFor, setSiteFor] = useState<Record<string, string>>({});

  const startHref = `/api/accounts/${provider.toLowerCase()}/start?returnTo=${encodeURIComponent('/accounts')}`;

  const saveToken = useCallback(async () => {
    setSaving(true);
    try {
      const result = await apiPost<{ account: PersonalAccountWire; note: string | null }>('/api/accounts/github/token', { token: token.trim() });
      toast.success(`GitHub linked as ${result.account.handle}`, result.note ? { description: result.note } : undefined);
      setToken('');
      await onChanged();
    } catch (error) {
      reportApiError(error, 'GitHub refused that token.');
    } finally {
      setSaving(false);
    }
  }, [token, onChanged]);

  const copyToSite = useCallback(
    async (account: PersonalAccountWire) => {
      const websiteId = siteFor[account.id] ?? data.sites[0]?.id;
      if (!websiteId) return;
      try {
        const result = await apiPost<{ handle: string | null }>(`/api/accounts/linked/${account.id}/copy-to-site`, { websiteId });
        const site = data.sites.find((entry) => entry.id === websiteId);
        toast.success(`${result.handle ?? 'Reddit'} is now ${site?.name ?? 'the site'}'s Reddit account`, {
          description: 'Listening, reply drafts and daily posts for that site use it, with the site’s limits and approvals.',
        });
      } catch (error) {
        reportApiError(error, 'Could not use the account on that site.');
      }
    },
    [siteFor, data.sites],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon aria-hidden="true" className="size-4" />
          {LABEL[provider]}
        </CardTitle>
        <CardDescription>
          {provider === 'GITHUB'
            ? 'Your profile, repositories and notifications; look up any repository; star, watch, fork, open issues and comment.'
            : 'Your karma, inbox and history; browse subreddits with their rules; post and comment through the same anti-spam guardrails as the social module.'}
        </CardDescription>
        {accounts.some((account) => account.status === 'CONNECTED') ? (
          <CardAction>
            <Button asChild size="sm">
              <Link href={`/accounts/${provider.toLowerCase()}`}>Open workspace</Link>
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {accounts.map((account) => (
          <div key={account.id} className="space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{account.handle ?? account.displayName ?? 'Linked account'}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[account.email, account.linkedVia === 'token' ? 'personal access token' : 'one-click link', account.lastUsedAt ? `used ${relativeAge(account.lastUsedAt)}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge account={account} />
                <Button size="sm" variant="ghost" onClick={() => void onUnlink(account)} aria-label={`Unlink ${account.handle ?? ''}`}>
                  <Unlink aria-hidden="true" />
                </Button>
              </div>
            </div>
            {account.lastError ? <p className="text-xs text-destructive">{account.lastError}</p> : null}
            {account.status !== 'CONNECTED' ? (
              <Button asChild size="sm" variant="secondary">
                <a href={startHref}>Link again</a>
              </Button>
            ) : null}
            {provider === 'REDDIT' && account.status === 'CONNECTED' && data.sites.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <NativeSelect
                  aria-label="Site"
                  value={siteFor[account.id] ?? data.sites[0]?.id}
                  onChange={(event) => setSiteFor((current) => ({ ...current, [account.id]: event.target.value }))}
                >
                  {data.sites.map((site) => (
                    <option key={site.id} value={site.id}>
                      {site.name}
                    </option>
                  ))}
                </NativeSelect>
                <Button size="sm" variant="outline" onClick={() => void copyToSite(account)}>
                  Use on this site
                </Button>
              </div>
            ) : null}
          </div>
        ))}

        {oauth.ready ? (
          <Button asChild className="w-full">
            <a href={startHref}>{accounts.length ? `Link another ${LABEL[provider]} account` : `Link ${LABEL[provider]}`}</a>
          </Button>
        ) : (
          <div className="space-y-2 rounded-md border border-dashed p-3 text-sm">
            <p className="font-medium">One-click linking needs a {LABEL[provider]} developer app, once</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              {provider === 'GITHUB' ? (
                <li>
                  Create an OAuth App at{' '}
                  <a className="text-primary hover:underline" href="https://github.com/settings/applications/new" target="_blank" rel="noopener noreferrer">
                    github.com/settings/applications/new
                  </a>{' '}
                  with this callback URL:
                </li>
              ) : (
                <li>
                  Create a “web app” at{' '}
                  <a className="text-primary hover:underline" href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener noreferrer">
                    reddit.com/prefs/apps
                  </a>{' '}
                  with this redirect URI (it is shared with the social module):
                </li>
              )}
              <li>
                Save its client id and secret under <strong>Social → Accounts → One-time developer apps</strong>
                {data.sites[0] ? (
                  <>
                    {' '}
                    (
                    <Link className="text-primary hover:underline" href={`/sites/${data.sites[0].id}/social?tab=accounts`}>
                      open it
                    </Link>
                    )
                  </>
                ) : null}
                , then come back and click Link.
              </li>
            </ol>
            <div className="flex items-center gap-2">
              <Input id={`${ids}-redirect`} value={oauth.redirectUri} readOnly className="font-mono text-xs" />
              <CopyButton value={oauth.redirectUri} label="Copy redirect URI" />
            </div>
          </div>
        )}

        {provider === 'GITHUB' ? (
          <details className="rounded-md border p-3 text-sm" open={!oauth.ready && accounts.length === 0}>
            <summary className="flex cursor-pointer items-center gap-2 font-medium">
              <KeyRound aria-hidden="true" className="size-4" />
              Use a token instead (no setup)
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                <a className="inline-flex items-center gap-1 text-primary hover:underline" href={data.oauth.GITHUB.tokenUrl} target="_blank" rel="noopener noreferrer">
                  Create a token with the right scopes <ExternalLink aria-hidden="true" className="size-3" />
                </a>{' '}
                (they are pre-selected; pick an expiry and click “Generate token”).
              </li>
              <li>Paste it here.</li>
            </ol>
            <div className="mt-2 flex gap-2">
              <Input
                type="password"
                autoComplete="off"
                placeholder="ghp_… or github_pat_…"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                aria-label="GitHub token"
              />
              <Button onClick={() => void saveToken()} loading={saving} disabled={token.trim().length < 20}>
                Link
              </Button>
            </div>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}
