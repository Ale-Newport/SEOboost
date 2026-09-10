import Link from 'next/link';
import { AlertTriangle, ArrowRight, Clock, Target } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Delta } from '@/components/ui/delta';
import { ScoreRing } from '@/components/ui/score-ring';
import { formatCompact, formatNumber } from '@/lib/utils';
import type { DashboardData } from '@/server/queries/dashboard';

type Site = DashboardData['websites'][number];
type Need = DashboardData['siteRanking'][number];

export function SiteCard({ site, need }: { site: Site; need: Need | null }) {
  const lastCrawl = site.lastCrawlAt
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(site.lastCrawlAt)
    : null;

  return (
    <Card className="group transition-colors hover:border-primary/40">
      <CardHeader className="space-y-0 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={`/sites/${site.websiteId}`} className="block">
              <h3 className="truncate font-semibold group-hover:text-primary">{site.name}</h3>
              <p className="truncate text-xs text-muted-foreground">{site.domain}</p>
            </Link>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {site.isDemo && <Badge variant="outline" className="text-2xs">Demo</Badge>}
            {site.status === 'PAUSED' && <Badge variant="secondary" className="text-2xs">Paused</Badge>}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center justify-around rounded-lg border border-border bg-muted/30 py-3">
          <ScoreRing value={site.healthScore} label="Health" size="sm" />
          <ScoreRing value={site.geoScore} label="GEO" size="sm" />
          <ScoreRing value={site.aiVisibilityScore} label="AI" size="sm" />
        </div>

        <dl className="grid grid-cols-3 gap-2 text-center">
          <div>
            <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Clicks</dt>
            <dd className="tabular text-sm font-semibold">{formatNumber(site.clicks28d)}</dd>
            {site.clicksChangePct !== null && (
              <Delta value={site.clicksChangePct} className="justify-center text-2xs" />
            )}
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Impressions</dt>
            <dd className="tabular text-sm font-semibold">{formatCompact(site.impressions28d)}</dd>
          </div>
          <div>
            <dt className="text-2xs uppercase tracking-wide text-muted-foreground">Issues</dt>
            <dd
              className={`tabular text-sm font-semibold ${site.openCriticalIssues > 0 ? 'text-destructive' : ''}`}
            >
              {formatNumber(site.openIssues)}
            </dd>
          </div>
        </dl>

        {need && need.needScore > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            {site.openCriticalIssues > 0 ? (
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
            ) : (
              <Target className="mt-0.5 h-3 w-3 shrink-0" />
            )}
            <span className="line-clamp-2">{need.reason}</span>
          </p>
        )}

        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="flex items-center gap-1 text-2xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {lastCrawl ? `Crawled ${lastCrawl}` : 'Never crawled'}
          </span>
          <Link
            href={`/sites/${site.websiteId}`}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            Open
            <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
