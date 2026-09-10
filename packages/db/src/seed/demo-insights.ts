import { clamp, round, truncate } from '@seo/shared';
import {
  auditSiteGeo,
  calculatePageOpportunity,
  calculatePageSeoScore,
  calculatePriority,
  decideContentAction,
  findCtrOpportunities,
  findStrikingDistance,
  generateSchemaForPage,
  suggestInternalLinks,
  type ExistingPageSummary,
  type GeoPageInput,
  type GeoSiteContext,
  type LinkCandidatePage,
  type QueryPageAggregate,
} from '@seo/seo-engine';
import { prisma } from '../client';
import { createManyChunked, json } from '../helpers';
import type { DemoCrawl, DemoPage } from './demo-pages';
import type { DemoSiteBlueprint } from './demo-sites';
import type { DemoSearchResult } from './demo-search';
import { Rng } from './rng';

/**
 * The analysis layer of the demo: page and GEO scores, internal-link suggestions, content
 * opportunities, structured data and AI visibility.
 *
 * Everything except the AI visibility answers comes out of the real engine functions. The AI runs
 * are the one place the demo cannot use the real thing (there is no API key, and a seed must never
 * require one), so those rows are explicitly stamped `provider: 'demo'` / `method: 'seed'` and the
 * answer text is prefixed so nobody can mistake them for a recorded model response.
 */

export interface DemoInsightsResult {
  geoScore: number;
  contentScore: number;
  aiVisibilityScore: number;
  topOpportunities: Array<{ id: string; title: string; targetKeyword: string | null; pageId: string | null; priority: number }>;
  linkSuggestions: Array<{ id: string; sourcePageId: string; targetPageId: string; anchorText: string; impactScore: number; reason: string }>;
  counts: Record<string, number>;
}

export async function persistDemoInsights(
  site: DemoSiteBlueprint,
  websiteId: string,
  crawl: DemoCrawl,
  search: DemoSearchResult,
  pageIdByPath: Map<string, string>,
  openIssuesByPath: Map<string, Array<{ severity: string; weight: number }>>,
  now: Date,
): Promise<DemoInsightsResult> {
  const rng = new Rng(`${site.key}:insights`);
  const counts: Record<string, number> = {};

  const indexable = crawl.pages.filter((page) => page.isIndexable && (page.statusCode ?? 0) === 200);

  // ── Per-page scores ────────────────────────────────────────────────────────
  const seoScores = new Map<string, number>();
  for (const page of indexable) {
    const pageId = pageIdByPath.get(page.path);
    if (!pageId) continue;
    const stats = search.pageStats.get(page.path);
    const openIssues = openIssuesByPath.get(page.path) ?? [];

    const seo = calculatePageSeoScore({
      title: page.title,
      metaDescription: page.metaDescription,
      h1: page.h1[0] ?? null,
      headingCount: page.headings.length,
      wordCount: page.wordCount,
      isIndexable: page.isIndexable,
      indexabilityReason: page.indexabilityReason,
      internalLinksIn: page.internalLinksIn ?? 0,
      internalLinksOut: page.internalLinksOut ?? 0,
      schemaTypes: page.schemaTypes,
      imageCount: page.imageCount,
      imagesMissingAlt: page.imagesMissingAlt,
      openIssues,
      targetKeyword: page.targetKeywords[0] ?? null,
      textContent: page.textContent,
    });

    const opportunity = calculatePageOpportunity({
      impressions28d: stats?.impressions ?? 0,
      clicks28d: stats?.clicks ?? 0,
      position28d: stats?.position ?? null,
      ctr28d: stats?.ctr ?? null,
      clicksTrendPct: stats?.trendPct ?? null,
      seoScore: seo.score,
      internalLinksIn: page.internalLinksIn ?? 0,
      wordCount: page.wordCount,
      openIssueCount: openIssues.length,
      maxImpressionsOnSite: search.maxImpressions,
    });

    seoScores.set(page.path, seo.score);
    await prisma.page.update({
      where: { id: pageId },
      data: { seoScore: seo.score, opportunityScore: opportunity.score, contentScore: seo.score },
    });
  }

  // ── GEO audit ──────────────────────────────────────────────────────────────
  const geoContext: GeoSiteContext = {
    brandName: site.brandName,
    domain: site.domain,
    brandDescriptions: crawl.pages.filter((p) => p.metaDescription).slice(0, 6).map((p) => p.metaDescription ?? ''),
    hasAboutPage: crawl.pages.some((p) => p.pageType === 'ABOUT'),
    hasContactPage: crawl.pages.some((p) => p.pageType === 'CONTACT'),
    hasAuthorPages: crawl.pages.some((p) => p.pageType === 'AUTHOR'),
    organizationSchemaFound: crawl.pages.some((p) => p.schemaTypes.includes('Organization')),
    websiteSchemaFound: crawl.pages.some((p) => p.schemaTypes.includes('WebSite')),
    verifiedFactCount: site.facts.length,
    knownEntities: [site.brandName, ...site.knowledge.uniqueValueProps.slice(0, 2)],
  };

  const geoPages: GeoPageInput[] = indexable
    .filter((page) => pageIdByPath.has(page.path))
    .map((page) => toGeoPageInput(page, pageIdByPath.get(page.path)!));

  const geoWeights = new Map<string, number>();
  for (const page of indexable) {
    const pageId = pageIdByPath.get(page.path);
    if (pageId) geoWeights.set(pageId, Math.max(1, search.pageStats.get(page.path)?.impressions ?? 1));
  }

  const geo = auditSiteGeo(geoPages, geoContext, geoWeights);
  const geoAudit = await prisma.geoAudit.create({
    data: {
      websiteId,
      overallScore: geo.score,
      dimensions: json(geo.dimensions),
      findings: json(geo.findings),
      recommendations: json(
        geo.findings
          .filter((finding) => finding.severity === 'high')
          .slice(0, 8)
          .map((finding) => ({ dimension: finding.dimension, action: finding.message, url: finding.url ?? null })),
      ),
      pagesAudited: geo.pagesAudited,
      method: 'deterministic',
      summary: geo.summary,
      createdAt: new Date(now.getTime() - 86_400_000),
    },
    select: { id: true },
  });
  counts.GeoAudit = 1;

  await createManyChunked(prisma.geoPageAudit, geo.pageScores.map((pageScore) => ({
    auditId: geoAudit.id,
    pageId: pageScore.pageId,
    score: pageScore.score,
    dimensions: json(Object.fromEntries(pageScore.factors.map((factor) => [factor.key, factor.value]))),
    findings: json(pageScore.findings),
  })));
  counts.GeoPageAudit = geo.pageScores.length;

  for (const pageScore of geo.pageScores) {
    await prisma.page.update({ where: { id: pageScore.pageId }, data: { geoScore: pageScore.score } });
  }

  // ── Internal link suggestions ──────────────────────────────────────────────
  const candidates: LinkCandidatePage[] = indexable
    .filter((page) => pageIdByPath.has(page.path))
    .map((page) => ({
      id: pageIdByPath.get(page.path)!,
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      title: page.title,
      h1: page.h1[0] ?? null,
      metaDescription: page.metaDescription,
      textContent: page.textContent,
      wordCount: page.wordCount,
      isIndexable: page.isIndexable,
      depth: page.depth,
      targetKeywords: page.targetKeywords,
      inboundLinks: page.internalLinksIn ?? 0,
      outboundLinks: page.internalLinksOut ?? 0,
    }));

  const existingLinks = crawl.edges
    .map((edge) => {
      const sourceId = pageIdByPath.get(edge.fromPath);
      const targetId = pageIdByPath.get(edge.toPath);
      return sourceId && targetId ? { sourceId, targetId, anchorText: edge.anchorText } : null;
    })
    .filter((link): link is { sourceId: string; targetId: string; anchorText: string } => link !== null);

  const suggestions = suggestInternalLinks(candidates, existingLinks, { maxTotal: 24, maxPerSourcePage: 2 });
  const linkSuggestions: DemoInsightsResult['linkSuggestions'] = [];
  for (const suggestion of suggestions) {
    const row = await prisma.internalLinkSuggestion.create({
      data: {
        websiteId,
        sourcePageId: suggestion.sourcePageId,
        targetPageId: suggestion.targetPageId,
        anchorText: suggestion.anchorText,
        placementHint: suggestion.placementHint,
        contextSnippet: suggestion.contextSnippet,
        reason: suggestion.reason,
        relevanceScore: suggestion.relevanceScore,
        impactScore: suggestion.impactScore,
        status: 'PENDING',
      },
      select: { id: true },
    });
    linkSuggestions.push({
      id: row.id,
      sourcePageId: suggestion.sourcePageId,
      targetPageId: suggestion.targetPageId,
      anchorText: suggestion.anchorText,
      impactScore: suggestion.impactScore,
      reason: suggestion.reason,
    });
  }
  counts.InternalLinkSuggestion = linkSuggestions.length;

  // ── Content opportunities ──────────────────────────────────────────────────
  const aggregates: QueryPageAggregate[] = search.current.map((row) => ({
    query: row.query,
    page: crawl.byPath.get(row.path)?.url ?? row.path,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
  }));

  const striking = findStrikingDistance(aggregates).slice(0, 4);
  const ctrGaps = findCtrOpportunities(aggregates).slice(0, 3);

  const existingSummaries: ExistingPageSummary[] = indexable
    .filter((page) => pageIdByPath.has(page.path))
    .map((page) => {
      const stats = search.pageStats.get(page.path);
      return {
        id: pageIdByPath.get(page.path)!,
        url: page.url,
        title: page.title,
        h1: page.h1[0] ?? null,
        metaDescription: page.metaDescription,
        textContent: page.textContent,
        wordCount: page.wordCount,
        pageType: page.pageType,
        targetKeywords: page.targetKeywords,
        position: stats?.position ?? null,
        impressions: stats?.impressions ?? 0,
        clicks: stats?.clicks ?? 0,
        ctr: stats?.ctr ?? null,
        clicksTrendPct: stats?.trendPct ?? null,
        isIndexable: page.isIndexable,
      };
    });

  const topOpportunities: DemoInsightsResult['topOpportunities'] = [];

  for (const candidate of striking) {
    const blueprintQuery = site.queries.find((q) => q.query === candidate.query);
    const decision = decideContentAction({
      keyword: candidate.query,
      intent: 'INFORMATIONAL',
      funnelStage: 'AWARENESS',
      impressions: candidate.impressions,
      clicks: candidate.clicks,
      searchVolume: blueprintQuery?.searchVolume ?? null,
      currentPosition: candidate.position,
      existingPages: existingSummaries,
      thinContentWords: 300,
    });

    // The decision engine is allowed to say "leave this alone", and when it does there is nothing
    // to show the operator — writing a NO_ACTION row into the opportunities list would be noise.
    if (decision.decision === 'NO_ACTION') continue;

    const impact = clamp(candidate.potentialClicks / Math.max(50, candidate.impressions * 0.2));
    const priority = calculatePriority({
      impact,
      confidence: decision.confidence,
      businessValue: 0.7,
      effort: decision.decision === 'IMPROVE_EXISTING_PAGE' ? 2 : 4,
      risk: 1,
    });

    const row = await prisma.contentOpportunity.create({
      data: {
        websiteId,
        pageId: decision.targetPage?.id ?? null,
        keywordId: search.keywordIdByQuery.get(candidate.query) ?? null,
        type: decision.decision,
        status: 'IDENTIFIED',
        title: decision.suggestedTitle ?? `Improve coverage for "${candidate.query}"`,
        targetKeyword: candidate.query,
        suggestedUrl: decision.suggestedUrl,
        reasoning: `${candidate.reason} ${decision.reasoning}`,
        evidence: json({ strikingDistance: candidate, decision: decision.evidence }),
        impactScore: round(impact * 100, 1),
        effortScore: decision.decision === 'IMPROVE_EXISTING_PAGE' ? 2 : 4,
        confidenceScore: decision.confidence,
        priorityScore: priority.score,
        estimatedTrafficGain: candidate.potentialClicks,
        cannibalizationChecked: true,
        cannibalizationRisk: decision.cannibalizationRisk,
        existingPageMatch: decision.targetPage?.url ?? null,
        discoveredAt: new Date(now.getTime() - rng.int(1, 12) * 86_400_000),
      },
      select: { id: true },
    });
    topOpportunities.push({
      id: row.id,
      title: decision.suggestedTitle ?? candidate.query,
      targetKeyword: candidate.query,
      pageId: decision.targetPage?.id ?? null,
      priority: priority.score,
    });
  }

  for (const gap of ctrGaps) {
    const path = crawl.pages.find((page) => page.url === gap.page)?.path;
    const pageId = path ? pageIdByPath.get(path) ?? null : null;
    const impact = clamp(gap.potentialClicks / Math.max(40, gap.clicks + gap.potentialClicks));
    const priority = calculatePriority({ impact, confidence: 0.72, businessValue: 0.65, effort: 1, risk: 1 });
    const row = await prisma.contentOpportunity.create({
      data: {
        websiteId,
        pageId,
        keywordId: search.keywordIdByQuery.get(gap.query) ?? null,
        type: 'CTR_OPTIMISATION',
        status: 'IDENTIFIED',
        title: `Rewrite the title and description for "${gap.query}"`,
        targetKeyword: gap.query,
        reasoning: gap.reason,
        evidence: json(gap),
        impactScore: round(impact * 100, 1),
        effortScore: 1,
        confidenceScore: 0.72,
        priorityScore: priority.score,
        estimatedTrafficGain: gap.potentialClicks,
        cannibalizationChecked: false,
        discoveredAt: new Date(now.getTime() - rng.int(1, 9) * 86_400_000),
      },
      select: { id: true },
    });
    topOpportunities.push({
      id: row.id,
      title: `Rewrite the snippet for "${gap.query}"`,
      targetKeyword: gap.query,
      pageId,
      priority: priority.score,
    });
  }
  counts.ContentOpportunity = topOpportunities.length;

  // ── Structured data proposals for pages that have none ─────────────────────
  const schemaTargets = indexable.filter((page) => page.schemaTypes.length <= 1 && page.wordCount > 300).slice(0, 4);
  let schemaCount = 0;
  for (const page of schemaTargets) {
    const pageId = pageIdByPath.get(page.path);
    if (!pageId) continue;
    const result = generateSchemaForPage(
      {
        url: page.url,
        path: page.path,
        title: page.title,
        h1: page.h1[0] ?? null,
        metaDescription: page.metaDescription,
        textContent: page.textContent,
        headings: page.headings,
        pageType: page.pageType,
        publishedAt: page.publishedAt,
        contentUpdatedAt: page.contentUpdatedAt,
        existingSchemaTypes: page.schemaTypes,
      },
      {
        domain: site.domain,
        protocol: 'https',
        brandName: site.brandName,
        siteName: site.name,
        logoUrl: `https://${site.domain}/assets/logo.png`,
        organizationDescription: site.description,
        sameAs: [],
        language: 'en',
      },
      { isHomepage: page.path === '/' },
    );

    for (const generated of result.generated) {
      if (generated.redundant) continue;
      await prisma.structuredDataItem.create({
        data: {
          websiteId,
          pageId,
          schemaType: generated.schemaType,
          jsonLd: json(generated.jsonLd),
          source: 'generated',
          validationStatus: generated.validation.status,
          validationErrors: json(generated.validation.issues),
          deploymentStatus: 'NOT_DEPLOYED',
          notes: generated.reason,
        },
      });
      schemaCount++;
    }
  }
  counts.StructuredDataItem = schemaCount;

  // ── AI visibility ──────────────────────────────────────────────────────────
  const aiResult = await persistAiVisibility(site, websiteId, crawl, now, rng);
  Object.assign(counts, aiResult.counts);

  const contentScore = round(
    [...seoScores.values()].reduce((total, score) => total + score, 0) / Math.max(1, seoScores.size),
    1,
  );

  return {
    geoScore: geo.score,
    contentScore,
    aiVisibilityScore: aiResult.score,
    topOpportunities: topOpportunities.sort((a, b) => b.priority - a.priority),
    linkSuggestions,
    counts,
  };
}

function toGeoPageInput(page: DemoPage, pageId: string): GeoPageInput {
  return {
    id: pageId,
    url: page.url,
    title: page.title,
    h1: page.h1[0] ?? null,
    metaDescription: page.metaDescription,
    textContent: page.textContent,
    wordCount: page.wordCount,
    headings: page.headings,
    schemaTypes: page.schemaTypes,
    structuredData: page.structuredData,
    externalLinks: page.links
      .filter((link) => !link.isInternal)
      .map((link) => ({ href: link.href, anchorText: link.anchorText, isNofollow: link.isNofollow })),
    pageType: page.pageType,
    isIndexable: page.isIndexable,
  };
}

const DEMO_ANSWER_PREFIX = '[DEMO ANSWER — generated by the seed, not by a model] ';

/**
 * AI visibility prompts and runs.
 *
 * The seed must work with no API key, so these rows record a *simulated* observation and say so in
 * every field a human or another system might read: provider `demo`, method `seed`, and an answer
 * that opens by declaring what it is. Mention and citation rates are then computed from the runs,
 * not asserted, so the prompt-level numbers match the rows underneath them.
 */
async function persistAiVisibility(
  site: DemoSiteBlueprint,
  websiteId: string,
  crawl: DemoCrawl,
  now: Date,
  rng: Rng,
): Promise<{ score: number; counts: Record<string, number> }> {
  const runsPerPrompt = 3;
  const citableUrls = crawl.pages
    .filter((page) => page.isIndexable && page.wordCount > 400)
    .slice(0, 6)
    .map((page) => page.url);

  let promptCount = 0;
  let runCount = 0;
  let mentionCount = 0;
  let mentionedTotal = 0;
  let citedTotal = 0;

  for (const [index, blueprint] of site.aiPrompts.entries()) {
    const runs: Array<{ mentioned: boolean; cited: boolean; runAt: Date; position: number | null; competitors: string[] }> = [];
    for (let run = 0; run < runsPerPrompt; run++) {
      const mentioned = rng.bool(blueprint.mentionRate);
      runs.push({
        mentioned,
        cited: mentioned && rng.bool(0.55) && citableUrls.length > 0,
        runAt: new Date(now.getTime() - (run * 14 + 2) * 86_400_000),
        position: mentioned ? rng.int(1, 4) : null,
        competitors: blueprint.competitors.slice(0, rng.int(1, Math.max(1, blueprint.competitors.length))),
      });
    }

    const mentionRate = round(runs.filter((r) => r.mentioned).length / runs.length, 3);
    const citationRate = round(runs.filter((r) => r.cited).length / runs.length, 3);
    mentionedTotal += runs.filter((r) => r.mentioned).length;
    citedTotal += runs.filter((r) => r.cited).length;

    const prompt = await prisma.aiVisibilityPrompt.create({
      data: {
        websiteId,
        prompt: blueprint.prompt,
        category: blueprint.category,
        locale: 'en-US',
        priority: 90 - index * 7,
        isActive: true,
        source: 'seed:demo',
        expectedBrand: site.brandName,
        mentionRate,
        citationRate,
        lastRunAt: runs[0].runAt,
      },
      select: { id: true },
    });
    promptCount++;

    for (const run of runs) {
      const citedUrl = run.cited ? citableUrls[rng.int(0, citableUrls.length - 1)] : null;
      const answer =
        `${DEMO_ANSWER_PREFIX}For "${blueprint.prompt}", the answer names ` +
        `${run.competitors.join(', ') || 'no specific provider'}` +
        `${run.mentioned ? `, and mentions ${site.brandName} in position ${run.position}.` : `, and does not mention ${site.brandName}.`}`;

      const runRow = await prisma.aiVisibilityRun.create({
        data: {
          websiteId,
          promptId: prompt.id,
          provider: 'demo',
          model: 'demo-seed',
          method: 'seed',
          answerText: answer,
          brandMentioned: run.mentioned,
          brandPosition: run.position,
          brandSentiment: run.mentioned ? 'neutral' : null,
          citedUrls: citedUrl ? [citedUrl] : [],
          ourUrlsCited: citedUrl ? [citedUrl] : [],
          competitorsMentioned: run.competitors,
          confidence: 0.5,
          tokensUsed: null,
          costUsd: 0,
          runAt: run.runAt,
        },
        select: { id: true },
      });
      runCount++;

      const mentions = [
        ...(run.mentioned
          ? [{ entityName: site.brandName, isOurBrand: true, position: run.position, citedUrl }]
          : []),
        ...run.competitors.map((competitor, position) => ({
          entityName: competitor,
          isOurBrand: false,
          position: position + 1,
          citedUrl: null,
        })),
      ];
      await createManyChunked(prisma.aiVisibilityMention, mentions.map((mention) => ({
        runId: runRow.id,
        entityName: mention.entityName,
        isOurBrand: mention.isOurBrand,
        position: mention.position,
        context: `${DEMO_ANSWER_PREFIX}mention recorded for "${truncate(blueprint.prompt, 60)}"`,
        sentiment: mention.isOurBrand ? 'neutral' : null,
        citedUrl: mention.citedUrl,
      })));
      mentionCount += mentions.length;
    }
  }

  // Visibility score: how often the brand appears at all, weighted up when it is also cited.
  const totalRuns = Math.max(1, runCount);
  const score = round(clamp(mentionedTotal / totalRuns * 0.7 + citedTotal / totalRuns * 0.3) * 100, 1);

  return {
    score,
    counts: { AiVisibilityPrompt: promptCount, AiVisibilityRun: runCount, AiVisibilityMention: mentionCount },
  };
}
