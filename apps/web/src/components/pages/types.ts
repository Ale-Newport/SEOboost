import type { ExplainableScore, HeadingNode, StructuredDataBlock } from '@seo/shared';
import type { PageProfile, PageQueryRow } from '@/server/queries/pages';

/**
 * View models for the page-detail screen.
 *
 * They live here, beside the components that render them, rather than in the route's data
 * module: the server loader and every panel then agree on one shape, and no component has to
 * reach into a route directory to name its own props. Types only — nothing here runs.
 */

// ── Performance ──────────────────────────────────────────────────────────────

export interface PagePerformancePoint {
  date: string;
  clicks: number;
  impressions: number;
  /** Impression-weighted average; null on days with no impressions, so the line breaks. */
  position: number | null;
}

export interface PagePerformanceTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export interface PagePerformance {
  points: PagePerformancePoint[];
  totals: PagePerformanceTotals;
  previous: PagePerformanceTotals;
  deltas: {
    clicks: number | null;
    impressions: number | null;
    ctr: number | null;
    position: number | null;
  };
  hasData: boolean;
  range: { from: string; to: string };
  comparisonRange: { from: string; to: string };
  days: number;
}

// ── Queries ──────────────────────────────────────────────────────────────────

export interface PageQueryInsight extends PageQueryRow {
  /** CTR the position alone would predict, from the shared curve. */
  expectedCtr: number;
  /** Actual minus expected, in rate points. Negative means the snippet under-earns its rank. */
  ctrGap: number;
  /** Clicks the query would add at the expected rate. Only meaningful when the gap is negative. */
  potentialClicks: number;
  underperforms: boolean;
}

// ── Crawl-time document ──────────────────────────────────────────────────────

export interface PageDocument {
  crawledAt: Date;
  statusCode: number | null;
  responseTimeMs: number | null;
  contentBytes: number | null;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  lang: string | null;
  redirectChain: string[];
  headings: HeadingNode[];
  imageCount: number;
  imagesMissingAlt: number;
  /** Blocks the crawler actually found in the HTML, with the parser's validity verdict. */
  structuredData: StructuredDataBlock[];
  readability: { score: number; label: string } | null;
}

// ── History ──────────────────────────────────────────────────────────────────

export type PageChangeField =
  | 'Title'
  | 'Meta description'
  | 'H1'
  | 'Body content'
  | 'Word count'
  | 'Status code';

export interface PageChange {
  field: PageChangeField;
  before: string | null;
  after: string | null;
  /** Extra context a raw before/after cannot carry, e.g. how many words moved. */
  detail?: string;
}

export interface PageHistoryEntry {
  id: string;
  capturedAt: Date;
  reason: string;
  wordCount: number;
  seoScore: number | null;
  geoScore: number | null;
  clicks28d: number | null;
  position28d: number | null;
  changes: PageChange[];
  /** True for the oldest snapshot held, which has nothing to be compared against. */
  isFirst: boolean;
}

// ── Title & meta review ──────────────────────────────────────────────────────

export type MetaStatus = 'missing' | 'short' | 'long' | 'ok';

export interface MetaField {
  value: string | null;
  length: number;
  min: number;
  max: number;
  status: MetaStatus;
}

export interface MetaReview {
  title: MetaField;
  metaDescription: MetaField;
  h1: string | null;
  /** Queries this URL already earns impressions for that the title does not contain. */
  missingFromTitle: Array<{ query: string; impressions: number; position: number }>;
}

// ── Recommendations ──────────────────────────────────────────────────────────

export interface PageRecommendation {
  id: string;
  title: string;
  detail: string;
  /** Where the operator goes to act on it. */
  href?: string;
  hrefLabel?: string;
  tone: 'critical' | 'warning' | 'info';
}

// ── The whole screen ─────────────────────────────────────────────────────────

export interface PageDetailData {
  profile: PageProfile;
  document: PageDocument | null;
  performance: PagePerformance;
  queries: PageQueryInsight[];
  history: PageHistoryEntry[];
  meta: MetaReview;
  recommendations: PageRecommendation[];
  scores: {
    seo: ExplainableScore | null;
    opportunity: ExplainableScore | null;
    geo: ExplainableScore | null;
    geoAuditedAt: Date | null;
  };
  thinContentWords: number;
  /** Generated schema items the platform holds for this URL, with their validation state. */
  generatedSchema: PageProfile['recommendations']['structuredData'];
}
