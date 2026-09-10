import Link from 'next/link';
import { CalendarRange, LineChart, Link2, Settings } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import type { AnalyticsWebsite, AnalyticsWindow, SearchConsoleConnection } from './types';
import { SyncSearchConsoleButton } from './sync-search-console-button';

const AUTHORIZE_ENDPOINT = '/api/integrations/google/authorize';
const SEARCH_CONSOLE_PROVIDER = 'GOOGLE_SEARCH_CONSOLE';

export interface SearchConsoleEmptyStateProps {
  website: AnalyticsWebsite;
  connection: SearchConsoleConnection;
  window: AnalyticsWindow;
}

/**
 * The one thing this screen shows when it has no measurements.
 *
 * Every figure on the analytics page comes from an imported Search Console row, so with none
 * there is nothing honest to draw — an empty chart with real axes reads as "no traffic", which is
 * a different and much worse claim than "not connected". There are four distinct reasons the
 * numbers can be missing and they have four different fixes, so the state names the one that
 * actually applies instead of a generic "no data".
 */
export function SearchConsoleEmptyState({
  website,
  connection,
  window,
}: SearchConsoleEmptyStateProps): React.JSX.Element {
  // ── The installation cannot connect Google at all ────────────────────────
  if (!connection.envReady) {
    const vars = connection.requiredEnv.length > 0
      ? connection.requiredEnv
      : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

    return (
      <EmptyState
        bordered
        icon={Settings}
        title="Google OAuth is not configured on this installation"
        description={
          // Block elements are spans on purpose: `EmptyState` renders the description inside a
          // `<p>`, and a nested `<p>` or `<ul>` would be invalid markup the browser silently
          // restructures — which shows up as a hydration mismatch.
          <>
            <span className="block leading-relaxed">
              Search performance comes from Google Search Console, and nobody can connect an
              account until an operator creates an OAuth client and sets these environment
              variables:
            </span>
            <span className="mt-2 flex flex-wrap justify-center gap-1.5">
              {vars.map((name) => (
                <code
                  key={name}
                  className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-2xs text-foreground"
                >
                  {name}
                </code>
              ))}
            </span>
            <span className="mt-2 block leading-relaxed">
              The redirect URI defaults to{' '}
              <code className="font-mono text-2xs">
                {'<APP_URL>'}/api/integrations/google/callback
              </code>
              . These are set in the deployment environment and restart the app, so there is no
              button here that can fix it. Until then this screen stays empty rather than
              estimating traffic.
            </span>
          </>
        }
        secondaryAction={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/sites/${website.id}`}>Back to the site overview</Link>
          </Button>
        }
      />
    );
  }

  // ── Configured, but this site has no Google account attached ─────────────
  if (!connection.connected) {
    const returnTo = `/sites/${website.id}/analytics`;
    const connectHref =
      `${AUTHORIZE_ENDPOINT}?websiteId=${encodeURIComponent(website.id)}` +
      `&provider=${SEARCH_CONSOLE_PROVIDER}` +
      `&redirectTo=${encodeURIComponent(returnTo)}`;

    return (
      <EmptyState
        bordered
        icon={LineChart}
        title="Connect Google Search Console to see search performance"
        description={
          <>
            Clicks, impressions, CTR, average position, the CTR gaps and the query and page tables
            on this screen are all read from Search Console. Nothing here is modelled, so until{' '}
            <span className="font-medium text-foreground">{website.domain}</span> is connected
            there is nothing to show. Sign in with the Google account that owns the property — you
            will be asked for read access only, and tokens are encrypted before they are stored.
          </>
        }
        action={
          <Button asChild>
            <a href={connectHref}>
              <Link2 aria-hidden="true" />
              Connect Google Search Console
            </a>
          </Button>
        }
        secondaryAction={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/sites/${website.id}`}>Back to the site overview</Link>
          </Button>
        }
      />
    );
  }

  // ── Connected, but nothing has been imported yet ─────────────────────────
  if (!connection.hasAnyData) {
    return (
      <EmptyState
        bordered
        icon={LineChart}
        title="Search Console is connected, but no data has been imported yet"
        description={
          <>
            The account is linked ({connection.status.toLowerCase()}) and the first import has not
            landed. Sync pulls the last 90 days, which is enough to fill this screen; backfill
            reaches over Google&rsquo;s full 16-month retention and takes considerably longer.
            {connection.lastError ? (
              <span className="mt-2 block text-destructive">
                Last sync error: {connection.lastError}
              </span>
            ) : null}
            {connection.lastSyncLabel ? (
              <span className="mt-2 block">Last sync attempt: {connection.lastSyncLabel}.</span>
            ) : null}
          </>
        }
        action={<SyncSearchConsoleButton websiteId={website.id} />}
        secondaryAction={
          <SyncSearchConsoleButton
            websiteId={website.id}
            backfill
            variant="ghost"
            label="Backfill 16 months"
          />
        }
      />
    );
  }

  // ── Connected and populated — this particular window is just empty ───────
  return (
    <EmptyState
      bordered
      icon={CalendarRange}
      title="No Search Console rows between these dates"
      description={
        <>
          {website.domain} has imported data, but nothing falls in{' '}
          <span className="tabular font-medium text-foreground">{window.label}</span>.
          {connection.earliestDataLabel && connection.latestDataLabel ? (
            <>
              {' '}
              The imported range runs from{' '}
              <span className="tabular font-medium text-foreground">
                {connection.earliestDataLabel}
              </span>{' '}
              to{' '}
              <span className="tabular font-medium text-foreground">
                {connection.latestDataLabel}
              </span>
              . Pick a window inside it, or sync the missing days.
            </>
          ) : (
            ' Pick a different window, or sync the missing days.'
          )}
        </>
      }
      action={<SyncSearchConsoleButton websiteId={website.id} variant="outline" label="Sync missing days" />}
    />
  );
}
