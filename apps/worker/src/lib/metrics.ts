/**
 * Denormalising search performance onto `Page`.
 *
 * The list views, the opportunity score and the decay detector all read `Page.clicks28d` and
 * friends. Recomputing those from `GscQueryMetric` on every read would be a full table scan per
 * page view, so the numbers are rolled up here after every sync — from real imported rows only.
 * A page with no Search Console data keeps zeros, which is the truth, not a placeholder.
 */

import { type Prisma, prisma } from '@seo/db';
import { createLogger, lastNDays, percentChange, previousPeriod, round } from '@seo/shared';
import { loadPageAggregates, type PageAggregate } from './gsc';
import { runChunked } from './batch';

const log = createLogger('worker:metrics');

/** Rolling window used everywhere in the product. Three days of lag is Search Console's own. */
export const ROLLING_DAYS = 28;
const GSC_LAG_DAYS = 3;

/** Ceiling on pages rolled up in one pass; far above any realistic single-site page count. */
const MAX_PAGES = 100_000;
const GROUP_PAGE_SIZE = 500;

async function collectAggregates(
  websiteId: string,
  range: { start: Date; end: Date },
  source?: string,
): Promise<Map<string, PageAggregate>> {
  const map = new Map<string, PageAggregate>();
  for (let skip = 0; skip < MAX_PAGES; skip += GROUP_PAGE_SIZE) {
    const rows = await loadPageAggregates(websiteId, range, {
      skip,
      take: GROUP_PAGE_SIZE,
      ...(source ? { source } : {}),
    });
    for (const row of rows) map.set(row.pageId, row);
    if (rows.length < GROUP_PAGE_SIZE) break;
  }
  return map;
}

export interface RefreshPageMetricsResult {
  pagesUpdated: number;
  windowStart: string;
  windowEnd: string;
}

/**
 * Writes the rolling 28-day and previous-28-day metrics onto every page that has data in
 * either window. Pages outside both windows are left untouched rather than zeroed, so a page
 * that has simply not been re-synced does not read as "lost all its traffic".
 */
export async function refreshPageMetrics(
  websiteId: string,
  source?: string,
): Promise<RefreshPageMetricsResult> {
  const current = lastNDays(ROLLING_DAYS, GSC_LAG_DAYS);
  const previous = previousPeriod(current);

  const [currentByPage, previousByPage] = await Promise.all([
    collectAggregates(websiteId, current, source),
    collectAggregates(websiteId, previous, source),
  ]);

  const pageIds = new Set<string>([...currentByPage.keys(), ...previousByPage.keys()]);
  const updates: Prisma.PrismaPromise<unknown>[] = [];

  for (const pageId of pageIds) {
    const now = currentByPage.get(pageId);
    const before = previousByPage.get(pageId);
    const clicks = now?.clicks ?? 0;
    const impressions = now?.impressions ?? 0;
    const clicksPrev = before?.clicks ?? 0;

    updates.push(
      prisma.page.update({
        where: { id: pageId },
        data: {
          clicks28d: clicks,
          impressions28d: impressions,
          ctr28d: impressions > 0 ? round(clicks / impressions, 5) : null,
          position28d: now?.position ?? null,
          clicksPrev28d: clicksPrev,
          impressionsPrev28d: before?.impressions ?? 0,
          positionPrev28d: before?.position ?? null,
          clicksTrendPct: percentChange(clicksPrev, clicks),
        },
      }),
    );
  }

  const pagesUpdated = await runChunked(updates);
  log.info('page metrics refreshed', { websiteId, pagesUpdated });

  return {
    pagesUpdated,
    windowStart: current.start.toISOString().slice(0, 10),
    windowEnd: current.end.toISOString().slice(0, 10),
  };
}

/** Highest impression count on the site — the normaliser for every page/keyword opportunity score. */
export async function maxImpressionsOnSite(websiteId: string): Promise<number> {
  const [page, keyword] = await Promise.all([
    prisma.page.aggregate({ where: { websiteId }, _max: { impressions28d: true } }),
    prisma.keyword.aggregate({ where: { websiteId }, _max: { impressions28d: true } }),
  ]);
  return Math.max(page._max.impressions28d ?? 0, keyword._max.impressions28d ?? 0, 1);
}
