import { clamp, round } from '@seo/shared';

export interface GraphNode {
  id: string;
  url: string;
  title: string | null;
  depth: number;
  cluster: string | null;
  inboundLinks: number;
  outboundLinks: number;
  isOrphan: boolean;
  isIndexable: boolean;
  wordCount: number;
  /** Normalised 0-1 internal authority from the PageRank pass. */
  authority: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  anchorText: string;
  isNofollow: boolean;
  inMainContent: boolean;
}

export interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    pageCount: number;
    edgeCount: number;
    orphanCount: number;
    avgOutboundLinks: number;
    avgInboundLinks: number;
    maxDepth: number;
    components: number;
    hubs: Array<{ id: string; url: string; outboundLinks: number }>;
    authorities: Array<{ id: string; url: string; inboundLinks: number; authority: number }>;
  };
}

export interface GraphInputPage {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string | null;
  depth: number;
  cluster?: string | null;
  isIndexable: boolean;
  wordCount: number;
}

export interface GraphInputEdge {
  sourceNormalized: string;
  targetNormalized: string;
  anchorText: string;
  isNofollow: boolean;
  inMainContent: boolean;
}

/**
 * Build the internal link graph with a PageRank pass so the UI can size nodes by real internal
 * authority rather than a raw inbound count (which any sitewide footer link would dominate).
 */
export function buildLinkGraph(
  pages: GraphInputPage[],
  edges: GraphInputEdge[],
  opts: { homepageNormalized?: string; damping?: number; iterations?: number } = {},
): LinkGraph {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 25;

  const byNormalized = new Map<string, GraphInputPage>();
  for (const page of pages) byNormalized.set(page.normalizedUrl, page);

  const outgoing = new Map<string, Set<string>>();
  const inboundCount = new Map<string, number>();
  const outboundCount = new Map<string, number>();
  const graphEdges: GraphEdge[] = [];

  for (const edge of edges) {
    const source = byNormalized.get(edge.sourceNormalized);
    const target = byNormalized.get(edge.targetNormalized);
    if (!source || !target || source.id === target.id) continue;

    graphEdges.push({
      source: source.id,
      target: target.id,
      anchorText: edge.anchorText,
      isNofollow: edge.isNofollow,
      inMainContent: edge.inMainContent,
    });

    // Nofollow links appear in the graph for display but do not pass authority.
    if (!edge.isNofollow) {
      let set = outgoing.get(source.id);
      if (!set) { set = new Set(); outgoing.set(source.id, set); }
      set.add(target.id);
    }
    inboundCount.set(target.id, (inboundCount.get(target.id) ?? 0) + 1);
    outboundCount.set(source.id, (outboundCount.get(source.id) ?? 0) + 1);
  }

  // PageRank
  const ids = pages.map((p) => p.id);
  const n = Math.max(1, ids.length);
  let rank = new Map<string, number>(ids.map((id) => [id, 1 / n]));
  const incoming = new Map<string, string[]>();
  for (const [source, targets] of outgoing) {
    for (const target of targets) {
      const list = incoming.get(target) ?? [];
      list.push(source);
      incoming.set(target, list);
    }
  }
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    // Dangling nodes (no outgoing links) redistribute their rank evenly.
    let danglingMass = 0;
    for (const id of ids) {
      const outs = outgoing.get(id);
      if (!outs || outs.size === 0) danglingMass += rank.get(id) ?? 0;
    }
    for (const id of ids) {
      let inboundRank = 0;
      for (const source of incoming.get(id) ?? []) {
        const outDegree = outgoing.get(source)?.size ?? 0;
        if (outDegree > 0) inboundRank += (rank.get(source) ?? 0) / outDegree;
      }
      next.set(id, (1 - damping) / n + damping * (inboundRank + danglingMass / n));
    }
    rank = next;
  }
  const maxRank = Math.max(...rank.values(), 1e-9);

  const nodes: GraphNode[] = pages.map((page) => ({
    id: page.id,
    url: page.url,
    title: page.title,
    depth: page.depth,
    cluster: page.cluster ?? null,
    inboundLinks: inboundCount.get(page.id) ?? 0,
    outboundLinks: outboundCount.get(page.id) ?? 0,
    isOrphan:
      (inboundCount.get(page.id) ?? 0) === 0 &&
      page.normalizedUrl !== opts.homepageNormalized,
    isIndexable: page.isIndexable,
    wordCount: page.wordCount,
    authority: round(clamp((rank.get(page.id) ?? 0) / maxRank), 4),
  }));

  // Connected components (undirected) to spot isolated islands.
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) adjacency.set(node.id, new Set());
  for (const edge of graphEdges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const seen = new Set<string>();
  let components = 0;
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    components++;
    const stack = [node.id];
    seen.add(node.id);
    while (stack.length) {
      const current = stack.pop()!;
      for (const neighbour of adjacency.get(current) ?? []) {
        if (!seen.has(neighbour)) { seen.add(neighbour); stack.push(neighbour); }
      }
    }
  }

  const totalOutbound = nodes.reduce((s, node) => s + node.outboundLinks, 0);
  const totalInbound = nodes.reduce((s, node) => s + node.inboundLinks, 0);

  return {
    nodes,
    edges: graphEdges,
    stats: {
      pageCount: nodes.length,
      edgeCount: graphEdges.length,
      orphanCount: nodes.filter((node) => node.isOrphan && node.isIndexable).length,
      avgOutboundLinks: nodes.length ? round(totalOutbound / nodes.length, 1) : 0,
      avgInboundLinks: nodes.length ? round(totalInbound / nodes.length, 1) : 0,
      maxDepth: nodes.reduce((m, node) => Math.max(m, node.depth), 0),
      components,
      hubs: [...nodes]
        .sort((a, b) => b.outboundLinks - a.outboundLinks)
        .slice(0, 10)
        .map((node) => ({ id: node.id, url: node.url, outboundLinks: node.outboundLinks })),
      authorities: [...nodes]
        .sort((a, b) => b.authority - a.authority)
        .slice(0, 10)
        .map((node) => ({ id: node.id, url: node.url, inboundLinks: node.inboundLinks, authority: node.authority })),
    },
  };
}
