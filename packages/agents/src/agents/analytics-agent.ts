import { prisma } from '@seo/db';
import {
  formatDateKey,
  normalizeKeyword,
  normalizeUrl,
  percentChange,
  round,
  safeDivide,
  startOfWeek,
  toUtcDate,
} from '@seo/shared';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  GSC_NOT_CONNECTED,
  comparisonWindows,
  hasSearchConsoleData,
  loadSite,
  notifyOnce,
  pluralise,
  result,
  skipped,
  step,
  throwIfAborted,
} from './shared';

const AGENT = 'AnalyticsAgent' as const;

/** A site losing this much of its clicks period-over-period is worth waking someone up for. */
const TRAFFIC_DROP_PCT = -25;
const TRAFFIC_CRITICAL_PCT = -50;
const MIN_CLICKS_FOR_ALERT = 50;
/** Position slide (in places) that counts as a ranking loss worth reporting. */
const RANKING_DROP_PLACES = 5;
const INDEXATION_DROP_PCT = -10;

const MAX_ROWS = 20_000;

interface Totals {
  clicks: number;
  impressions: number;
  weightedPosition: number;
}

function emptyTotals(): Totals {
  return { clicks: 0, impressions: 0, weightedPosition: 0 };
}

function positionOf(totals: Totals): number | null {
  return totals.impressions > 0 ? round(totals.weightedPosition / totals.impressions, 2) : null;
}

/** Aggregate GSC rows by an arbitrary key, keeping an impression-weighted position. */
export function aggregate<T>(
  rows: readonly T[],
  keyOf: (row: T) => string | null,
  metrics: (row: T) => { clicks: number; impressions: number; position: number },
): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const entry = out.get(key) ?? emptyTotals();
    const value = metrics(row);
    entry.clicks += value.clicks;
    entry.impressions += value.impressions;
    entry.weightedPosition += value.position * value.impressions;
    out.set(key, entry);
  }
  return out;
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);
  if (!(await hasSearchConsoleData(ctx.websiteId))) {
    return skipped('No Search Console data to roll up.', GSC_NOT_CONNECTED);
  }

  const windows = comparisonWindows();

  // ── Raw rows for both windows ──────────────────────────────────────────────
  const [currentRows, previousRows] = await Promise.all([
    step(ctx, 'get_search_console_rows', { window: 'current-28d' }, () => readRows(ctx.websiteId, windows.current.start, windows.current.end)),
    step(ctx, 'get_search_console_rows', { window: 'previous-28d' }, () => readRows(ctx.websiteId, windows.previous.start, windows.previous.end)),
  ]);

  const pageKey = (row: GscRow) => normalizeUrl(row.page);
  const queryKey = (row: GscRow) => normalizeKeyword(row.query) || null;
  const metrics = (row: GscRow) => ({ clicks: row.clicks, impressions: row.impressions, position: row.position });

  const currentByPage = aggregate(currentRows, pageKey, metrics);
  const previousByPage = aggregate(previousRows, pageKey, metrics);
  const currentByQuery = aggregate(currentRows, queryKey, metrics);
  const previousByQuery = aggregate(previousRows, queryKey, metrics);

  // ── Pages ──────────────────────────────────────────────────────────────────
  const pages = await prisma.page.findMany({
    where: { websiteId: ctx.websiteId, isActive: true },
    select: { id: true, url: true, normalizedUrl: true },
    take: MAX_ROWS,
  });

  let pagesUpdated = 0;
  for (const page of pages) {
    throwIfAborted(ctx);
    const current = currentByPage.get(page.normalizedUrl);
    const previous = previousByPage.get(page.normalizedUrl);
    if (!current && !previous) continue;

    const clicks = current?.clicks ?? 0;
    const impressions = current?.impressions ?? 0;
    const clicksPrev = previous?.clicks ?? 0;

    await prisma.page.update({
      where: { id: page.id },
      data: {
        clicks28d: clicks,
        impressions28d: impressions,
        ctr28d: impressions > 0 ? round(safeDivide(clicks, impressions), 4) : null,
        position28d: current ? positionOf(current) : null,
        clicksPrev28d: clicksPrev,
        impressionsPrev28d: previous?.impressions ?? 0,
        positionPrev28d: previous ? positionOf(previous) : null,
        clicksTrendPct: percentChange(clicksPrev, clicks),
        lastAnalysedAt: new Date(),
      },
    });
    pagesUpdated++;
  }

  // ── Keywords ───────────────────────────────────────────────────────────────
  const keywords = await prisma.keyword.findMany({
    where: { websiteId: ctx.websiteId },
    select: { id: true, keyword: true, normalized: true, currentPosition: true, bestPosition: true, impressions28d: true },
    take: MAX_ROWS,
  });

  let keywordsUpdated = 0;
  const rankingLosses: Array<{ keyword: string; from: number; to: number; impressions: number }> = [];

  for (const keyword of keywords) {
    throwIfAborted(ctx);
    const current = currentByQuery.get(keyword.normalized);
    const previous = previousByQuery.get(keyword.normalized);
    if (!current && !previous) continue;

    const position = current ? positionOf(current) : null;
    const previousPosition = previous ? positionOf(previous) : null;
    const clicks = current?.clicks ?? 0;
    const impressions = current?.impressions ?? 0;

    await prisma.keyword.update({
      where: { id: keyword.id },
      data: {
        currentPosition: position,
        previousPosition,
        positionChange: position !== null && previousPosition !== null ? round(position - previousPosition, 2) : null,
        bestPosition:
          position === null
            ? keyword.bestPosition
            : keyword.bestPosition === null
              ? position
              : Math.min(keyword.bestPosition, position),
        clicks28d: clicks,
        impressions28d: impressions,
        ctr28d: impressions > 0 ? round(safeDivide(clicks, impressions), 4) : null,
        position28d: position,
        lastSeenAt: new Date(),
      },
    });
    keywordsUpdated++;

    if (
      previousPosition !== null &&
      position !== null &&
      previousPosition <= 10 &&
      position - previousPosition >= RANKING_DROP_PLACES &&
      (previous?.impressions ?? 0) >= MIN_CLICKS_FOR_ALERT
    ) {
      rankingLosses.push({
        keyword: keyword.keyword,
        from: previousPosition,
        to: position,
        impressions: previous?.impressions ?? 0,
      });
    }
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────
  const today = toUtcDate(new Date());
  const [openIssues, criticalIssues, indexablePages, orphanPages, top3, top10, top100] = await Promise.all([
    prisma.technicalIssue.count({ where: { websiteId: ctx.websiteId, status: { in: ['OPEN', 'REGRESSED'] } } }),
    prisma.technicalIssue.count({
      where: { websiteId: ctx.websiteId, status: { in: ['OPEN', 'REGRESSED'] }, severity: 'CRITICAL' },
    }),
    prisma.page.count({ where: { websiteId: ctx.websiteId, isActive: true, isIndexable: true } }),
    prisma.page.count({ where: { websiteId: ctx.websiteId, isActive: true, isOrphan: true } }),
    prisma.keyword.count({ where: { websiteId: ctx.websiteId, currentPosition: { lte: 3, gt: 0 } } }),
    prisma.keyword.count({ where: { websiteId: ctx.websiteId, currentPosition: { lte: 10, gt: 0 } } }),
    prisma.keyword.count({ where: { websiteId: ctx.websiteId, currentPosition: { lte: 100, gt: 0 } } }),
  ]);

  const siteCurrent = totalsOf(currentByPage);
  const sitePrevious = totalsOf(previousByPage);

  const previousSnapshot = await prisma.scoreSnapshot.findFirst({
    where: { websiteId: ctx.websiteId, date: { lt: today } },
    orderBy: { date: 'desc' },
    select: { date: true, indexablePages: true, clicks28d: true },
  });

  const snapshotData = {
    healthScore: site.healthScore,
    geoScore: site.geoScore,
    aiVisibilityScore: site.aiVisibilityScore,
    contentScore: site.contentScore,
    openIssues,
    criticalIssues,
    indexablePages,
    orphanPages,
    keywordsTop3: top3,
    keywordsTop10: top10,
    keywordsTop100: top100,
    clicks28d: siteCurrent.clicks,
    impressions28d: siteCurrent.impressions,
    avgPosition: positionOf(siteCurrent),
  };

  await prisma.scoreSnapshot.upsert({
    where: { websiteId_date: { websiteId: ctx.websiteId, date: today } },
    create: { websiteId: ctx.websiteId, date: today, ...snapshotData },
    update: snapshotData,
  });

  await prisma.website.update({ where: { id: ctx.websiteId }, data: { lastAnalysisAt: new Date() } });

  // ── Notifications ──────────────────────────────────────────────────────────
  // Keyed by ISO week so a persistent problem produces one alert, not one per daily run.
  const weekKey = formatDateKey(startOfWeek(new Date()));
  const notifications: string[] = [];

  const trafficChange = percentChange(sitePrevious.clicks, siteCurrent.clicks);
  if (trafficChange !== null && trafficChange <= TRAFFIC_DROP_PCT && sitePrevious.clicks >= MIN_CLICKS_FOR_ALERT) {
    const created = await notifyOnce({
      websiteId: ctx.websiteId,
      userId: site.userId,
      type: 'TRAFFIC_DROP',
      severity: trafficChange <= TRAFFIC_CRITICAL_PCT ? 'CRITICAL' : 'WARNING',
      title: `Organic clicks down ${Math.abs(Math.round(trafficChange))}% on ${site.domain}`,
      message:
        `Search Console clicks fell from ${sitePrevious.clicks.toLocaleString()} to ${siteCurrent.clicks.toLocaleString()} ` +
        `comparing the last 28 days with the 28 before them. Impressions moved ` +
        `${percentChange(sitePrevious.impressions, siteCurrent.impressions) ?? 0}%.`,
      data: { current: siteCurrent, previous: sitePrevious, changePct: trafficChange },
      dedupeKey: `${ctx.websiteId}:traffic-drop:${weekKey}`,
    });
    if (created) notifications.push('TRAFFIC_DROP');
  }

  if (rankingLosses.length > 0) {
    const worst = [...rankingLosses].sort((a, b) => b.impressions - a.impressions).slice(0, 5);
    const created = await notifyOnce({
      websiteId: ctx.websiteId,
      userId: site.userId,
      type: 'RANKING_DROP',
      severity: 'WARNING',
      title: `${rankingLosses.length} ${pluralise(rankingLosses.length, 'keyword')} dropped out of the top 10`,
      message: worst
        .map((entry) => `"${entry.keyword}" ${entry.from.toFixed(1)} → ${entry.to.toFixed(1)}`)
        .join('; '),
      data: { losses: rankingLosses.slice(0, 50) },
      dedupeKey: `${ctx.websiteId}:ranking-drop:${weekKey}`,
    });
    if (created) notifications.push('RANKING_DROP');
  }

  if (previousSnapshot && previousSnapshot.indexablePages > 0) {
    const indexationChange = percentChange(previousSnapshot.indexablePages, indexablePages);
    if (indexationChange !== null && indexationChange <= INDEXATION_DROP_PCT) {
      const created = await notifyOnce({
        websiteId: ctx.websiteId,
        userId: site.userId,
        type: 'INDEXATION_DROP',
        severity: 'CRITICAL',
        title: `Indexable pages fell ${Math.abs(Math.round(indexationChange))}% on ${site.domain}`,
        message:
          `${previousSnapshot.indexablePages} indexable pages on ${formatDateKey(previousSnapshot.date)}, ` +
          `${indexablePages} now. A drop this size usually means a robots or canonical change, not organic churn.`,
        data: { before: previousSnapshot.indexablePages, after: indexablePages, changePct: indexationChange },
        dedupeKey: `${ctx.websiteId}:indexation-drop:${weekKey}`,
      });
      if (created) notifications.push('INDEXATION_DROP');
    }
  }

  return result({
    summary:
      `Recomputed 28-day metrics for ${pagesUpdated} ${pluralise(pagesUpdated, 'page')} and ${keywordsUpdated} ` +
      `${pluralise(keywordsUpdated, 'keyword')}. Clicks ${siteCurrent.clicks.toLocaleString()} ` +
      `(${trafficChange === null ? 'no comparison' : `${trafficChange > 0 ? '+' : ''}${Math.round(trafficChange)}%`}), ` +
      `${top10} ${pluralise(top10, 'keyword')} in the top 10. ` +
      (notifications.length ? `Raised ${notifications.join(', ')}.` : 'No alert thresholds crossed.'),
    confidence: 0.95,
    data: {
      window: { current: windows.current, previous: windows.previous },
      pagesUpdated,
      keywordsUpdated,
      snapshot: { date: formatDateKey(today), ...snapshotData },
      notifications,
      rankingLosses: rankingLosses.slice(0, 25),
      trafficChangePct: trafficChange,
    },
  });
}

interface GscRow {
  page: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}

/**
 * Raw rows rather than a `groupBy`, because both the page and the query roll-up need an
 * impression-weighted position and Prisma cannot express that aggregate.
 */
async function readRows(websiteId: string, start: Date, end: Date): Promise<GscRow[]> {
  return prisma.gscQueryMetric.findMany({
    where: { websiteId, date: { gte: start, lte: end } },
    select: { page: true, query: true, clicks: true, impressions: true, position: true },
    orderBy: { impressions: 'desc' },
    take: 100_000,
  });
}

function totalsOf(byKey: Map<string, Totals>): Totals {
  const out = emptyTotals();
  for (const totals of byKey.values()) {
    out.clicks += totals.clicks;
    out.impressions += totals.impressions;
    out.weightedPosition += totals.weightedPosition;
  }
  return out;
}

export const analyticsAgent: AgentDefinition = {
  name: AGENT,
  label: 'Analytics',
  description:
    'Recomputes rolling 28-day page and keyword metrics, writes the daily score snapshot and raises deduplicated alerts for real drops.',
  allowedActionTypes: [],
  tools: ['get_search_console_rows'],
  requiresAi: false,
  run,
};

registerAgent(analyticsAgent);
