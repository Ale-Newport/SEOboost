'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Link2, Plug, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { ApiError, apiDelete, apiPost } from '@/lib/api-client';
import type { AdapterFieldInfo, IntegrationRow } from '@/components/site-settings/types';

/**
 * Connection state per provider for this site.
 *
 * Two things this screen will never do: show a credential, and pretend a provider is available
 * when the installation cannot support it. An unconfigured provider names the exact environment
 * variables an operator has to set — "not connected" and "not possible here" are different
 * problems, and they get different copy.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** URL-friendly provider segment used by `/api/integrations/[provider]`. */
function providerSlug(provider: string): string {
  return provider.toLowerCase().replace(/_/g, '-');
}

type Busy = { provider: string; op: 'sync' | 'test' | 'disconnect' | 'connect' } | null;

export interface IntegrationsTabProps {
  websiteId: string;
  integrations: readonly IntegrationRow[];
}

export function IntegrationsTab({ websiteId, integrations }: IntegrationsTabProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [connecting, setConnecting] = useState<IntegrationRow | null>(null);
  const [disconnecting, setDisconnecting] = useState<IntegrationRow | null>(null);

  const isBusy = (provider: string, op: NonNullable<Busy>['op']): boolean =>
    busy !== null && busy.provider === provider && busy.op === op;

  const sync = useCallback(
    async (row: IntegrationRow) => {
      setBusy({ provider: row.provider, op: 'sync' });
      try {
        const result = await apiPost<{ skipped?: boolean; reason?: string; enqueued?: boolean }>(
          `/api/integrations/${providerSlug(row.provider)}/sync`,
          { websiteId },
        );
        if (result.skipped) {
          toast.warning(`${row.label} was not synced`, { description: result.reason });
        } else if (result.enqueued === false) {
          toast.warning('Sync recorded but not started', {
            description: 'No queue broker is reachable. Set REDIS_URL and start the worker.',
          });
        } else {
          toast.success(`${row.label} sync queued`, {
            description: 'Follow it on the Jobs screen; new data appears once the job finishes.',
          });
        }
        router.refresh();
      } catch (cause) {
        toast.error(cause instanceof ApiError ? cause.message : `Could not sync ${row.label}.`);
      } finally {
        setBusy(null);
      }
    },
    [router, websiteId],
  );

  const test = useCallback(
    async (row: IntegrationRow) => {
      setBusy({ provider: row.provider, op: 'test' });
      try {
        const result = await apiPost<{ ok: boolean; detail?: string; error?: string; warnings?: string[] }>(
          `/api/integrations/${providerSlug(row.provider)}/test`,
          { websiteId },
        );
        if (result.ok) {
          toast.success(`${row.label} responded`, {
            description: result.detail ?? 'The authenticated round-trip succeeded.',
          });
        } else {
          toast.error(`${row.label} did not respond`, { description: result.error });
        }
        for (const warning of result.warnings ?? []) toast.warning(warning);
        router.refresh();
      } catch (cause) {
        toast.error(cause instanceof ApiError ? cause.message : `Could not test ${row.label}.`);
      } finally {
        setBusy(null);
      }
    },
    [router, websiteId],
  );

  const disconnect = useCallback(async () => {
    if (!disconnecting) return;
    const row = disconnecting;
    setBusy({ provider: row.provider, op: 'disconnect' });
    try {
      await apiDelete(
        `/api/integrations/${providerSlug(row.provider)}?websiteId=${encodeURIComponent(websiteId)}`,
      );
      toast.success(`${row.label} disconnected`, {
        description: 'The stored credentials were cleared. Data already synced is kept.',
      });
      setDisconnecting(null);
      router.refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : `Could not disconnect ${row.label}.`);
      throw cause;
    } finally {
      setBusy(null);
    }
  }, [disconnecting, router, websiteId]);

  return (
    <div className="space-y-6">
      <Alert variant="neutral" icon={ShieldCheck}>
        <AlertTitle>Credentials never come back out</AlertTitle>
        <AlertDescription>
          Secrets are encrypted on the server the moment they are saved and are never returned to
          this screen — not masked, not partially. To change one, connect again; to remove it,
          disconnect.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 xl:grid-cols-2">
        {integrations.map((row) => (
          <Card key={row.provider}>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {row.label}
                <StatusBadge status={row.status} />
                {row.isOAuth ? (
                  <Badge variant="outline" className="font-normal">
                    OAuth
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription>
                {row.adapter?.description ??
                  (row.isOAuth
                    ? 'Connected by granting access to a Google account that can see this property.'
                    : 'Configured through this installation’s environment.')}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-3">
              {!row.envReady ? (
                <Alert variant="warning" icon={KeyRound}>
                  <AlertTitle>Not available on this installation</AlertTitle>
                  <AlertDescription>
                    Set{' '}
                    {row.requiredEnv.map((name, index) => (
                      <span key={name}>
                        {index > 0 ? ' and ' : ''}
                        <code className="font-mono text-2xs">{name}</code>
                      </span>
                    ))}{' '}
                    on the server, then restart it. Until then this provider cannot be connected
                    for any site.
                  </AlertDescription>
                </Alert>
              ) : null}

              <StatList dense divided>
                <StatListItem
                  label="Credentials"
                  value={row.hasCredentials ? 'Stored (encrypted)' : 'None stored'}
                  {...(row.hasCredentials ? {} : { muted: true })}
                  hint="Only whether an encrypted envelope exists. The value itself never leaves the server."
                />
                {row.accountEmail ? (
                  <StatListItem label="Account" value={row.accountEmail} />
                ) : null}
                {Object.entries(row.config).map(([key, value]) => (
                  <StatListItem key={key} label={key} value={value} mono />
                ))}
                <StatListItem
                  label="Last sync"
                  value={row.lastSyncAt ? DATE_TIME.format(new Date(row.lastSyncAt)) : 'Never synced'}
                  {...(row.lastSyncAt ? {} : { muted: true })}
                />
                {row.lastSyncStatus ? (
                  <StatListItem label="Last sync result" value={row.lastSyncStatus} />
                ) : null}
                {row.expiresAt ? (
                  <StatListItem
                    label="Grant expires"
                    value={DATE_TIME.format(new Date(row.expiresAt))}
                    hint="Refreshed automatically while the refresh token is valid."
                  />
                ) : null}
              </StatList>

              {row.lastError ? (
                <Alert variant="destructive">
                  <AlertTitle>Last error</AlertTitle>
                  <AlertDescription className="break-words">{row.lastError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                {row.hasCredentials ? (
                  <>
                    {row.canSync ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8"
                        loading={isBusy(row.provider, 'sync')}
                        loadingText="Queueing"
                        onClick={() => void sync(row)}
                      >
                        <RefreshCw aria-hidden="true" />
                        Sync now
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      loading={isBusy(row.provider, 'test')}
                      loadingText="Testing"
                      onClick={() => void test(row)}
                    >
                      <Plug aria-hidden="true" />
                      Test connection
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-destructive hover:text-destructive"
                      onClick={() => setDisconnecting(row)}
                    >
                      <Unplug aria-hidden="true" />
                      Disconnect
                    </Button>
                  </>
                ) : row.isOAuth ? (
                  <Button asChild size="sm" className="h-8" disabled={!row.envReady}>
                    <a
                      href={`/api/integrations/google/authorize?websiteId=${encodeURIComponent(
                        websiteId,
                      )}&provider=${row.provider}&redirectTo=${encodeURIComponent(
                        `/sites/${websiteId}/settings?tab=integrations`,
                      )}`}
                    >
                      <Link2 aria-hidden="true" />
                      Connect with Google
                    </a>
                  </Button>
                ) : row.adapter ? (
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={!row.envReady}
                    onClick={() => setConnecting(row)}
                  >
                    <Link2 aria-hidden="true" />
                    Connect
                  </Button>
                ) : (
                  <p className="text-2xs text-muted-foreground">
                    This provider has no per-site credentials; it is enabled through the
                    environment only.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <ConnectDialog
        websiteId={websiteId}
        row={connecting}
        onClose={() => setConnecting(null)}
        onConnected={() => {
          setConnecting(null);
          router.refresh();
        }}
      />

      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => {
          if (!open) setDisconnecting(null);
        }}
        destructive
        title={`Disconnect ${disconnecting?.label ?? 'this integration'}?`}
        description="The stored credentials are cleared and nothing will sync or publish through this provider until it is connected again. Data already synced stays."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
      />
    </div>
  );
}

/**
 * Credential form for an adapter-backed provider.
 *
 * The fields come from the adapter's own declaration, so this dialog never guesses what a
 * provider needs, and nothing typed here is echoed back after saving.
 */
function ConnectDialog({
  websiteId,
  row,
  onClose,
  onConnected,
}: {
  websiteId: string;
  row: IntegrationRow | null;
  onClose: () => void;
  onConnected: () => void;
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  const adapter = row?.adapter ?? null;
  const missing =
    adapter === null
      ? []
      : [...adapter.credentialFields, ...adapter.configFields]
          .filter((field) => field.required && !values[field.key]?.trim())
          .map((field) => field.label);

  async function connect(): Promise<void> {
    if (!row || !adapter) return;
    setPending(true);
    try {
      const credentials: Record<string, string> = {};
      for (const field of adapter.credentialFields) {
        const value = values[field.key]?.trim();
        if (value) credentials[field.key] = value;
      }
      const config: Record<string, string> = {};
      for (const field of adapter.configFields) {
        const value = values[field.key]?.trim();
        if (value) config[field.key] = value;
      }

      const result = await apiPost<{ status: string; test?: { ok: boolean; error?: string } }>(
        `/api/integrations/${providerSlug(row.provider)}`,
        { websiteId, credentials, config, test: true },
      );

      if (result.test && !result.test.ok) {
        toast.warning(`${row.label} credentials saved, but the test call failed`, {
          description: result.test.error ?? 'Check the values and try again.',
        });
      } else {
        toast.success(`${row.label} connected`);
      }
      setValues({});
      onConnected();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : `Could not connect ${row.label}.`);
    } finally {
      setPending(false);
    }
  }

  function field(spec: AdapterFieldInfo): React.JSX.Element {
    return (
      <FormField
        key={spec.key}
        label={spec.label}
        htmlFor={`connect-${spec.key}`}
        required={spec.required}
        {...(spec.help ? { description: spec.help } : {})}
      >
        <Input
          id={`connect-${spec.key}`}
          type={spec.secret ? 'password' : 'text'}
          value={values[spec.key] ?? ''}
          placeholder={spec.placeholder}
          autoComplete={spec.secret ? 'new-password' : 'off'}
          spellCheck={false}
          onChange={(event) => setValues((current) => ({ ...current, [spec.key]: event.target.value }))}
        />
      </FormField>
    );
  }

  return (
    <Dialog
      open={row !== null && adapter !== null}
      onOpenChange={(open) => {
        if (!open) {
          setValues({});
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect {row?.label}</DialogTitle>
          <DialogDescription>
            Saved encrypted and never shown again. The connection is tested with a real call before
            it is reported as connected.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
          {adapter?.credentialFields.map(field)}
          {adapter && adapter.configFields.length > 0 ? (
            <div className="space-y-4 border-t border-border pt-4">
              <p className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Settings (not secret)
              </p>
              {adapter.configFields.map(field)}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={pending}
            loadingText="Connecting"
            disabled={missing.length > 0}
            onClick={() => void connect()}
          >
            Connect and test
          </Button>
        </DialogFooter>

        {missing.length > 0 ? (
          <p className="text-2xs text-muted-foreground">Still needed: {missing.join(', ')}.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
