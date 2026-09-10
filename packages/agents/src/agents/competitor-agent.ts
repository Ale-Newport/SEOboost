import { ai, competitorGapAnalysisPrompt, isAiAvailable } from '@seo/ai';
import { json, prisma } from '@seo/db';
import {
  analyseKeywordGaps,
  buildCompetitorOverview,
  type CompetitorKeywordRow,
  type KeywordGap,
  type OurKeywordRow,
} from '@seo/seo-engine';
import { calculatePriority, riskLevelForActionType } from '@seo/seo-engine';
import { cleanDomain, clamp, errorMessage, getHostname, normalizeKeyword, round } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  jsonArray,
  loadSite,
  pluralise,
  result,
  skipped,
  step,
  throwIfAborted,
  unique,
} from './shared';

const AGENT = 'CompetitorAgent' as const;

const MAX_OPPORTUNITIES = 15;
const SNAPSHOT_LOOKBACK_DAYS = 60;

const gapAnalysisSchema = z.object({
  opportunities: z.array(
    z.object({
      gapType: z.enum(['CONTENT_GAP', 'QUALITY_GAP', 'FORMAT_GAP', 'DEPTH_GAP', 'ENTITY_GAP']),
      keywords: z.array(z.string()),
      competitors: z.array(z.string()),
      effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
      winnability: z.number().min(0).max(1),
      businessCase: z.string(),
      firstAction: z.string(),
    }),
  ),
  notWorthPursuing: z.array(z.object({ topic: z.string(), reason: z.string() })),
  topMoves: z.array(z.string()),
  biggestStructuralWeakness: z.string(),
  whereWeAreAhead: z.string().nullable(),
});

const NO_COMPETITOR_DATA =
  'There is no competitor ranking data for this site. Either add competitors manually (Site → Competitors) ' +
  'with their keyword data, or configure a SERP provider (DATAFORSEO_LOGIN/PASSWORD, SERPER_API_KEY or ' +
  'SERPAPI_KEY) so the platform can observe who ranks alongside you.';

/**
 * Competitor rows extracted from stored SERP snapshots.
 *
 * This reads snapshots another job captured rather than making SERP calls of its own: the agent
 * must be cheap enough to run on a schedule, and SERP calls are metered.
 */
async function competitorRowsFromSerp(
  websiteId: string,
  ourDomain: string,
): Promise<{ rows: CompetitorKeywordRow[]; snapshots: number }> {
  const since = new Date(Date.now() - SNAPSHOT_LOOKBACK_DAYS * 86_400_000);
  const snapshots = await prisma.serpSnapshot.findMany({
    where: { websiteId, capturedAt: { gte: since } },
    orderBy: { capturedAt: 'desc' },
    take: 500,
    select: { query: true, results: true },
  });

  const seen = new Set<string>();
  const rows: CompetitorKeywordRow[] = [];
  for (const snapshot of snapshots) {
    for (const entry of jsonArray(snapshot.results)) {
      const url = typeof entry.url === 'string' ? entry.url : null;
      const position = typeof entry.position === 'number' ? entry.position : null;
      if (!url || position === null) continue;
      const host = getHostname(url);
      if (!host) continue;
      const domain = cleanDomain(host);
      if (domain === ourDomain || domain.endsWith(`.${ourDomain}`)) continue;
      const key = `${domain}|${normalizeKeyword(snapshot.query)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ competitorDomain: domain, keyword: snapshot.query, position, url, estimatedVolume: null });
    }
  }
  return { rows, snapshots: snapshots.length };
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);
  const ourDomain = cleanDomain(site.domain);

  const competitors = await step(
    ctx,
    'list_competitors',
    { websiteId: ctx.websiteId },
    () =>
      prisma.competitor.findMany({
        where: { websiteId: ctx.websiteId, isActive: true },
        select: { id: true, domain: true, name: true },
        take: 50,
      }),
    (rows) => ({ competitors: rows.length }),
  );

  const ourKeywords: OurKeywordRow[] = (
    await step(
      ctx,
      'list_keywords',
      { websiteId: ctx.websiteId },
      () =>
        prisma.keyword.findMany({
          where: { websiteId: ctx.websiteId },
          orderBy: { impressions28d: 'desc' },
          take: 5000,
          select: { keyword: true, currentPosition: true, impressions28d: true, rankingUrl: true },
        }),
      (rows) => ({ keywords: rows.length }),
    )
  ).map((row) => ({
    keyword: row.keyword,
    position: row.currentPosition,
    impressions: row.impressions28d,
    url: row.rankingUrl,
  }));

  // Source 1: what a SERP provider observed. Source 2: rows already stored per competitor.
  const serp = await step(ctx, 'read_serp_snapshots', { days: SNAPSHOT_LOOKBACK_DAYS }, () =>
    competitorRowsFromSerp(ctx.websiteId, ourDomain),
  );

  const storedRows = await prisma.competitorKeyword.findMany({
    where: { competitorId: { in: competitors.map((competitor) => competitor.id) } },
    select: { keyword: true, position: true, url: true, estimatedVolume: true, competitorId: true },
    take: 20_000,
  });
  const domainById = new Map(competitors.map((competitor) => [competitor.id, cleanDomain(competitor.domain)]));
  const stored: CompetitorKeywordRow[] = storedRows.flatMap((row) => {
    const domain = domainById.get(row.competitorId);
    return domain
      ? [{ competitorDomain: domain, keyword: row.keyword, position: row.position, url: row.url, estimatedVolume: row.estimatedVolume }]
      : [];
  });

  const competitorRows = [...stored, ...serp.rows];
  if (competitorRows.length === 0) {
    return skipped('No competitor ranking data.', NO_COMPETITOR_DATA, {
      competitorsTracked: competitors.length,
      serpSnapshotsRead: serp.snapshots,
    });
  }

  const gaps = analyseKeywordGaps(ourKeywords, competitorRows, { maxResults: 300 });

  // ── Update competitor rows ────────────────────────────────────────────────
  const trackedDomains = unique(competitors.map((competitor) => cleanDomain(competitor.domain)));
  const observedDomains = unique(serp.rows.map((row) => row.competitorDomain));
  const overviews = trackedDomains.map((domain) => buildCompetitorOverview(domain, ourKeywords, competitorRows));

  for (const overview of overviews) {
    throwIfAborted(ctx);
    const competitor = competitors.find((entry) => cleanDomain(entry.domain) === overview.domain);
    if (!competitor) continue;
    await prisma.competitor.update({
      where: { id: competitor.id },
      data: {
        sharedKeywords: overview.sharedKeywords,
        gapKeywords: overview.gapKeywords,
        estimatedKeywords: overview.totalKeywords,
        serpOverlapPct: overview.serpOverlapPct,
        avgPosition: overview.avgPosition,
        topicalStrengths: overview.topicalStrengths,
        lastAnalysedAt: new Date(),
      },
    });

    // Persist the observed keyword rows for this competitor so the gaps table has evidence.
    const theirRows = competitorRows.filter((row) => row.competitorDomain === overview.domain).slice(0, 2000);
    const gapByKeyword = new Map(gaps.map((gap) => [normalizeKeyword(gap.keyword), gap]));
    for (const row of theirRows) {
      const normalized = normalizeKeyword(row.keyword);
      const gap = gapByKeyword.get(normalized);
      const ours = ourKeywords.find((entry) => normalizeKeyword(entry.keyword) === normalized) ?? null;
      await prisma.competitorKeyword.upsert({
        where: { competitorId_keyword: { competitorId: competitor.id, keyword: row.keyword } },
        create: {
          competitorId: competitor.id,
          keyword: row.keyword,
          position: row.position,
          url: row.url,
          ourPosition: ours?.position ?? null,
          isGap: Boolean(gap),
          gapScore: gap?.gapScore ?? null,
          estimatedVolume: row.estimatedVolume,
        },
        update: {
          position: row.position,
          url: row.url,
          ourPosition: ours?.position ?? null,
          isGap: Boolean(gap),
          gapScore: gap?.gapScore ?? null,
          estimatedVolume: row.estimatedVolume,
          observedAt: new Date(),
        },
      });
    }
  }

  // ── Opportunities for the strongest gaps ──────────────────────────────────
  const opportunitiesCreated = await createGapOpportunities(ctx, gaps);

  // ── Strategic summary (optional) ──────────────────────────────────────────
  let strategy: z.infer<typeof gapAnalysisSchema> | null = null;
  let strategyNote = 'No AI provider configured — gaps are reported without a strategic summary.';
  if (isAiAvailable() && gaps.length > 0) {
    try {
      const answer = await step(
        ctx,
        'summarise_competitor_gaps',
        { gaps: Math.min(gaps.length, 40) },
        () =>
          ai.generateStructured({
            task: competitorGapAnalysisPrompt.id,
            websiteId: ctx.websiteId,
            agent: AGENT,
            role: competitorGapAnalysisPrompt.defaultRole ?? 'reasoning',
            system: competitorGapAnalysisPrompt.system,
            prompt: competitorGapAnalysisPrompt.render({
              siteName: site.name,
              domain: site.domain,
              competitors: unique([...trackedDomains, ...observedDomains]).slice(0, 15),
              businessCategory: site.businessCategory,
              keywordGaps: gaps.slice(0, 40).map((gap) => ({
                keyword: gap.keyword,
                ourPosition: gap.ourPosition,
                competitorPositions: Object.fromEntries(
                  gap.competitorDomains.map((domain) => [domain, gap.bestCompetitorPosition]),
                ),
                volume: gap.estimatedVolume,
              })),
            }),
            schema: gapAnalysisSchema,
            schemaName: 'competitor_gap_analysis',
            settings: site.settings,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        (value) => ({ opportunities: value.data.opportunities.length }),
      );
      strategy = answer.data;
      strategyNote = answer.data.biggestStructuralWeakness;
    } catch (err) {
      ctx.log('competitor gap summary failed', { error: errorMessage(err) });
      strategyNote = `Strategic summary failed (${errorMessage(err)}); the deterministic gap list is unaffected.`;
    }
  }

  return result({
    summary:
      `${gaps.length} keyword ${pluralise(gaps.length, 'gap')} across ${trackedDomains.length} tracked and ` +
      `${observedDomains.length} observed ${pluralise(observedDomains.length, 'competitor')}. ` +
      `Created ${opportunitiesCreated} content ${pluralise(opportunitiesCreated, 'opportunity', 'opportunities')}. ${strategyNote}`,
    confidence: serp.snapshots > 0 ? 0.7 : 0.55,
    findings: [
      ...gaps.slice(0, 25).map((gap) => ({ kind: 'keyword-gap', ...gap })),
      ...(strategy ? strategy.opportunities.map((entry) => ({ kind: 'strategic-gap', ...entry })) : []),
      ...(strategy ? strategy.notWorthPursuing.map((entry) => ({ kind: 'gap-declined', ...entry })) : []),
    ],
    data: {
      competitorsTracked: trackedDomains.length,
      competitorsObserved: observedDomains,
      serpSnapshotsRead: serp.snapshots,
      competitorRows: competitorRows.length,
      gaps: gaps.length,
      opportunitiesCreated,
      overviews,
      topMoves: strategy?.topMoves ?? [],
      dataSource:
        serp.snapshots > 0
          ? 'Competitor positions observed in stored SERP snapshots, plus any keyword rows imported for tracked competitors.'
          : 'No SERP snapshots in the window — gaps come only from keyword rows already stored for tracked competitors.',
    },
  });
}

/**
 * Turn the strongest gaps into `ContentOpportunity` rows.
 *
 * A gap where we already rank becomes an improvement, never a new page: the same rule the content
 * strategy agent applies, because a competitor ranking for something is not a licence to publish
 * a second page on a topic we already cover.
 */
async function createGapOpportunities(ctx: AgentContext, gaps: readonly KeywordGap[]): Promise<number> {
  let created = 0;
  for (const gap of gaps.slice(0, MAX_OPPORTUNITIES)) {
    throwIfAborted(ctx);
    const normalized = normalizeKeyword(gap.keyword);
    const keyword = await prisma.keyword.findFirst({
      where: { websiteId: ctx.websiteId, normalized },
      select: { id: true, pageId: true, businessValue: true },
    });

    const type = gap.gapType === 'underperforming' ? 'IMPROVE_EXISTING_PAGE' : 'NEW_ARTICLE';
    const existing = await prisma.contentOpportunity.findFirst({
      where: {
        websiteId: ctx.websiteId,
        targetKeyword: gap.keyword,
        status: { in: ['IDENTIFIED', 'ACCEPTED', 'IN_PROGRESS'] },
      },
      select: { id: true },
    });
    if (existing) continue;

    const impact = clamp(gap.gapScore / 100);
    const effort = type === 'NEW_ARTICLE' ? 4 : 3;
    const confidence = clamp(0.45 + Math.min(gap.competitorCount, 4) * 0.1);
    const priority = calculatePriority({
      impact,
      confidence,
      businessValue: clamp(keyword?.businessValue ?? 0.5),
      effort,
      risk: riskLevelForActionType(type === 'NEW_ARTICLE' ? 'CREATE_CONTENT_BRIEF' : 'UPDATE_CONTENT'),
    });

    await prisma.contentOpportunity.create({
      data: {
        websiteId: ctx.websiteId,
        keywordId: keyword?.id ?? null,
        pageId: type === 'IMPROVE_EXISTING_PAGE' ? keyword?.pageId ?? null : null,
        type,
        status: 'IDENTIFIED',
        title:
          type === 'NEW_ARTICLE'
            ? `Cover "${gap.keyword}" — ${gap.competitorCount} ${pluralise(gap.competitorCount, 'competitor')} rank, we do not`
            : `Outrank competitors for "${gap.keyword}"`,
        targetKeyword: gap.keyword,
        reasoning: gap.reason,
        evidence: json({
          gapType: gap.gapType,
          gapScore: gap.gapScore,
          competitorDomains: gap.competitorDomains,
          bestCompetitorPosition: gap.bestCompetitorPosition,
          ourPosition: gap.ourPosition,
          estimatedVolume: gap.estimatedVolume,
          priorityFactors: priority.factors,
          source: 'competitor-gap-analysis',
        }),
        impactScore: round(impact, 3),
        effortScore: effort,
        confidenceScore: round(confidence, 3),
        priorityScore: priority.score,
        cannibalizationChecked: false,
      },
    });
    created++;
  }
  return created;
}

export const competitorAgent: AgentDefinition = {
  name: AGENT,
  label: 'Competitor analysis',
  description:
    'Compares our rankings with competitors observed in SERP snapshots or imported data, and turns the winnable gaps into opportunities.',
  allowedActionTypes: [],
  tools: ['list_competitors', 'list_keywords', 'read_serp_snapshots', 'summarise_competitor_gaps'],
  requiresAi: false,
  run,
};

registerAgent(competitorAgent);
