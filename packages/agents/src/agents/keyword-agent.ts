import { ai, isAiAvailable, keywordIntentPrompt } from '@seo/ai';
import { type FunnelStage, type SearchIntent, json, prisma } from '@seo/db';
import {
  calculateKeywordOpportunity,
  estimateGeoPotential,
  findCannibalization,
  findCtrOpportunities,
  findStrikingDistance,
  inferBusinessValue,
  inferFunnelStage,
  inferIntent,
  type QueryPageAggregate,
} from '@seo/seo-engine';
import {
  clamp,
  containsPhrase,
  errorMessage,
  lexicalCosine,
  normalizeKeyword,
  normalizeUrl,
  round,
  safeDivide,
  saturate,
  tokenize,
} from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  GSC_NOT_CONNECTED,
  comparisonWindows,
  gscAggregates,
  hasSearchConsoleData,
  loadSite,
  pluralise,
  result,
  skipped,
  step,
  throwIfAborted,
} from './shared';

const AGENT = 'KeywordAgent' as const;

/** Cost control: the LLM only ever sees the ambiguous head of the list, never the whole corpus. */
const DEFAULT_REFINE_LIMIT = 20;
const DEFAULT_KEYWORD_LIMIT = 400;

// ── Pure aggregation ──────────────────────────────────────────────────────────

export interface QueryRollup {
  query: string;
  normalized: string;
  clicks: number;
  impressions: number;
  ctr: number;
  /** Impression-weighted mean position across every URL that ranked for the query. */
  position: number;
  /** The URL that earned the most impressions for this query. */
  bestPage: string | null;
  pageCount: number;
}

/**
 * Collapse query × page rows to one row per query.
 *
 * Position is impression-weighted here (unlike the per-page read, which cannot be) because a
 * query ranking #3 on a page with 10,000 impressions and #40 on one with 12 is a #3 query.
 */
export function rollupQueries(rows: readonly QueryPageAggregate[]): QueryRollup[] {
  const byQuery = new Map<string, { query: string; clicks: number; impressions: number; weighted: number; pages: Map<string, number> }>();

  for (const row of rows) {
    const key = normalizeKeyword(row.query);
    if (!key) continue;
    let entry = byQuery.get(key);
    if (!entry) {
      entry = { query: row.query, clicks: 0, impressions: 0, weighted: 0, pages: new Map() };
      byQuery.set(key, entry);
    }
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    entry.pages.set(row.page, (entry.pages.get(row.page) ?? 0) + row.impressions);
  }

  const out: QueryRollup[] = [];
  for (const [normalized, entry] of byQuery) {
    const bestPage = [...entry.pages.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({
      query: entry.query,
      normalized,
      clicks: entry.clicks,
      impressions: entry.impressions,
      ctr: round(safeDivide(entry.clicks, entry.impressions), 4),
      position: round(safeDivide(entry.weighted, entry.impressions), 2),
      bestPage,
      pageCount: entry.pages.size,
    });
  }
  return out.sort((a, b) => b.impressions - a.impressions);
}

/**
 * How much of the site already speaks to a query's topic, measured as the number of distinct
 * URLs that earn impressions for queries sharing a significant token with it.
 *
 * A proxy, not a claim about authority in the abstract — but it is derived only from observed
 * Search Console data, which is the point.
 */
export function topicalAuthorityIndex(rollups: readonly QueryRollup[]): Map<string, number> {
  const pagesByToken = new Map<string, Set<string>>();
  for (const rollup of rollups) {
    if (!rollup.bestPage) continue;
    for (const token of tokenize(rollup.normalized, { minLength: 4 })) {
      let set = pagesByToken.get(token);
      if (!set) {
        set = new Set();
        pagesByToken.set(token, set);
      }
      set.add(rollup.bestPage);
    }
  }

  const out = new Map<string, number>();
  for (const rollup of rollups) {
    const pages = new Set<string>();
    for (const token of tokenize(rollup.normalized, { minLength: 4 })) {
      for (const page of pagesByToken.get(token) ?? []) pages.add(page);
    }
    // 5 covering URLs is treated as the half-way point of "this site owns the topic".
    out.set(rollup.normalized, round(saturate(pages.size, 5), 3));
  }
  return out;
}

// ── LLM refinement ────────────────────────────────────────────────────────────

const INTENTS = ['INFORMATIONAL', 'NAVIGATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'LOCAL', 'UNKNOWN'] as const;
const FUNNEL_STAGES = ['AWARENESS', 'CONSIDERATION', 'DECISION', 'RETENTION', 'UNKNOWN'] as const;

const intentRefinementSchema = z.object({
  keywords: z.array(
    z.object({
      keyword: z.string(),
      intent: z.enum(INTENTS),
      funnelStage: z.enum(FUNNEL_STAGES),
      pageType: z.string().nullable(),
      commercialValue: z.number().min(0).max(1),
      difficultySignal: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

/** The prompt's taxonomy has a RETENTION stage the schema does not; it is not a funnel stage we act on. */
function toFunnelStage(value: (typeof FUNNEL_STAGES)[number]): FunnelStage {
  return value === 'RETENTION' ? 'UNKNOWN' : value;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

interface KeywordWrite {
  rollup: QueryRollup;
  intent: SearchIntent;
  funnelStage: FunnelStage;
  businessValue: number;
  geoPotential: number;
  relevance: number;
  topicalAuthority: number;
  isContentGap: boolean;
  hasCannibalization: boolean;
  isBranded: boolean;
  pageId: string | null;
  intentSource: 'heuristic' | 'llm';
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);

  if (!(await hasSearchConsoleData(ctx.websiteId))) {
    return skipped('No Search Console data for this site.', GSC_NOT_CONNECTED);
  }

  const limit = typeof ctx.input.limit === 'number' ? Math.max(1, Math.min(2000, ctx.input.limit)) : DEFAULT_KEYWORD_LIMIT;
  const refineLimit =
    typeof ctx.input.refineLimit === 'number' ? Math.max(0, Math.min(50, ctx.input.refineLimit)) : DEFAULT_REFINE_LIMIT;

  const windows = comparisonWindows();
  const rows = await step(
    ctx,
    'get_search_console_queries',
    { from: windows.current.start.toISOString().slice(0, 10), to: windows.current.end.toISOString().slice(0, 10) },
    () => gscAggregates(ctx.websiteId, windows.current, 5000),
    (value) => ({ queryPagePairs: value.length }),
  );

  if (rows.length === 0) {
    return result({
      summary: 'Search Console is connected but returned no query rows for the last 28 days.',
      confidence: 0.5,
      data: { window: { start: windows.current.start, end: windows.current.end }, rows: 0 },
    });
  }

  const striking = findStrikingDistance(rows);
  const ctrOpportunities = findCtrOpportunities(rows, {
    minImpressions: site.settings?.ctrOpportunityMinImpressions ?? undefined,
  });
  const cannibalization = findCannibalization(rows);
  const cannibalizedQueries = new Set(cannibalization.map((group) => normalizeKeyword(group.query)));

  const rollups = rollupQueries(rows);
  const authority = topicalAuthorityIndex(rollups);
  const maxImpressions = rollups[0]?.impressions ?? 0;

  // Pages we own, so a keyword can be linked to the URL that actually ranks for it.
  const pages = await step(
    ctx,
    'list_pages',
    { websiteId: ctx.websiteId },
    () =>
      prisma.page.findMany({
        where: { websiteId: ctx.websiteId, isActive: true },
        select: { id: true, normalizedUrl: true, title: true, h1: true, metaDescription: true },
        take: 10_000,
      }),
    (value) => ({ pages: value.length }),
  );
  const pageByUrl = new Map(pages.map((page) => [page.normalizedUrl, page]));

  const competitorCounts = await competitorRankingCounts(ctx.websiteId);
  const selected = rollups.slice(0, limit);

  const writes: KeywordWrite[] = selected.map((rollup) => {
    const intent = inferIntent(rollup.query);
    const normalizedPage = rollup.bestPage ? normalizeUrl(rollup.bestPage) : null;
    const page = normalizedPage ? pageByUrl.get(normalizedPage) ?? null : null;
    const pageText = page ? [page.title, page.h1, page.metaDescription].filter(Boolean).join(' ') : '';
    return {
      rollup,
      intent,
      funnelStage: inferFunnelStage(intent),
      businessValue: inferBusinessValue(rollup.query, intent),
      geoPotential: estimateGeoPotential(rollup.query, intent),
      // The site is already being served for this query, so relevance has a floor; the lexical
      // match with the ranking page's own metadata refines it upwards.
      relevance: page ? clamp(0.5 + 0.5 * lexicalCosine(rollup.query, pageText)) : 0.5,
      topicalAuthority: authority.get(rollup.normalized) ?? 0,
      isContentGap: page === null || rollup.position > 20,
      hasCannibalization: cannibalizedQueries.has(rollup.normalized),
      isBranded: site.brandName ? containsPhrase(rollup.query, site.brandName) : false,
      pageId: page?.id ?? null,
      intentSource: 'heuristic',
    };
  });

  // ── Optional LLM pass, strictly bounded ─────────────────────────────────────
  let refined = 0;
  let refineNote = 'Intent classification is heuristic only.';
  const ambiguous = writes
    .filter((write) => write.intent === 'UNKNOWN')
    .sort((a, b) => b.rollup.impressions - a.rollup.impressions)
    .slice(0, refineLimit);

  if (ambiguous.length > 0 && refineLimit > 0) {
    if (!isAiAvailable()) {
      refineNote =
        `${ambiguous.length} ${pluralise(ambiguous.length, 'keyword')} could not be classified heuristically. ` +
        'Configure an AI provider to have them classified; they stay UNKNOWN until then.';
    } else {
      try {
        const answer = await step(
          ctx,
          'refine_keyword_intent',
          { keywords: ambiguous.length },
          () =>
            ai.generateStructured({
              task: keywordIntentPrompt.id,
              websiteId: ctx.websiteId,
              agent: AGENT,
              role: keywordIntentPrompt.defaultRole ?? 'fast',
              system: keywordIntentPrompt.system,
              prompt: keywordIntentPrompt.render({
                siteName: site.name,
                domain: site.domain,
                businessCategory: site.businessCategory,
                targetCountry: site.targetCountry,
                keywords: ambiguous.map((write) => ({
                  keyword: write.rollup.query,
                  volume: write.rollup.impressions,
                  currentPosition: write.rollup.position,
                })),
              }),
              schema: intentRefinementSchema,
              schemaName: 'keyword_intent',
              settings: site.settings,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            }),
          (value) => ({ classified: value.data.keywords.length }),
        );

        const byKeyword = new Map(answer.data.keywords.map((entry) => [normalizeKeyword(entry.keyword), entry]));
        for (const write of ambiguous) {
          const entry = byKeyword.get(write.rollup.normalized);
          // Only take the model's answer when it is actually confident; otherwise UNKNOWN is
          // the honest label.
          if (!entry || entry.confidence < 0.5 || entry.intent === 'UNKNOWN') continue;
          write.intent = entry.intent;
          write.funnelStage = toFunnelStage(entry.funnelStage);
          write.businessValue = clamp(entry.commercialValue);
          write.geoPotential = estimateGeoPotential(write.rollup.query, entry.intent);
          write.intentSource = 'llm';
          refined++;
        }
        refineNote = `${refined} of ${ambiguous.length} ambiguous keywords were classified by the model (top ${refineLimit} by impressions only).`;
      } catch (err) {
        // A refinement failure must not lose the deterministic work already done.
        ctx.log('keyword intent refinement failed', { error: errorMessage(err) });
        refineNote = `Intent refinement failed (${errorMessage(err)}); heuristic intents were kept.`;
      }
    }
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  const locale = site.targetLocales[0] ?? 'en-US';
  let created = 0;
  let updated = 0;
  const scored: Array<{ keyword: string; score: number; summary: string }> = [];

  for (const write of writes) {
    throwIfAborted(ctx);
    const { rollup } = write;
    const opportunity = calculateKeywordOpportunity({
      keyword: rollup.query,
      currentPosition: rollup.position > 0 ? rollup.position : null,
      impressions28d: rollup.impressions,
      clicks28d: rollup.clicks,
      ctr28d: rollup.ctr,
      searchVolume: null,
      difficulty: null,
      relevance: write.relevance,
      businessValue: write.businessValue,
      isContentGap: write.isContentGap,
      competitorsRanking: competitorCounts.get(rollup.normalized) ?? null,
      topicalAuthority: write.topicalAuthority,
      geoPotential: write.geoPotential,
      maxImpressionsOnSite: maxImpressions,
    });

    const common = {
      keyword: rollup.query,
      language: site.primaryLanguage,
      country: site.targetCountry,
      intent: write.intent,
      funnelStage: write.funnelStage,
      isBranded: write.isBranded,
      currentPosition: rollup.position > 0 ? rollup.position : null,
      rankingUrl: rollup.bestPage,
      clicks28d: rollup.clicks,
      impressions28d: rollup.impressions,
      ctr28d: rollup.ctr,
      position28d: rollup.position > 0 ? rollup.position : null,
      relevanceScore: round(write.relevance, 3),
      businessValue: round(write.businessValue, 3),
      geoPotential: round(write.geoPotential, 3),
      opportunityScore: opportunity.score,
      opportunityReason: opportunity.summary,
      opportunityFactors: json({ factors: opportunity.factors, intentSource: write.intentSource }),
      isContentGap: write.isContentGap,
      hasCannibalization: write.hasCannibalization,
      pageId: write.pageId,
      lastSeenAt: new Date(),
    };

    const existing = await prisma.keyword.findUnique({
      where: { websiteId_normalized_locale: { websiteId: ctx.websiteId, normalized: rollup.normalized, locale } },
      select: { id: true, bestPosition: true, currentPosition: true },
    });

    if (existing) {
      const previous = existing.currentPosition;
      await prisma.keyword.update({
        where: { id: existing.id },
        data: {
          ...common,
          previousPosition: previous,
          positionChange:
            previous !== null && common.currentPosition !== null ? round(common.currentPosition - previous, 2) : null,
          bestPosition:
            common.currentPosition === null
              ? existing.bestPosition
              : existing.bestPosition === null
                ? common.currentPosition
                : Math.min(existing.bestPosition, common.currentPosition),
        },
      });
      updated++;
    } else {
      await prisma.keyword.create({
        data: {
          ...common,
          websiteId: ctx.websiteId,
          normalized: rollup.normalized,
          locale,
          source: 'SEARCH_CONSOLE',
          bestPosition: common.currentPosition,
        },
      });
      created++;
    }

    scored.push({ keyword: rollup.query, score: opportunity.score, summary: opportunity.summary });
  }

  scored.sort((a, b) => b.score - a.score);

  return result({
    summary:
      `Scored ${writes.length} ${pluralise(writes.length, 'keyword')} from Search Console (${created} new, ${updated} updated). ` +
      `${striking.length} striking-distance ${pluralise(striking.length, 'opportunity', 'opportunities')}, ` +
      `${ctrOpportunities.length} CTR ${pluralise(ctrOpportunities.length, 'gap')}, ` +
      `${cannibalization.length} cannibalisation ${pluralise(cannibalization.length, 'group')}. ${refineNote}`,
    confidence: 0.75,
    findings: [
      ...striking.slice(0, 15).map((entry) => ({ kind: 'striking-distance', ...entry })),
      ...ctrOpportunities.slice(0, 15).map((entry) => ({ kind: 'ctr-opportunity', ...entry })),
      ...cannibalization.slice(0, 10).map((entry) => ({ kind: 'cannibalisation', ...entry })),
    ],
    data: {
      window: { start: windows.current.start, end: windows.current.end },
      queryPagePairs: rows.length,
      keywordsScored: writes.length,
      created,
      updated,
      refined,
      topOpportunities: scored.slice(0, 20),
      method:
        'Opportunity scores come from calculateKeywordOpportunity over observed Search Console metrics. ' +
        'Search volume and difficulty stay empty unless a SERP provider is configured.',
    },
  });
}

/** How many tracked competitors rank top-10 for each keyword, when competitor data exists. */
async function competitorRankingCounts(websiteId: string): Promise<Map<string, number>> {
  const rows = await prisma.competitorKeyword.findMany({
    where: { competitor: { websiteId, isActive: true }, position: { lte: 10 } },
    select: { keyword: true, competitorId: true },
    take: 20_000,
  });
  const byKeyword = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = normalizeKeyword(row.keyword);
    let set = byKeyword.get(key);
    if (!set) {
      set = new Set();
      byKeyword.set(key, set);
    }
    set.add(row.competitorId);
  }
  return new Map([...byKeyword].map(([keyword, set]) => [keyword, set.size]));
}

export const keywordAgent: AgentDefinition = {
  name: AGENT,
  label: 'Keyword intelligence',
  description:
    'Turns Search Console queries into scored keyword rows, flagging striking-distance, CTR and cannibalisation opportunities.',
  allowedActionTypes: [],
  tools: ['get_search_console_queries', 'list_pages', 'refine_keyword_intent'],
  requiresAi: false,
  run,
};

registerAgent(keywordAgent);
