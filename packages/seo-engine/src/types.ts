import type { HeadingNode, ImageInfo, DiscoveredLink } from '@seo/shared';

/**
 * The audit input model.
 *
 * Deliberately decoupled from both the crawler's output types and Prisma rows so the
 * rules engine can run against a fresh crawl *or* against pages already in the database
 * (e.g. re-running the audit after a settings change without re-crawling).
 */
export interface AuditPage {
  url: string;
  normalizedUrl: string;
  statusCode: number | null;
  contentType: string | null;
  redirectTarget: string | null;
  redirectChain: string[];
  depth: number;
  responseTimeMs: number | null;
  contentBytes: number | null;
  error: string | null;

  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  metaViewport: string | null;
  lang: string | null;
  h1: string[];
  headings: HeadingNode[];
  wordCount: number;
  textContent: string | null;
  contentHash: string | null;
  simhash: string | null;

  links: DiscoveredLink[];
  images: ImageInfo[];
  imagesMissingAlt: number;
  schemaTypes: string[];
  structuredData: unknown[];
  hreflang: Array<{ lang: string; href: string }>;

  isIndexable: boolean;
  indexabilityReason: string | null;
  inSitemap: boolean;

  /** Populated by the link-graph pass, not by the crawler. */
  internalLinksIn?: number;
  internalLinksOut?: number;
}

export interface AuditDataset {
  websiteId: string;
  domain: string;
  protocol: string;
  pages: AuditPage[];
  /** Every internal edge discovered in the crawl. */
  edges: Array<{ from: string; to: string; anchorText: string; isNofollow: boolean; inMainContent: boolean }>;
  robots: {
    found: boolean;
    body: string | null;
    sitemaps: string[];
    /** URLs the crawler skipped because robots.txt disallowed them. */
    disallowedUrls: string[];
  };
  sitemap: {
    found: boolean;
    urls: string[];
    errors: string[];
  };
  settings: {
    thinContentWords: number;
    maxDepthWarn: number;
  };
  /** URLs the crawler declined to fetch, with the reason (crawl traps, patterns, limits). */
  skipped: Array<{ url: string; reason: string }>;
}

export type IssueSeverityValue = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
export type IssueCategoryValue =
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

/** A finding produced by a rule, before it is persisted as a TechnicalIssue. */
export interface IssueDraft {
  ruleId: string;
  title: string;
  category: IssueCategoryValue;
  severity: IssueSeverityValue;
  url: string | null;
  description: string;
  recommendation: string;
  evidence: Record<string, unknown>;
  estimatedImpact: number;
  confidence: number;
  autoFixable: boolean;
  weight: number;
  /** Copied from the rule so the health score can weight site-wide findings correctly. */
  scope: 'page' | 'site';
  fingerprint: string;
}

export interface RuleDefinition {
  id: string;
  title: string;
  category: IssueCategoryValue;
  severity: IssueSeverityValue;
  /** Relative contribution to the health-score penalty within its category. */
  weight: number;
  autoFixable: boolean;
  /**
   * Where the problem lives.
   *
   * `page` issues scale with site size — ten missing titles on a 10,000-page site is a smaller
   * proportional problem than on a 20-page site. `site` issues do not: a missing sitemap is
   * exactly as bad on a huge site as on a tiny one (arguably worse), so the health score must not
   * dilute them by page count.
   */
  scope: 'page' | 'site';
  /** Shown in the audit methodology panel. */
  rationale: string;
}
