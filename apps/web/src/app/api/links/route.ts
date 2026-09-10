import { z } from 'zod';
import { SuggestionStatus, prisma } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { auditAnchorText, type ExistingLink, type LinkCandidatePage } from '@seo/seo-engine';
import { readQuery, route } from '@/lib/api';
import {
  booleanParam,
  multiValueParam,
  parseEnumList,
  requireScopedWebsite,
  websiteScopeSchema,
} from '@/app/api/_lib/common';
import { loadLinkGraphData } from '@/app/api/_lib/links';

/**
 * `GET /api/links?websiteId=` — internal link suggestions, orphan pages and the anchor audit.
 *
 * The anchor audit runs over the *stored* edges of the last completed crawl. It is a
 * manipulation check, not an optimisation one: a page whose inbound anchors are overwhelmingly
 * the same exact-match keyword reads as engineered rather than editorial, and the audit exists
 * to flag that on our own suggestions too.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  status: multiValueParam,
  /** Orphan rows are a separate list; this caps how many come back. */
  orphanLimit: z.coerce.number().int().min(1).max(500).default(100),
  /** Skip the anchor audit when the caller only needs the suggestion list. */
  includeAnchors: booleanParam(true),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireScopedWebsite(user, query.websiteId);

  const statuses = parseEnumList(query.status, Object.values(SuggestionStatus)) ?? [
    SuggestionStatus.PENDING,
  ];

  const suggestionWhere = { websiteId: website.id, status: { in: statuses } };

  const [suggestions, total, orphans, orphanCount, counts] = await Promise.all([
    prisma.internalLinkSuggestion.findMany({
      where: suggestionWhere,
      orderBy: [{ impactScore: 'desc' }, { relevanceScore: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        anchorText: true,
        placementHint: true,
        contextSnippet: true,
        reason: true,
        relevanceScore: true,
        impactScore: true,
        status: true,
        appliedAt: true,
        rejectedReason: true,
        createdAt: true,
        sourcePage: { select: { id: true, url: true, title: true, internalLinksOut: true } },
        targetPage: {
          select: { id: true, url: true, title: true, internalLinksIn: true, isOrphan: true, clicks28d: true },
        },
      },
    }),
    prisma.internalLinkSuggestion.count({ where: suggestionWhere }),
    prisma.page.findMany({
      where: { websiteId: website.id, isActive: true, isOrphan: true },
      orderBy: [{ impressions28d: 'desc' }, { depth: 'asc' }],
      take: query.orphanLimit,
      select: {
        id: true,
        url: true,
        title: true,
        pageType: true,
        depth: true,
        wordCount: true,
        isIndexable: true,
        clicks28d: true,
        impressions28d: true,
        seoScore: true,
      },
    }),
    prisma.page.count({ where: { websiteId: website.id, isActive: true, isOrphan: true } }),
    prisma.internalLinkSuggestion.groupBy({
      by: ['status'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
  ]);

  let anchorAudit: ReturnType<typeof auditAnchorText> = [];
  let crawlId: string | null = null;
  let crawledAt: Date | null = null;

  if (query.includeAnchors) {
    const graph = await loadLinkGraphData(website.id);
    crawlId = graph.crawlId;
    crawledAt = graph.crawledAt;

    const byNormalized = new Map(graph.pages.map((page) => [page.normalizedUrl, page]));
    const candidates: LinkCandidatePage[] = graph.pages.map((page) => ({
      id: page.id,
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      title: page.title,
      h1: page.h1,
      metaDescription: page.metaDescription,
      // The audit only reads urls and target keywords; page text is not loaded for it.
      textContent: null,
      wordCount: page.wordCount,
      isIndexable: page.isIndexable,
      depth: page.depth,
      targetKeywords: page.targetKeywords,
      inboundLinks: page.internalLinksIn,
      outboundLinks: page.internalLinksOut,
    }));

    const existing: ExistingLink[] = [];
    for (const edge of graph.edges) {
      const source = byNormalized.get(edge.sourceNormalized);
      const target = byNormalized.get(edge.targetNormalized);
      if (!source || !target || source.id === target.id) continue;
      existing.push({ sourceId: source.id, targetId: target.id, anchorText: edge.anchorText });
    }

    anchorAudit = auditAnchorText(candidates, existing);
  }

  const byStatus: Record<string, number> = {};
  for (const row of counts) byStatus[row.status] = row._count._all;

  return {
    websiteId: website.id,
    suggestions: {
      items: suggestions,
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      byStatus,
    },
    orphans: { items: orphans, total: orphanCount },
    anchorAudit,
    source: { crawlId, crawledAt },
  };
});
