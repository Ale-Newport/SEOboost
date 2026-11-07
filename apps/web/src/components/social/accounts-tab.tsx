'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, KeyRound, LogIn, Plug, RefreshCw, ShieldCheck, Unplug, Wrench } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { apiDelete, apiPost } from '@/lib/api-client';
import { reportApiError } from '@/lib/job-feedback';
import { PLATFORM_LABEL, formatDateTime, relativeTime } from './format';
import type {
  DeveloperAppWire,
  PublisherFieldInfo,
  PublisherInfoWire,
  SocialAccountRow,
  SocialOverview,
  SocialPlatformValue,
} from './types';

/**
 * The accounts the platform may post from — one per platform per site, all owned and connected
 * by the operator.
 *
 * Publishing goes through each platform's official API with the operator's own credentials,
 * never through a browser session or a scraped login. Secrets are encrypted at rest, never sent
 * back to this screen, and a blank secret field on re-save keeps the stored value.
 */

type ConnectionTestWire = { ok: boolean; handle: string | null; displayName: string | null; message: string };

const STATUS_VARIANT = {
  CONNECTED: 'success',
  ERROR: 'destructive',
  EXPIRED: 'warning',
  DISABLED: 'muted',
  NOT_CONFIGURED: 'muted',
} as const;

function platformSlug(platform: string): string {
  return platform.toLowerCase().replace(/_/g, '-');
}

/** Where the secret is created, for the platforms without a real OAuth flow. */
const QUICK_FORMS: Partial<Record<SocialPlatformValue, { href: string; linkLabel: string; steps: string[] }>> = {
  BLUESKY: {
    href: 'https://bsky.app/settings/app-passwords',
    linkLabel: 'Open Bluesky app passwords',
    steps: [
      'Create an app password named "SEO OS" (never your real password).',
      'Click Connect and paste your handle and that app password.',
      'It is checked with a read-only call — nothing is posted.',
    ],
  },
  TELEGRAM: {
    href: 'https://t.me/BotFather',
    linkLabel: 'Open @BotFather',
    steps: [
      'Send /newbot to @BotFather and copy the token it gives you.',
      'Add that bot to your channel as an administrator.',
      'Click Connect and paste the token and the channel (@yourchannel).',
    ],
  },
  DEVTO: {
    href: 'https://dev.to/settings/extensions',
    linkLabel: 'Open Dev.to API keys',
    steps: [
      'Under "DEV Community API Keys", generate a key named "SEO OS".',
      'Click Connect and paste it.',
      'Articles are cross-posted with a canonical link back to your site.',
    ],
  },
};

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/** One line on what happens when the token runs out — the thing an operator of ten accounts needs to know. */
function expiryLabel(account: SocialAccountRow): string {
  if (account.authType !== 'oauth') return 'Uses the keys you pasted';
  if (!account.expiresAt) return 'Does not expire';
  if (account.refreshable) return 'Renews automatically';
  const days = daysUntil(account.expiresAt);
  return days <= 0 ? 'Expired — reconnect' : `Reconnect in ${days} day${days === 1 ? '' : 's'}`;
}

function startUrl(platform: SocialPlatformValue, websiteId: string, instance?: string): string {
  const params = new URLSearchParams({ websiteId });
  if (instance) params.set('instance', instance);
  return `/api/social/oauth/${platformSlug(platform)}/start?${params.toString()}`;
}

export function AccountsTab({ data }: { data: SocialOverview }): React.JSX.Element {
  const router = useRouter();
  const [connecting, setConnecting] = useState<PublisherInfoWire | null>(null);
  const [disconnecting, setDisconnecting] = useState<PublisherInfoWire | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [instance, setInstance] = useState('mastodon.social');
  const websiteId = data.website.id;

  const accountFor = (platform: string): SocialAccountRow | undefined => data.accounts.find((account) => account.platform === platform);
  const modeFor = (platform: SocialPlatformValue) => data.oauth.platforms.find((entry) => entry.platform === platform);

  // The platform sends the browser back here with `connected` or `error`; say so once, then
  // drop the parameters so a reload does not repeat the message.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const connected = url.searchParams.get('connected');
    const error = url.searchParams.get('error');
    const handle = url.searchParams.get('handle');
    if (!connected && !error) return;
    if (connected) {
      const label = data.publishers.find((publisher) => platformSlug(publisher.platform) === connected)?.label ?? connected;
      toast.success(`${label} connected${handle ? ` as ${handle}` : ''}`);
    }
    if (error) toast.error('Connection not completed', { description: error, duration: 12_000 });
    for (const key of ['connected', 'error', 'handle']) url.searchParams.delete(key);
    window.history.replaceState(null, '', url.toString());
  }, [data.publishers]);

  const test = useCallback(
    async (publisher: PublisherInfoWire) => {
      setBusy(publisher.platform);
      try {
        const result = await apiPost<{ test: ConnectionTestWire }>(`/api/social/accounts/${platformSlug(publisher.platform)}/test`, {
          websiteId,
        });
        if (result.test.ok) toast.success(`${publisher.label} works`, { description: result.test.message });
        else toast.warning(`${publisher.label} test failed`, { description: result.test.message, duration: 10_000 });
        router.refresh();
      } catch (error) {
        reportApiError(error, `Could not test ${publisher.label}.`);
      } finally {
        setBusy(null);
      }
    },
    [router, websiteId],
  );

  async function disconnect(): Promise<void> {
    if (!disconnecting) return;
    try {
      await apiDelete(`/api/social/accounts/${platformSlug(disconnecting.platform)}?websiteId=${encodeURIComponent(websiteId)}`);
      toast.success(`${disconnecting.label} disconnected`);
      router.refresh();
    } catch (error) {
      reportApiError(error, `Could not disconnect ${disconnecting.label}.`);
    } finally {
      setDisconnecting(null);
    }
  }

  const missingApps = data.oauth.developerApps.filter((app) => !app.configured).length;

  return (
    <div className="space-y-5">
      <Alert variant="neutral" icon={ShieldCheck}>
        <AlertTitle>One click per account — on the platform&rsquo;s own page</AlertTitle>
        <AlertDescription>
          &ldquo;Connect&rdquo; sends you to Reddit, X, LinkedIn, Mastodon or Discord, where you sign in and approve; nothing
          about your login passes through this app, and the platform can revoke it any time. Posting only ever uses each
          network&rsquo;s official API, one brand account per network for this site. This app never creates accounts or
          logs in for you, and replies in other people&rsquo;s communities always wait for your approval.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.publishers.map((publisher) => {
          const account = accountFor(publisher.platform);
          const status = account?.status ?? 'NOT_CONFIGURED';
          const connected = Boolean(account?.hasCredentials);
          const mode = modeFor(publisher.platform);
          const quick = QUICK_FORMS[publisher.platform];
          const needsReconnect = status === 'EXPIRED' || status === 'ERROR';
          return (
            <Card key={publisher.platform}>
              <CardHeader>
                <CardTitle className="text-base">{publisher.label}</CardTitle>
                <CardAction>
                  <Badge variant={STATUS_VARIANT[status]}>
                    {status === 'NOT_CONFIGURED'
                      ? 'Not connected'
                      : status === 'CONNECTED' && account && !account.canPost
                        ? 'listening only'
                        : status.toLowerCase()}
                  </Badge>
                </CardAction>
                <CardDescription>
                  {mode?.mode === 'form'
                    ? 'Three quick steps — the secret is created on the platform and pasted once.'
                    : mode?.mode === 'oauth-instance'
                      ? 'Name your server and approve. No developer setup at all.'
                      : mode?.ready
                        ? 'Click Connect, sign in on the platform and approve.'
                        : 'One click once the developer app below is set up (a one-time step for all your sites).'}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={publisher.capabilities.original ? 'secondary' : 'muted'} className="font-normal">
                    {publisher.capabilities.original ? 'Posts to your channel' : 'No posts'}
                  </Badge>
                  <Badge variant={publisher.capabilities.reply ? 'secondary' : 'muted'} className="font-normal">
                    {publisher.capabilities.reply ? 'Replies (with approval)' : 'No replies'}
                  </Badge>
                  <Badge variant={publisher.capabilities.metrics ? 'secondary' : 'muted'} className="font-normal">
                    {publisher.capabilities.metrics ? 'Reads engagement' : 'No engagement data'}
                  </Badge>
                </div>

                {account && connected ? (
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-muted-foreground">Account</dt>
                    <dd className="truncate text-foreground">{account.handle ?? account.displayName ?? 'unknown (not tested yet)'}</dd>
                    <dt className="text-muted-foreground">Connection</dt>
                    <dd className="text-foreground">
                      {account.authType === 'oauth' ? 'One-click' : 'Keys'} · {expiryLabel(account)}
                    </dd>
                    <dt className="text-muted-foreground">Last post</dt>
                    <dd className="text-foreground">{account.lastPostAt ? relativeTime(account.lastPostAt) : 'none yet'}</dd>
                    <dt className="text-muted-foreground">Last checked</dt>
                    <dd className="text-foreground">{account.lastTestedAt ? formatDateTime(account.lastTestedAt) : 'never'}</dd>
                  </dl>
                ) : null}
                {account?.lastError ? (
                  <p className="rounded-md border border-destructive/30 bg-destructive/[0.07] p-2 text-xs text-destructive">{account.lastError}</p>
                ) : null}

                {quick && !connected ? (
                  <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
                    {quick.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                ) : null}

                {mode?.mode === 'oauth-instance' && (!connected || needsReconnect) ? (
                  <FormField label="Your Mastodon server" htmlFor={`instance-${publisher.platform}`} description="For example mastodon.social or fosstodon.org.">
                    <Input
                      id={`instance-${publisher.platform}`}
                      value={instance}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(event) => setInstance(event.target.value)}
                    />
                  </FormField>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  {mode?.mode === 'oauth' || mode?.mode === 'oauth-instance' ? (
                    mode.ready ? (
                      <Button size="sm" variant={connected && !needsReconnect ? 'outline' : 'default'} asChild>
                        <a href={startUrl(publisher.platform, websiteId, mode.mode === 'oauth-instance' ? instance.trim() : undefined)}>
                          <LogIn aria-hidden="true" />
                          {connected ? (needsReconnect ? 'Reconnect' : 'Reconnect / switch account') : `Connect ${publisher.label}`}
                        </a>
                      </Button>
                    ) : (
                      <Button size="sm" variant="default" asChild>
                        <a href="#developer-apps">
                          <Wrench aria-hidden="true" />
                          Set up once, then connect
                        </a>
                      </Button>
                    )
                  ) : (
                    <>
                      {quick ? (
                        <Button size="sm" variant="outline" asChild>
                          <a href={quick.href} target="_blank" rel="noopener noreferrer">
                            <ExternalLink aria-hidden="true" />
                            {quick.linkLabel}
                          </a>
                        </Button>
                      ) : null}
                      <Button size="sm" variant={connected && !needsReconnect ? 'outline' : 'default'} onClick={() => setConnecting(publisher)}>
                        {connected ? <KeyRound aria-hidden="true" /> : <Plug aria-hidden="true" />}
                        {connected ? 'Update' : 'Connect'}
                      </Button>
                    </>
                  )}
                  {connected ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        loading={busy === publisher.platform}
                        loadingText="Testing"
                        onClick={() => void test(publisher)}
                      >
                        <RefreshCw aria-hidden="true" />
                        Test
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDisconnecting(publisher)}>
                        <Unplug aria-hidden="true" />
                        Disconnect
                      </Button>
                    </>
                  ) : null}
                  {mode && mode.mode !== 'form' ? (
                    <Button size="sm" variant="ghost" onClick={() => setConnecting(publisher)}>
                      <KeyRound aria-hidden="true" />
                      Use keys instead
                    </Button>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <DeveloperAppsCard apps={data.oauth.developerApps} missing={missingApps} />

      <p className="text-2xs text-muted-foreground">
        Hand-posted platforms: {data.manualOnlyPlatforms.map((platform) => PLATFORM_LABEL[platform]).join(', ')}. Managing
        several sites? <a className="text-primary hover:underline" href="/social">See every account in one place</a>.
      </p>

      <ConnectDialog
        websiteId={websiteId}
        publisher={connecting}
        account={connecting ? accountFor(connecting.platform) : undefined}
        onClose={() => setConnecting(null)}
      />

      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        destructive
        title={`Disconnect ${disconnecting?.label ?? 'this account'}?`}
        description="The stored credentials are deleted. Posts already scheduled for this platform will be handed to you to post by hand instead."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
      />
    </div>
  );
}

/**
 * The one-time setup behind one-click Connect for Reddit, X, LinkedIn and Discord: an app on
 * each developer portal, shared by every site and every account on this installation.
 */
function DeveloperAppsCard({ apps, missing }: { apps: DeveloperAppWire[]; missing: number }): React.JSX.Element {
  return (
    <Card id="developer-apps" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench aria-hidden="true" className="size-4" />
          One-time developer apps
        </CardTitle>
        <CardAction>
          <Badge variant={missing === 0 ? 'success' : 'muted'}>{missing === 0 ? 'All set' : `${missing} to set up`}</Badge>
        </CardAction>
        <CardDescription>
          Reddit, X, LinkedIn and Discord only offer one-click approval to registered apps. Register each once (about two
          minutes) and every site gets a Connect button. Mastodon needs nothing; Bluesky, Telegram and Dev.to use a short form.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        {apps.map((app) => (
          <DeveloperAppForm key={app.platform} app={app} />
        ))}
      </CardContent>
    </Card>
  );
}

function DeveloperAppForm({ app }: { app: DeveloperAppWire }): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [pending, setPending] = useState(false);

  async function save(): Promise<void> {
    setPending(true);
    try {
      await apiPost('/api/social/oauth-apps', { platform: app.platform, clientId: clientId.trim(), clientSecret: clientSecret.trim() });
      toast.success(`${app.label} app saved`, { description: 'Connect buttons for it are live on every site.' });
      setClientId('');
      setClientSecret('');
      router.refresh();
    } catch (error) {
      reportApiError(error, `Could not save the ${app.label} app.`);
    } finally {
      setPending(false);
    }
  }

  async function remove(): Promise<void> {
    setPending(true);
    try {
      await apiDelete(`/api/social/oauth-apps?platform=${app.platform}`);
      toast.success(`${app.label} app removed`);
      router.refresh();
    } catch (error) {
      reportApiError(error, `Could not remove the ${app.label} app.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-labelledby={`${ids}-title`}>
      <div className="flex items-start justify-between gap-3">
        <h4 id={`${ids}-title`} className="text-sm font-semibold">
          {app.label}
        </h4>
        <Badge variant={app.configured ? 'success' : 'muted'}>
          {app.configured ? (app.source === 'env' ? 'set in .env' : `saved · ${app.clientIdPreview ?? ''}`) : 'not set up'}
        </Badge>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        {app.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <Button size="sm" variant="outline" asChild>
        <a href={app.createUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink aria-hidden="true" />
          Open the {app.label} developer portal
        </a>
      </Button>
      <FormField label="Redirect URI" htmlFor={`${ids}-redirect`} description="Paste exactly this into the app's redirect/callback setting.">
        <div className="flex items-center gap-2">
          <Input id={`${ids}-redirect`} value={app.redirectUri} readOnly className="font-mono text-xs" />
          <CopyButton value={app.redirectUri} label="Copy redirect URI" />
        </div>
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Client ID" htmlFor={`${ids}-id`}>
          <Input
            id={`${ids}-id`}
            value={clientId}
            placeholder={app.configured ? 'Saved — paste to replace' : ''}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setClientId(event.target.value)}
          />
        </FormField>
        <FormField label="Client secret" htmlFor={`${ids}-secret`} {...(app.hasSecret ? { description: 'Blank keeps the saved secret.' } : {})}>
          <Input
            id={`${ids}-secret`}
            type="password"
            value={clientSecret}
            placeholder={app.hasSecret ? '•••••• (saved)' : ''}
            autoComplete="new-password"
            spellCheck={false}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </FormField>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={pending} loadingText="Saving" disabled={!clientId.trim()} onClick={() => void save()}>
          Save {app.label} app
        </Button>
        {app.configured && app.source === 'settings' ? (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => void remove()}>
            Remove
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Credential form generated from the publisher's own field declaration. Secret fields are
 * password inputs and are never prefilled; non-secret settings show their stored value.
 */
function ConnectDialog({
  websiteId,
  publisher,
  account,
  onClose,
}: {
  websiteId: string;
  publisher: PublisherInfoWire | null;
  account: SocialAccountRow | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const hasStored = Boolean(account?.hasCredentials);

  useEffect(() => {
    if (!publisher) return;
    const initial: Record<string, string> = {};
    for (const field of publisher.configFields) {
      const stored = account?.config[field.key];
      if (stored !== undefined) initial[field.key] = String(stored);
    }
    setValues(initial);
  }, [publisher, account]);

  const missing = publisher
    ? [
        // Stored credentials satisfy required fields: blank means "keep what is saved".
        ...publisher.credentialFields.filter((field) => field.required && !hasStored && !values[field.key]?.trim()),
        ...publisher.configFields.filter((field) => field.required && !values[field.key]?.trim()),
      ].map((field) => field.label)
    : [];

  async function connect(): Promise<void> {
    if (!publisher) return;
    setPending(true);
    try {
      const credentials: Record<string, string> = {};
      for (const field of publisher.credentialFields) {
        const value = values[field.key]?.trim();
        if (value) credentials[field.key] = value;
      }
      const config: Record<string, string> = {};
      for (const field of publisher.configFields) config[field.key] = values[field.key]?.trim() ?? '';

      const result = await apiPost<{ test: ConnectionTestWire | null }>(`/api/social/accounts/${platformSlug(publisher.platform)}`, {
        websiteId,
        credentials,
        config,
        test: true,
      });
      if (result.test && !result.test.ok) {
        toast.warning(`${publisher.label} saved, but the test call failed`, { description: result.test.message, duration: 10_000 });
      } else {
        toast.success(`${publisher.label} connected${result.test?.handle ? ` as ${result.test.handle}` : ''}`);
      }
      setValues({});
      onClose();
      router.refresh();
    } catch (error) {
      reportApiError(error, `Could not connect ${publisher.label}.`);
    } finally {
      setPending(false);
    }
  }

  function field(spec: PublisherFieldInfo, isCredential: boolean): React.JSX.Element {
    const keepHint = isCredential && hasStored ? 'Leave blank to keep the saved value.' : null;
    const description = [spec.help, keepHint].filter(Boolean).join(' ');
    return (
      <FormField
        key={spec.key}
        label={spec.label}
        htmlFor={`${ids}-${spec.key}`}
        required={spec.required && !(isCredential && hasStored)}
        {...(description ? { description } : {})}
      >
        <Input
          id={`${ids}-${spec.key}`}
          type={spec.secret ? 'password' : 'text'}
          value={values[spec.key] ?? ''}
          placeholder={isCredential && hasStored ? '•••••• (saved)' : spec.placeholder}
          autoComplete={spec.secret ? 'new-password' : 'off'}
          spellCheck={false}
          onChange={(event) => setValues((current) => ({ ...current, [spec.key]: event.target.value }))}
        />
      </FormField>
    );
  }

  return (
    <Dialog
      open={publisher !== null}
      onOpenChange={(open) => {
        if (!open) {
          setValues({});
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {hasStored ? 'Update' : 'Connect'} {publisher?.label}
          </DialogTitle>
          <DialogDescription>
            {publisher?.setupHelp} Saved encrypted and never shown again. The connection is checked with a read-only call — nothing
            is posted to test it.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
          {publisher?.credentialFields.map((spec) => field(spec, true))}
          {publisher && publisher.configFields.length > 0 ? (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Settings (not secret)</p>
              {publisher.configFields.map((spec) => field(spec, false))}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" loading={pending} loadingText="Connecting" disabled={missing.length > 0} onClick={() => void connect()}>
            {hasStored ? 'Save and test' : 'Connect and test'}
          </Button>
        </DialogFooter>
        {missing.length > 0 ? <p className="text-2xs text-muted-foreground">Still needed: {missing.join(', ')}.</p> : null}
      </DialogContent>
    </Dialog>
  );
}
