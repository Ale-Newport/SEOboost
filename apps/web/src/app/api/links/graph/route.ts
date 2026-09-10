import { z } from 'zod';
import { buildLinkGraph, type GraphEdge, type GraphNode } from '@seo/seo-engine';
import { normalizeUrl } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import { booleanParam, requireScopedWebsite, skipped, websiteScopeSchema } from '@/app/api/_lib/common';
import { loadLinkGraphData } from '@/app/api/_lib/links';

/**
 * `GET /api/links/graph?websiteId=` — nodes and edges for the site graph.
 *
 * A force-directed graph stops being readable — and stops being renderable — long before a
 * real site runs out of pages, so the response is decimated: the graph is computed over
 * *everything* (PageRank needs the whole structure to be correct) and only then trimmed to the
 * highest-authority nodes and the edges between them. `stats` is always the full-graph figure,
 * so the counts the UI reports are the site's, not the sample's.
 */

const querySchema = websiteScopeSchema.extend({
  maxNodes: z.coerce.number().int().min(10).max(2000).default(300),
  maxEdges: z.coerce.number().int().min(10).max(8000).default(2000),
  /** Drop non-indexable pages from the rendered graph. */
  indexableOnly: booleanParam(false),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireScopedWebsite(user, query.websiteId);

  const data = await loadLinkGraphData(website.id);
  if (data.pages.length === 0) {
    return {
      ...skipped(
        'This website has no crawled pages, so there is no link graph to draw.',
        'Run a crawl first; the graph is built from the pages and links it records.',
      ),
      nodes: [],
      edges: [],
      stats: null,
    };
  }

  const homepageNormalized = normalizeUrl(`${website.protocol}://${website.domain}`);

  const graph = buildLinkGraph(
    data.pages.map((page) => ({
      id: page.id,
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      title: page.title,
      depth: page.depth,
      isIndexable: page.isIndexable,
      wordCount: page.wordCount,
    })),
    data.edges,
    // The homepage seeds the PageRank pass; when the URL cannot be normalised the pass falls
    // back to a uniform seed rather than being skipped.
    homepageNormalized ? { homepageNormalized } : {},
  );

  const eligible = query.indexableOnly
    ? graph.nodes.filter((node) => node.isIndexable)
    : graph.nodes;

  // Authority-ranked truncation: the pages that carry the site's structure survive, the long
  // tail of near-zero-authority leaves is what gets dropped.
  const nodes: GraphNode[] = [...eligible]
    .sort((a, b) => b.authority - a.authority || b.inboundLinks - a.inboundLinks)
    .slice(0, query.maxNodes);

  const kept = new Set(nodes.map((node) => node.id));
  const authorityOf = new Map(nodes.map((node) => [node.id, node.authority]));

  const withinGraph = graph.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));
  const edges: GraphEdge[] =
    withinGraph.length <= query.maxEdges
      ? withinGraph
      : [...withinGraph]
          .sort((a, b) => edgeWeight(b, authorityOf) - edgeWeight(a, authorityOf))
          .slice(0, query.maxEdges);

  return {
    websiteId: website.id,
    nodes,
    edges,
    stats: graph.stats,
    rendered: {
      nodes: nodes.length,
      edges: edges.length,
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length,
      decimated: nodes.length < graph.nodes.length || edges.length < withinGraph.length,
    },
    source: { crawlId: data.crawlId, crawledAt: data.crawledAt, truncated: data.truncated },
  };
});

/**
 * Ranking used when there are still too many edges to draw.
 * Editorial in-content links describe the site's real topology; nav and footer links are the
 * same everywhere and tell the reader nothing, so they are dropped first.
 */
function edgeWeight(edge: GraphEdge, authority: Map<string, number>): number {
  const endpoints = (authority.get(edge.source) ?? 0) + (authority.get(edge.target) ?? 0);
  const editorial = edge.inMainContent ? 1 : 0;
  const followed = edge.isNofollow ? 0 : 0.5;
  return endpoints + editorial + followed;
}
