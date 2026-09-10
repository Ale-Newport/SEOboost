import Link from 'next/link';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Delta } from '@/components/ui/delta';
import { ScoreRing } from '@/components/ui/score-ring';
import { formatCompact, formatNumber, cn } from '@/lib/utils';
import type { DashboardData } from '@/server/queries/dashboard';

interface Props {
  websites: DashboardData['websites'];
  ranking: DashboardData['siteRanking'];
}

export function WebsiteTable({ websites, ranking }: Props) {
  const needById = new Map(ranking.map((r) => [r.websiteId, r]));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Websites</CardTitle>
        <Link href="/sites" className="text-xs font-medium text-primary hover:underline">
          Manage all sites
        </Link>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="border-y border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">Website</th>
                <th scope="col" className="px-3 py-2 text-center font-medium">Health</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Clicks (28d)</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Impressions</th>
                <th scope="col" className="px-3 py-2 text-center font-medium">GEO</th>
                <th scope="col" className="px-3 py-2 text-center font-medium">AI visibility</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Issues</th>
                <th scope="col" className="px-3 py-2 text-left font-medium">Needs attention</th>
                <th scope="col" className="w-8 px-3 py-2" aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {websites.map((site) => {
                const need = needById.get(site.websiteId);
                return (
                  <tr key={site.websiteId} className="data-grid-row group">
                    <td className="px-4 py-2.5">
                      <Link href={`/sites/${site.websiteId}`} className="block min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium group-hover:text-primary">{site.name}</span>
                          {site.isDemo && <Badge variant="outline" className="shrink-0 text-2xs">Demo</Badge>}
                          {site.status === 'PAUSED' && <Badge variant="secondary" className="shrink-0 text-2xs">Paused</Badge>}
                        </div>
                        <span className="truncate text-xs text-muted-foreground">{site.domain}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {site.healthScore === null ? (
                        <span className="text-xs text-muted-foreground">Not crawled</span>
                      ) : (
                        <ScoreRing value={site.healthScore} size="sm" />
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      <div>{formatNumber(site.clicks28d)}</div>
                      {site.clicksChangePct !== null && (
                        <Delta value={site.clicksChangePct} className="justify-end text-2xs" />
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right text-muted-foreground">
                      {formatCompact(site.impressions28d)}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {site.geoScore === null ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <ScoreRing value={site.geoScore} size="sm" />
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      {site.aiVisibilityScore === null ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <ScoreRing value={site.aiVisibilityScore} size="sm" />
                      )}
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1',
                          site.openCriticalIssues > 0 ? 'font-medium text-destructive' : 'text-muted-foreground',
                        )}
                      >
                        {site.openCriticalIssues > 0 && <AlertTriangle className="h-3 w-3" />}
                        {formatNumber(site.openIssues)}
                      </span>
                    </td>
                    <td className="max-w-[280px] px-3 py-2.5">
                      <span className="line-clamp-1 text-xs text-muted-foreground" title={need?.reason}>
                        {need?.reason ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Link href={`/sites/${site.websiteId}`} aria-label={`Open ${site.name}`}>
                        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
