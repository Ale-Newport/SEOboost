import Link from 'next/link';
import { ArrowLeft, ExternalLink, MousePointerClick, Search, Target, TrendingUp } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { PageActions } from '@/components/pages/page-actions';
import { PageContentPanel } from '@/components/pages/page-content-panel';
import { PageHistoryPanel } from '@/components/pages/page-history-panel';
import { PageIssuesPanel } from '@/components/pages/page-issues-panel';
import { PageLinksPanel } from '@/components/pages/page-links-panel';
import { PagePerformancePanel } from '@/components/pages/page-performance-panel';
import { PageQueriesTable } from '@/components/pages/page-queries-table';
import { PageRecommendationsPanel } from '@/components/pages/page-recommendations-panel';
import { PageSchemaPanel } from '@/components/pages/page-schema-panel';
import { PageScorePanel } from '@/components/pages/page-score-panel';
import { formatCompact, formatNumber, formatPercent, formatPosition, shortenUrl } from '@/lib/utils';
import type { PageDetailData } from '@/components/pages/types';

export interface PageDetailViewProps {
  websiteId: string;
  websiteDomain: string;
  data: PageDetailData;
}

/** `ARTICLE` → `Article`. */
function humanizeType(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

export function PageDetailView({ websiteId, websiteDomain, data }: PageDetailViewProps): React.JSX.Element {
  const { profile, performance, document, scores } = data;
  const page = profile.page;
  const comparisonLabel = `vs the previous ${performance.days} days`;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title={page.title ?? shortenUrl(page.path === '' ? '/' : page.path, 70)}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 break-all font-mono text-xs">{page.url}</span>
            <CopyButton value={page.url} label="Copy the full URL" className="-my-1" />
            <a
              href={page.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              Open
              <ExternalLink className="size-3" aria-hidden="true" />
              <span className="sr-only">{page.url} in a new tab</span>
            </a>
          </span>
        }
        actions={
          <PageActions
            websiteId={websiteId}
            pageId={page.id}
            meta={data.meta}
            queries={data.queries}
            opportunities={profile.recommendations.opportunities}
          />
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
          <Link href={`/sites/${websiteId}/pages`}>
            <ArrowLeft aria-hidden="true" />
            All pages
          </Link>
        </Button>
        <Badge variant="outline">{humanizeType(page.pageType)}</Badge>
        {page.isIndexable ? (
          <Badge variant="success">Indexable</Badge>
        ) : (
          <Badge variant="muted">Not indexable</Badge>
        )}
        {page.statusCode === null ? null : (
          <Badge variant={page.statusCode >= 400 ? 'destructive' : page.statusCode >= 300 ? 'warning' : 'outline'}>
            HTTP {page.statusCode}
          </Badge>
        )}
        {page.inSitemap ? <Badge variant="outline">In sitemap</Badge> : <Badge variant="muted">Not in sitemap</Badge>}
        {page.isOrphan ? <Badge variant="warning">Orphan</Badge> : null}
        <span className="text-2xs text-muted-foreground">
          {page.lastCrawledAt
            ? `Last crawled ${page.lastCrawledAt.toLocaleString(undefined, DATE_FORMAT)}`
            : 'Never crawled'}
          {page.depth > 0 ? ` · depth ${page.depth}` : ''}
          {` · ${websiteDomain}`}
        </span>
      </div>

      {!page.isIndexable ? (
        <Alert variant="warning">
          <AlertTitle>This page is not indexable</AlertTitle>
          <AlertDescription>
            {page.indexabilityReason ??
              'The last crawl marked it non-indexable but recorded no reason — re-crawl the site to capture one.'}{' '}
            Search engines will not rank it while that is true, so on-page work here has no effect until it is
            resolved.
          </AlertDescription>
        </Alert>
      ) : null}

      {profile.crawlId === null ? (
        <Alert variant="info">
          <AlertTitle>No completed crawl for this site yet</AlertTitle>
          <AlertDescription>
            Internal links, the heading outline and the structured-data blocks all come from a crawl.{' '}
            <Link href={`/sites/${websiteId}`}>Start one from the site overview</Link> to fill in the empty
            sections below.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <PageScorePanel
          seo={scores.seo}
          storedSeoScore={page.seoScore}
          geo={scores.geo}
          storedGeoScore={page.geoScore}
          geoAuditedAt={scores.geoAuditedAt}
          opportunity={scores.opportunity}
          websiteId={websiteId}
          lastAnalysedAt={page.lastAnalysedAt}
        />

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label="Clicks"
            value={performance.hasData ? formatNumber(performance.totals.clicks) : '—'}
            delta={performance.hasData ? performance.deltas.clicks : undefined}
            deltaLabel={comparisonLabel}
            icon={MousePointerClick}
            info={`Search Console clicks for this exact URL between ${performance.range.from} and ${performance.range.to}.`}
            footer={performance.hasData ? `Last ${performance.days} days` : 'Connect Search Console'}
          />
          <MetricCard
            label="Impressions"
            value={performance.hasData ? formatCompact(performance.totals.impressions) : '—'}
            delta={performance.hasData ? performance.deltas.impressions : undefined}
            deltaLabel={comparisonLabel}
            icon={TrendingUp}
          />
          <MetricCard
            label="CTR"
            value={performance.hasData ? formatPercent(performance.totals.ctr, 2) : '—'}
            delta={performance.hasData ? performance.deltas.ctr : undefined}
            deltaLabel={comparisonLabel}
            icon={Search}
            info="Clicks divided by impressions across every query this URL appeared for."
          />
          <MetricCard
            label="Avg. position"
            value={performance.hasData ? formatPosition(performance.totals.position) : '—'}
            delta={performance.hasData ? performance.deltas.position : undefined}
            invertDelta
            deltaLabel={comparisonLabel}
            icon={Target}
            info="Impression-weighted across every query. Lower is better, so a negative change is an improvement."
          />
        </div>
      </div>

      <PagePerformancePanel websiteId={websiteId} performance={performance} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <PageQueriesTable queries={data.queries} hasSearchData={performance.hasData} websiteId={websiteId} />
        <PageRecommendationsPanel recommendations={data.recommendations} websiteId={websiteId} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <PageContentPanel
          page={page}
          document={document}
          meta={data.meta}
          thinContentWords={data.thinContentWords}
        />
        <PageLinksPanel
          websiteId={websiteId}
          hasCrawl={profile.crawlId !== null}
          inboundLinks={profile.inboundLinks}
          inboundLinkTotal={profile.inboundLinkTotal}
          outboundLinks={profile.outboundLinks}
          outboundLinkTotal={profile.outboundLinkTotal}
          suggestionsIn={profile.recommendations.linkSuggestionsIn}
          suggestionsOut={profile.recommendations.linkSuggestionsOut}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <PageIssuesPanel websiteId={websiteId} issues={profile.issues} hasCrawl={profile.crawlId !== null} />
        <PageSchemaPanel
          websiteId={websiteId}
          schemaTypes={page.schemaTypes}
          blocks={document?.structuredData ?? []}
          generated={data.generatedSchema}
          hasCrawl={profile.crawlId !== null}
        />
      </div>

      <PageHistoryPanel history={data.history} websiteId={websiteId} />
    </div>
  );
}
