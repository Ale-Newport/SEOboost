import { ai, geoRecommendationsPrompt, isAiAvailable } from '@seo/ai';
import { json, prisma } from '@seo/db';
import { auditSiteGeo, type GeoFinding, type GeoPageInput, type GeoSiteContext } from '@seo/seo-engine';
import { clamp, errorMessage, round, truncate } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  NO_CRAWL,
  jsonArray,
  latestCrawl,
  loadSite,
  loadVerifiedFacts,
  pluralise,
  propose,
  result,
  skipped,
  step,
  unique,
} from './shared';

const AGENT = 'GEOAgent' as const;
const ALLOWED_ACTION_TYPES = ['GEO_IMPROVEMENT'] as const;

const MAX_PAGES = 300;
const MAX_ACTIONS = 8;

/**
 * The honesty clause attached to every GEO output.
 *
 * Nobody outside the model vendors knows how answer engines choose sources, and anyone claiming
 * otherwise is selling something. These recommendations are best practice derived from how
 * retrieval and extraction demonstrably work — not ranking factors, and not guarantees.
 */
export const GEO_DISCLAIMER =
  'GEO guidance is probabilistic best practice, not a set of confirmed ranking factors. Answer engines do not ' +
  'publish how they select and cite sources. These changes make a page easier to retrieve, extract and attribute, ' +
  'which raises the likelihood of citation — they do not guarantee it.';

const recommendationSchema = z.object({
  recommendations: z.array(
    z.object({
      dimension: z.string(),
      action: z.string(),
      currentState: z.string(),
      proposedChange: z.string(),
      rationale: z.string(),
      effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      expectedImpact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
      requiresHumanInput: z.boolean(),
      humanInputNeeded: z.string().nullable(),
      autoApplicable: z.boolean(),
      targetUrl: z.string().nullable(),
    }),
  ),
});

const EFFORT_SCALE: Record<string, number> = { LOW: 1, MEDIUM: 3, HIGH: 5 };
const IMPACT_SCALE: Record<string, number> = { HIGH: 0.7, MEDIUM: 0.45, LOW: 0.25 };

/** Findings grouped by dimension, worst first — the shape the action list is built from. */
export function groupFindings(findings: readonly GeoFinding[]): Array<{
  dimension: string;
  severity: GeoFinding['severity'];
  count: number;
  urls: string[];
  messages: string[];
}> {
  const byDimension = new Map<string, GeoFinding[]>();
  for (const finding of findings) {
    const list = byDimension.get(finding.dimension);
    if (list) list.push(finding);
    else byDimension.set(finding.dimension, [finding]);
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return [...byDimension.entries()]
    .map(([dimension, group]) => ({
      dimension,
      severity: group.reduce<GeoFinding['severity']>(
        (worst, finding) => (rank[finding.severity] < rank[worst] ? finding.severity : worst),
        group[0]?.severity ?? 'low',
      ),
      count: group.length,
      urls: unique(group.flatMap((finding) => (finding.url ? [finding.url] : []))).slice(0, 20),
      messages: unique(group.map((finding) => finding.message)).slice(0, 5),
    }))
    .sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);
  const crawl = await step(ctx, 'get_latest_crawl', { websiteId: ctx.websiteId }, () => latestCrawl(ctx.websiteId));
  if (!crawl) return skipped('No crawl to audit for GEO.', NO_CRAWL);

  const pages = await step(
    ctx,
    'list_pages',
    { websiteId: ctx.websiteId },
    () =>
      prisma.page.findMany({
        where: { websiteId: ctx.websiteId, isActive: true, isIndexable: true },
        orderBy: { impressions28d: 'desc' },
        take: MAX_PAGES,
        select: {
          id: true,
          url: true,
          path: true,
          title: true,
          h1: true,
          metaDescription: true,
          wordCount: true,
          pageType: true,
          schemaTypes: true,
          isIndexable: true,
          impressions28d: true,
        },
      }),
    (rows) => ({ pages: rows.length }),
  );

  if (pages.length === 0) {
    return skipped('No indexable pages to audit.', 'The latest crawl produced no indexable pages to audit for GEO.');
  }

  const pageIds = pages.map((page) => page.id);
  const crawlPages = await prisma.crawlPage.findMany({
    where: { crawlId: crawl.id, pageId: { in: pageIds } },
    select: { id: true, pageId: true, textContent: true, headings: true, structuredData: true, schemaTypes: true },
  });

  const externalEdges = await prisma.linkEdge.findMany({
    where: { crawlId: crawl.id, isInternal: false },
    select: { sourceCrawlPageId: true, targetUrl: true, anchorText: true, isNofollow: true },
    take: 100_000,
  });
  const externalBySourceCrawlPage = new Map<string, Array<{ href: string; anchorText: string; isNofollow: boolean }>>();
  for (const edge of externalEdges) {
    const list = externalBySourceCrawlPage.get(edge.sourceCrawlPageId) ?? [];
    list.push({ href: edge.targetUrl, anchorText: edge.anchorText ?? '', isNofollow: edge.isNofollow });
    externalBySourceCrawlPage.set(edge.sourceCrawlPageId, list);
  }

  const crawlByPageId = new Map(crawlPages.flatMap((row) => (row.pageId ? [[row.pageId, row] as const] : [])));

  const entities = await prisma.entity.findMany({
    where: { websiteId: ctx.websiteId },
    select: { name: true },
    take: 200,
  });
  const facts = await loadVerifiedFacts(ctx.websiteId, 500);

  const geoPages: GeoPageInput[] = pages.map((page) => {
    const crawled = crawlByPageId.get(page.id);
    return {
      id: page.id,
      url: page.url,
      title: page.title,
      h1: page.h1,
      metaDescription: page.metaDescription,
      textContent: crawled?.textContent ?? null,
      wordCount: page.wordCount,
      headings: crawled
        ? jsonArray(crawled.headings).flatMap((heading) =>
            typeof heading.text === 'string' && typeof heading.level === 'number'
              ? [{ level: heading.level, text: heading.text }]
              : [],
          )
        : [],
      schemaTypes: crawled?.schemaTypes ?? page.schemaTypes,
      structuredData: jsonArray(crawled?.structuredData),
      externalLinks: crawled ? externalBySourceCrawlPage.get(crawled.id) ?? [] : [],
      pageType: page.pageType,
      isIndexable: page.isIndexable,
    };
  });

  const allSchemaTypes = unique(geoPages.flatMap((page) => page.schemaTypes));
  const siteContext: GeoSiteContext = {
    brandName: site.brandName,
    domain: site.domain,
    brandDescriptions: unique(
      [site.description, site.knowledgeBase?.businessDescription, ...pages.slice(0, 20).map((page) => page.metaDescription)].flatMap(
        (value) => (value ? [value] : []),
      ),
    ),
    hasAboutPage: pages.some((page) => page.pageType === 'ABOUT' || /\/about/i.test(page.path)),
    hasContactPage: pages.some((page) => page.pageType === 'CONTACT' || /\/contact/i.test(page.path)),
    hasAuthorPages: pages.some((page) => page.pageType === 'AUTHOR' || /\/author/i.test(page.path)),
    organizationSchemaFound: allSchemaTypes.includes('Organization'),
    websiteSchemaFound: allSchemaTypes.includes('WebSite'),
    verifiedFactCount: facts.length,
    knownEntities: entities.map((entity) => entity.name),
  };

  const weights = new Map(pages.map((page) => [page.id, Math.max(1, page.impressions28d)]));
  const audit = auditSiteGeo(geoPages, siteContext, weights);

  // ── Persist ────────────────────────────────────────────────────────────────
  const geoAudit = await prisma.geoAudit.create({
    data: {
      websiteId: ctx.websiteId,
      overallScore: audit.score,
      dimensions: json(audit.dimensions),
      findings: json(audit.findings),
      recommendations: json([]),
      pagesAudited: audit.pagesAudited,
      method: 'deterministic',
      summary: audit.summary,
    },
    select: { id: true },
  });

  for (const pageScore of audit.pageScores) {
    await prisma.geoPageAudit.create({
      data: {
        auditId: geoAudit.id,
        pageId: pageScore.pageId,
        score: pageScore.score,
        dimensions: json(Object.fromEntries(pageScore.factors.map((factor) => [factor.key, factor.value]))),
        findings: json(pageScore.findings),
      },
    });
    await prisma.page.update({ where: { id: pageScore.pageId }, data: { geoScore: pageScore.score } });
  }

  await prisma.website.update({ where: { id: ctx.websiteId }, data: { geoScore: audit.score } });

  // ── Concrete recommendations ───────────────────────────────────────────────
  const grouped = groupFindings(audit.findings);
  const weakest = [...audit.factors].sort((a, b) => a.value - b.value);
  let recommendations: z.infer<typeof recommendationSchema>['recommendations'] = [];
  let method = 'deterministic';

  if (isAiAvailable()) {
    const worstPage = [...audit.pageScores].sort((a, b) => a.score - b.score)[0] ?? null;
    const worstPageContent = worstPage ? geoPages.find((page) => page.id === worstPage.pageId)?.textContent ?? null : null;
    try {
      const answer = await step(
        ctx,
        'geo_recommendations',
        { dimensions: audit.factors.length },
        () =>
          ai.generateStructured({
            task: geoRecommendationsPrompt.id,
            websiteId: ctx.websiteId,
            agent: AGENT,
            role: geoRecommendationsPrompt.defaultRole ?? 'reasoning',
            system: geoRecommendationsPrompt.system,
            prompt: geoRecommendationsPrompt.render({
              url: worstPage?.url ?? site.domain,
              title: site.name,
              overallScore: audit.score,
              dimensionScores: audit.factors.map((factor) => ({
                dimension: factor.label,
                score: round(factor.value * 100, 1),
                evidence: factor.explanation,
              })),
              content: worstPageContent ? truncate(worstPageContent, 6000, '') : null,
              structuredDataTypes: allSchemaTypes,
              maxRecommendations: MAX_ACTIONS,
            }),
            schema: recommendationSchema,
            schemaName: 'geo_recommendations',
            settings: site.settings,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        (value) => ({ recommendations: value.data.recommendations.length }),
      );
      recommendations = answer.data.recommendations;
      method = 'deterministic+llm';
    } catch (err) {
      ctx.log('geo recommendations failed', { error: errorMessage(err) });
    }
  }

  // Fall back to the deterministic findings when no model turned them into concrete changes.
  const fallback: typeof recommendations = grouped.slice(0, MAX_ACTIONS).map((group) => ({
    dimension: group.dimension,
    action: group.messages[0] ?? `Improve ${group.dimension}`,
    currentState: `${group.count} ${pluralise(group.count, 'page')} flagged on this dimension.`,
    proposedChange: group.messages.join(' '),
    rationale: 'Derived from the deterministic GEO audit; connect an AI provider for page-specific rewrites.',
    effort: group.severity === 'high' ? 'MEDIUM' : 'LOW',
    expectedImpact: group.severity === 'high' ? 'HIGH' : group.severity === 'medium' ? 'MEDIUM' : 'LOW',
    requiresHumanInput: true,
    humanInputNeeded: null,
    autoApplicable: false,
    targetUrl: group.urls[0] ?? null,
  }));

  const finalRecommendations = recommendations.length > 0 ? recommendations : fallback;
  await prisma.geoAudit.update({
    where: { id: geoAudit.id },
    data: { recommendations: json(finalRecommendations), method },
  });

  // ── Actions ────────────────────────────────────────────────────────────────
  const actions = new ActionCollector();
  for (const recommendation of finalRecommendations.slice(0, MAX_ACTIONS)) {
    await propose(ctx, actions, {
      type: 'GEO_IMPROVEMENT',
      title: truncate(recommendation.action, 120, '…'),
      reasoning:
        `${recommendation.currentState} ${recommendation.proposedChange} Why it matters: ${recommendation.rationale} ` +
        (recommendation.requiresHumanInput && recommendation.humanInputNeeded
          ? `This needs input from the business: ${recommendation.humanInputNeeded}. `
          : '') +
        GEO_DISCLAIMER,
      evidence: {
        dimension: recommendation.dimension,
        siteGeoScore: audit.score,
        auditId: geoAudit.id,
        pagesAudited: audit.pagesAudited,
        weakestDimensions: weakest.slice(0, 3).map((factor) => ({ label: factor.label, value: factor.value })),
        expectedImpact: recommendation.expectedImpact,
        effort: recommendation.effort,
        requiresHumanInput: recommendation.requiresHumanInput,
        disclaimer: GEO_DISCLAIMER,
      },
      affectedUrls: recommendation.targetUrl ? [recommendation.targetUrl] : [],
      payload: { dimension: recommendation.dimension, proposedChange: recommendation.proposedChange, auditId: geoAudit.id },
      impact: IMPACT_SCALE[recommendation.expectedImpact] ?? 0.35,
      // Deliberately capped: GEO outcomes are not directly measurable, so the platform never
      // claims high confidence in an individual GEO change.
      confidence: recommendation.requiresHumanInput ? 0.45 : 0.6,
      effort: EFFORT_SCALE[recommendation.effort] ?? 3,
      sourceType: 'GeoAudit',
      sourceId: `${geoAudit.id}:${recommendation.dimension}`,
      ...(recommendation.requiresHumanInput || !recommendation.autoApplicable
        ? {
            advisory:
              recommendation.humanInputNeeded ??
              'This change alters published copy, so a person makes the edit rather than the platform.',
          }
        : {}),
    });
  }

  return result({
    summary:
      `GEO score ${audit.score}/100 across ${audit.pagesAudited} ${pluralise(audit.pagesAudited, 'page')}. ` +
      `Weakest: ${weakest.slice(0, 2).map((factor) => factor.label).join(' and ')}. ` +
      `${finalRecommendations.length} ${pluralise(finalRecommendations.length, 'recommendation')}, ${actions.actionsCreated.length} proposed as actions.`,
    confidence: 0.6,
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings: [
      ...grouped.map((group) => ({ kind: 'geo-finding', ...group })),
      ...finalRecommendations.map((recommendation) => ({ kind: 'geo-recommendation', ...recommendation })),
    ],
    data: {
      auditId: geoAudit.id,
      score: audit.score,
      dimensions: audit.dimensions,
      pagesAudited: audit.pagesAudited,
      method,
      disclaimer: GEO_DISCLAIMER,
    },
  });
}

export const geoAgent: AgentDefinition = {
  name: AGENT,
  label: 'Generative engine optimisation',
  description:
    'Audits how quotable the site is for AI answer engines and turns the weakest dimensions into concrete, honest recommendations.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: ['get_latest_crawl', 'list_pages', 'geo_recommendations'],
  requiresAi: false,
  run,
};

registerAgent(geoAgent);
