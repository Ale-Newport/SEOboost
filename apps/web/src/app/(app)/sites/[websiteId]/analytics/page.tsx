import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { IntegrationProvider, prisma } from '@seo/db';
import { daysBetween, type DateRange } from '@seo/shared';

import { getCurrentUser } from '@/lib/auth';
import {
  GSC_LAG_DAYS,
  getCtrGaps,
  getPerformanceSeries,
  getPerformanceSummary,
  getQueryPageAggregates,
  getRankingDistribution,
  getSegmentBreakdown,
  getTopQueries,
  resolveRange,
  type PerformanceFilters,
} from '@/server/queries/analytics';
import { getSiteIntegrations } from '@/server/queries/integrations';
import { AnalyticsView } from '@/components/analytics/analytics-view';
import type {
  AnalyticsDeltas,
  AnalyticsWindow,
  CtrGapRow,
  PageRow,
  PerformancePoint,
  QueryRow,
  RankingCounts,
  SearchConsoleConnection,
  SegmentRow,
} from '@/components/analytics/types';

export const metadata: Metadata = { title: 'Analytics' };
export const dynamic = 'force-dynamic';

/** Matches the picker's own clamp — `?days=999999` is one keystroke away from an unbounded scan. */
const MAX_RANGE_DAYS = 1095;
const DEFAULT_RANGE_DAYS = 28;

const TOP_QUERY_LIMIT = 50;
const TOP_PAGE_LIMIT = 50;
/** Query × page rows pulled to build the page table. Enough for a large site, bounded for a huge one. */
const PAGE_AGGREGATE_LIMIT = 5000;
const CTR_GAP_LIMIT = 25;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Fixed locale and UTC: the ranges are calendar days, and the server must not label them using
// its own timezone when the browser would disagree about which day it is.
const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function describeRange(start: Date, end: Date): string {
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  return `${(sameYear ? DAY_MONTH : DAY_MONTH_YEAR).format(start)} – ${DAY_MONTH_YEAR.format(end)}`;
}

function toWindow(range: DateRange): AnalyticsWindow {
  return {
    from: range.start.toISOString().slice(0, 10),
    to: range.end.toISOString().slice(0, 10),
    days: daysBetween(range.start, range.end) + 1,
    label: describeRange(range.start, range.end),
  };
}

// ── URL params ────────────────────────────────────────────────────────────

type RawSearchParams = Record<string, string | string[] | undefined>;

function paramValue(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.length === 0 ? undefined : first;
}

function paramDateKey(value: string | string[] | undefined): string | undefined {
  const raw = paramValue(value);
  return raw !== undefined && DATE_KEY.test(raw) ? raw : undefined;
}

function paramDays(value: string | string[] | undefined): number {
  const parsed = Number(paramValue(value));
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_RANGE_DAYS;
  return Math.min(Math.floor(parsed), MAX_RANGE_DAYS);
}

// ── TimeSeriesPoint is index-signed, so every read has to be narrowed ─────

function num(value: string | number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: string | number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: string | number | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// ── Segment labels ────────────────────────────────────────────────────────

/**
 * Search Console reports countries as lowercase ISO 3166-1 alpha-3 (`usa`, `gbr`) and uses `zzz`
 * for traffic it could not attribute. The code is shown as-is rather than mapped to a display
 * name: a wrong country name is worse than an unfamiliar code, and the export has to round-trip.
 */
function countryLabel(value: string): string {
  if (value === 'zzz' || value === 'unknown') return 'Unattributed';
  return value.toUpperCase();
}

function deviceLabel(value: string): string {
  if (value === 'unknown') return 'Unknown';
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function toSegmentRows(
  rows: ReadonlyArray<{
    value: string;
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  }>,
  label: (value: string) => string,
): SegmentRow[] {
  const totalClicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const totalImpressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  // With no clicks anywhere, share by impressions rather than showing every row at 0%.
  const denominator = totalClicks > 0 ? totalClicks : totalImpressions;

  return rows.map((row) => ({
    value: row.value,
    label: label(row.value),
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
    share: denominator > 0 ? (totalClicks > 0 ? row.clicks : row.impressions) / denominator : 0,
  }));
}

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  const query = await searchParams;

  const website = await prisma.website.findFirst({
    where: { id: websiteId, userId: user.id },
    select: { id: true, name: true, domain: true, protocol: true },
  });
  if (!website) notFound();

  const from = paramDateKey(query.from);
  const to = paramDateKey(query.to);
  const compare = paramValue(query.compare) === '1';

  const filters: PerformanceFilters = {
    websiteId: website.id,
    // A complete from/to pair pins the window; anything else falls back to the rolling one.
    ...(from !== undefined && to !== undefined ? { from, to } : { days: paramDays(query.days) }),
    compare,
  };

  const { range, comparison } = resolveRange(filters);
  const windowValue = toWindow(range);
  const comparisonWindow = comparison ? toWindow(comparison) : null;

  const [summary, integrations, coverage] = await Promise.all([
    getPerformanceSummary(filters),
    getSiteIntegrations(website.id),
    prisma.searchConsoleDaily.aggregate({
      where: { websiteId: website.id, source: 'gsc' },
      _min: { date: true },
      _max: { date: true },
      _count: { _all: true },
    }),
  ]);

  const gsc = integrations.find(
    (entry) => entry.provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  );

  const connection: SearchConsoleConnection = {
    connected: gsc?.hasCredentials ?? false,
    status: gsc?.status ?? 'NOT_CONFIGURED',
    envReady: gsc?.envReady ?? false,
    requiredEnv: gsc?.requiredEnv ?? [],
    lastSyncLabel: gsc?.lastSyncAt ? DAY_MONTH_YEAR.format(gsc.lastSyncAt) : null,
    lastError: gsc?.lastError ?? null,
    earliestDataLabel: coverage._min.date ? DAY_MONTH_YEAR.format(coverage._min.date) : null,
    latestDataLabel: coverage._max.date ? DAY_MONTH_YEAR.format(coverage._max.date) : null,
    hasAnyData: coverage._count._all > 0,
  };

  const deltas: AnalyticsDeltas | null = summary.deltas
    ? {
        clicks: summary.deltas.clicks,
        impressions: summary.deltas.impressions,
        ctr: summary.deltas.ctr,
        position: summary.deltas.position,
      }
    : null;

  // Nothing measured in this window: the empty state is the whole screen, so none of the
  // expensive aggregates below are worth running.
  if (!summary.hasData) {
    return (
      <AnalyticsView
        website={{
          id: website.id,
          name: website.name,
          domain: website.domain,
          url: `${website.protocol}://${website.domain}`,
        }}
        window={windowValue}
        comparisonWindow={comparisonWindow}
        totals={summary.totals}
        deltas={deltas}
        series={[]}
        queries={[]}
        pages={[]}
        ctrGaps={[]}
        countries={[]}
        devices={[]}
        rankingCounts={{ pos1to3: 0, pos4to10: 0, pos11to20: 0, pos21to50: 0, pos51to100: 0 }}
        rankedKeywords={0}
        connection={connection}
        hasData={false}
        lagDays={GSC_LAG_DAYS}
      />
    );
  }

  const [rawSeries, topQueries, queryPages, rawCtrGaps, rawCountries, rawDevices, distribution] =
    await Promise.all([
      getPerformanceSeries(filters),
      getTopQueries(website.id, range, TOP_QUERY_LIMIT),
      getQueryPageAggregates(website.id, range, { limit: PAGE_AGGREGATE_LIMIT }),
      getCtrGaps(website.id, range, CTR_GAP_LIMIT),
      getSegmentBreakdown(website.id, range, 'country'),
      getSegmentBreakdown(website.id, range, 'device'),
      getRankingDistribution(website.id),
    ]);

  const series: PerformancePoint[] = rawSeries.map((point) => {
    const previousClicks = num(point.previousClicks);
    const previousImpressions = num(point.previousImpressions);
    return {
      date: point.date,
      clicks: num(point.clicks),
      impressions: num(point.impressions),
      ctr: num(point.ctr),
      position: numOrNull(point.position),
      ...(comparison
        ? {
            previousDate: str(point.previousDate),
            previousClicks,
            previousImpressions,
            // The series query does not carry a previous CTR; it is the same division the
            // current-period rows already went through, done on the same two numbers.
            previousCtr: previousImpressions > 0 ? previousClicks / previousImpressions : 0,
            previousPosition: numOrNull(point.previousPosition),
          }
        : {}),
    };
  });

  const queries: QueryRow[] = topQueries.map((row) => ({
    query: row.query,
    page: row.page,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
    pageCount: row.pageCount,
  }));

  // Query × page rows rolled up to the page. Position has to stay impression-weighted through the
  // roll-up, so the weighted sum is carried rather than the already-divided average.
  const pageBuckets = new Map<
    string,
    {
      clicks: number;
      impressions: number;
      weighted: number;
      queryCount: number;
      topQuery: string;
      topQueryImpressions: number;
    }
  >();

  for (const row of queryPages) {
    const bucket = pageBuckets.get(row.page) ?? {
      clicks: 0,
      impressions: 0,
      weighted: 0,
      queryCount: 0,
      topQuery: '',
      topQueryImpressions: -1,
    };
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.weighted += row.position * row.impressions;
    bucket.queryCount += 1;
    if (row.impressions > bucket.topQueryImpressions) {
      bucket.topQuery = row.query;
      bucket.topQueryImpressions = row.impressions;
    }
    pageBuckets.set(row.page, bucket);
  }

  const pages: PageRow[] = [...pageBuckets.entries()]
    .map(([page, bucket]) => ({
      page,
      clicks: bucket.clicks,
      impressions: bucket.impressions,
      ctr: bucket.impressions > 0 ? bucket.clicks / bucket.impressions : 0,
      position: bucket.impressions > 0 ? bucket.weighted / bucket.impressions : 0,
      queryCount: bucket.queryCount,
      topQuery: bucket.topQuery,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
    .slice(0, TOP_PAGE_LIMIT);

  const ctrGaps: CtrGapRow[] = rawCtrGaps.map((row) => ({
    query: row.query,
    page: row.page,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    expectedCtr: row.expectedCtr,
    position: row.position,
    potentialClicks: row.potentialClicks,
  }));

  const bucketCounts = new Map(distribution.map((entry) => [entry.bucket, entry.count]));
  const rankingCounts: RankingCounts = {
    pos1to3: bucketCounts.get('1-3') ?? 0,
    pos4to10: bucketCounts.get('4-10') ?? 0,
    pos11to20: bucketCounts.get('11-20') ?? 0,
    pos21to50: bucketCounts.get('21-50') ?? 0,
    pos51to100: bucketCounts.get('51-100') ?? 0,
  };
  const rankedKeywords = Object.values(rankingCounts).reduce((sum, count) => sum + count, 0);

  return (
    <AnalyticsView
      website={{
        id: website.id,
        name: website.name,
        domain: website.domain,
        url: `${website.protocol}://${website.domain}`,
      }}
      window={windowValue}
      comparisonWindow={comparisonWindow}
      totals={summary.totals}
      deltas={deltas}
      series={series}
      queries={queries}
      pages={pages}
      ctrGaps={ctrGaps}
      countries={toSegmentRows(rawCountries, countryLabel)}
      devices={toSegmentRows(rawDevices, deviceLabel)}
      rankingCounts={rankingCounts}
      rankedKeywords={rankedKeywords}
      connection={connection}
      hasData
      lagDays={GSC_LAG_DAYS}
    />
  );
}
