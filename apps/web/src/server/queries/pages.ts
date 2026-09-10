import 'server-only';
import { type Page, type PageType, Prisma, prisma } from '@seo/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type Paginated, lastNDays, round } from '@seo/shared';
import { GSC_LAG_DAYS } from './analytics';

/**
 * Page read models for `/api/websites/[id]/pages` and the Pages screen.
 *
 * The list is deliberately built from the denormalised `Page` columns the analysis pipeline
 * maintains (clicks28d, seoScore, internalLinksIn…) rather than by joining GSC rows per request:
 * a 50k-page site has to paginate in tens of milliseconds, and those columns are what the
 * indexes are for.
 */

/** Sortable columns, whitelisted so a query string cannot reach an unindexed or private column. */
const PAGE_SORT_COLUMNS = {
  url: 'url',
  path: 'path',
  title: 'title',
  pageType: 'pageType',
  statusCode: 'statusCode',
  depth: 'depth',
  wordCount: 'wordCount',
  clicks28d: 'clicks28d',
  impressions28d: 'impressions28d',
  ctr28d: 'ctr28d',
  position28d: 'position28d',
  clicksTrendPct: 'clicksTrendPct',
  seoScore: 'seoScore',
  geoScore: 'geoScore',
  contentScore: 'contentScore',
  opportunityScore: 'opportunityScore',
  internalLinksIn: 'internalLinksIn',
  internalLinksOut: 'internalLinksOut',
  lastCrawledAt: 'lastCrawledAt',
  firstSeenAt: 'firstSeenAt',
  updatedAt: 'updatedAt',
} as const satisfies Record<string, keyof Prisma.PageOrderByWithRelationInput>;

export type PageSortKey = keyof typeof PAGE_SORT_COLUMNS;

export function isPageSortKey(value: string): value is PageSortKey {
  return Object.hasOwn(PAGE_SORT_COLUMNS, value);
}

export interface PageListFilters {
  websiteId: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  /** Matches url, path, title or H1. */
  search?: string;
  pageType?: PageType[];
  indexable?: boolean;
  orphan?: boolean;
  inSitemap?: boolean;
  minWordCount?: number;
  maxWordCount?: number;
  hasIssues?: boolean;
  statusCode?: number[];
  /** Include pages the last crawl no longer found. Off by default. */
  includeInactive?: boolean;
}

export interface PageListItem {
  id: string;
  url: string;
  path: string;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  pageType: PageType;
  statusCode: number | null;
  depth: number;
  wordCount: number;
  isIndexable: boolean;
  indexabilityReason: string | null;
  inSitemap: boolean;
  isOrphan: boolean;
  internalLinksIn: number;
  internalLinksOut: number;
  clicks28d: number;
  impressions28d: number;
  ctr28d: number | null;
  position28d: number | null;
  clicksTrendPct: number | null;
  seoScore: number | null;
  geoScore: number | null;
  contentScore: number | null;
  opportunityScore: number | null;
  openIssues: number;
  criticalIssues: number;
  lastCrawledAt: Date | null;
  isActive: boolean;
}

function buildPageWhere(filters: PageListFilters): Prisma.PageWhereInput {
  const where: Prisma.PageWhereInput = { websiteId: filters.websiteId };

  if (!filters.includeInactive) where.isActive = true;
  if (filters.indexable !== undefined) where.isIndexable = filters.indexable;
  if (filters.orphan !== undefined) where.isOrphan = filters.orphan;
  if (filters.inSitemap !== undefined) where.inSitemap = filters.inSitemap;
  if (filters.pageType && filters.pageType.length > 0) where.pageType = { in: filters.pageType };
  if (filters.statusCode && filters.statusCode.length > 0) where.statusCode = { in: filters.statusCode };

  if (filters.minWordCount !== undefined || filters.maxWordCount !== undefined) {
    where.wordCount = {
      ...(filters.minWordCount !== undefined ? { gte: filters.minWordCount } : {}),
      ...(filters.maxWordCount !== undefined ? { lte: filters.maxWordCount } : {}),
    };
  }

  // "Has issues" means *open* issues; a page whose problems were all resolved is clean.
  if (filters.hasIssues === true) where.issues = { some: { status: { in: ['OPEN', 'REGRESSED'] } } };
  if (filters.hasIssues === false) where.issues = { none: { status: { in: ['OPEN', 'REGRESSED'] } } };

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { url: { contains: search, mode: 'insensitive' } },
      { path: { contains: search, mode: 'insensitive' } },
      { title: { contains: search, mode: 'insensitive' } },
      { h1: { contains: search, mode: 'insensitive' } },
    ];
  }

  return where;
}

function buildPageOrderBy(
  sort: string | undefined,
  order: 'asc' | 'desc',
): Prisma.PageOrderByWithRelationInput[] {
  const column = sort && isPageSortKey(sort) ? PAGE_SORT_COLUMNS[sort] : null;
  if (!column) {
    // Default: the pages with the most to gain first, then the busiest.
    return [{ opportunityScore: { sort: 'desc', nulls: 'last' } }, { clicks28d: 'desc' }, { url: 'asc' }];
  }
  // Nulls last in both directions: an unscored page is "unknown", not "worst".
  return [{ [column]: { sort: order, nulls: 'last' } }, { url: 'asc' }];
}

/**
 * Open/critical issue counts per page, in one grouped query rather than a per-row join.
 * Scoped by `websiteId` as well as the page ids so the query lands on `TechnicalIssue`'s
 * website-leading indexes instead of scanning by a bare `pageId IN (…)`.
 */
async function issueCountsByPage(
  websiteId: string,
  pageIds: string[],
): Promise<Map<string, { open: number; critical: number }>> {
  const counts = new Map<string, { open: number; critical: number }>();
  if (pageIds.length === 0) return counts;

  const rows = await prisma.technicalIssue.groupBy({
    by: ['pageId', 'severity'],
    where: { websiteId, pageId: { in: pageIds }, status: { in: ['OPEN', 'REGRESSED'] } },
    _count: { _all: true },
  });

  for (const row of rows) {
    if (!row.pageId) continue;
    const entry = counts.get(row.pageId) ?? { open: 0, critical: 0 };
    entry.open += row._count._all;
    if (row.severity === 'CRITICAL') entry.critical += row._count._all;
    counts.set(row.pageId, entry);
  }
  return counts;
}

const PAGE_LIST_SELECT = {
  id: true,
  url: true,
  path: true,
  title: true,
  metaDescription: true,
  h1: true,
  pageType: true,
  statusCode: true,
  depth: true,
  wordCount: true,
  isIndexable: true,
  indexabilityReason: true,
  inSitemap: true,
  isOrphan: true,
  internalLinksIn: true,
  internalLinksOut: true,
  clicks28d: true,
  impressions28d: true,
  ctr28d: true,
  position28d: true,
  clicksTrendPct: true,
  seoScore: true,
  geoScore: true,
  contentScore: true,
  opportunityScore: true,
  lastCrawledAt: true,
  isActive: true,
} satisfies Prisma.PageSelect;

export async function listPages(filters: PageListFilters): Promise<Paginated<PageListItem>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const where = buildPageWhere(filters);

  const [rows, total] = await Promise.all([
    prisma.page.findMany({
      where,
      select: PAGE_LIST_SELECT,
      orderBy: buildPageOrderBy(filters.sort, filters.order ?? 'desc'),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.page.count({ where }),
  ]);

  const issueCounts = await issueCountsByPage(filters.websiteId, rows.map((row) => row.id));

  return {
    items: rows.map((row) => ({
      ...row,
      openIssues: issueCounts.get(row.id)?.open ?? 0,
      criticalIssues: issueCounts.get(row.id)?.critical ?? 0,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Every page matching the filters, for a CSV export.
 *
 * Capped rather than unbounded: an export is a download, not a denial-of-service, and the cap
 * is reported back so the UI can say the file was truncated instead of quietly lying.
 */
export async function listPagesForExport(
  filters: PageListFilters,
  limit = 10_000,
): Promise<{ rows: PageListItem[]; truncated: boolean; total: number }> {
  const where = buildPageWhere(filters);
  const total = await prisma.page.count({ where });
  const rows = await prisma.page.findMany({
    where,
    select: PAGE_LIST_SELECT,
    orderBy: buildPageOrderBy(filters.sort, filters.order ?? 'desc'),
    take: limit,
  });
  const issueCounts = await issueCountsByPage(filters.websiteId, rows.map((row) => row.id));

  return {
    rows: rows.map((row) => ({
      ...row,
      openIssues: issueCounts.get(row.id)?.open ?? 0,
      criticalIssues: issueCounts.get(row.id)?.critical ?? 0,
    })),
    truncated: total > rows.length,
    total,
  };
}

/** Filter facets for the Pages toolbar — real counts, so an empty filter value is never offered. */
export async function getPageFacets(websiteId: string): Promise<{
  pageType: Array<{ value: PageType; count: number }>;
  statusCode: Array<{ value: number; count: number }>;
  indexable: { yes: number; no: number };
  orphan: number;
  total: number;
}> {
  const base = { websiteId, isActive: true };
  const [byType, byStatus, indexable, orphan, total] = await Promise.all([
    prisma.page.groupBy({ by: ['pageType'], where: base, _count: { _all: true } }),
    prisma.page.groupBy({ by: ['statusCode'], where: base, _count: { _all: true } }),
    prisma.page.count({ where: { ...base, isIndexable: true } }),
    prisma.page.count({ where: { ...base, isOrphan: true } }),
    prisma.page.count({ where: base }),
  ]);

  return {
    pageType: byType
      .map((row) => ({ value: row.pageType, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    statusCode: byStatus
      .filter((row): row is typeof row & { statusCode: number } => row.statusCode !== null)
      .map((row) => ({ value: row.statusCode, count: row._count._all }))
      .sort((a, b) => a.value - b.value),
    indexable: { yes: indexable, no: total - indexable },
    orphan,
    total,
  };
}

export interface PageLinkRow {
  url: string;
  anchorText: string | null;
  isNofollow: boolean;
  inNav: boolean;
  inFooter: boolean;
  inMainContent: boolean;
}

export interface PageQueryRow {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface PageProfile {
  page: Page;
  /** Null until the site has been crawled at least once — link data has no other source. */
  crawlId: string | null;
  inboundLinks: PageLinkRow[];
  inboundLinkTotal: number;
  outboundLinks: PageLinkRow[];
  outboundLinkTotal: number;
  keywords: Array<{
    id: string;
    keyword: string;
    currentPosition: number | null;
    positionChange: number | null;
    impressions28d: number;
    clicks28d: number;
    searchVolume: number | null;
    opportunityScore: number | null;
    intent: string;
  }>;
  issues: Array<{
    id: string;
    ruleId: string;
    title: string;
    category: string;
    severity: string;
    status: string;
    description: string;
    recommendation: string;
    autoFixable: boolean;
    lastSeenAt: Date;
  }>;
  topQueries: PageQueryRow[];
  snapshots: Array<{
    id: string;
    capturedAt: Date;
    reason: string;
    wordCount: number;
    title: string | null;
    seoScore: number | null;
    geoScore: number | null;
    clicks28d: number | null;
    impressions28d: number | null;
    position28d: number | null;
  }>;
  recommendations: {
    opportunities: Array<{
      id: string;
      type: string;
      status: string;
      title: string;
      reasoning: string;
      priorityScore: number;
      estimatedTrafficGain: number | null;
    }>;
    linkSuggestionsIn: Array<{ id: string; sourceUrl: string; anchorText: string; reason: string; relevanceScore: number; status: string }>;
    linkSuggestionsOut: Array<{ id: string; targetUrl: string; anchorText: string; reason: string; relevanceScore: number; status: string }>;
    structuredData: Array<{ id: string; schemaType: string; validationStatus: string; deploymentStatus: string }>;
  };
}

/**
 * Top search queries for one page over a recent window.
 *
 * Raw SQL because the position has to be impression-weighted and Prisma's `groupBy` can only
 * offer `_avg`, which averages daily averages — a day with three impressions would then count
 * as much as a day with thirty thousand. The window matters just as much: aggregating a page's
 * entire GSC history would mix queries it stopped ranking for a year ago into "top queries",
 * and grows without bound as the site ages.
 */
async function topQueriesForPage(
  websiteId: string,
  pageId: string,
  limit: number,
  days: number,
): Promise<PageQueryRow[]> {
  const range = lastNDays(days, GSC_LAG_DAYS);
  const rows = await prisma.$queryRaw<
    Array<{ query: string; clicks: bigint; impressions: bigint; weighted: number }>
  >(Prisma.sql`
    SELECT
      "query",
      SUM("clicks")::bigint      AS clicks,
      SUM("impressions")::bigint AS impressions,
      COALESCE(SUM("position" * "impressions") / NULLIF(SUM("impressions"), 0), 0) AS weighted
    FROM "GscQueryMetric"
    WHERE "websiteId" = ${websiteId}
      AND "pageId" = ${pageId}
      AND "source" = 'gsc'
      AND "date" >= ${range.start}
      AND "date" <= ${range.end}
    GROUP BY "query"
    ORDER BY SUM("impressions") DESC
    LIMIT ${limit}
  `);

  return rows.map((row) => {
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    return {
      query: row.query,
      clicks,
      impressions,
      ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
      position: round(Number(row.weighted) || 0, 1),
    };
  });
}

/**
 * The full page profile.
 *
 * Link edges live on the immutable crawl snapshot, so inbound/outbound links are read from the
 * most recent completed crawl. Before any crawl completes those lists are empty and `crawlId`
 * is null — the screen says "crawl this site first" instead of showing an empty graph as fact.
 */
export async function getPageProfile(
  websiteId: string,
  pageId: string,
  options: {
    linkLimit?: number;
    queryLimit?: number;
    snapshotLimit?: number;
    /** Window for `topQueries`, in days. Matches the 28-day columns on `Page` by default. */
    queryDays?: number;
  } = {},
): Promise<PageProfile | null> {
  const linkLimit = options.linkLimit ?? 100;
  const queryLimit = options.queryLimit ?? 25;
  const snapshotLimit = options.snapshotLimit ?? 20;

  const page = await prisma.page.findFirst({ where: { id: pageId, websiteId } });
  if (!page) return null;

  const latestCrawl = await prisma.crawl.findFirst({
    where: { websiteId, status: 'COMPLETED' },
    orderBy: { finishedAt: 'desc' },
    select: { id: true },
  });
  const crawlId = latestCrawl?.id ?? null;

  const crawlPage = crawlId
    ? await prisma.crawlPage.findUnique({
        where: { crawlId_normalizedUrl: { crawlId, normalizedUrl: page.normalizedUrl } },
        select: { id: true },
      })
    : null;

  const [
    inboundLinks,
    inboundLinkTotal,
    outboundLinks,
    outboundLinkTotal,
    keywords,
    issues,
    topQueries,
    snapshots,
    opportunities,
    linkSuggestionsIn,
    linkSuggestionsOut,
    structuredData,
  ] = await Promise.all([
    crawlId
      ? prisma.linkEdge.findMany({
          where: { crawlId, normalizedTarget: page.normalizedUrl, isInternal: true },
          select: {
            sourceUrl: true,
            anchorText: true,
            isNofollow: true,
            inNav: true,
            inFooter: true,
            inMainContent: true,
          },
          orderBy: [{ inMainContent: 'desc' }, { position: 'asc' }],
          take: linkLimit,
        })
      : Promise.resolve([]),
    crawlId
      ? prisma.linkEdge.count({
          where: { crawlId, normalizedTarget: page.normalizedUrl, isInternal: true },
        })
      : Promise.resolve(0),
    crawlPage
      ? prisma.linkEdge.findMany({
          where: { sourceCrawlPageId: crawlPage.id },
          select: {
            targetUrl: true,
            anchorText: true,
            isNofollow: true,
            inNav: true,
            inFooter: true,
            inMainContent: true,
            isInternal: true,
          },
          orderBy: [{ inMainContent: 'desc' }, { position: 'asc' }],
          take: linkLimit,
        })
      : Promise.resolve([]),
    crawlPage
      ? prisma.linkEdge.count({ where: { sourceCrawlPageId: crawlPage.id } })
      : Promise.resolve(0),
    prisma.keyword.findMany({
      where: { websiteId, pageId },
      select: {
        id: true,
        keyword: true,
        currentPosition: true,
        positionChange: true,
        impressions28d: true,
        clicks28d: true,
        searchVolume: true,
        opportunityScore: true,
        intent: true,
      },
      orderBy: [{ impressions28d: 'desc' }],
      take: 100,
    }),
    prisma.technicalIssue.findMany({
      where: { websiteId, pageId },
      select: {
        id: true,
        ruleId: true,
        title: true,
        category: true,
        severity: true,
        status: true,
        description: true,
        recommendation: true,
        autoFixable: true,
        lastSeenAt: true,
      },
      orderBy: [{ status: 'asc' }, { severity: 'asc' }],
      take: 200,
    }),
    topQueriesForPage(websiteId, pageId, queryLimit, options.queryDays ?? 28),
    prisma.pageSnapshot.findMany({
      where: { pageId },
      select: {
        id: true,
        capturedAt: true,
        reason: true,
        wordCount: true,
        title: true,
        seoScore: true,
        geoScore: true,
        clicks28d: true,
        impressions28d: true,
        position28d: true,
      },
      orderBy: { capturedAt: 'desc' },
      take: snapshotLimit,
    }),
    prisma.contentOpportunity.findMany({
      where: { websiteId, pageId },
      select: {
        id: true,
        type: true,
        status: true,
        title: true,
        reasoning: true,
        priorityScore: true,
        estimatedTrafficGain: true,
      },
      orderBy: { priorityScore: 'desc' },
      take: 20,
    }),
    prisma.internalLinkSuggestion.findMany({
      where: { websiteId, targetPageId: pageId },
      select: {
        id: true,
        anchorText: true,
        reason: true,
        relevanceScore: true,
        status: true,
        sourcePage: { select: { url: true } },
      },
      orderBy: { relevanceScore: 'desc' },
      take: 25,
    }),
    prisma.internalLinkSuggestion.findMany({
      where: { websiteId, sourcePageId: pageId },
      select: {
        id: true,
        anchorText: true,
        reason: true,
        relevanceScore: true,
        status: true,
        targetPage: { select: { url: true } },
      },
      orderBy: { relevanceScore: 'desc' },
      take: 25,
    }),
    prisma.structuredDataItem.findMany({
      where: { websiteId, pageId },
      select: { id: true, schemaType: true, validationStatus: true, deploymentStatus: true },
      orderBy: { schemaType: 'asc' },
      take: 50,
    }),
  ]);

  return {
    page,
    crawlId,
    inboundLinks: inboundLinks.map((edge) => ({
      url: edge.sourceUrl,
      anchorText: edge.anchorText,
      isNofollow: edge.isNofollow,
      inNav: edge.inNav,
      inFooter: edge.inFooter,
      inMainContent: edge.inMainContent,
    })),
    inboundLinkTotal,
    outboundLinks: outboundLinks.map((edge) => ({
      url: edge.targetUrl,
      anchorText: edge.anchorText,
      isNofollow: edge.isNofollow,
      inNav: edge.inNav,
      inFooter: edge.inFooter,
      inMainContent: edge.inMainContent,
    })),
    outboundLinkTotal,
    keywords,
    issues,
    topQueries,
    snapshots,
    recommendations: {
      opportunities,
      linkSuggestionsIn: linkSuggestionsIn.map((row) => ({
        id: row.id,
        sourceUrl: row.sourcePage.url,
        anchorText: row.anchorText,
        reason: row.reason,
        relevanceScore: row.relevanceScore,
        status: row.status,
      })),
      linkSuggestionsOut: linkSuggestionsOut.map((row) => ({
        id: row.id,
        targetUrl: row.targetPage.url,
        anchorText: row.anchorText,
        reason: row.reason,
        relevanceScore: row.relevanceScore,
        status: row.status,
      })),
      structuredData,
    },
  };
}
