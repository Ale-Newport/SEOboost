import { ai, internalLinkAnchorPrompt, isAiAvailable } from '@seo/ai';
import { json, prisma } from '@seo/db';
import {
  auditAnchorText,
  buildLinkGraph,
  suggestInternalLinks,
  type ExistingLink,
  type InternalLinkSuggestion,
  type LinkCandidatePage,
} from '@seo/seo-engine';
import { clamp, errorMessage, round, saturate, truncate } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  NO_CRAWL,
  latestCrawl,
  loadSite,
  pluralise,
  propose,
  result,
  skipped,
  step,
  throwIfAborted,
  unique,
} from './shared';

const AGENT = 'InternalLinkAgent' as const;
const ALLOWED_ACTION_TYPES = ['ADD_INTERNAL_LINKS'] as const;

const MAX_PAGES = 1500;
const MAX_TEXT_CHARS = 20_000;
const DEFAULT_MAX_ACTIONS = 10;
/** The anchor rewrite is a cheap `fast` call, but it still only runs on the best suggestions. */
const DEFAULT_REFINE_LIMIT = 15;

const anchorSchema = z.object({
  links: z.array(
    z.object({
      targetUrl: z.string(),
      anchorText: z.string(),
      sentence: z.string(),
      reason: z.string(),
    }),
  ),
  skipped: z.array(z.object({ targetUrl: z.string(), reason: z.string() })),
});

/**
 * Impact of adding inbound links to a page: how starved of internal links it currently is.
 * An orphan gains far more from its first link than a well-linked hub gains from its ninth.
 */
export function linkImpact(inboundLinks: number, suggestions: number): number {
  const starvation = 1 - saturate(inboundLinks, 4);
  return round(clamp(starvation * 0.75 + saturate(suggestions, 3) * 0.25), 3);
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);
  const crawl = await step(ctx, 'get_latest_crawl', { websiteId: ctx.websiteId }, () => latestCrawl(ctx.websiteId));
  if (!crawl) return skipped('No crawl to build a link graph from.', NO_CRAWL);

  const maxActions =
    typeof ctx.input.maxActions === 'number' ? Math.max(1, Math.min(50, ctx.input.maxActions)) : DEFAULT_MAX_ACTIONS;
  const refineLimit =
    typeof ctx.input.refineLimit === 'number' ? Math.max(0, Math.min(50, ctx.input.refineLimit)) : DEFAULT_REFINE_LIMIT;

  // ── Gather: pages, their crawled text, their link edges ─────────────────────
  const pages = await step(
    ctx,
    'list_pages',
    { websiteId: ctx.websiteId },
    () =>
      prisma.page.findMany({
        where: { websiteId: ctx.websiteId, isActive: true },
        orderBy: { impressions28d: 'desc' },
        take: MAX_PAGES,
        select: {
          id: true,
          url: true,
          normalizedUrl: true,
          title: true,
          h1: true,
          metaDescription: true,
          wordCount: true,
          depth: true,
          isIndexable: true,
          internalLinksIn: true,
          internalLinksOut: true,
          keywords: { select: { keyword: true }, orderBy: { impressions28d: 'desc' }, take: 5 },
        },
      }),
    (rows) => ({ pages: rows.length }),
  );

  if (pages.length < 2) {
    return skipped('Not enough pages to link between.', 'The site needs at least two crawled pages before internal links can be suggested.');
  }

  const pageIds = pages.map((page) => page.id);
  const [crawlPages, embeddings] = await Promise.all([
    prisma.crawlPage.findMany({
      where: { crawlId: crawl.id, pageId: { in: pageIds } },
      select: { id: true, pageId: true, normalizedUrl: true, textContent: true },
    }),
    prisma.embeddingRecord.findMany({
      where: { websiteId: ctx.websiteId, ownerType: 'PAGE', pageId: { in: pageIds } },
      select: { pageId: true, vector: true },
    }),
  ]);

  const textByPageId = new Map<string, string>();
  const pageIdByCrawlPageId = new Map<string, string>();
  for (const row of crawlPages) {
    if (!row.pageId) continue;
    pageIdByCrawlPageId.set(row.id, row.pageId);
    if (row.textContent) textByPageId.set(row.pageId, truncate(row.textContent, MAX_TEXT_CHARS, ''));
  }
  const embeddingByPageId = new Map<string, number[]>();
  for (const row of embeddings) {
    if (row.pageId) embeddingByPageId.set(row.pageId, row.vector);
  }

  if (textByPageId.size === 0) {
    return skipped(
      'No page text available.',
      'The latest crawl stored no page text, so no anchor can be found inside real copy. Re-run the crawl ' +
        '(text extraction is required for internal-link suggestions).',
    );
  }

  const edges = await step(
    ctx,
    'get_link_edges',
    { crawlId: crawl.id },
    () =>
      prisma.linkEdge.findMany({
        where: { crawlId: crawl.id, isInternal: true },
        select: {
          sourceCrawlPageId: true,
          normalizedTarget: true,
          anchorText: true,
          isNofollow: true,
          inMainContent: true,
        },
        take: 200_000,
      }),
    (rows) => ({ edges: rows.length }),
  );

  const pageIdByNormalized = new Map(pages.map((page) => [page.normalizedUrl, page.id]));
  const normalizedByPageId = new Map(pages.map((page) => [page.id, page.normalizedUrl]));

  const existingLinks: ExistingLink[] = [];
  for (const edge of edges) {
    const sourceId = pageIdByCrawlPageId.get(edge.sourceCrawlPageId);
    const targetId = pageIdByNormalized.get(edge.normalizedTarget);
    if (!sourceId || !targetId || sourceId === targetId) continue;
    existingLinks.push({ sourceId, targetId, anchorText: edge.anchorText ?? '' });
  }

  const candidates: LinkCandidatePage[] = pages.map((page) => ({
    id: page.id,
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    title: page.title,
    h1: page.h1,
    metaDescription: page.metaDescription,
    textContent: textByPageId.get(page.id) ?? null,
    wordCount: page.wordCount,
    isIndexable: page.isIndexable,
    depth: page.depth,
    targetKeywords: page.keywords.map((keyword) => keyword.keyword),
    embedding: embeddingByPageId.get(page.id) ?? null,
    inboundLinks: page.internalLinksIn,
    outboundLinks: page.internalLinksOut,
  }));

  const graph = buildLinkGraph(
    pages.map((page) => ({
      id: page.id,
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      title: page.title,
      depth: page.depth,
      isIndexable: page.isIndexable,
      wordCount: page.wordCount,
    })),
    edges.flatMap((edge) => {
      const sourceId = pageIdByCrawlPageId.get(edge.sourceCrawlPageId);
      const sourceNormalized = sourceId ? normalizedByPageId.get(sourceId) : undefined;
      if (!sourceNormalized) return [];
      return [
        {
          sourceNormalized,
          targetNormalized: edge.normalizedTarget,
          anchorText: edge.anchorText ?? '',
          isNofollow: edge.isNofollow,
          inMainContent: edge.inMainContent,
        },
      ];
    }),
  );

  const suggestions = suggestInternalLinks(candidates, existingLinks);
  const anchorAudits = auditAnchorText(candidates, existingLinks);

  // ── Persist suggestions, skipping pairs already proposed or rejected ────────
  const existingSuggestions = await prisma.internalLinkSuggestion.findMany({
    where: { websiteId: ctx.websiteId },
    select: { sourcePageId: true, targetPageId: true },
  });
  const known = new Set(existingSuggestions.map((row) => `${row.sourcePageId}→${row.targetPageId}`));

  const fresh = suggestions.filter((suggestion) => !known.has(`${suggestion.sourcePageId}→${suggestion.targetPageId}`));
  const refined = await refineAnchors(ctx, site, fresh, refineLimit);

  let persisted = 0;
  for (const suggestion of fresh) {
    throwIfAborted(ctx);
    const anchor = refined.get(anchorKey(suggestion)) ?? suggestion.anchorText;
    try {
      await prisma.internalLinkSuggestion.create({
        data: {
          websiteId: ctx.websiteId,
          sourcePageId: suggestion.sourcePageId,
          targetPageId: suggestion.targetPageId,
          anchorText: anchor,
          placementHint: suggestion.placementHint,
          contextSnippet: suggestion.contextSnippet,
          reason: suggestion.reason,
          relevanceScore: suggestion.relevanceScore,
          impactScore: suggestion.impactScore,
          status: 'PENDING',
        },
      });
      persisted++;
    } catch {
      // A concurrent run may have created the same pair; the unique index is the arbiter.
    }
  }

  // ── One action per target page ─────────────────────────────────────────────
  const byTarget = new Map<string, InternalLinkSuggestion[]>();
  for (const suggestion of fresh) {
    const list = byTarget.get(suggestion.targetPageId);
    if (list) list.push(suggestion);
    else byTarget.set(suggestion.targetPageId, [suggestion]);
  }

  const inboundByPageId = new Map(pages.map((page) => [page.id, page.internalLinksIn]));
  const ranked = [...byTarget.entries()].sort(
    (a, b) => (inboundByPageId.get(a[0]) ?? 0) - (inboundByPageId.get(b[0]) ?? 0) || b[1].length - a[1].length,
  );

  const actions = new ActionCollector();
  for (const [targetPageId, group] of ranked.slice(0, maxActions)) {
    const target = group[0];
    if (!target) continue;
    const inbound = inboundByPageId.get(targetPageId) ?? 0;
    await propose(ctx, actions, {
      type: 'ADD_INTERNAL_LINKS',
      title: `Add ${group.length} internal ${pluralise(group.length, 'link')} to ${truncate(target.targetUrl, 70, '…')}`,
      reasoning:
        `${target.targetUrl} has ${inbound} internal ${pluralise(inbound, 'link')} pointing at it. ` +
        `${group.length} existing ${pluralise(group.length, 'page')} already discuss the topic in prose, so the link can be placed ` +
        'inside a sentence that is already there rather than bolted on. ' +
        group
          .slice(0, 3)
          .map((suggestion) => `"${suggestion.anchorText}" on ${suggestion.sourceUrl}`)
          .join('; ') +
        '.',
      evidence: {
        targetUrl: target.targetUrl,
        inboundLinks: inbound,
        authority: graph.nodes.find((node) => node.id === targetPageId)?.authority ?? null,
        placements: group.slice(0, 10).map((suggestion) => ({
          sourceUrl: suggestion.sourceUrl,
          anchorText: refined.get(anchorKey(suggestion)) ?? suggestion.anchorText,
          placementHint: suggestion.placementHint,
          relevance: suggestion.relevanceScore,
        })),
      },
      affectedUrls: unique(group.map((suggestion) => suggestion.sourceUrl)).slice(0, 20),
      payload: {
        targetPageId,
        links: group.map((suggestion) => ({
          sourcePageId: suggestion.sourcePageId,
          sourceUrl: suggestion.sourceUrl,
          anchorText: refined.get(anchorKey(suggestion)) ?? suggestion.anchorText,
          contextSnippet: suggestion.contextSnippet,
        })),
      },
      impact: linkImpact(inbound, group.length),
      confidence: round(clamp(group.reduce((total, s) => total + s.relevanceScore, 0) / group.length), 3),
      effort: 1,
      sourceType: 'InternalLinkSuggestionBatch',
      sourceId: `${targetPageId}:${crawl.id}`,
    });
  }

  return result({
    summary:
      `${suggestions.length} internal link ${pluralise(suggestions.length, 'suggestion')} from ${pages.length} pages ` +
      `(${persisted} new). ${graph.stats.orphanCount} orphan ${pluralise(graph.stats.orphanCount, 'page')}, ` +
      `${anchorAudits.length} over-optimised anchor ${pluralise(anchorAudits.length, 'profile')}. ` +
      `Proposed ${actions.actionsCreated.length} link ${pluralise(actions.actionsCreated.length, 'batch', 'batches')}.`,
    confidence: 0.75,
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings: [
      ...anchorAudits.slice(0, 15).map((audit) => ({ kind: 'anchor-over-optimisation', ...audit })),
      ...graph.stats.authorities.slice(0, 5).map((node) => ({ kind: 'authority-page', ...node })),
    ],
    data: {
      crawlId: crawl.id,
      pages: pages.length,
      edges: edges.length,
      suggestions: suggestions.length,
      persisted,
      graph: graph.stats,
      embeddingsUsed: embeddingByPageId.size,
      method:
        embeddingByPageId.size > 0
          ? 'Relatedness uses stored page embeddings where available and lexical similarity elsewhere.'
          : 'No page embeddings exist yet, so relatedness is lexical only. Generating embeddings improves precision.',
    },
  });
}

function anchorKey(suggestion: InternalLinkSuggestion): string {
  return `${suggestion.sourcePageId}→${suggestion.targetPageId}`;
}

/**
 * Ask the model for more natural anchor text on the strongest suggestions.
 *
 * The engine already found a phrase that exists in the source copy; the model can only *replace*
 * it with another verbatim substring of the same passage. Anything else is discarded, because the
 * applier performs a literal replacement and a paraphrase would corrupt the sentence.
 */
async function refineAnchors(
  ctx: AgentContext,
  site: Awaited<ReturnType<typeof loadSite>>,
  suggestions: readonly InternalLinkSuggestion[],
  limit: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (limit === 0 || suggestions.length === 0 || !isAiAvailable()) return out;

  const top = [...suggestions].sort((a, b) => b.impactScore - a.impactScore).slice(0, limit);
  const bySource = new Map<string, InternalLinkSuggestion[]>();
  for (const suggestion of top) {
    const list = bySource.get(suggestion.sourcePageId);
    if (list) list.push(suggestion);
    else bySource.set(suggestion.sourcePageId, [suggestion]);
  }

  for (const [, group] of bySource) {
    const first = group[0];
    if (!first) continue;
    const context = group
      .map((suggestion) => suggestion.contextSnippet)
      .filter((snippet): snippet is string => Boolean(snippet))
      .join('\n\n');
    if (!context) continue;

    try {
      const answer = await step(
        ctx,
        'refine_link_anchors',
        { sourceUrl: first.sourceUrl, candidates: group.length },
        () =>
          ai.generateStructured({
            task: internalLinkAnchorPrompt.id,
            websiteId: ctx.websiteId,
            agent: AGENT,
            role: internalLinkAnchorPrompt.defaultRole ?? 'fast',
            system: internalLinkAnchorPrompt.system,
            prompt: internalLinkAnchorPrompt.render({
              sourceUrl: first.sourceUrl,
              sourceContent: context,
              candidates: group.map((suggestion) => ({
                targetUrl: suggestion.targetUrl,
                targetSummary: suggestion.reason,
                similarity: suggestion.relevanceScore,
              })),
              maxLinks: group.length,
            }),
            schema: anchorSchema,
            schemaName: 'internal_link_anchor',
            settings: site.settings,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        (value) => ({ anchors: value.data.links.length }),
      );

      for (const link of answer.data.links) {
        const match = group.find((suggestion) => suggestion.targetUrl === link.targetUrl);
        if (!match) continue;
        if (!context.includes(link.anchorText)) continue; // not verbatim — discard
        out.set(anchorKey(match), link.anchorText);
      }
    } catch (err) {
      ctx.log('anchor refinement failed', { sourceUrl: first.sourceUrl, error: errorMessage(err) });
    }
  }

  return out;
}

export const internalLinkAgent: AgentDefinition = {
  name: AGENT,
  label: 'Internal linking',
  description:
    'Builds the internal link graph, suggests links from real prose to under-linked pages and audits anchor-text distribution.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: ['get_latest_crawl', 'list_pages', 'get_link_edges', 'refine_link_anchors'],
  requiresAi: false,
  run,
};

registerAgent(internalLinkAgent);
