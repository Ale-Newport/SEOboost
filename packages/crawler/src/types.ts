/**
 * Shared shapes for the crawler.
 *
 * `PageAnalysis` is deliberately a superset of the `CrawlPage` table: the worker persists a
 * row straight from it. Keeping the two in lockstep is what stops extraction and storage
 * drifting apart as rules are added.
 */

import type { DiscoveredLink, HeadingNode, ImageInfo, StructuredDataBlock } from '@seo/shared';

/** A `<link rel="alternate" hreflang="…">` pair, with `href` already resolved to absolute. */
export interface HreflangAlternate {
  hreflang: string;
  href: string;
}

export interface PageAnalysis {
  /** URL as requested (pre-redirect). */
  url: string;
  normalizedUrl: string;
  statusCode: number | null;
  contentType: string | null;
  /** Final URL when the request was redirected, otherwise null. */
  redirectTarget: string | null;
  /** Every hop after the requested URL, in order. */
  redirectChain: string[];
  depth: number;
  responseTimeMs: number | null;
  contentBytes: number | null;
  error: string | null;

  title: string | null;
  titleLength: number | null;
  metaDescription: string | null;
  metaDescriptionLength: number | null;
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
  structuredData: StructuredDataBlock[];
  hreflang: HreflangAlternate[];
  /**
   * Raw social meta keyed by the property as authored (`og:title`, `twitter:card`, …) so
   * downstream rules can look for either family without a second parse.
   */
  openGraph: Record<string, string>;

  isIndexable: boolean;
  indexabilityReason: string;

  /** Set by the crawler when the URL appeared in a sitemap. */
  inSitemap: boolean;
  /** True when the analysed HTML came from a headless browser render. */
  rendered: boolean;
}

/**
 * Everything the engine needs to run. Only `startUrl`, `maxPages` and `maxDepth` are required;
 * the rest falls back to website settings defaults or `env`. The shape is plain JSON so a job
 * payload can carry it — the `AbortSignal` lives in `CrawlHooks` for that reason.
 */
export interface CrawlConfig {
  startUrl: string;
  /** Bare domain for same-site checks. Defaults to the start URL host. */
  domain?: string;
  maxPages: number;
  maxDepth: number;
  concurrency?: number;
  /** Minimum gap between two requests to the same host. */
  delayMs?: number;
  userAgent?: string;
  respectRobots?: boolean;
  renderJs?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  /** Seed the frontier from sitemaps. Default true. */
  useSitemap?: boolean;
  maxSitemapUrls?: number;
  /** Attempts per URL, including the first. Default 3. */
  retries?: number;
  /** Probe non-HTML asset links with HEAD to catch broken images/PDFs. Default false. */
  checkAssets?: boolean;
}

export interface FetchResult {
  /** URL originally requested. */
  url: string;
  /** URL that actually served the response, after redirects. */
  finalUrl: string;
  ok: boolean;
  statusCode: number | null;
  contentType: string | null;
  headers: Record<string, string>;
  /** Decoded body. Null for HEAD probes, non-textual responses and failures. */
  body: string | null;
  /** Undecoded bytes, only when `raw` was requested (gzipped sitemaps need these). */
  rawBody: Uint8Array | null;
  /** Bytes actually received (capped by `maxBodyBytes`). */
  contentBytes: number;
  truncated: boolean;
  redirectChain: string[];
  redirectTarget: string | null;
  /**
   * Status of the *first* redirecting response (301, 302, …), null when nothing redirected.
   * `statusCode` is the final hop's, so without this a permanent redirect is indistinguishable
   * from a temporary one — the difference an audit exists to report.
   */
  redirectStatus: number | null;
  responseTimeMs: number;
  attempts: number;
  /** True when the caller's signal cancelled the request, as opposed to a real failure. */
  aborted: boolean;
  error: string | null;
}

export interface RobotsInfo {
  origin: string;
  url: string;
  /** False when robots.txt is absent, empty, or unreadable — in which case everything is allowed. */
  found: boolean;
  statusCode: number | null;
  body: string | null;
  /** Crawl-delay for our user-agent, in seconds. */
  crawlDelay: number | null;
  sitemaps: string[];
  error: string | null;
  isAllowed(url: string): boolean;
}

export interface SitemapEntry {
  loc: string;
  normalizedLoc: string;
  lastmod: string | null;
  changefreq: string | null;
  priority: number | null;
  /** Sitemap document this entry came from. */
  source: string;
}

export interface SitemapResult {
  /** Sitemap documents that parsed successfully, in discovery order. */
  sitemapUrls: string[];
  entries: SitemapEntry[];
  errors: Array<{ url: string; error: string }>;
  /** True when a cap (URLs, documents or nesting depth) stopped the expansion early. */
  truncated: boolean;
}

export type SkipReason =
  | 'robots-disallow'
  | 'exclude-pattern'
  | 'include-pattern'
  | 'non-html-extension'
  | 'crawl-trap'
  | 'max-depth'
  | 'max-pages'
  | 'off-site'
  | 'invalid-url'
  | 'cancelled';

export interface SkippedUrl {
  url: string;
  normalizedUrl: string | null;
  reason: SkipReason;
  /** Human-readable specifics, e.g. which pattern matched. */
  detail: string;
  depth: number;
  /** URL that linked to this one, when it was discovered rather than seeded. */
  foundOn: string | null;
}

export type CrawlPhase = 'starting' | 'robots' | 'sitemap' | 'crawling' | 'finishing';

export interface CrawlProgress {
  phase: CrawlPhase;
  /** Unique URLs accepted into the frontier (crawled + queued). */
  discovered: number;
  crawled: number;
  failed: number;
  skipped: number;
  queued: number;
  depth: number;
  currentUrl: string | null;
  elapsedMs: number;
  message: string;
}

/** One directed link, flattened for the `LinkEdge` table. */
export interface CrawlLinkEdge {
  sourceUrl: string;
  sourceNormalizedUrl: string;
  targetUrl: string;
  normalizedTarget: string;
  anchorText: string;
  rel: string | null;
  isInternal: boolean;
  isNofollow: boolean;
  inNav: boolean;
  inFooter: boolean;
  inMainContent: boolean;
  position: number;
}

export interface CrawlStats {
  pagesCrawled: number;
  pagesFailed: number;
  pagesSkipped: number;
  pagesDiscovered: number;
  maxDepthReached: number;
  totalBytes: number;
  /** Mean response time over responses that produced a status code. */
  avgResponseTimeMs: number;
}

export interface CrawlOutcome {
  startUrl: string;
  domain: string;
  pages: PageAnalysis[];
  linkGraph: CrawlLinkEdge[];
  robots: RobotsInfo;
  sitemap: SitemapResult;
  skipped: SkippedUrl[];
  stats: CrawlStats;
  /** CMS detected from the first HTML page fetched, when there was one. */
  cms: CmsDetection | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** True when the caller's signal stopped the crawl before the frontier drained. */
  cancelled: boolean;
  /** True when a page/depth cap stopped the crawl before the frontier drained. */
  limitReached: boolean;
  /** Non-fatal problems worth surfacing (robots unreachable, renderer missing, …). */
  warnings: string[];
}

/** Mirrors the `CmsType` enum minus `GIT`, which is a connection type rather than a detection. */
export type DetectedCms =
  | 'UNKNOWN'
  | 'WORDPRESS'
  | 'SHOPIFY'
  | 'WEBFLOW'
  | 'NEXTJS'
  | 'ASTRO'
  | 'HUGO'
  | 'GHOST'
  | 'SQUARESPACE'
  | 'WIX'
  | 'CUSTOM';

export interface CmsDetection {
  cms: DetectedCms;
  /** 0-1. Sum of matched signal weights, capped. */
  confidence: number;
  signals: string[];
}
