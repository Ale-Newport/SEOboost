import {
  clamp,
  daysBetween,
  eachDay,
  expectedCtr,
  lastNDays,
  round,
  toUtcDate,
  type DateRange,
} from '@seo/shared';
import type { DemoQueryBlueprint, DemoSiteBlueprint } from './demo-sites';
import { Rng } from './rng';

/**
 * Search Console-shaped daily metrics for the demo sites.
 *
 * The series is modelled rather than sampled: a base impression volume, a weekday multiplier (the
 * weekly seasonality every real search property has), a slow positional drift, and a CTR taken
 * from the *same* position/CTR curve the engine uses to detect CTR gaps. That last point matters —
 * it means a demo "CTR opportunity" is one the detector genuinely finds, not one the seed asserted.
 */

export interface DemoQueryDay {
  date: Date;
  query: string;
  path: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface DemoDayTotal {
  date: Date;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface DemoMetrics {
  /** The window the series covers — the last 90 complete days, lagged 3 like real GSC data. */
  range: DateRange;
  days: Date[];
  rows: DemoQueryDay[];
  siteDaily: DemoDayTotal[];
}

const WINDOW_DAYS = 90;
/** Search Console data is typically 2-3 days behind; the demo mirrors that so "today" looks right. */
const REPORTING_LAG_DAYS = 3;

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function buildDemoMetrics(site: DemoSiteBlueprint, now: Date): DemoMetrics {
  const rng = new Rng(`${site.key}:metrics`);
  const range = lastNDays(WINDOW_DAYS, REPORTING_LAG_DAYS, now);
  const days = eachDay(range);
  const rows: DemoQueryDay[] = [];

  for (const query of site.queries) {
    for (let i = 0; i < days.length; i++) {
      const date = days[i];
      const t = days.length > 1 ? i / (days.length - 1) : 1;
      rows.push(buildDay(site, query, date, t, now, rng));
    }
  }

  const byDate = new Map<number, DemoDayTotal>();
  for (const row of rows) {
    const key = row.date.getTime();
    const entry = byDate.get(key) ?? { date: row.date, clicks: 0, impressions: 0, ctr: 0, position: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    // `position` accumulates impression-weighted position and is divided out below.
    entry.position += row.position * row.impressions;
    byDate.set(key, entry);
  }

  const siteDaily = [...byDate.values()]
    .map((entry) => ({
      date: entry.date,
      clicks: entry.clicks,
      impressions: entry.impressions,
      ctr: entry.impressions > 0 ? round(entry.clicks / entry.impressions, 4) : 0,
      position: entry.impressions > 0 ? round(entry.position / entry.impressions, 2) : 0,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  return { range, days, rows, siteDaily };
}

function buildDay(
  site: DemoSiteBlueprint,
  query: DemoQueryBlueprint,
  date: Date,
  t: number,
  now: Date,
  rng: Rng,
): DemoQueryDay {
  const weekday = date.getUTCDay();
  const seasonality = site.weeklyShape[weekday];

  const position = Math.max(1, lerp(query.position, query.endPosition ?? query.position, t) + rng.gauss(0, 0.32));

  const demand = lerp(1, query.demandTrend ?? 1, t);
  const impressions = Math.max(0, Math.round(query.impressions * demand * seasonality * rng.jitter(0.16)));

  // Branded queries sit far above the generic position/CTR curve; that is a property of the query,
  // not a defect, so it is modelled rather than flagged.
  let ctrFactor = query.ctrFactor ?? (query.branded ? 1.9 : 1);
  const daysAgo = daysBetween(date, now);
  if (query.stepDaysAgo !== undefined && query.stepCtrFactor !== undefined && daysAgo <= query.stepDaysAgo) {
    ctrFactor *= query.stepCtrFactor;
  }

  const ctr = clamp(expectedCtr(position) * ctrFactor * rng.jitter(0.14), 0, 0.92);
  const clicks = Math.min(impressions, Math.round(impressions * ctr));

  return {
    date: toUtcDate(date),
    query: query.query,
    path: query.path,
    clicks,
    impressions,
    // Report the CTR that the clicks actually imply, so every row is internally consistent.
    ctr: impressions > 0 ? round(clicks / impressions, 4) : 0,
    position: round(position, 2),
  };
}

export interface QueryAggregate {
  query: string;
  path: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** Aggregate the daily rows over the last `days` days of the window, GSC-style. */
export function aggregateQueries(metrics: DemoMetrics, days: number, offsetDays = 0): QueryAggregate[] {
  const end = new Date(metrics.range.end.getTime() - offsetDays * 86_400_000);
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const buckets = new Map<string, { clicks: number; impressions: number; weighted: number }>();

  for (const row of metrics.rows) {
    if (row.date < start || row.date > end) continue;
    const key = `${row.query}\u0000${row.path}`;
    const bucket = buckets.get(key) ?? { clicks: 0, impressions: 0, weighted: 0 };
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.weighted += row.position * row.impressions;
    buckets.set(key, bucket);
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const [query, path] = key.split('\u0000');
    return {
      query,
      path,
      clicks: bucket.clicks,
      impressions: bucket.impressions,
      ctr: bucket.impressions > 0 ? round(bucket.clicks / bucket.impressions, 4) : 0,
      position: bucket.impressions > 0 ? round(bucket.weighted / bucket.impressions, 2) : 0,
    };
  });
}

/** Daily series for one page, used to evaluate the demo experiment against real numbers. */
export function pageDailySeries(metrics: DemoMetrics, path: string): DemoDayTotal[] {
  const byDate = new Map<number, DemoDayTotal>();
  for (const row of metrics.rows) {
    if (row.path !== path) continue;
    const key = row.date.getTime();
    const entry = byDate.get(key) ?? { date: row.date, clicks: 0, impressions: 0, ctr: 0, position: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.position += row.position * row.impressions;
    byDate.set(key, entry);
  }
  return [...byDate.values()]
    .map((entry) => ({
      date: entry.date,
      clicks: entry.clicks,
      impressions: entry.impressions,
      ctr: entry.impressions > 0 ? round(entry.clicks / entry.impressions, 4) : 0,
      position: entry.impressions > 0 ? round(entry.position / entry.impressions, 2) : 0,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
