import 'server-only';
import { IntegrationProvider, IntegrationStatus, prisma } from '@seo/db';
import { ForbiddenError, NotFoundError, normalizeUrl } from '@seo/shared';
import { isBingConfigured, readBingConfig } from '@seo/integrations/bing/webmaster';

/**
 * Read model for the indexation screen: the reconciliation between what we crawled, what the
 * sitemap claims, and what Search Console has data for.
 *
 * A deliberate limit is baked into the copy this feeds: Google publishes no general-purpose
 * indexing API, so nothing here can force a URL into the index. The platform reconciles and
 * reports; submission is only offered where a search engine actually exposes it (Bing).
 */

export type DiscrepancyKind =
  | 'IN_SITEMAP_NOT_CRAWLED'
  | 'CRAWLED_NOT_IN_SITEMAP'
  | 'INDEXABLE_NO_SEARCH_DATA'
  | 'NOINDEX'
  | 'CANONICALISED_AWAY';

export interface DiscrepancyRow {
  id: string;
  kind: DiscrepancyKind;
  pageId: string;
  url: string;
  path: string;
  title: string | null;
  statusCode: number | null;
  isIndexable: boolean;
  indexabilityReason: string | null;
  canonicalUrl: string | null;
  inSitemap: boolean;
  lastCrawledAt: Date | null;
  impressions28d: number;
  clicks28d: number;
  /** Why this row is in this bucket, in one sentence. */
  detail: string;
}

export interface DiscrepancyGroup {
  kind: DiscrepancyKind;
  label: string;
  /** What the mismatch means and what to do about it. */
  description: string;
  count: number;
  /** Neutral kinds are informational; they are not defects. */
  tone: 'warning' | 'info';
}

export interface IndexationData {
  website: { id: string; name: string; domain: string; protocol: string };
  crawl: {
    id: string;
    status: string;
    finishedAt: Date | null;
    pagesCrawled: number;
    robotsTxtFound: boolean;
    /** Sitemap documents the crawler fetched (index files and children). */
    sitemapDocuments: string[];
    /** URL entries those documents listed. */
    sitemapUrlCount: number;
  } | null;
  totals: {
    pages: number;
    active: number;
    indexable: number;
    nonIndexable: number;
    inSitemap: number;
    crawledOk: number;
    withSearchData: number;
    /** Sitemap entries that never became a page row. Never negative. */
    sitemapEntriesNotSeen: number;
  };
  groups: DiscrepancyGroup[];
  rows: DiscrepancyRow[];
  /** True when the site has more pages than one render can classify. */
  truncated: boolean;
  scanned: number;
  search: {
    /** Search Console connected for this site. */
    gscConnected: boolean;
    gscStatus: IntegrationStatus | null;
    gscLastSyncAt: Date | null;
    /** Any Search Console / Bing rows stored at all. */
    hasSearchData: boolean;
  };
  bing: {
    /** Installation-wide key present. */
    configured: boolean;
    /** Verified Bing property URL for this site, once a sync has resolved one. */
    siteUrl: string | null;
    status: IntegrationStatus | null;
  };
}

/** Pages classified in one render. Beyond this the screen says the picture is partial. */
const MAX_SCAN = 10_000;
/** Rows returned per discrepancy kind. */
const ROWS_PER_KIND = 250;

const GROUP_META: Record<DiscrepancyKind, { label: string; description: string; tone: 'warning' | 'info' }> = {
  IN_SITEMAP_NOT_CRAWLED: {
    label: 'In the sitemap, not crawled successfully',
    description:
      'The sitemap offers these URLs but our crawler never got a usable response — the URL errored, redirected away or was never reached. A sitemap full of dead URLs wastes crawl budget and erodes trust in the file.',
    tone: 'warning',
  },
  CRAWLED_NOT_IN_SITEMAP: {
    label: 'Crawled and indexable, missing from the sitemap',
    description:
      'Indexable pages our crawler found by following links, but which no sitemap lists. Adding them makes discovery cheaper; leaving them out is only right if you did not want them indexed.',
    tone: 'warning',
  },
  INDEXABLE_NO_SEARCH_DATA: {
    label: 'Indexable, no Search Console impressions',
    description:
      'Indexable pages with zero impressions in the last 28 days. That is evidence of nothing being served for them — it is not proof of non-indexation, because a page can be indexed and simply never surface.',
    tone: 'info',
  },
  NOINDEX: {
    label: 'Excluded from indexing',
    description:
      'Pages we can see but that tell crawlers not to index them (meta robots, X-Robots-Tag, robots.txt or a non-200 status). Deliberate for most of these; check nothing valuable is in the list.',
    tone: 'info',
  },
  CANONICALISED_AWAY: {
    label: 'Canonicalised to another URL',
    description:
      'These pages point their canonical at a different URL, so they ask search engines to consolidate them elsewhere. Correct for duplicates and parameter variants; a mistake if the target is unrelated.',
    tone: 'info',
  },
};

interface ScannedPage {
  id: string;
  url: string;
  path: string;
  title: string | null;
  statusCode: number | null;
  isIndexable: boolean;
  indexabilityReason: string | null;
  canonicalUrl: string | null;
  normalizedUrl: string;
  inSitemap: boolean;
  isActive: boolean;
  lastCrawledAt: Date | null;
  impressions28d: number;
  clicks28d: number;
}

function crawledOk(page: ScannedPage): boolean {
  return page.lastCrawledAt !== null && page.statusCode !== null && page.statusCode < 400;
}

/** True when the canonical points somewhere other than this URL, compared after normalisation. */
function canonicalisedAway(page: ScannedPage): boolean {
  if (!page.canonicalUrl) return false;
  const canonical = normalizeUrl(page.canonicalUrl);
  if (!canonical) return false;
  return canonical !== page.normalizedUrl;
}

/** Everything the indexation screen renders, in one pass. */
export async function getIndexationData(userId: string, websiteId: string): Promise<IndexationData> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, userId: true, name: true, domain: true, protocol: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const [crawl, totalPages, pages, integrations, searchRow] = await Promise.all([
    prisma.crawl.findFirst({
      where: { websiteId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        finishedAt: true,
        pagesCrawled: true,
        robotsTxtFound: true,
        sitemapUrls: true,
        sitemapUrlCount: true,
      },
    }),
    prisma.page.count({ where: { websiteId } }),
    prisma.page.findMany({
      where: { websiteId },
      // Impression order puts the pages worth reconciling first when the scan has to stop early.
      orderBy: [{ impressions28d: 'desc' }, { createdAt: 'asc' }],
      take: MAX_SCAN,
      select: {
        id: true,
        url: true,
        path: true,
        title: true,
        statusCode: true,
        isIndexable: true,
        indexabilityReason: true,
        canonicalUrl: true,
        normalizedUrl: true,
        inSitemap: true,
        isActive: true,
        lastCrawledAt: true,
        impressions28d: true,
        clicks28d: true,
      },
    }),
    prisma.integration.findMany({
      where: {
        websiteId,
        provider: { in: [IntegrationProvider.GOOGLE_SEARCH_CONSOLE, IntegrationProvider.BING_WEBMASTER] },
      },
      select: { provider: true, status: true, config: true, lastSyncAt: true },
    }),
    prisma.searchConsoleDaily.findFirst({ where: { websiteId }, select: { id: true } }),
  ]);

  const gsc = integrations.find((row) => row.provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE) ?? null;
  const bing = integrations.find((row) => row.provider === IntegrationProvider.BING_WEBMASTER) ?? null;

  const rowsByKind = new Map<DiscrepancyKind, DiscrepancyRow[]>();
  const counts = new Map<DiscrepancyKind, number>();

  const push = (kind: DiscrepancyKind, page: ScannedPage, detail: string): void => {
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    const bucket = rowsByKind.get(kind) ?? [];
    if (bucket.length < ROWS_PER_KIND) {
      bucket.push({
        id: `${kind}:${page.id}`,
        kind,
        pageId: page.id,
        url: page.url,
        path: page.path,
        title: page.title,
        statusCode: page.statusCode,
        isIndexable: page.isIndexable,
        indexabilityReason: page.indexabilityReason,
        canonicalUrl: page.canonicalUrl,
        inSitemap: page.inSitemap,
        lastCrawledAt: page.lastCrawledAt,
        impressions28d: page.impressions28d,
        clicks28d: page.clicks28d,
        detail,
      });
      rowsByKind.set(kind, bucket);
    }
  };

  let active = 0;
  let indexable = 0;
  let nonIndexable = 0;
  let inSitemap = 0;
  let crawledOkCount = 0;
  let withSearchData = 0;

  for (const page of pages) {
    if (page.isActive) active += 1;
    if (page.isActive && page.isIndexable) indexable += 1;
    if (!page.isIndexable) nonIndexable += 1;
    if (page.inSitemap) inSitemap += 1;
    if (crawledOk(page)) crawledOkCount += 1;
    if (page.impressions28d > 0) withSearchData += 1;

    if (page.inSitemap && !crawledOk(page)) {
      push(
        'IN_SITEMAP_NOT_CRAWLED',
        page,
        page.lastCrawledAt === null
          ? 'Listed in the sitemap but never fetched successfully by a crawl.'
          : `Last crawl returned ${page.statusCode ?? 'no status'}.`,
      );
    }

    if (page.isActive && page.isIndexable && !page.inSitemap && crawledOk(page)) {
      push('CRAWLED_NOT_IN_SITEMAP', page, 'Found by crawling links; no sitemap lists it.');
    }

    if (page.isActive && page.isIndexable && page.impressions28d === 0 && crawledOk(page)) {
      push(
        'INDEXABLE_NO_SEARCH_DATA',
        page,
        'Indexable and reachable, but no impressions in the last 28 days of Search Console data.',
      );
    }

    if (!page.isIndexable) {
      push('NOINDEX', page, page.indexabilityReason ?? 'Marked non-indexable; no reason was recorded.');
    }

    if (canonicalisedAway(page)) {
      push('CANONICALISED_AWAY', page, `Canonical points to ${page.canonicalUrl ?? 'another URL'}.`);
    }
  }

  const groups: DiscrepancyGroup[] = (Object.keys(GROUP_META) as DiscrepancyKind[]).map((kind) => ({
    kind,
    label: GROUP_META[kind].label,
    description: GROUP_META[kind].description,
    tone: GROUP_META[kind].tone,
    count: counts.get(kind) ?? 0,
  }));

  const rows = (Object.keys(GROUP_META) as DiscrepancyKind[]).flatMap((kind) => rowsByKind.get(kind) ?? []);

  const bingConfig = readBingConfig(bing?.config ?? null);

  return {
    website: { id: website.id, name: website.name, domain: website.domain, protocol: website.protocol },
    crawl: crawl
      ? {
          id: crawl.id,
          status: crawl.status,
          finishedAt: crawl.finishedAt,
          pagesCrawled: crawl.pagesCrawled,
          robotsTxtFound: crawl.robotsTxtFound,
          sitemapDocuments: crawl.sitemapUrls,
          sitemapUrlCount: crawl.sitemapUrlCount,
        }
      : null,
    totals: {
      pages: totalPages,
      active,
      indexable,
      nonIndexable,
      inSitemap,
      crawledOk: crawledOkCount,
      withSearchData,
      sitemapEntriesNotSeen: Math.max(0, (crawl?.sitemapUrlCount ?? 0) - inSitemap),
    },
    groups,
    rows,
    truncated: totalPages > pages.length,
    scanned: pages.length,
    search: {
      gscConnected: gsc?.status === IntegrationStatus.CONNECTED,
      gscStatus: gsc?.status ?? null,
      gscLastSyncAt: gsc?.lastSyncAt ?? null,
      hasSearchData: searchRow !== null,
    },
    bing: {
      configured: isBingConfigured(),
      siteUrl: bingConfig.siteUrl ?? null,
      status: bing?.status ?? null,
    },
  };
}
