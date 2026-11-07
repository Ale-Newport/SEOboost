import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Plus, Wrench } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import type { MatrixAccountCell, SocialAccountsMatrix } from './types';

/**
 * The sites × networks table behind `/social`.
 *
 * Server-rendered: it only links out, so it needs no client state. Each cell says the one thing
 * an operator scanning ten accounts needs — connected as whom, or what to do about it — and
 * links straight to the site's Accounts tab where that is done.
 */

function daysUntil(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

function cellNote(cell: MatrixAccountCell): { text: string; tone: 'success' | 'warning' | 'destructive' | 'muted' } {
  if (cell.status === 'EXPIRED') return { text: 'Expired — reconnect', tone: 'warning' };
  if (cell.status === 'ERROR') return { text: 'Needs attention', tone: 'destructive' };
  if (cell.status !== 'CONNECTED') return { text: cell.status.toLowerCase(), tone: 'muted' };
  if (!cell.canPost) return { text: 'Listening only', tone: 'muted' };
  if (cell.authType === 'oauth' && cell.expiresAt && !cell.refreshable) {
    const days = daysUntil(cell.expiresAt);
    if (days <= 14) return { text: days <= 0 ? 'Expired — reconnect' : `Reconnect in ${days}d`, tone: 'warning' };
  }
  return { text: 'Connected', tone: 'success' };
}

export function SocialAccountsMatrixView({ matrix }: { matrix: SocialAccountsMatrix }): React.JSX.Element {
  if (matrix.sites.length === 0) {
    return (
      <EmptyState
        title="No sites yet"
        description="Add a website first; each site gets its own brand account per network."
        action={
          <Link className="text-sm text-primary hover:underline" href="/sites/new">
            Add a website
          </Link>
        }
      />
    );
  }

  const missingApps = matrix.developerApps.total - matrix.developerApps.configured;
  const firstSite = matrix.sites[0];

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Connected accounts" value={String(matrix.totals.connected)} icon={CheckCircle2} />
        <MetricCard label="Need a reconnect" value={String(matrix.totals.needsAttention)} icon={AlertTriangle} />
        <MetricCard
          label="Developer apps set up"
          value={`${matrix.developerApps.configured}/${matrix.developerApps.total}`}
          icon={Wrench}
        />
      </div>

      {missingApps > 0 && firstSite ? (
        <Alert variant="info" icon={Wrench}>
          <AlertTitle>
            {missingApps} one-time developer app{missingApps === 1 ? '' : 's'} left to set up
          </AlertTitle>
          <AlertDescription>
            Reddit, X, LinkedIn and Discord need an app registered once for the whole installation; after that every site
            connects with one click.{' '}
            <Link className="text-primary hover:underline" href={`/sites/${firstSite.id}/social?tab=accounts#developer-apps`}>
              Set them up
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <caption className="sr-only">Social accounts per site and network</caption>
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="sticky left-0 z-10 bg-card px-4 py-3 font-semibold">
                    Site
                  </th>
                  {matrix.platforms.map((platform) => (
                    <th key={platform.platform} scope="col" className="px-3 py-3 font-semibold">
                      {platform.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrix.sites.map((site) => {
                  const accountsHref = `/sites/${site.id}/social?tab=accounts`;
                  return (
                    <tr key={site.id} className="border-b border-border last:border-0">
                      <th scope="row" className="sticky left-0 z-10 bg-card px-4 py-3 text-left align-top font-medium">
                        <Link className="hover:underline" href={accountsHref}>
                          {site.name}
                        </Link>
                        <div className="text-2xs font-normal text-muted-foreground">{site.domain}</div>
                      </th>
                      {matrix.platforms.map((platform) => {
                        const cell = site.accounts[platform.platform];
                        if (!cell) {
                          return (
                            <td key={platform.platform} className="px-3 py-3 align-top">
                              <Link
                                className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground hover:text-primary"
                                href={accountsHref}
                              >
                                <Plus aria-hidden="true" className="size-3" />
                                {platform.mode === 'oauth' && !platform.ready ? 'Set up' : 'Connect'}
                              </Link>
                            </td>
                          );
                        }
                        const note = cellNote(cell);
                        return (
                          <td key={platform.platform} className="px-3 py-3 align-top">
                            <Link className="block space-y-1" href={accountsHref} title={cell.lastError ?? undefined}>
                              <span className="block max-w-[11rem] truncate text-xs text-foreground">{cell.handle ?? '—'}</span>
                              <Badge variant={note.tone} className="font-normal">
                                {note.text}
                              </Badge>
                            </Link>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-2xs text-muted-foreground">
        One account per network per site, by design: several accounts of the same network promoting the same product is
        sock-puppetry, and platforms ban it.
      </p>
    </div>
  );
}
