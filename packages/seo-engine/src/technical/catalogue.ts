import type { RuleDefinition } from '../types';

/**
 * The complete rule catalogue.
 *
 * Every rule is declared here (not inline in the evaluator) so the audit UI can render the
 * methodology, the health score can weight findings consistently, and rules can be enabled or
 * ignored per site without touching evaluation code.
 */
export const RULES = {
  // ── Crawlability ────────────────────────────────────────────────────────
  HTTP_404: {
    id: 'HTTP_404', title: 'Page returns 404', category: 'CRAWLABILITY', severity: 'HIGH',
    weight: 3, autoFixable: false,
    scope: 'page',
    rationale: 'A linked URL that 404s wastes crawl budget and strands any link equity pointing at it.',
  },
  HTTP_410: {
    id: 'HTTP_410', title: 'Page returns 410 Gone', category: 'CRAWLABILITY', severity: 'MEDIUM',
    weight: 1.5, autoFixable: false,
    scope: 'page',
    rationale: '410 is a deliberate removal signal; confirm it was intentional and that nothing still links there.',
  },
  HTTP_5XX: {
    id: 'HTTP_5XX', title: 'Server error (5xx)', category: 'CRAWLABILITY', severity: 'CRITICAL',
    weight: 5, autoFixable: false,
    scope: 'page',
    rationale: 'Server errors stop indexing outright and can cause existing pages to be dropped.',
  },
  HTTP_4XX_OTHER: {
    id: 'HTTP_4XX_OTHER', title: 'Client error (4xx)', category: 'CRAWLABILITY', severity: 'MEDIUM',
    weight: 2, autoFixable: false,
    scope: 'page',
    rationale: 'Non-404 client errors (401/403/429) usually mean the page is unreachable to crawlers.',
  },
  FETCH_FAILED: {
    id: 'FETCH_FAILED', title: 'Page could not be fetched', category: 'CRAWLABILITY', severity: 'HIGH',
    weight: 3, autoFixable: false,
    scope: 'page',
    rationale: 'Timeouts and connection failures are how search engines experience an unstable site.',
  },
  REDIRECT_CHAIN: {
    id: 'REDIRECT_CHAIN', title: 'Redirect chain', category: 'CRAWLABILITY', severity: 'MEDIUM',
    weight: 1.5, autoFixable: true,
    scope: 'page',
    rationale: 'Each hop loses a little equity and crawl budget; point the first URL at the final destination.',
  },
  REDIRECT_LOOP: {
    id: 'REDIRECT_LOOP', title: 'Redirect loop', category: 'CRAWLABILITY', severity: 'CRITICAL',
    weight: 5, autoFixable: false,
    scope: 'page',
    rationale: 'A loop makes the URL permanently unreachable.',
  },
  MISSING_ROBOTS_TXT: {
    id: 'MISSING_ROBOTS_TXT', title: 'No robots.txt found', category: 'CRAWLABILITY', severity: 'LOW',
    weight: 1, autoFixable: false,
    scope: 'site',
    rationale: 'robots.txt is where crawl directives and sitemap discovery live; its absence is a missed control point.',
  },
  ROBOTS_BLOCKS_IMPORTANT: {
    id: 'ROBOTS_BLOCKS_IMPORTANT', title: 'robots.txt blocks linked pages', category: 'CRAWLABILITY', severity: 'HIGH',
    weight: 3, autoFixable: false,
    scope: 'site',
    rationale: 'Internally linked pages that robots.txt disallows cannot be crawled at all.',
  },
  CRAWL_TRAP: {
    id: 'CRAWL_TRAP', title: 'Potential crawl trap', category: 'CRAWLABILITY', severity: 'MEDIUM',
    weight: 2, autoFixable: false,
    scope: 'page',
    rationale: 'Faceted or calendar URL patterns can generate unbounded URL space and exhaust crawl budget.',
  },
  SLOW_RESPONSE: {
    id: 'SLOW_RESPONSE', title: 'Slow server response', category: 'PERFORMANCE', severity: 'MEDIUM',
    weight: 1.5, autoFixable: false,
    scope: 'page',
    rationale: 'Slow time-to-first-byte reduces effective crawl rate and hurts user experience metrics.',
  },
  LARGE_PAGE: {
    id: 'LARGE_PAGE', title: 'Excessive page size', category: 'PERFORMANCE', severity: 'LOW',
    weight: 1, autoFixable: false,
    scope: 'page',
    rationale: 'Very large HTML payloads slow rendering and can truncate what gets parsed.',
  },

  // ── Indexability ────────────────────────────────────────────────────────
  NOINDEX_PAGE: {
    id: 'NOINDEX_PAGE', title: 'Page is noindex', category: 'INDEXABILITY', severity: 'INFO',
    weight: 0.5, autoFixable: false,
    scope: 'page',
    rationale: 'Often intentional. Flagged so an accidental noindex on a money page is impossible to miss.',
  },
  NOINDEX_WITH_TRAFFIC: {
    id: 'NOINDEX_WITH_TRAFFIC', title: 'Noindex on a page that ranks', category: 'INDEXABILITY', severity: 'CRITICAL',
    weight: 5, autoFixable: true,
    scope: 'page',
    rationale: 'A noindex directive on a page with Search Console impressions will remove it from results.',
  },
  MISSING_CANONICAL: {
    id: 'MISSING_CANONICAL', title: 'Missing canonical tag', category: 'INDEXABILITY', severity: 'LOW',
    weight: 1, autoFixable: true,
    scope: 'page',
    rationale: 'A self-referencing canonical protects against duplicate URLs created by parameters.',
  },
  CANONICAL_TO_NON_INDEXABLE: {
    id: 'CANONICAL_TO_NON_INDEXABLE', title: 'Canonical points to a non-indexable page', category: 'INDEXABILITY',
    severity: 'HIGH', weight: 3, autoFixable: false,
    scope: 'page',
    rationale: 'Consolidating signals into a page that cannot be indexed discards them entirely.',
  },
  CANONICAL_TO_REDIRECT: {
    id: 'CANONICAL_TO_REDIRECT', title: 'Canonical points to a redirect', category: 'INDEXABILITY',
    severity: 'MEDIUM', weight: 2, autoFixable: true,
    scope: 'page',
    rationale: 'Canonicals should name the final destination URL, not an intermediate hop.',
  },
  CANONICAL_TO_404: {
    id: 'CANONICAL_TO_404', title: 'Canonical points to a broken URL', category: 'INDEXABILITY',
    severity: 'HIGH', weight: 3, autoFixable: false,
    scope: 'page',
    rationale: 'A canonical to a 404 leaves the page with no valid consolidation target.',
  },
  CANONICAL_CROSS_DOMAIN: {
    id: 'CANONICAL_CROSS_DOMAIN', title: 'Canonical points to another domain', category: 'INDEXABILITY',
    severity: 'HIGH', weight: 3, autoFixable: false,
    scope: 'page',
    rationale: 'Cross-domain canonicals hand ranking signals to a different site — rarely intended.',
  },
  CONFLICTING_ROBOTS_DIRECTIVES: {
    id: 'CONFLICTING_ROBOTS_DIRECTIVES', title: 'Conflicting robots directives', category: 'INDEXABILITY',
    severity: 'MEDIUM', weight: 2, autoFixable: false,
    scope: 'page',
    rationale: 'Meta robots and X-Robots-Tag disagreeing produces unpredictable indexing behaviour.',
  },
  BLOCKED_BUT_CANONICAL_TARGET: {
    id: 'BLOCKED_BUT_CANONICAL_TARGET', title: 'Canonical target is blocked by robots.txt', category: 'INDEXABILITY',
    severity: 'HIGH', weight: 3, autoFixable: false,
    scope: 'page',
    rationale: 'A crawler that cannot fetch the canonical target cannot honour the canonical.',
  },
  NOINDEX_IN_SITEMAP: {
    id: 'NOINDEX_IN_SITEMAP', title: 'Non-indexable URL listed in sitemap', category: 'INDEXABILITY',
    severity: 'MEDIUM', weight: 2, autoFixable: true,
    scope: 'page',
    rationale: 'Sitemaps should list only canonical, indexable URLs; mixed signals reduce trust in the file.',
  },

  // ── Sitemap ─────────────────────────────────────────────────────────────
  MISSING_SITEMAP: {
    id: 'MISSING_SITEMAP', title: 'No XML sitemap found', category: 'CRAWLABILITY', severity: 'MEDIUM',
    weight: 2, autoFixable: false,
    scope: 'site',
    rationale: 'Sitemaps are the primary discovery channel for new and deep pages.',
  },
  SITEMAP_ERROR: {
    id: 'SITEMAP_ERROR', title: 'Sitemap could not be parsed', category: 'CRAWLABILITY', severity: 'HIGH',
    weight: 3, autoFixable: false,
    scope: 'site',
    rationale: 'A malformed sitemap may be ignored entirely, silently losing discovery coverage.',
  },
  SITEMAP_ORPHAN_URL: {
    id: 'SITEMAP_ORPHAN_URL', title: 'Sitemap URL not reachable by internal links', category: 'ARCHITECTURE',
    severity: 'MEDIUM', weight: 1.5, autoFixable: false,
    scope: 'site',
    rationale: 'A URL only discoverable via the sitemap gets almost no internal link equity.',
  },
  SITEMAP_BROKEN_URL: {
    id: 'SITEMAP_BROKEN_URL', title: 'Sitemap lists a broken URL', category: 'CRAWLABILITY', severity: 'MEDIUM',
    weight: 2, autoFixable: true,
    scope: 'site',
    rationale: 'Dead URLs in a sitemap waste crawl budget and reduce confidence in the file.',
  },

  // ── Metadata ────────────────────────────────────────────────────────────
  MISSING_TITLE: {
    id: 'MISSING_TITLE', title: 'Missing title tag', category: 'METADATA', severity: 'HIGH',
    weight: 3, autoFixable: true,
    scope: 'page',
    rationale: 'The title is the single strongest on-page relevance signal and the clickable SERP headline.',
  },
  DUPLICATE_TITLE: {
    id: 'DUPLICATE_TITLE', title: 'Duplicate title tag', category: 'METADATA', severity: 'MEDIUM',
    weight: 2, autoFixable: true,
    scope: 'site',
    rationale: 'Identical titles make pages compete with each other and look interchangeable in results.',
  },
  TITLE_TOO_LONG: {
    id: 'TITLE_TOO_LONG', title: 'Title too long', category: 'METADATA', severity: 'LOW',
    weight: 1, autoFixable: true,
    scope: 'page',
    rationale: 'Titles beyond ~60 characters get truncated, hiding the differentiating words.',
  },
  TITLE_TOO_SHORT: {
    id: 'TITLE_TOO_SHORT', title: 'Title too short', category: 'METADATA', severity: 'LOW',
    weight: 0.8, autoFixable: true,
    scope: 'page',
    rationale: 'Very short titles waste available SERP real estate and relevance signal.',
  },
  MISSING_META_DESCRIPTION: {
    id: 'MISSING_META_DESCRIPTION', title: 'Missing meta description', category: 'METADATA', severity: 'MEDIUM',
    weight: 1.5, autoFixable: true,
    scope: 'page',
    rationale: 'Without one the engine writes its own snippet, which usually converts worse.',
  },
  DUPLICATE_META_DESCRIPTION: {
    id: 'DUPLICATE_META_DESCRIPTION', title: 'Duplicate meta description', category: 'METADATA', severity: 'LOW',
    weight: 1, autoFixable: true,
    scope: 'site',
    rationale: 'Repeated descriptions signal templated, low-differentiation pages.',
  },
  META_DESCRIPTION_TOO_LONG: {
    id: 'META_DESCRIPTION_TOO_LONG', title: 'Meta description too long', category: 'METADATA', severity: 'LOW',
    weight: 0.6, autoFixable: true,
    scope: 'page',
    rationale: 'Descriptions past ~155 characters are truncated mid-sentence.',
  },
  META_DESCRIPTION_TOO_SHORT: {
    id: 'META_DESCRIPTION_TOO_SHORT', title: 'Meta description too short', category: 'METADATA', severity: 'LOW',
    weight: 0.5, autoFixable: true,
    scope: 'page',
    rationale: 'Very short descriptions leave click-through persuasion on the table.',
  },
  MISSING_H1: {
    id: 'MISSING_H1', title: 'Missing H1', category: 'METADATA', severity: 'MEDIUM',
    weight: 1.5, autoFixable: true,
    scope: 'page',
    rationale: 'The H1 states the page topic for both readers and parsers.',
  },
  MULTIPLE_H1: {
    id: 'MULTIPLE_H1', title: 'Multiple H1 headings', category: 'METADATA', severity: 'LOW',
    weight: 0.7, autoFixable: false,
    scope: 'page',
    rationale: 'Valid in HTML5 but often a symptom of an unclear content hierarchy.',
  },
  DUPLICATE_H1: {
    id: 'DUPLICATE_H1', title: 'Duplicate H1 across pages', category: 'METADATA', severity: 'LOW',
    weight: 0.8, autoFixable: false,
    scope: 'site',
    rationale: 'Pages sharing an H1 usually target the same topic and risk cannibalisation.',
  },
  HEADING_HIERARCHY_SKIP: {
    id: 'HEADING_HIERARCHY_SKIP', title: 'Heading levels skipped', category: 'METADATA', severity: 'INFO',
    weight: 0.3, autoFixable: false,
    scope: 'page',
    rationale: 'Skipping from H2 to H4 harms accessibility and makes the outline harder to parse.',
  },
  MISSING_VIEWPORT: {
    id: 'MISSING_VIEWPORT', title: 'Missing viewport meta tag', category: 'PERFORMANCE', severity: 'MEDIUM',
    weight: 1.5, autoFixable: true,
    scope: 'page',
    rationale: 'Without a viewport tag the page is not mobile-friendly, which is the primary index.',
  },
  MISSING_LANG: {
    id: 'MISSING_LANG', title: 'Missing html lang attribute', category: 'INTERNATIONAL', severity: 'LOW',
    weight: 0.6, autoFixable: true,
    scope: 'page',
    rationale: 'Declaring the language helps engines serve the page to the right audience.',
  },
  HREFLANG_NO_RETURN: {
    id: 'HREFLANG_NO_RETURN', title: 'Hreflang without return link', category: 'INTERNATIONAL', severity: 'MEDIUM',
    weight: 1.5, autoFixable: false,
    scope: 'page',
    rationale: 'Hreflang annotations must be reciprocal or they are ignored.',
  },

  // ── Content ─────────────────────────────────────────────────────────────
  THIN_CONTENT: {
    id: 'THIN_CONTENT', title: 'Thin content', category: 'CONTENT', severity: 'MEDIUM',
    weight: 2, autoFixable: false,
    scope: 'page',
    rationale: 'Pages with very little unique text rarely satisfy an informational query.',
  },
  DUPLICATE_CONTENT: {
    id: 'DUPLICATE_CONTENT', title: 'Duplicate content', category: 'CONTENT', severity: 'HIGH',
    weight: 3, autoFixable: false,
    scope: 'site',
    rationale: 'Byte-identical bodies force the engine to pick one URL and discard the others.',
  },
  NEAR_DUPLICATE_CONTENT: {
    id: 'NEAR_DUPLICATE_CONTENT', title: 'Near-duplicate content', category: 'CONTENT', severity: 'MEDIUM',
    weight: 2, autoFixable: false,
    scope: 'site',
    rationale: 'Heavily overlapping pages split ranking signals between near-identical documents.',
  },
  MISSING_IMAGE_ALT: {
    id: 'MISSING_IMAGE_ALT', title: 'Images missing alt text', category: 'CONTENT', severity: 'LOW',
    weight: 1, autoFixable: true,
    scope: 'page',
    rationale: 'Alt text is an accessibility requirement and the only textual signal an image carries.',
  },
  BROKEN_IMAGE: {
    id: 'BROKEN_IMAGE', title: 'Broken image', category: 'CONTENT', severity: 'MEDIUM',
    weight: 1.5, autoFixable: false,
    scope: 'page',
    rationale: 'Images that fail to load damage perceived quality and page experience.',
  },

  // ── Links ───────────────────────────────────────────────────────────────
  BROKEN_INTERNAL_LINK: {
    id: 'BROKEN_INTERNAL_LINK', title: 'Broken internal link', category: 'LINKS', severity: 'HIGH',
    weight: 3, autoFixable: true,
    scope: 'page',
    rationale: 'Internal links to dead URLs waste crawl budget and frustrate readers mid-journey.',
  },
  BROKEN_EXTERNAL_LINK: {
    id: 'BROKEN_EXTERNAL_LINK', title: 'Broken external link', category: 'LINKS', severity: 'LOW',
    weight: 0.8, autoFixable: true,
    scope: 'page',
    rationale: 'Dead outbound links are a visible quality signal and a poor reader experience.',
  },
  INTERNAL_LINK_TO_REDIRECT: {
    id: 'INTERNAL_LINK_TO_REDIRECT', title: 'Internal link points to a redirect', category: 'LINKS',
    severity: 'MEDIUM', weight: 1.5, autoFixable: true,
    scope: 'page',
    rationale: 'Linking straight to the destination removes a hop and preserves equity.',
  },
  INTERNAL_LINK_TO_NOINDEX: {
    id: 'INTERNAL_LINK_TO_NOINDEX', title: 'Internal link points to a non-indexable page', category: 'LINKS',
    severity: 'LOW', weight: 0.7, autoFixable: false,
    scope: 'page',
    rationale: 'Equity flowing into a noindex page is largely wasted.',
  },
  ORPHAN_PAGE: {
    id: 'ORPHAN_PAGE', title: 'Orphan page', category: 'ARCHITECTURE', severity: 'HIGH',
    weight: 2.5, autoFixable: true,
    scope: 'page',
    rationale: 'A page nothing links to receives no internal equity and is discovered slowly, if at all.',
  },
  LOW_INTERNAL_LINKS: {
    id: 'LOW_INTERNAL_LINKS', title: 'Very few internal links pointing here', category: 'ARCHITECTURE',
    severity: 'LOW', weight: 0.8, autoFixable: true,
    scope: 'page',
    rationale: 'Under-linked pages read as unimportant relative to the rest of the site.',
  },
  DEEP_PAGE: {
    id: 'DEEP_PAGE', title: 'Page buried too deep', category: 'ARCHITECTURE', severity: 'MEDIUM',
    weight: 1.5, autoFixable: false,
    scope: 'page',
    rationale: 'Pages more than a few clicks from the homepage are crawled less often and rank worse.',
  },
  ISOLATED_CLUSTER: {
    id: 'ISOLATED_CLUSTER', title: 'Isolated content cluster', category: 'ARCHITECTURE', severity: 'MEDIUM',
    weight: 1.5, autoFixable: true,
    scope: 'site',
    rationale: 'A group of pages linked only to each other cannot pass equity to or from the main site.',
  },
  EXCESSIVE_OUTBOUND_LINKS: {
    id: 'EXCESSIVE_OUTBOUND_LINKS', title: 'Excessive links on page', category: 'LINKS', severity: 'LOW',
    weight: 0.6, autoFixable: false,
    scope: 'page',
    rationale: 'Hundreds of links per page dilute the equity each one carries.',
  },

  // ── Structured data ─────────────────────────────────────────────────────
  MALFORMED_STRUCTURED_DATA: {
    id: 'MALFORMED_STRUCTURED_DATA', title: 'Malformed structured data', category: 'STRUCTURED_DATA',
    severity: 'MEDIUM', weight: 2, autoFixable: true,
    scope: 'page',
    rationale: 'Invalid JSON-LD is discarded silently, so the markup delivers nothing.',
  },
  MISSING_STRUCTURED_DATA: {
    id: 'MISSING_STRUCTURED_DATA', title: 'No structured data', category: 'STRUCTURED_DATA', severity: 'LOW',
    weight: 1, autoFixable: true,
    scope: 'page',
    rationale: 'Schema markup is how machines — including answer engines — read entities and relationships.',
  },
  MISSING_ORGANIZATION_SCHEMA: {
    id: 'MISSING_ORGANIZATION_SCHEMA', title: 'No Organization schema on the site', category: 'GEO',
    severity: 'MEDIUM', weight: 2, autoFixable: true,
    scope: 'site',
    rationale: 'Organization markup is the anchor entity that ties a brand to its knowledge graph record.',
  },
  MISSING_BREADCRUMBS: {
    id: 'MISSING_BREADCRUMBS', title: 'No BreadcrumbList schema', category: 'STRUCTURED_DATA', severity: 'LOW',
    weight: 0.6, autoFixable: true,
    scope: 'page',
    rationale: 'Breadcrumb markup clarifies hierarchy and improves the SERP presentation.',
  },

  // ── Security / protocol ─────────────────────────────────────────────────
  MIXED_CONTENT: {
    id: 'MIXED_CONTENT', title: 'Mixed HTTP content on an HTTPS page', category: 'SECURITY', severity: 'HIGH',
    weight: 3, autoFixable: true,
    scope: 'page',
    rationale: 'Browsers block insecure sub-resources, breaking the page and eroding trust signals.',
  },
  HTTP_LINK_ON_HTTPS: {
    id: 'HTTP_LINK_ON_HTTPS', title: 'Internal link uses http:// on an https site', category: 'SECURITY',
    severity: 'LOW', weight: 0.7, autoFixable: true,
    scope: 'page',
    rationale: 'Every http link forces an extra redirect hop before the secure page is served.',
  },
} as const satisfies Record<string, RuleDefinition>;

export type RuleId = keyof typeof RULES;

export const RULE_LIST: RuleDefinition[] = Object.values(RULES);

export function getRule(id: RuleId): RuleDefinition {
  return RULES[id];
}
