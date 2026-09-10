import 'server-only';
import { CrawlStatus, prisma } from '@seo/db';

/**
 * Loading the internal link graph out of the database.
 *
 * The durable `Page` rows are the nodes; the edges live on `LinkEdge`, which is per-crawl and
 * immutable. So "the site's current link graph" means "the edges from the most recent completed
 * crawl, joined back to the pages that still exist" — an edge to a page that has since been
 * removed is dropped rather than shown as a dangling node.
 *
 * Both callers (the links overview and the graph endpoint) share this so the anchor audit and
 * the rendered graph can never be computed from different crawls.
 */

export const MAX_GRAPH_PAGES = 5_000;
export const MAX_GRAPH_EDGES = 40_000;

export interface LinkGraphPage {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string | null;
  h1: string | null;
  metaDescription: string | null;
  depth: number;
  wordCount: number;
  isIndexable: boolean;
  isOrphan: boolean;
  pageType: string;
  internalLinksIn: number;
  internalLinksOut: number;
  clicks28d: number;
  targetKeywords: string[];
}

export interface LinkGraphEdge {
  sourceNormalized: string;
  targetNormalized: string;
  anchorText: string;
  isNofollow: boolean;
  inMainContent: boolean;
}

export interface LinkGraphData {
  crawlId: string | null;
  crawledAt: Date | null;
  pages: LinkGraphPage[];
  edges: LinkGraphEdge[];
  /** True when a cap truncated the data, so the UI can say the view is partial. */
  truncated: { pages: boolean; edges: boolean };
}

export async function loadLinkGraphData(
  websiteId: string,
  opts: { maxPages?: number; maxEdges?: number } = {},
): Promise<LinkGraphData> {
  const maxPages = Math.min(opts.maxPages ?? MAX_GRAPH_PAGES, MAX_GRAPH_PAGES);
  const maxEdges = Math.min(opts.maxEdges ?? MAX_GRAPH_EDGES, MAX_GRAPH_EDGES);

  const [crawl, pageRows] = await Promise.all([
    prisma.crawl.findFirst({
      where: { websiteId, status: CrawlStatus.COMPLETED },
      orderBy: { finishedAt: 'desc' },
      select: { id: true, finishedAt: true },
    }),
    prisma.page.findMany({
      where: { websiteId, isActive: true },
      // Most-linked pages first, so a truncated graph keeps the structurally important nodes.
      orderBy: [{ internalLinksIn: 'desc' }, { depth: 'asc' }],
      take: maxPages,
      select: {
        id: true,
        url: true,
        normalizedUrl: true,
        title: true,
        h1: true,
        metaDescription: true,
        depth: true,
        wordCount: true,
        isIndexable: true,
        isOrphan: true,
        pageType: true,
        internalLinksIn: true,
        internalLinksOut: true,
        clicks28d: true,
        keywords: {
          select: { keyword: true },
          orderBy: [{ opportunityScore: 'desc' }, { impressions28d: 'desc' }],
          take: 5,
        },
      },
    }),
  ]);

  const totalPages = await prisma.page.count({ where: { websiteId, isActive: true } });

  const pages: LinkGraphPage[] = pageRows.map((row) => ({
    id: row.id,
    url: row.url,
    normalizedUrl: row.normalizedUrl,
    title: row.title,
    h1: row.h1,
    metaDescription: row.metaDescription,
    depth: row.depth,
    wordCount: row.wordCount,
    isIndexable: row.isIndexable,
    isOrphan: row.isOrphan,
    pageType: row.pageType,
    internalLinksIn: row.internalLinksIn,
    internalLinksOut: row.internalLinksOut,
    clicks28d: row.clicks28d,
    targetKeywords: row.keywords.map((keyword) => keyword.keyword),
  }));

  if (!crawl) {
    return {
      crawlId: null,
      crawledAt: null,
      pages,
      edges: [],
      truncated: { pages: totalPages > pages.length, edges: false },
    };
  }

  const edgeRows = await prisma.linkEdge.findMany({
    where: { crawlId: crawl.id, isInternal: true },
    take: maxEdges,
    select: {
      normalizedTarget: true,
      anchorText: true,
      isNofollow: true,
      inMainContent: true,
      sourceCrawlPage: { select: { normalizedUrl: true } },
    },
  });

  const edges: LinkGraphEdge[] = edgeRows.map((row) => ({
    sourceNormalized: row.sourceCrawlPage.normalizedUrl,
    targetNormalized: row.normalizedTarget,
    anchorText: row.anchorText ?? '',
    isNofollow: row.isNofollow,
    inMainContent: row.inMainContent,
  }));

  return {
    crawlId: crawl.id,
    crawledAt: crawl.finishedAt,
    pages,
    edges,
    truncated: { pages: totalPages > pages.length, edges: edgeRows.length === maxEdges },
  };
}
