/**
 * View models for the search-performance explorer.
 *
 * Every figure here originates in an imported Search Console row. Nothing is modelled, estimated
 * or back-filled: when a window has no rows the screen says so rather than drawing a flat line
 * that looks like measured zero traffic.
 *
 * Values arrive pre-aggregated and pre-rounded from the server, and dates are calendar strings
 * (`yyyy-MM-dd`) rather than instants — the tables render thousands of rows and a per-row
 * `toLocaleDateString()` would both cost time and risk a server/browser timezone mismatch.
 */

import type { MetricDelta } from '@seo/shared';

export interface AnalyticsWebsite {
  id: string;
  name: string;
  domain: string;
  url: string;
}

/** The window the whole screen is scoped to, as resolved from the URL on the server. */
export interface AnalyticsWindow {
  from: string;
  to: string;
  /** Inclusive day count. */
  days: number;
  /** Pre-formatted for display, e.g. “13 Aug – 9 Sep 2026”. */
  label: string;
}

export interface AnalyticsTotals {
  clicks: number;
  impressions: number;
  /** 0-1. */
  ctr: number;
  /** Impression-weighted average position. Lower is better. */
  position: number;
  /** Days that actually carried a row — fewer than `window.days` means gaps in the import. */
  days: number;
}

export interface AnalyticsDeltas {
  clicks: MetricDelta;
  impressions: MetricDelta;
  ctr: MetricDelta;
  position: MetricDelta;
}

/** One day of the series, with the comparison period zipped on by index when it is enabled. */
export interface PerformancePoint {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
  previousDate?: string | null;
  previousClicks?: number;
  previousImpressions?: number;
  previousCtr?: number;
  previousPosition?: number | null;
}

export interface QueryRow {
  query: string;
  /** The page taking the most impressions for this query. */
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** Distinct pages ranking for the query — more than one is a cannibalisation signal. */
  pageCount: number;
}

export interface PageRow {
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  queryCount: number;
  /** The query taking the most impressions on this page. */
  topQuery: string;
}

export interface CtrGapRow {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  /** Measured CTR, 0-1. */
  ctr: number;
  /** Curve CTR for this position, 0-1. */
  expectedCtr: number;
  position: number;
  /** `impressions × expectedCtr − clicks`, floored at 0. */
  potentialClicks: number;
}

export interface SegmentRow {
  value: string;
  label: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  /** This row's share of the segment's total clicks, 0-1. */
  share: number;
}

/** Counts keyed the way `DistributionChart` expects them. */
export interface RankingCounts {
  pos1to3: number;
  pos4to10: number;
  pos11to20: number;
  pos21to50: number;
  pos51to100: number;
}

/**
 * Why the screen might be empty, in enough detail to name the next action.
 *
 * "Google is not configured on this installation" and "this site has not connected Google" are
 * different problems with different fixes, and the empty state has to tell them apart.
 */
export interface SearchConsoleConnection {
  /** A credential envelope exists for this site. */
  connected: boolean;
  status: string;
  /** Google OAuth is configured in the environment, so connecting is even possible. */
  envReady: boolean;
  /** Env vars an operator must set before anyone can connect. */
  requiredEnv: string[];
  lastSyncLabel: string | null;
  lastError: string | null;
  /** Earliest and latest day this site has any imported rows for; null when it has none. */
  earliestDataLabel: string | null;
  latestDataLabel: string | null;
  /** True when at least one Search Console row exists for the site, in any window. */
  hasAnyData: boolean;
}

// ── Chart metric toggle ───────────────────────────────────────────────────

export const METRIC_KEYS = ['clicks', 'impressions', 'ctr', 'position'] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export interface MetricOption {
  key: MetricKey;
  label: string;
  /**
   * Which axis the metric can be drawn on. Clicks and impressions are counts and share the left
   * axis; CTR is a ratio and average position is inverted, so each needs the right axis to itself.
   */
  axis: 'left' | 'right';
  hint: string;
}

export const METRIC_OPTIONS: readonly MetricOption[] = [
  { key: 'clicks', label: 'Clicks', axis: 'left', hint: 'Visits from search results.' },
  {
    key: 'impressions',
    label: 'Impressions',
    axis: 'left',
    hint: 'Times a result for this site appeared.',
  },
  {
    key: 'ctr',
    label: 'CTR',
    axis: 'right',
    hint: 'Clicks ÷ impressions. Uses the right axis.',
  },
  {
    key: 'position',
    label: 'Avg. position',
    axis: 'right',
    hint: 'Impression-weighted, and inverted so up is better. Uses the right axis.',
  },
];

export function isMetricKey(value: string): value is MetricKey {
  return (METRIC_KEYS as readonly string[]).includes(value);
}
