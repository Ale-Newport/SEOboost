import type { ExplainableScore } from '@seo/shared';

/**
 * Shapes shared between the Keywords server queries and the client components that render them.
 *
 * They live here, not in the `server-only` query module, so a client component can import the
 * type without dragging the module (and Prisma with it) anywhere near the browser bundle.
 */

/**
 * A type alias rather than an interface on purpose: `TimeSeriesChart` takes rows with an index
 * signature, and only object *type aliases* get the implicit index signature that makes them
 * assignable to it.
 */
export type KeywordHistoryPoint = {
  date: string;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
};

/** Where the history came from, so the chart names its own source instead of implying GSC. */
export type KeywordHistorySource = 'KEYWORD_METRIC' | 'SEARCH_CONSOLE' | 'NONE';

export interface KeywordSibling {
  id: string;
  keyword: string;
  currentPosition: number | null;
  impressions28d: number;
  clicks28d: number;
  opportunityScore: number | null;
}

export interface KeywordClusterSummary {
  id: string;
  name: string;
  keywordCount: number;
  avgPosition: number | null;
  coverageScore: number | null;
  opportunityScore: number | null;
}

export interface KeywordProfile {
  id: string;
  keyword: string;
  normalized: string;
  locale: string;
  intent: string;
  funnelStage: string;
  source: string;
  isTracked: boolean;
  isBranded: boolean;
  isContentGap: boolean;
  hasCannibalization: boolean;
  searchVolume: number | null;
  volumeSource: string | null;
  difficulty: number | null;
  cpc: number | null;
  currentPosition: number | null;
  previousPosition: number | null;
  positionChange: number | null;
  bestPosition: number | null;
  rankingUrl: string | null;
  clicks28d: number;
  impressions28d: number;
  ctr28d: number | null;
  position28d: number | null;
  businessValue: number | null;
  relevanceScore: number | null;
  geoPotential: number | null;
  pageUrl: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Rebuilt from the factors the scoring engine persisted. Null when it has never scored this row. */
  opportunity: ExplainableScore | null;
  history: KeywordHistoryPoint[];
  historySource: KeywordHistorySource;
  cluster: KeywordClusterSummary | null;
  siblings: KeywordSibling[];
  /** An existing brief for this keyword, so the UI links to it rather than opening a second one. */
  brief: { id: string; title: string; status: string } | null;
}

export interface KeywordClusterRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentTopic: string | null;
  intent: string;
  keywordCount: number;
  totalVolume: number;
  totalImpressions: number;
  totalClicks: number;
  avgPosition: number | null;
  coverageScore: number | null;
  opportunityScore: number | null;
  /** URL of the pillar page clustering mapped this topic to, when it found one. */
  pillarPageUrl: string | null;
}
