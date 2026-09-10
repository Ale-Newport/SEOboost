/**
 * Reading the search-performance warehouse.
 *
 * `GscQueryMetric` is the biggest table in the product (query × page × day), so nothing here
 * pulls rows into the worker: every read is a bounded `groupBy` that makes Postgres do the
 * aggregation. Positions are averaged across days rather than impression-weighted — Search
 * Console already reports a weighted daily average, and re-weighting across days would need the
 * raw rows this module exists to avoid loading.
 */

import { type Prisma, prisma } from '@seo/db';
import { type DateRange, lastNDays, previousPeriod, round, toUtcDate } from '@seo/shared';
import type { DailyMetricPoint } from '@seo/seo-engine';
import type { PeriodComparison, QueryPageAggregate } from '@seo/seo-engine';

/** `GscQueryMetric.source` written by the Search Console importer. */
export const GSC_SOURCE = 'gsc';

/** Aggregates are capped so a site with a million query rows cannot exhaust the worker. */
export const DEFAULT_AGGREGATE_LIMIT = 5_000;

export interface AggregateOptions {
  source?: string;
  limit?: number;
  /** Only rows for these page URLs (the `page` column holds the URL as GSC reports it). */
  pages?: string[];
}

function rangeWhere(websiteId: string, range: DateRange, options: AggregateOptions): Prisma.GscQueryMetricWhereInput {
  return {
    websiteId,
    source: options.source ?? GSC_SOURCE,
    date: { gte: toUtcDate(range.start), lte: toUtcDate(range.end) },
    ...(options.pages?.length ? { page: { in: options.pages } } : {}),
  };
}

/**
 * Query × page totals for a window, biggest first.
 *
 * Rows with an empty query are excluded: Bing and GA4 write page-level rows with `query = ''`,
 * and folding those into a keyword analysis would invent a keyword called "".
 */
export async function loadQueryAggregates(
  websiteId: string,
  range: DateRange,
  options: AggregateOptions = {},
): Promise<QueryPageAggregate[]> {
  const grouped = await prisma.gscQueryMetric.groupBy({
    by: ['query', 'page'],
    where: { ...rangeWhere(websiteId, range, options), query: { not: '' } },
    _sum: { clicks: true, impressions: true },
    _avg: { position: true },
    orderBy: { _sum: { impressions: 'desc' } },
    take: options.limit ?? DEFAULT_AGGREGATE_LIMIT,
  });

  return grouped.map((row) => {
    const clicks = row._sum.clicks ?? 0;
    const impressions = row._sum.impressions ?? 0;
    return {
      query: row.query,
      page: row.page,
      clicks,
      impressions,
      ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
      position: round(row._avg.position ?? 0, 2),
    };
  });
}

/** The same window and the one immediately before it, for decay and movement analyses. */
export async function loadPeriodComparison(
  websiteId: string,
  days: number,
  options: AggregateOptions = {},
): Promise<{ comparison: PeriodComparison<QueryPageAggregate>; current: DateRange; previous: DateRange }> {
  const current = lastNDays(days, 3);
  const previous = previousPeriod(current);
  const [currentRows, previousRows] = await Promise.all([
    loadQueryAggregates(websiteId, current, options),
    loadQueryAggregates(websiteId, previous, options),
  ]);
  return { comparison: { current: currentRows, previous: previousRows }, current, previous };
}

export interface PageAggregate {
  pageId: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

/**
 * Per-page totals for a window, one bounded page of results at a time.
 *
 * Keyed on `pageId`, so it only sees rows `linkGscRowsToPages` has already resolved to a
 * crawled URL — which is exactly the set whose `Page` row we are about to update.
 */
export async function loadPageAggregates(
  websiteId: string,
  range: DateRange,
  options: AggregateOptions & { skip?: number; take?: number } = {},
): Promise<PageAggregate[]> {
  const grouped = await prisma.gscQueryMetric.groupBy({
    by: ['pageId'],
    where: { ...rangeWhere(websiteId, range, options), pageId: { not: null } },
    _sum: { clicks: true, impressions: true },
    _avg: { position: true },
    orderBy: { pageId: 'asc' },
    skip: options.skip ?? 0,
    take: options.take ?? 500,
  });

  const out: PageAggregate[] = [];
  for (const row of grouped) {
    if (!row.pageId) continue;
    const clicks = row._sum.clicks ?? 0;
    const impressions = row._sum.impressions ?? 0;
    out.push({
      pageId: row.pageId,
      clicks,
      impressions,
      ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
      position: row._avg.position === null ? null : round(row._avg.position, 2),
    });
  }
  return out;
}

export interface DailySeriesOptions {
  source?: string;
  /** Restrict to one page (the URL as Search Console reports it). */
  pageUrl?: string | null;
  pageId?: string | null;
}

/**
 * Daily totals for the experiment evaluator. Days with no rows are simply absent — the
 * evaluator counts observed days, and inventing zero-rows would understate the mean.
 */
export async function loadDailySeries(
  websiteId: string,
  range: DateRange,
  options: DailySeriesOptions = {},
): Promise<DailyMetricPoint[]> {
  const grouped = await prisma.gscQueryMetric.groupBy({
    by: ['date'],
    where: {
      websiteId,
      source: options.source ?? GSC_SOURCE,
      date: { gte: toUtcDate(range.start), lte: toUtcDate(range.end) },
      ...(options.pageId ? { pageId: options.pageId } : {}),
      ...(options.pageUrl ? { page: options.pageUrl } : {}),
    },
    _sum: { clicks: true, impressions: true },
    _avg: { position: true },
    orderBy: { date: 'asc' },
  });

  return grouped.map((row) => {
    const clicks = row._sum.clicks ?? 0;
    const impressions = row._sum.impressions ?? 0;
    return {
      date: row.date,
      clicks,
      impressions,
      ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
      position: round(row._avg.position ?? 0, 2),
    };
  });
}

/** Site-level totals for a window, used by reports and score snapshots. */
export async function loadSiteTotals(
  websiteId: string,
  range: DateRange,
  source = GSC_SOURCE,
): Promise<{ clicks: number; impressions: number; ctr: number; position: number | null; days: number }> {
  const aggregate = await prisma.searchConsoleDaily.aggregate({
    where: { websiteId, source, date: { gte: toUtcDate(range.start), lte: toUtcDate(range.end) } },
    _sum: { clicks: true, impressions: true },
    _avg: { position: true },
    _count: { _all: true },
  });

  const clicks = aggregate._sum.clicks ?? 0;
  const impressions = aggregate._sum.impressions ?? 0;
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
    position: aggregate._avg.position === null ? null : round(aggregate._avg.position, 2),
    days: aggregate._count._all,
  };
}

/** True when any search data has been imported for this site. */
export async function hasSearchData(websiteId: string, source = GSC_SOURCE): Promise<boolean> {
  const row = await prisma.gscQueryMetric.findFirst({
    where: { websiteId, source },
    select: { id: true },
  });
  return row !== null;
}
