import Link from 'next/link';
import { ExternalLink, MousePointerClick, Search, Target, TrendingUp } from 'lucide-react';

import { DistributionChart } from '@/components/charts/distribution-chart';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import {
  Section,
  SectionActions,
  SectionDescription,
  SectionHeader,
  SectionTitle,
} from '@/components/ui/section';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { formatCompact, formatNumber, formatPercent, formatPosition } from '@/lib/utils';
import { CtrGapTable } from './ctr-gap-table';
import { PagesTable } from './pages-table';
import { PerformanceChart } from './performance-chart';
import { PerformanceToolbar } from './performance-toolbar';
import { QueriesTable } from './queries-table';
import { SearchConsoleEmptyState } from './search-console-empty-state';
import { SegmentBreakdown } from './segment-breakdown';
import { SyncSearchConsoleButton } from './sync-search-console-button';
import type {
  AnalyticsDeltas,
  AnalyticsTotals,
  AnalyticsWebsite,
  AnalyticsWindow,
  CtrGapRow,
  PageRow,
  PerformancePoint,
  QueryRow,
  RankingCounts,
  SearchConsoleConnection,
  SegmentRow,
} from './types';

export interface AnalyticsViewProps {
  website: AnalyticsWebsite;
  window: AnalyticsWindow;
  /** Present only while the compare toggle is on. */
  comparisonWindow: AnalyticsWindow | null;
  totals: AnalyticsTotals;
  deltas: AnalyticsDeltas | null;
  series: readonly PerformancePoint[];
  queries: readonly QueryRow[];
  pages: readonly PageRow[];
  ctrGaps: readonly CtrGapRow[];
  countries: readonly SegmentRow[];
  devices: readonly SegmentRow[];
  rankingCounts: RankingCounts;
  /** Total keywords with a recorded position, so the distribution can state its own denominator. */
  rankedKeywords: number;
  connection: SearchConsoleConnection;
  /** False when the resolved window holds no imported rows at all. */
  hasData: boolean;
  /** Days the default window stops short of today, because Search Console publishes on a delay. */
  lagDays: number;
}

/**
 * The search-performance explorer.
 *
 * Ordered by the question being asked: how did the site do over this window, how did that move
 * day to day, which queries and pages produced it, where the cheapest unclaimed clicks are, and
 * who was searching. The window itself is the one control that governs everything below it, so it
 * sits directly under the title rather than inside any one card.
 */
export function AnalyticsView({
  website,
  window,
  comparisonWindow,
  totals,
  deltas,
  series,
  queries,
  pages,
  ctrGaps,
  countries,
  devices,
  rankingCounts,
  rankedKeywords,
  connection,
  hasData,
  lagDays,
}: AnalyticsViewProps): React.JSX.Element {
  const deltaLabel = comparisonWindow ? `vs ${comparisonWindow.label}` : undefined;
  const coverage =
    totals.days >= window.days
      ? `All ${formatNumber(window.days)} days imported`
      : `${formatNumber(totals.days)} of ${formatNumber(window.days)} days imported`;

  const header = (
    <PageHeader
      title="Analytics"
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <a
            href={website.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            {website.domain}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
          <span aria-hidden="true">·</span>
          <span>Measured search performance from Google Search Console</span>
        </span>
      }
      actions={
        connection.connected ? (
          <SyncSearchConsoleButton websiteId={website.id} variant="outline" label="Sync now" />
        ) : null
      }
    />
  );

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      {header}

      <PerformanceToolbar
        windowLabel={window.label}
        comparisonLabel={comparisonWindow?.label ?? null}
        lagDays={lagDays}
      />

      {!hasData ? (
        <SearchConsoleEmptyState website={website} connection={connection} window={window} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard
              label="Clicks"
              value={formatNumber(totals.clicks)}
              icon={MousePointerClick}
              {...(deltas ? { delta: deltas.clicks.changePct } : {})}
              {...(deltaLabel ? { deltaLabel } : {})}
              footer={coverage}
              info="Visits from a search result, summed over the window. Days with no imported row contribute nothing — they are not counted as zero-click days."
            />
            <MetricCard
              label="Impressions"
              value={formatCompact(totals.impressions)}
              icon={TrendingUp}
              {...(deltas ? { delta: deltas.impressions.changePct } : {})}
              {...(deltaLabel ? { deltaLabel } : {})}
              footer={`${formatNumber(totals.impressions)} exactly`}
              info="Times a result for this site appeared in search, summed over the window."
            />
            <MetricCard
              label="CTR"
              value={formatPercent(totals.ctr, 2)}
              icon={Search}
              {...(deltas ? { delta: deltas.ctr.changePct } : {})}
              {...(deltaLabel ? { deltaLabel } : {})}
              footer="Clicks ÷ impressions"
              info="Computed over the whole window, not as the mean of the daily rates — averaging daily CTRs over-weights quiet days."
            />
            <MetricCard
              label="Avg. position"
              value={formatPosition(totals.position)}
              icon={Target}
              invertDelta
              {...(deltas ? { delta: deltas.position.changePct } : {})}
              {...(deltaLabel ? { deltaLabel } : {})}
              footer="Lower is better"
              info="Impression-weighted mean position across every reported query. Weighting matters: a plain average lets a single obscure query at position 90 drag the whole site down."
            />
          </div>

          <PerformanceChart
            data={series}
            comparisonEnabled={comparisonWindow !== null}
            comparisonLabel={comparisonWindow ? comparisonWindow.label : 'Previous period'}
            windowLabel={window.label}
          />

          <Section spacing="md">
            <SectionHeader>
              <div className="space-y-1">
                <SectionTitle>What produced the traffic</SectionTitle>
                <SectionDescription>
                  Queries aggregated across every page that ranks for them, and pages aggregated
                  across every query that sent them impressions. Both tables sort and export the
                  full set you see.
                </SectionDescription>
              </div>
            </SectionHeader>

            <Tabs defaultValue="queries" className="space-y-3">
              <TabsList aria-label="Top queries or top pages">
                <TabsTrigger value="queries">
                  Top queries
                  <span className="tabular text-2xs text-muted-foreground">
                    {formatNumber(queries.length)}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="pages">
                  Top pages
                  <span className="tabular text-2xs text-muted-foreground">
                    {formatNumber(pages.length)}
                  </span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="queries">
                <QueriesTable
                  rows={queries}
                  domain={website.domain}
                  windowLabel={window.label}
                />
              </TabsContent>
              <TabsContent value="pages">
                <PagesTable rows={pages} domain={website.domain} windowLabel={window.label} />
              </TabsContent>
            </Tabs>
          </Section>

          <Section spacing="md">
            <SectionHeader>
              <div className="space-y-1">
                <SectionTitle className="flex items-center gap-1.5">
                  CTR gaps
                  <TooltipInfo
                    label="How the CTR gap is calculated"
                    content={
                      <>
                        For each query and page already ranking in the top ten with at least 100
                        impressions, the measured CTR is compared with the published click curve
                        for that average position. Rows more than a quarter below the curve are
                        listed, worst first. Potential clicks is{' '}
                        <span className="tabular">impressions × curve CTR − clicks</span> over this
                        window — what the same impressions would have produced at an ordinary CTR,
                        not a forecast of clicks you will get.
                      </>
                    }
                  />
                </SectionTitle>
                <SectionDescription>
                  Positions you already hold that are not being clicked. These are title, meta
                  description and rich-result problems, not ranking problems — which makes them the
                  cheapest work on this list.
                </SectionDescription>
              </div>
            </SectionHeader>

            <CtrGapTable rows={ctrGaps} domain={website.domain} windowLabel={window.label} />
          </Section>

          <Section spacing="md">
            <SectionHeader>
              <div className="space-y-1">
                <SectionTitle>Who was searching</SectionTitle>
                <SectionDescription>
                  Country and device rows are separate Search Console exports: each totals the whole
                  site for this window, so they agree with the cards above but cannot be combined
                  with each other.
                </SectionDescription>
              </div>
            </SectionHeader>

            <SegmentBreakdown
              countries={countries}
              devices={devices}
              domain={website.domain}
              windowLabel={window.label}
            />
          </Section>

          <Section spacing="md">
            <SectionHeader>
              <div className="space-y-1">
                <SectionTitle>Ranking distribution</SectionTitle>
                <SectionDescription>
                  Where this site&rsquo;s {formatNumber(rankedKeywords)} tracked{' '}
                  {rankedKeywords === 1 ? 'keyword sits' : 'keywords sit'} today. This comes from
                  the keyword table&rsquo;s latest recorded position, not from the window above, so
                  it does not move when you change the date range.
                </SectionDescription>
              </div>
              <SectionActions>
                <Link
                  href={`/sites/${website.id}/keywords`}
                  className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Open keywords
                </Link>
              </SectionActions>
            </SectionHeader>

            <DistributionChart
              counts={rankingCounts}
              unitLabel="keywords"
              emptyMessage="No tracked keyword has a recorded position yet. Import or track keywords for this site, then run a rank check to fill this in."
            />
          </Section>
        </>
      )}
    </div>
  );
}
