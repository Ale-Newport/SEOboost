'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Plug, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import type { PublisherFieldInfo, PublisherInfoWire, SocialAccountRow, SocialOverview } from './types';

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

export function AccountsTab({ data }: { data: SocialOverview }): React.JSX.Element {
  const router = useRouter();
  const [connecting, setConnecting] = useState<PublisherInfoWire | null>(null);
  const [disconnecting, setDisconnecting] = useState<PublisherInfoWire | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const websiteId = data.website.id;

  const accountFor = (platform: string): SocialAccountRow | undefined => data.accounts.find((account) => account.platform === platform);

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

  return (
    <div className="space-y-5">
      <Alert variant="neutral" icon={ShieldCheck}>
        <AlertTitle>Your accounts, official APIs, nothing else</AlertTitle>
        <AlertDescription>
          The platform only posts through each network&rsquo;s official API, from accounts you connect here yourself. It
          never logs in through a browser, never uses a scraped session, and never creates accounts. Replies in other
          people&rsquo;s communities always wait for your approval. Hacker News has no posting API: posts for it are
          prepared for you to submit by hand.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-2">
        {data.publishers.map((publisher) => {
          const account = accountFor(publisher.platform);
          const status = account?.status ?? 'NOT_CONFIGURED';
          const connected = Boolean(account?.hasCredentials);
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
                <CardDescription>{publisher.setupHelp}</CardDescription>
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
                    <dt className="text-muted-foreground">Last tested</dt>
                    <dd className="text-foreground">{account.lastTestedAt ? formatDateTime(account.lastTestedAt) : 'never'}</dd>
                    <dt className="text-muted-foreground">Last post</dt>
                    <dd className="text-foreground">{account.lastPostAt ? relativeTime(account.lastPostAt) : 'none yet'}</dd>
                  </dl>
                ) : null}
                {account?.lastError ? (
                  <p className="rounded-md border border-destructive/30 bg-destructive/[0.07] p-2 text-xs text-destructive">{account.lastError}</p>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant={connected ? 'outline' : 'default'} onClick={() => setConnecting(publisher)}>
                    {connected ? <KeyRound aria-hidden="true" /> : <Plug aria-hidden="true" />}
                    {connected ? 'Update' : 'Connect'}
                  </Button>
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
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-2xs text-muted-foreground">
        Hand-posted platforms: {data.manualOnlyPlatforms.map((platform) => PLATFORM_LABEL[platform]).join(', ')}.
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
