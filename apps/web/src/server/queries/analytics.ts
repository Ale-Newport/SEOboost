import 'server-only';
import { Prisma, prisma } from '@seo/db';
import {
  addDays,
  daysBetween,
  expectedCtr,
  formatDateKey,
  lastNDays,
  percentChange,
  previousPeriod,
  round,
  toUtcDate,
  type DateRange,
  type MetricDelta,
  type TimeSeriesPoint,
} from '@seo/shared';

/**
 * Search-performance read models.
 *
 * All figures come from imported Search Console / Bing / GA4 rows. When no integration is
 * connected the queries return zeros and empty series — never invented numbers — and the UI
 * renders an empty state pointing at the integration settings.
 */

export interface PerformanceFilters {
  websiteId?: string;
  websiteIds?: string[];
  from?: string;
  to?: string;
  days?: number;
  country?: string;
  device?: string;
  source?: string;
  compare?: boolean;
}

/** Search Console data lags ~2-3 days; default windows end there so the last day is never partial. */
export const GSC_LAG_DAYS = 3;

export function resolveRange(filters: PerformanceFilters): { range: DateRange; comparison: DateRange | null } {
  let range: DateRange;
  if (filters.from && filters.to) {
    range = { start: toUtcDate(filters.from), end: toUtcDate(filters.to) };
  } else {
    range = lastNDays(filters.days ?? 28, GSC_LAG_DAYS);
  }
  return { range, comparison: filters.compare ? previousPeriod(range) : null };
}

export interface PerformanceTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  days: number;
}

const EMPTY_TOTALS: PerformanceTotals = { clicks: 0, impressions: 0, ctr: 0, position: 0, days: 0 };

async function sumDaily(
  websiteIds: string[],
  range: DateRange,
  filters: PerformanceFilters,
): Promise<PerformanceTotals> {
  if (websiteIds.length === 0) return EMPTY_TOTALS;
  const rows = await prisma.searchConsoleDaily.findMany({
    where: {
      websiteId: { in: websiteIds },
      date: { gte: range.start, lte: range.end },
      source: filters.source ?? 'gsc',
      country: filters.country ?? null,
      device: filters.device ?? null,
    },
    select: { clicks: true, impressions: true, position: true, date: true },
  });
  if (rows.length === 0) return EMPTY_TOTALS;

  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  // Position must be impression-weighted; a plain average over-weights low-volume days.
  const weightedPosition = rows.reduce((s, r) => s + r.position * r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
    position: impressions > 0 ? round(weightedPosition / impressions, 2) : 0,
    days: new Set(rows.map((r) => formatDateKey(r.date))).size,
  };
}

export function toDelta(current: number, previous: number): MetricDelta {
  return {
    current,
    previous,
    change: round(current - previous, 4),
    changePct: percentChange(previous, current),
  };
}

export interface PerformanceSummary {
  range: { from: string; to: string };
  comparisonRange: { from: string; to: string } | null;
  totals: PerformanceTotals;
  previous: PerformanceTotals | null;
  deltas: { clicks: MetricDelta; impressions: MetricDelta; ctr: MetricDelta; position: MetricDelta } | null;
  hasData: boolean;
}

export async function getPerformanceSummary(filters: PerformanceFilters): Promise<PerformanceSummary> {
  const websiteIds = filters.websiteIds ?? (filters.websiteId ? [filters.websiteId] : []);
  const { range, comparison } = resolveRange(filters);

  const [totals, previous] = await Promise.all([
    sumDaily(websiteIds, range, filters),
    comparison ? sumDaily(websiteIds, comparison, filters) : Promise.resolve(null),
  ]);

  return {
    range: { from: formatDateKey(range.start), to: formatDateKey(range.end) },
    comparisonRange: comparison
      ? { from: formatDateKey(comparison.start), to: formatDateKey(comparison.end) }
      : null,
    totals,
    previous,
    deltas: previous
      ? {
          clicks: toDelta(totals.clicks, previous.clicks),
          impressions: toDelta(totals.impressions, previous.impressions),
          ctr: toDelta(totals.ctr, previous.ctr),
          // Lower position is better; the UI inverts the colour for this metric.
          position: toDelta(totals.position, previous.position),
        }
      : null,
    hasData: totals.impressions > 0 || totals.clicks > 0,
  };
}

/** Daily time series for the performance chart, with an optional comparison overlay. */
export async function getPerformanceSeries(filters: PerformanceFilters): Promise<TimeSeriesPoint[]> {
  const websiteIds = filters.websiteIds ?? (filters.websiteId ? [filters.websiteId] : []);
  if (websiteIds.length === 0) return [];
  const { range, comparison } = resolveRange(filters);

  const load = async (window: DateRange) =>
    prisma.searchConsoleDaily.findMany({
      where: {
        websiteId: { in: websiteIds },
        date: { gte: window.start, lte: window.end },
        source: filters.source ?? 'gsc',
        country: filters.country ?? null,
        device: filters.device ?? null,
      },
      select: { date: true, clicks: true, impressions: true, position: true },
      orderBy: { date: 'asc' },
    });

  const [current, previousRows] = await Promise.all([
    load(range),
    comparison ? load(comparison) : Promise.resolve([]),
  ]);

  const bucket = (rows: typeof current) => {
    const map = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>();
    for (const row of rows) {
      const key = formatDateKey(row.date);
      const entry = map.get(key) ?? { clicks: 0, impressions: 0, weightedPosition: 0 };
      entry.clicks += row.clicks;
      entry.impressions += row.impressions;
      entry.weightedPosition += row.position * row.impressions;
      map.set(key, entry);
    }
    return map;
  };

  const currentMap = bucket(current);
  const previousMap = bucket(previousRows);
  const previousKeys = [...previousMap.keys()].sort();

  const points: TimeSeriesPoint[] = [];
  const totalDays = daysBetween(range.start, range.end) + 1;

  for (let i = 0; i < totalDays; i++) {
    const date = addDays(range.start, i);
    const key = formatDateKey(date);
    const entry = currentMap.get(key);
    const clicks = entry?.clicks ?? 0;
    const impressions = entry?.impressions ?? 0;

    const point: TimeSeriesPoint = {
      date: key,
      clicks,
      impressions,
      ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
      position: impressions > 0 ? round((entry?.weightedPosition ?? 0) / impressions, 2) : null,
    };

    if (comparison) {
      const previousKey = previousKeys[i];
      const previousEntry = previousKey ? previousMap.get(previousKey) : undefined;
      point.previousDate = previousKey ?? null;
      point.previousClicks = previousEntry?.clicks ?? 0;
      point.previousImpressions = previousEntry?.impressions ?? 0;
      point.previousPosition =
        previousEntry && previousEntry.impressions > 0
          ? round(previousEntry.weightedPosition / previousEntry.impressions, 2)
          : null;
    }
    points.push(point);
  }
  return points;
}

export interface QueryPageRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/**
 * Aggregate query × page rows for a window.
 * Uses a raw aggregate because Prisma's groupBy cannot express the impression-weighted
 * position average, and a per-row fetch would pull millions of rows on a large site.
 */
export async function getQueryPageAggregates(
  websiteId: string,
  range: DateRange,
  options: { limit?: number; source?: string; minImpressions?: number } = {},
): Promise<QueryPageRow[]> {
  const limit = Math.min(options.limit ?? 5000, 50_000);
  const source = options.source ?? 'gsc';
  const minImpressions = options.minImpressions ?? 1;

  const rows = await prisma.$queryRaw<
    Array<{ query: string; page: string; clicks: bigint; impressions: bigint; weighted: number }>
  >(Prisma.sql`
    SELECT
      "query",
      "page",
      SUM("clicks")::bigint      AS clicks,
      SUM("impressions")::bigint AS impressions,
      COALESCE(SUM("position" * "impressions") / NULLIF(SUM("impressions"), 0), 0) AS weighted
    FROM "GscQueryMetric"
    WHERE "websiteId" = ${websiteId}
      AND "source" = ${source}
      AND "date" >= ${range.start}
      AND "date" <= ${range.end}
    GROUP BY "query", "page"
    HAVING SUM("impressions") >= ${minImpressions}
    ORDER BY SUM("impressions") DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => {
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    return {
      query: row.query,
      page: row.page,
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: Number(row.weighted) || 0,
    };
  });
}

/**
 * Top queries for a window, aggregated across pages.
 *
 * Scoped to one `source` (default `gsc`): the table holds every provider's rows side by side,
 * so an unscoped aggregate would add Bing impressions to Google ones and report a total that
 * matches neither the summary cards nor the provider's own console.
 */
export async function getTopQueries(
  websiteId: string,
  range: DateRange,
  limit = 50,
  options: { source?: string } = {},
): Promise<Array<QueryPageRow & { pageCount: number }>> {
  const source = options.source ?? 'gsc';
  const rows = await prisma.$queryRaw<
    Array<{ query: string; clicks: bigint; impressions: bigint; weighted: number; pages: bigint; top_page: string }>
  >(Prisma.sql`
    SELECT
      "query",
      SUM("clicks")::bigint      AS clicks,
      SUM("impressions")::bigint AS impressions,
      COALESCE(SUM("position" * "impressions") / NULLIF(SUM("impressions"), 0), 0) AS weighted,
      COUNT(DISTINCT "page")::bigint AS pages,
      (ARRAY_AGG("page" ORDER BY "impressions" DESC))[1] AS top_page
    FROM "GscQueryMetric"
    WHERE "websiteId" = ${websiteId}
      AND "source" = ${source}
      AND "date" >= ${range.start}
      AND "date" <= ${range.end}
    GROUP BY "query"
    ORDER BY SUM("clicks") DESC, SUM("impressions") DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => {
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    return {
      query: row.query,
      page: row.top_page ?? '',
      clicks,
      impressions,
      ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
      position: round(Number(row.weighted) || 0, 1),
      pageCount: Number(row.pages),
    };
  });
}

/**
 * Ranking distribution buckets for the position histogram.
 *
 * Counted in the database rather than by loading every ranking keyword — a large portfolio has
 * hundreds of thousands of them and this runs on every site overview. The bounds are half-open
 * (`gt`/`lte`) because `currentPosition` is an *average* position and is routinely fractional:
 * integer bounds like `>= 4 && <= 3` drop every keyword sitting at 3.4.
 */
export async function getRankingDistribution(
  websiteId: string,
): Promise<Array<{ bucket: string; count: number }>> {
  const buckets = [
    { bucket: '1-3', gt: 0, lte: 3 },
    { bucket: '4-10', gt: 3, lte: 10 },
    { bucket: '11-20', gt: 10, lte: 20 },
    { bucket: '21-50', gt: 20, lte: 50 },
    { bucket: '51-100', gt: 50, lte: 100 },
  ];

  const counts = await Promise.all(
    buckets.map(({ gt, lte }) =>
      prisma.keyword.count({ where: { websiteId, currentPosition: { gt, lte } } }),
    ),
  );

  return buckets.map(({ bucket }, index) => ({ bucket, count: counts[index] ?? 0 }));
}

export interface KeywordCounts {
  top3: number;
  top10: number;
  top100: number;
  total: number;
  tracked: number;
}

export async function getKeywordCounts(websiteIds: string[]): Promise<KeywordCounts> {
  if (websiteIds.length === 0) return { top3: 0, top10: 0, top100: 0, total: 0, tracked: 0 };
  const where = { websiteId: { in: websiteIds } };
  const [top3, top10, top100, total, tracked] = await Promise.all([
    prisma.keyword.count({ where: { ...where, currentPosition: { lte: 3, gt: 0 } } }),
    prisma.keyword.count({ where: { ...where, currentPosition: { lte: 10, gt: 0 } } }),
    prisma.keyword.count({ where: { ...where, currentPosition: { lte: 100, gt: 0 } } }),
    prisma.keyword.count({ where }),
    prisma.keyword.count({ where: { ...where, isTracked: true } }),
  ]);
  return { top3, top10, top100, total, tracked };
}

/** Country and device breakdowns for the analytics filters. */
export async function getSegmentBreakdown(
  websiteId: string,
  range: DateRange,
  dimension: 'country' | 'device',
): Promise<Array<{ value: string; clicks: number; impressions: number; ctr: number; position: number }>> {
  const rows = await prisma.searchConsoleDaily.findMany({
    where: {
      websiteId,
      date: { gte: range.start, lte: range.end },
      source: 'gsc',
      [dimension]: { not: null },
      ...(dimension === 'country' ? { device: null } : { country: null }),
    },
    select: { clicks: true, impressions: true, position: true, country: true, device: true },
  });

  const map = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const row of rows) {
    const key = (dimension === 'country' ? row.country : row.device) ?? 'unknown';
    const entry = map.get(key) ?? { clicks: 0, impressions: 0, weighted: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    map.set(key, entry);
  }

  return [...map.entries()]
    .map(([value, entry]) => ({
      value,
      clicks: entry.clicks,
      impressions: entry.impressions,
      ctr: entry.impressions > 0 ? round(entry.clicks / entry.impressions, 5) : 0,
      position: entry.impressions > 0 ? round(entry.weighted / entry.impressions, 1) : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

/** Pages whose CTR sits furthest below the position curve — the cheapest wins on the site. */
export async function getCtrGaps(
  websiteId: string,
  range: DateRange,
  limit = 20,
): Promise<Array<QueryPageRow & { expectedCtr: number; potentialClicks: number }>> {
  const rows = await getQueryPageAggregates(websiteId, range, { limit: 3000, minImpressions: 100 });
  return rows
    .filter((row) => row.position <= 10 && row.position >= 1)
    .map((row) => {
      const expected = expectedCtr(row.position);
      return {
        ...row,
        expectedCtr: round(expected, 4),
        potentialClicks: Math.max(0, Math.round(row.impressions * expected - row.clicks)),
      };
    })
    .filter((row) => row.potentialClicks > 0 && row.ctr < row.expectedCtr * 0.75)
    .sort((a, b) => b.potentialClicks - a.potentialClicks)
    .slice(0, limit);
}
