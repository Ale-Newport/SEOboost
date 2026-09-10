/**
 * Turning a stored crawl back into the rules engine's input model.
 *
 * `runTechnicalAudit` is pure and works on an `AuditDataset`, which lets the audit re-run
 * without re-crawling. This module is the adapter, and it is deliberate about two lossy spots:
 *
 *  - **Page text is not loaded.** No rule reads `textContent` (duplicate detection uses the
 *    stored simhash, thin content uses the word count), and loading 10 000 documents to pass
 *    `null`-equivalent data would be the single biggest allocation in the worker.
 *  - **Images are counted, not listed.** `CrawlPage` stores `imageCount`/`imagesMissingAlt`
 *    but not the individual `src` values, so the array handed to the rules carries the real
 *    counts with empty sources. Every number the audit reports stays true; only the "example
 *    image URL" evidence is unavailable, and an empty string says so rather than inventing one.
 */

import { type Prisma, prisma } from '@seo/db';
import { SEO_THRESHOLDS, type HeadingNode, type DiscoveredLink, type ImageInfo } from '@seo/shared';
import type { AuditDataset, AuditPage } from '@seo/seo-engine';

/** Pages loaded into one audit. Above this the audit reports on a documented subset. */
export const MAX_AUDIT_PAGES = 5_000;

/** Links kept per page. Sitewide navigation makes the tail repetitive and unbounded. */
export const MAX_LINKS_PER_PAGE = 150;

/** Internal edges loaded for the sitewide link rules. */
export const MAX_AUDIT_EDGES = 200_000;

const EDGE_BATCH = 2_000;
const PAGE_BATCH = 250;

export interface AuditDatasetOptions {
  /** Restrict the audit to specific durable page ids (a targeted re-audit after a fix). */
  pageIds?: string[];
  maxPages?: number;
}

export interface BuiltAuditDataset {
  dataset: AuditDataset;
  pagesLoaded: number;
  edgesLoaded: number;
  /** True when a cap stopped the load; surfaced in the job result, never hidden. */
  truncated: boolean;
}

function readHeadings(value: Prisma.JsonValue | null): HeadingNode[] {
  if (!Array.isArray(value)) return [];
  const out: HeadingNode[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.level === 'number' && typeof record.text === 'string') {
      out.push({ level: record.level, text: record.text });
    }
  }
  return out;
}

function readHreflang(value: Prisma.JsonValue | null): Array<{ lang: string; href: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ lang: string; href: string }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const lang = typeof record.hreflang === 'string' ? record.hreflang : record.lang;
    if (typeof lang === 'string' && typeof record.href === 'string') {
      out.push({ lang, href: record.href });
    }
  }
  return out;
}

function readStructuredData(value: Prisma.JsonValue | null): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Real counts, unknown sources — see the module comment for why this is the honest shape. */
function imagePlaceholders(total: number, missingAlt: number): ImageInfo[] {
  const count = Math.max(0, Math.min(total, 500));
  const missing = Math.max(0, Math.min(missingAlt, count));
  const images: ImageInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    images.push({ src: '', alt: i < missing ? null : 'present' });
  }
  return images;
}

export async function buildAuditDataset(
  website: { id: string; domain: string; protocol: string },
  crawlId: string,
  settings: { thinContentWords: number },
  options: AuditDatasetOptions = {},
): Promise<BuiltAuditDataset> {
  const maxPages = Math.min(options.maxPages ?? MAX_AUDIT_PAGES, MAX_AUDIT_PAGES);

  const crawl = await prisma.crawl.findUnique({
    where: { id: crawlId },
    select: { robotsTxtFound: true, robotsTxtBody: true, sitemapUrls: true, sitemapUrlCount: true },
  });

  const pages: AuditPage[] = [];
  const normalizedById = new Map<string, string>();
  const linksBySource = new Map<string, DiscoveredLink[]>();
  const sitemapUrls: string[] = [];
  let truncated = false;

  let cursor: string | null = null;
  for (;;) {
    if (pages.length >= maxPages) {
      truncated = true;
      break;
    }
    const where: Prisma.CrawlPageWhereInput = {
      crawlId,
      ...(cursor === null ? {} : { id: { gt: cursor } }),
      ...(options.pageIds?.length ? { pageId: { in: options.pageIds } } : {}),
    };
    const rows = await prisma.crawlPage.findMany({
      where,
      orderBy: { id: 'asc' },
      take: Math.min(PAGE_BATCH, maxPages - pages.length),
      select: {
        id: true,
        url: true,
        normalizedUrl: true,
        statusCode: true,
        contentType: true,
        redirectTarget: true,
        redirectChain: true,
        depth: true,
        responseTimeMs: true,
        contentBytes: true,
        error: true,
        title: true,
        metaDescription: true,
        canonicalUrl: true,
        robotsMeta: true,
        xRobotsTag: true,
        metaViewport: true,
        lang: true,
        h1: true,
        headings: true,
        wordCount: true,
        contentHash: true,
        simhash: true,
        imageCount: true,
        imagesMissingAlt: true,
        schemaTypes: true,
        structuredData: true,
        hreflang: true,
        isIndexable: true,
        indexabilityReason: true,
        inSitemap: true,
        internalLinkCount: true,
        externalLinkCount: true,
      },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      normalizedById.set(row.id, row.normalizedUrl);
      if (row.inSitemap) sitemapUrls.push(row.url);
      pages.push({
        url: row.url,
        normalizedUrl: row.normalizedUrl,
        statusCode: row.statusCode,
        contentType: row.contentType,
        redirectTarget: row.redirectTarget,
        redirectChain: row.redirectChain,
        depth: row.depth,
        responseTimeMs: row.responseTimeMs,
        contentBytes: row.contentBytes,
        error: row.error,
        title: row.title,
        metaDescription: row.metaDescription,
        canonicalUrl: row.canonicalUrl,
        robotsMeta: row.robotsMeta,
        xRobotsTag: row.xRobotsTag,
        metaViewport: row.metaViewport,
        lang: row.lang,
        h1: row.h1,
        headings: readHeadings(row.headings),
        wordCount: row.wordCount,
        textContent: null,
        contentHash: row.contentHash,
        simhash: row.simhash,
        links: [],
        images: imagePlaceholders(row.imageCount, row.imagesMissingAlt),
        imagesMissingAlt: row.imagesMissingAlt,
        schemaTypes: row.schemaTypes,
        structuredData: readStructuredData(row.structuredData),
        hreflang: readHreflang(row.hreflang),
        isIndexable: row.isIndexable,
        indexabilityReason: row.indexabilityReason,
        inSitemap: row.inSitemap,
        internalLinksOut: row.internalLinkCount,
      });
      linksBySource.set(row.normalizedUrl, []);
    }

    if (rows.length < PAGE_BATCH) break;
  }

  // ── edges ────────────────────────────────────────────────
  const edges: AuditDataset['edges'] = [];
  let edgeCursor: string | null = null;

  for (;;) {
    if (edges.length >= MAX_AUDIT_EDGES) {
      truncated = true;
      break;
    }
    const where: Prisma.LinkEdgeWhereInput = {
      crawlId,
      ...(edgeCursor === null ? {} : { id: { gt: edgeCursor } }),
    };
    const rows = await prisma.linkEdge.findMany({
      where,
      orderBy: { id: 'asc' },
      take: EDGE_BATCH,
      select: {
        id: true,
        sourceCrawlPageId: true,
        targetUrl: true,
        normalizedTarget: true,
        anchorText: true,
        rel: true,
        isInternal: true,
        isNofollow: true,
        inNav: true,
        inFooter: true,
        inMainContent: true,
        position: true,
      },
    });
    if (rows.length === 0) break;
    edgeCursor = rows[rows.length - 1].id;

    for (const row of rows) {
      const from = normalizedById.get(row.sourceCrawlPageId);
      if (!from) continue;

      if (row.isInternal) {
        edges.push({
          from,
          to: row.normalizedTarget,
          anchorText: row.anchorText ?? '',
          isNofollow: row.isNofollow,
          inMainContent: row.inMainContent,
        });
      }

      const bucket = linksBySource.get(from);
      if (bucket && bucket.length < MAX_LINKS_PER_PAGE) {
        bucket.push({
          href: row.targetUrl,
          normalized: row.normalizedTarget,
          anchorText: row.anchorText ?? '',
          rel: row.rel,
          isInternal: row.isInternal,
          isNofollow: row.isNofollow,
          inNav: row.inNav,
          inFooter: row.inFooter,
          inMainContent: row.inMainContent,
          position: row.position,
        });
      }
    }

    if (rows.length < EDGE_BATCH) break;
  }

  const inbound = new Map<string, number>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }

  for (const page of pages) {
    page.links = linksBySource.get(page.normalizedUrl) ?? [];
    page.internalLinksIn = inbound.get(page.normalizedUrl) ?? 0;
  }

  const dataset: AuditDataset = {
    websiteId: website.id,
    domain: website.domain,
    protocol: website.protocol,
    pages,
    edges,
    robots: {
      found: crawl?.robotsTxtFound ?? false,
      body: crawl?.robotsTxtBody ?? null,
      sitemaps: crawl?.sitemapUrls ?? [],
      // Skipped URLs are not retained after a crawl, so the "robots blocks a linked URL" rule
      // has nothing to work from here rather than something invented.
      disallowedUrls: [],
    },
    sitemap: {
      found: (crawl?.sitemapUrlCount ?? 0) > 0 || (crawl?.sitemapUrls.length ?? 0) > 0,
      urls: sitemapUrls,
      errors: [],
    },
    settings: {
      thinContentWords: settings.thinContentWords,
      maxDepthWarn: SEO_THRESHOLDS.crawlDepth.warn,
    },
    skipped: [],
  };

  return { dataset, pagesLoaded: pages.length, edgesLoaded: edges.length, truncated };
}
