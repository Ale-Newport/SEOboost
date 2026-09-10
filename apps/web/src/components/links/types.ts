/**
 * Wire shapes for the internal-link endpoints.
 *
 * These screens read `GET /api/links` and `GET /api/links/graph` from the browser rather than
 * through a server query module, so the response has already been through `JSON.stringify`:
 * every `Date` on the server is an ISO string here. Typing them as strings is the point — it
 * stops a component calling `.toLocaleDateString()` on something that is not a `Date`.
 */

export type SuggestionStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED' | 'APPLIED' | 'FAILED';

export interface LinkSuggestionPageRef {
  id: string;
  url: string;
  title: string | null;
}

export interface LinkSuggestionSource extends LinkSuggestionPageRef {
  internalLinksOut: number;
}

export interface LinkSuggestionTarget extends LinkSuggestionPageRef {
  internalLinksIn: number;
  isOrphan: boolean;
  clicks28d: number;
}

export interface LinkSuggestion {
  id: string;
  anchorText: string;
  /** Where in the source page the link belongs, in the suggester's words. */
  placementHint: string | null;
  /** The exact existing sentence the anchor was found in. */
  contextSnippet: string | null;
  reason: string;
  /** 0-1 semantic similarity between the two pages. */
  relevanceScore: number;
  /** 0-1: how starved of inbound links the target currently is. */
  impactScore: number;
  status: SuggestionStatusValue;
  appliedAt: string | null;
  rejectedReason: string | null;
  createdAt: string;
  sourcePage: LinkSuggestionSource;
  targetPage: LinkSuggestionTarget;
}

export interface OrphanPage {
  id: string;
  url: string;
  title: string | null;
  pageType: string;
  depth: number;
  wordCount: number;
  isIndexable: boolean;
  clicks28d: number;
  impressions28d: number;
  seoScore: number | null;
}

export interface AnchorAuditRow {
  targetPageId: string;
  targetUrl: string;
  totalInbound: number;
  exactMatchCount: number;
  /** 0-1. */
  exactMatchRatio: number;
  topAnchors: Array<{ anchor: string; count: number }>;
  severity: 'high' | 'medium' | 'none';
  recommendation: string;
}

export interface LinksResponse {
  websiteId: string;
  suggestions: {
    items: LinkSuggestion[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
    byStatus: Partial<Record<SuggestionStatusValue, number>>;
  };
  orphans: { items: OrphanPage[]; total: number };
  anchorAudit: AnchorAuditRow[];
  source: { crawlId: string | null; crawledAt: string | null };
}

export interface GraphNodeDto {
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
  /** Normalised 0-1 PageRank over the *whole* site, not the rendered sample. */
  authority: number;
}

export interface GraphEdgeDto {
  source: string;
  target: string;
  anchorText: string;
  isNofollow: boolean;
  inMainContent: boolean;
}

export interface GraphStatsDto {
  pageCount: number;
  edgeCount: number;
  orphanCount: number;
  avgOutboundLinks: number;
  avgInboundLinks: number;
  maxDepth: number;
  components: number;
  hubs: Array<{ id: string; url: string; outboundLinks: number }>;
  authorities: Array<{ id: string; url: string; inboundLinks: number; authority: number }>;
}

export interface LinkGraphResponse {
  websiteId?: string;
  /** Present only when the endpoint refused to build a graph (no crawl yet). */
  status?: 'skipped';
  reason?: string;
  fix?: string;
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  /** Always the whole site's figures, even when `nodes` was decimated for rendering. */
  stats: GraphStatsDto | null;
  rendered?: {
    nodes: number;
    edges: number;
    totalNodes: number;
    totalEdges: number;
    decimated: boolean;
  };
  source?: { crawlId: string | null; crawledAt: string | null; truncated: { pages: boolean; edges: boolean } };
}

/** Non-secret CMS adapter state, passed from the server page into the client views. */
export interface CmsAdapterSummary {
  provider: string;
  label: string;
  status: string;
  canUpdateContent: boolean;
  canInjectStructuredData: boolean;
}

export interface EnqueueSummaryDto {
  enqueued: boolean;
  queue: string;
  jobRecordId: string | null;
  jobId: string | null;
  schedulerId: string | null;
  reason: string | null;
  message: string;
}

/** Every mutating endpoint in this area may answer "I did not do that, and here is why". */
export interface SkippedDto {
  status?: 'skipped';
  reason?: string;
  fix?: string;
}
