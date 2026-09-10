/**
 * View models for the site-audit screen.
 *
 * Everything the client components receive is declared here as plain, serialisable data with
 * dates already formatted on the server: the audit table renders thousands of rows, and letting
 * each one call `toLocaleDateString()` in the browser would both cost time and risk a hydration
 * mismatch between the server's timezone and the reader's.
 *
 * The string unions mirror the Prisma enums exactly (`IssueSeverity`, `IssueCategory`,
 * `IssueStatus`). They are restated rather than imported so no client bundle has to reach into
 * `@seo/db` for a type it only needs at compile time.
 */

export type IssueSeverityName = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export type IssueCategoryName =
  | 'CRAWLABILITY'
  | 'INDEXABILITY'
  | 'METADATA'
  | 'CONTENT'
  | 'LINKS'
  | 'ARCHITECTURE'
  | 'STRUCTURED_DATA'
  | 'PERFORMANCE'
  | 'SECURITY'
  | 'INTERNATIONAL'
  | 'GEO';

export type IssueStatusName = 'OPEN' | 'IGNORED' | 'IN_PROGRESS' | 'RESOLVED' | 'REGRESSED';

/** Worst first — the same order the database enum is declared in, so sorting agrees with it. */
export const SEVERITY_SEQUENCE: readonly IssueSeverityName[] = [
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
  'INFO',
];

export const SEVERITY_LABEL: Record<IssueSeverityName, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info',
};

export const CATEGORY_LABEL: Record<IssueCategoryName, string> = {
  CRAWLABILITY: 'Crawlability',
  INDEXABILITY: 'Indexability',
  METADATA: 'Metadata',
  CONTENT: 'Content',
  LINKS: 'Links',
  ARCHITECTURE: 'Architecture',
  STRUCTURED_DATA: 'Structured data',
  PERFORMANCE: 'Performance',
  SECURITY: 'Security',
  INTERNATIONAL: 'International',
  GEO: 'GEO',
};

export const STATUS_LABEL: Record<IssueStatusName, string> = {
  OPEN: 'Open',
  REGRESSED: 'Regressed',
  IN_PROGRESS: 'In progress',
  IGNORED: 'Ignored',
  RESOLVED: 'Resolved',
};

/**
 * The categories the health score weights, in the order they are weighted.
 * GEO carries a weight of 0 (it has its own screen), so it only appears in the summary when the
 * site actually has GEO findings — see `buildCategorySummaries`.
 */
export const WEIGHTED_CATEGORIES: readonly IssueCategoryName[] = [
  'CRAWLABILITY',
  'INDEXABILITY',
  'METADATA',
  'CONTENT',
  'LINKS',
  'ARCHITECTURE',
  'STRUCTURED_DATA',
  'PERFORMANCE',
  'SECURITY',
  'INTERNATIONAL',
];

export function categoryLabel(value: string): string {
  return CATEGORY_LABEL[value as IssueCategoryName] ?? value;
}

export function severityLabel(value: string): string {
  return SEVERITY_LABEL[value as IssueSeverityName] ?? value;
}

export function statusLabel(value: string): string {
  return STATUS_LABEL[value as IssueStatusName] ?? value;
}

/** One row of the issue table. Dates arrive pre-formatted; `discoveredAt` stays sortable. */
export interface AuditIssueRow {
  id: string;
  ruleId: string;
  title: string;
  category: IssueCategoryName;
  severity: IssueSeverityName;
  status: IssueStatusName;
  /** The affected URL, falling back to the crawled page's URL when the rule is site-wide. */
  url: string | null;
  description: string;
  recommendation: string;
  /** 0-1, from the rule that raised the finding. */
  estimatedImpact: number;
  /** 0-1. */
  confidence: number;
  autoFixable: boolean;
  /** Epoch milliseconds — sortable without re-parsing a string in every comparison. */
  discoveredAt: number;
  discoveredLabel: string;
  lastSeenLabel: string;
  ignoredReason: string | null;
}

export interface SeverityCount {
  severity: IssueSeverityName;
  count: number;
}

/** One card in the section summary. */
export interface CategorySummary {
  category: IssueCategoryName;
  label: string;
  /** Live (open + regressed) issues in this category. */
  total: number;
  bySeverity: SeverityCount[];
  /** The engine's 0-100 score for this category, or null when it is not weighted. */
  score: number | null;
  /** Share of the health score this category carries, 0-1. Null when not weighted. */
  weight: number | null;
}

export interface FacetOptionCount {
  value: string;
  label: string;
  count: number;
}

export interface RuleFacetOption extends FacetOptionCount {
  severity: IssueSeverityName;
}

export interface IssueFacetData {
  /** Every issue ever recorded for the site, in any status. */
  total: number;
  /** Open + regressed. */
  live: number;
  autoFixable: number;
  severity: FacetOptionCount[];
  category: FacetOptionCount[];
  status: FacetOptionCount[];
  rules: RuleFacetOption[];
}

/** One entry of the inspectable rule catalogue. */
export interface RuleReferenceEntry {
  id: string;
  title: string;
  category: IssueCategoryName;
  severity: IssueSeverityName;
  weight: number;
  autoFixable: boolean;
  scope: 'page' | 'site';
  rationale: string;
}

/** The methodology numbers, read from the engine's own constants rather than restated in copy. */
export interface HealthMethodology {
  severityWeights: Array<{ severity: IssueSeverityName; weight: number }>;
  categoryWeights: Array<{ category: IssueCategoryName; label: string; weight: number }>;
  /** Half-way point for page-scoped penalties: `max(4, pages × 0.15)`. */
  pageHalfPoint: number;
  /** Fixed half-way point for site-scoped penalties. */
  siteHalfPoint: number;
  pagesCrawled: number;
  liveIssuesScored: number;
  /** True when the site has more live issues than the breakdown could load in one pass. */
  truncated: boolean;
  /** The score last written by the analysis pipeline, for comparison. */
  storedScore: number | null;
  storedScoreLabel: string | null;
}
