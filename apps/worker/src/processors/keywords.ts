/**
 * Keyword discovery, enrichment and clustering.
 *
 * The rule that shapes this whole file: **a keyword's numbers are either measured or absent.**
 * Search Console gives clicks, impressions, CTR and position — those are stored. Search volume,
 * CPC and competition come from a SERP provider — with no provider configured those columns
 * stay null and `keywords.enrich` reports exactly which keys would fill them, rather than
 * writing a plausible-looking estimate that the rest of the product would treat as fact.
 */

import {
  FunnelStage,
  KeywordSource,
  type Prisma,
  SearchIntent,
  createManyChunked,
  json,
  prisma,
} from '@seo/db';
import type { JobHandler } from '@seo/queue';
import {
  clamp,
  createLogger,
  errorMessage,
  lastNDays,
  lexicalCosine,
  normalizeKeyword,
  round,
  slugify,
  toUtcDate,
  truncate,
} from '@seo/shared';
import { ai, isAiAvailable, keywordExpansionPrompt } from '@seo/ai';
import {
  getKeywordMetricsProvider,
  listSerpProviders,
  serpKeywordMetrics,
} from '@seo/integrations';
import {
  calculateKeywordOpportunity,
  clusterKeywords,
  estimateGeoPotential,
  inferBusinessValue,
  inferFunnelStage,
  inferIntent,
  type ClusterableKeyword,
} from '@seo/seo-engine';
import { z } from 'zod';
import { effectiveSettings, loadWebsite, type WebsiteWithSettings } from '../lib/website';
import { loadQueryAggregates } from '../lib/gsc';
import { maxImpressionsOnSite, ROLLING_DAYS } from '../lib/metrics';
import { runChunked } from '../lib/batch';
import { skip } from '../lib/result';

const log = createLogger('worker:keywords');

/** Query rows read from the warehouse for one discovery run. */
const GSC_CANDIDATE_LIMIT = 3_000;

/** Keywords persisted per discovery run when the payload does not say otherwise. */
const DEFAULT_DISCOVER_LIMIT = 500;

/** Keywords sent to a metrics provider in one call. */
const METRICS_BATCH = 100;

/** Keywords loaded into one clustering pass; above this the largest by demand win. */
const CLUSTER_LIMIT = 5_000;

// ─────────────────────────────────────────────────────────────
// Shared scoring
// ─────────────────────────────────────────────────────────────

interface KeywordSignals {
  keyword: string;
  currentPosition: number | null;
  impressions28d: number;
  clicks28d: number;
  ctr28d: number | null;
  searchVolume: number | null;
  difficulty: number | null;
  /** Distinct URLs of ours that Search Console shows for this query. */
  rankingPageCount: number;
  hasTargetPage: boolean;
  intent: string;
}

/**
 * The opportunity score for one keyword, with every input drawn from something we measured.
 *
 * `competitorsRanking` is passed as null unless SERP data exists: the scorer treats null as
 * "unknown" and says so in its explanation, which is the honest answer on an install with no
 * SERP provider.
 */
function scoreKeyword(
  signals: KeywordSignals,
  context: { siteProfile: string; maxImpressions: number; competitorsRanking: number | null },
) {
  const relevance = clamp(lexicalCosine(signals.keyword, context.siteProfile));
  const businessValue = inferBusinessValue(signals.keyword, signals.intent);

  return calculateKeywordOpportunity({
    keyword: signals.keyword,
    currentPosition: signals.currentPosition,
    impressions28d: signals.impressions28d,
    clicks28d: signals.clicks28d,
    ctr28d: signals.ctr28d,
    searchVolume: signals.searchVolume,
    difficulty: signals.difficulty,
    relevance,
    businessValue,
    isContentGap: !signals.hasTargetPage && (signals.currentPosition === null || signals.currentPosition > 20),
    competitorsRanking: context.competitorsRanking,
    // Topical authority we can actually observe: how many of our own URLs the engine already
    // shows for this query. One page is normal, several means the site owns the topic.
    topicalAuthority: clamp(signals.rankingPageCount / 3),
    geoPotential: estimateGeoPotential(signals.keyword, signals.intent),
    maxImpressionsOnSite: context.maxImpressions,
  });
}

/** A short bag of words describing what the site is about, for the relevance factor. */
async function buildSiteProfile(website: WebsiteWithSettings): Promise<string> {
  const pages = await prisma.page.findMany({
    where: { websiteId: website.id, isActive: true, isIndexable: true },
    orderBy: { impressions28d: 'desc' },
    take: 60,
    select: { title: true, h1: true },
  });

  const parts = [
    website.name,
    website.brandName ?? '',
    website.description ?? '',
    website.businessCategory ?? '',
    website.targetAudience ?? '',
    ...pages.flatMap((page) => [page.title ?? '', page.h1 ?? '']),
  ];
  return parts.filter(Boolean).join(' ');
}

function intentOf(keyword: string): { intent: SearchIntent; funnelStage: FunnelStage } {
  const intent = inferIntent(keyword) as SearchIntent;
  return { intent, funnelStage: inferFunnelStage(intent) as FunnelStage };
}

// ─────────────────────────────────────────────────────────────
// keywords.discover
// ─────────────────────────────────────────────────────────────

interface Candidate {
  keyword: string;
  normalized: string;
  source: KeywordSource;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  rankingUrl: string | null;
  rankingPageCount: number;
}

export interface KeywordDiscoverResult {
  status: 'completed';
  sources: string[];
  candidates: number;
  created: number;
  updated: number;
  aiSuggestions: number;
  aiSkipped: string | null;
}

export const keywordsDiscover: JobHandler<'keywords.discover'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const settings = effectiveSettings(website);
  const limit = payload.limit ?? DEFAULT_DISCOVER_LIMIT;
  const sources = payload.sources ?? ['gsc', 'site', ...(payload.seeds?.length ? ['seeds' as const] : [])];
  const locale = website.targetLocales[0] ?? 'en-US';

  await ctx.updateProgress(5, 'Collecting keyword candidates');

  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate): void => {
    const existing = candidates.get(candidate.normalized);
    if (!existing) {
      candidates.set(candidate.normalized, candidate);
      return;
    }
    // Search Console evidence always wins over a text-derived guess.
    if (existing.impressions < candidate.impressions) candidates.set(candidate.normalized, candidate);
  };

  if (sources.includes('gsc')) {
    const rows = await loadQueryAggregates(website.id, lastNDays(ROLLING_DAYS, 3), {
      limit: GSC_CANDIDATE_LIMIT,
    });
    const byQuery = new Map<string, Candidate>();
    for (const row of rows) {
      const normalized = normalizeKeyword(row.query);
      if (!normalized) continue;
      const existing = byQuery.get(normalized);
      if (!existing) {
        byQuery.set(normalized, {
          keyword: row.query,
          normalized,
          source: KeywordSource.SEARCH_CONSOLE,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
          rankingUrl: row.page,
          rankingPageCount: 1,
        });
        continue;
      }
      existing.clicks += row.clicks;
      existing.rankingPageCount += 1;
      // Keep the best-performing URL as the ranking page for the query.
      if (row.impressions > existing.impressions) {
        existing.rankingUrl = row.page;
        existing.position = row.position;
      }
      existing.impressions += row.impressions;
      existing.ctr = existing.impressions > 0 ? round(existing.clicks / existing.impressions, 5) : null;
    }
    for (const candidate of byQuery.values()) add(candidate);
  }

  if (sources.includes('site')) {
    const pages = await prisma.page.findMany({
      where: { websiteId: website.id, isActive: true, isIndexable: true },
      orderBy: { impressions28d: 'desc' },
      take: 300,
      select: { title: true, h1: true },
    });
    for (const page of pages) {
      for (const raw of [page.h1, page.title]) {
        const phrase = cleanTitlePhrase(raw, website.brandName ?? website.name);
        const normalized = normalizeKeyword(phrase);
        if (!normalized || normalized.split(' ').length > 8) continue;
        add({
          keyword: phrase,
          normalized,
          source: KeywordSource.SITE_CONTENT,
          clicks: 0,
          impressions: 0,
          ctr: null,
          position: null,
          rankingUrl: null,
          rankingPageCount: 0,
        });
      }
    }
  }

  if (sources.includes('seeds')) {
    for (const seed of payload.seeds ?? []) {
      const normalized = normalizeKeyword(seed);
      if (!normalized) continue;
      add({
        keyword: seed.trim(),
        normalized,
        source: KeywordSource.MANUAL,
        clicks: 0,
        impressions: 0,
        ctr: null,
        position: null,
        rankingUrl: null,
        rankingPageCount: 0,
      });
    }
  }

  // ── optional AI expansion ────────────────────────────────
  let aiSuggestions = 0;
  let aiSkipped: string | null = null;
  const wantsAi = payload.seeds?.length ? true : candidates.size > 0;

  if (!isAiAvailable()) {
    aiSkipped =
      'No AI provider is configured, so the keyword set was not expanded beyond measured data.';
  } else if (wantsAi) {
    await ctx.updateProgress(30, 'Expanding the keyword set');
    try {
      const seedList = (payload.seeds?.length
        ? payload.seeds
        : [...candidates.values()].sort((a, b) => b.impressions - a.impressions).slice(0, 25).map((c) => c.keyword)
      ).slice(0, 25);

      const topics = await prisma.page.findMany({
        where: { websiteId: website.id, isActive: true, isIndexable: true },
        orderBy: { impressions28d: 'desc' },
        take: 60,
        select: { title: true },
      });

      const expansion = await ai.generateStructured({
        task: keywordExpansionPrompt.id,
        websiteId: website.id,
        settings: settings.models,
        system: keywordExpansionPrompt.system,
        prompt: keywordExpansionPrompt.render({
          siteName: website.name,
          domain: website.domain,
          seedKeywords: seedList,
          existingKeywords: [...candidates.keys()].slice(0, 200),
          siteTopics: topics.map((page) => page.title ?? '').filter(Boolean),
          targetCountry: website.targetCountry,
          language: website.primaryLanguage,
          maxSuggestions: 40,
        }),
        schema: z.object({
          suggestions: z
            .array(
              z.object({
                keyword: z.string().min(2),
                axis: z.string().nullable().optional(),
                relevance: z.number().min(0).max(1).nullable().optional(),
                rationale: z.string().nullable().optional(),
              }),
            )
            .max(80),
        }),
      });

      for (const suggestion of expansion.data.suggestions) {
        const normalized = normalizeKeyword(suggestion.keyword);
        if (!normalized || candidates.has(normalized)) continue;
        add({
          keyword: suggestion.keyword.trim(),
          normalized,
          source: KeywordSource.AI_EXPANSION,
          clicks: 0,
          impressions: 0,
          ctr: null,
          position: null,
          rankingUrl: null,
          rankingPageCount: 0,
        });
        aiSuggestions += 1;
      }
    } catch (err) {
      // An expansion failure must not lose the measured candidates already collected.
      aiSkipped = `Keyword expansion failed: ${errorMessage(err)}`;
      log.warn('keyword expansion failed', { websiteId: website.id, error: errorMessage(err) });
    }
  }

  // ── persist ──────────────────────────────────────────────
  await ctx.updateProgress(60, `Storing ${Math.min(candidates.size, limit)} keywords`);

  const ordered = [...candidates.values()]
    .sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks)
    .slice(0, limit);

  const [siteProfile, maxImpressions] = await Promise.all([
    buildSiteProfile(website),
    maxImpressionsOnSite(website.id),
  ]);

  const brand = (website.brandName ?? website.name).toLowerCase();
  const pageIdByUrl = await loadPageIndex(website.id, ordered.map((c) => c.rankingUrl));

  let created = 0;
  let updated = 0;

  for (let i = 0; i < ordered.length; i += 100) {
    const batch = ordered.slice(i, i + 100);
    const existing = await prisma.keyword.findMany({
      where: { websiteId: website.id, locale, normalized: { in: batch.map((c) => c.normalized) } },
      select: {
        id: true,
        normalized: true,
        currentPosition: true,
        bestPosition: true,
        searchVolume: true,
        difficulty: true,
        source: true,
      },
    });
    const existingByNormalized = new Map(existing.map((row) => [row.normalized, row]));

    const operations: Prisma.PrismaPromise<unknown>[] = [];
    for (const candidate of batch) {
      const prior = existingByNormalized.get(candidate.normalized);
      const { intent, funnelStage } = intentOf(candidate.keyword);
      const pageId = candidate.rankingUrl ? pageIdByUrl.get(candidate.rankingUrl) ?? null : null;

      const opportunity = scoreKeyword(
        {
          keyword: candidate.keyword,
          currentPosition: candidate.position,
          impressions28d: candidate.impressions,
          clicks28d: candidate.clicks,
          ctr28d: candidate.ctr,
          searchVolume: prior?.searchVolume ?? null,
          difficulty: prior?.difficulty ?? null,
          rankingPageCount: candidate.rankingPageCount,
          hasTargetPage: pageId !== null,
          intent,
        },
        { siteProfile, maxImpressions, competitorsRanking: null },
      );

      const shared = {
        keyword: candidate.keyword,
        intent,
        funnelStage,
        isBranded: candidate.normalized.includes(brand) && brand.length > 2,
        clicks28d: candidate.clicks,
        impressions28d: candidate.impressions,
        ctr28d: candidate.ctr,
        position28d: candidate.position,
        currentPosition: candidate.position,
        rankingUrl: candidate.rankingUrl,
        pageId,
        relevanceScore: opportunity.factors.find((factor) => factor.key === 'relevance')?.value ?? null,
        businessValue: opportunity.factors.find((factor) => factor.key === 'businessValue')?.value ?? null,
        opportunityScore: opportunity.score,
        opportunityReason: truncate(opportunity.summary, 800),
        opportunityFactors: json(opportunity.factors),
        geoPotential: opportunity.factors.find((factor) => factor.key === 'geoPotential')?.value ?? null,
        isContentGap: pageId === null && (candidate.position === null || candidate.position > 20),
        lastSeenAt: new Date(),
      };

      if (prior) {
        operations.push(
          prisma.keyword.update({
            where: { id: prior.id },
            data: {
              ...shared,
              previousPosition: prior.currentPosition,
              positionChange:
                prior.currentPosition !== null && candidate.position !== null
                  ? round(prior.currentPosition - candidate.position, 2)
                  : null,
              bestPosition: bestOf(prior.bestPosition, candidate.position),
            },
          }),
        );
        updated += 1;
      } else {
        operations.push(
          prisma.keyword.create({
            data: {
              websiteId: website.id,
              normalized: candidate.normalized,
              locale,
              language: website.primaryLanguage,
              country: website.targetCountry,
              source: candidate.source,
              bestPosition: candidate.position,
              ...shared,
            },
          }),
        );
        created += 1;
      }
    }

    await runChunked(operations, 100);
    await ctx.updateProgress(
      60 + Math.min(35, ((i + batch.length) / Math.max(1, ordered.length)) * 35),
      `Stored ${i + batch.length} of ${ordered.length}`,
    );
  }

  await ctx.updateProgress(100, 'Keyword discovery complete');
  const result: KeywordDiscoverResult = {
    status: 'completed',
    sources: [...sources],
    candidates: candidates.size,
    created,
    updated,
    aiSuggestions,
    aiSkipped,
  };
  return result;
};

/** Titles usually read "<topic> | <brand>"; the brand half is not a keyword. */
function cleanTitlePhrase(raw: string | null, brand: string): string {
  if (!raw) return '';
  const [head] = raw.split(/[|–—]/);
  const phrase = (head ?? raw).trim();
  const withoutBrand = phrase.replace(new RegExp(`\\b${escapeRegExp(brand)}\\b`, 'gi'), '').trim();
  return (withoutBrand.length >= 3 ? withoutBrand : phrase).replace(/\s{2,}/g, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bestOf(current: number | null, candidate: number | null): number | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return Math.min(current, candidate);
}

/** Resolves Search Console URLs to durable page ids, in one bounded query. */
async function loadPageIndex(
  websiteId: string,
  urls: Array<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set(urls.filter((url): url is string => Boolean(url)))].slice(0, 2_000);
  if (wanted.length === 0) return new Map();

  const rows = await prisma.page.findMany({
    where: { websiteId, OR: [{ url: { in: wanted } }, { normalizedUrl: { in: wanted } }] },
    select: { id: true, url: true, normalizedUrl: true },
  });

  const index = new Map<string, string>();
  for (const row of rows) {
    index.set(row.url, row.id);
    index.set(row.normalizedUrl, row.id);
  }
  return index;
}

// ─────────────────────────────────────────────────────────────
// keywords.enrich
// ─────────────────────────────────────────────────────────────

export interface KeywordEnrichResult {
  status: 'completed';
  provider: string;
  requested: number;
  enriched: number;
  withoutData: number;
  /** Set when the provider stopped answering part-way through, with the reason. */
  stoppedEarly?: string;
}

export const keywordsEnrich: JobHandler<'keywords.enrich'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const provider = getKeywordMetricsProvider();

  if (!provider) {
    const required = [...new Set(listSerpProviders().flatMap((entry) => entry.requiredEnv))];
    return skip(
      'No keyword-metrics provider is configured, so search volume, CPC and competition stay ' +
        'empty. Search Console still supplies clicks, impressions and position for these keywords.',
      required,
    );
  }

  const limit = payload.limit ?? 200;
  const staleBefore =
    payload.refreshOlderThanDays && payload.refreshOlderThanDays > 0
      ? new Date(Date.now() - payload.refreshOlderThanDays * 86_400_000)
      : null;

  const where: Prisma.KeywordWhereInput = payload.keywordIds?.length
    ? { websiteId: website.id, id: { in: payload.keywordIds } }
    : {
        websiteId: website.id,
        ...(staleBefore
          ? { OR: [{ searchVolume: null }, { updatedAt: { lt: staleBefore } }] }
          : { searchVolume: null }),
      };

  const keywords = await prisma.keyword.findMany({
    where,
    orderBy: { impressions28d: 'desc' },
    take: limit,
    select: {
      id: true,
      keyword: true,
      normalized: true,
      locale: true,
      currentPosition: true,
      impressions28d: true,
      clicks28d: true,
      ctr28d: true,
      difficulty: true,
      pageId: true,
    },
  });

  if (keywords.length === 0) {
    return skip('Every keyword already has provider metrics; nothing needed enriching.');
  }

  const [siteProfile, maxImpressions] = await Promise.all([
    buildSiteProfile(website),
    maxImpressionsOnSite(website.id),
  ]);

  const today = toUtcDate(new Date());
  let enriched = 0;
  let withoutData = 0;
  let stoppedEarly: string | null = null;

  for (let i = 0; i < keywords.length; i += METRICS_BATCH) {
    const batch = keywords.slice(i, i + METRICS_BATCH);
    const outcome = await serpKeywordMetrics(
      batch.map((row) => row.keyword),
      { locale: batch[0]?.locale ?? website.targetLocales[0] ?? 'en-US' },
    );

    if (!outcome.available) {
      // The provider dropped out mid-run: keep what was already written rather than
      // discarding it, and report the reason with the partial counts.
      stoppedEarly = outcome.reason;
      break;
    }

    const byKeyword = new Map(
      outcome.metrics.map((metric) => [normalizeKeyword(metric.keyword), metric]),
    );

    const operations: Prisma.PrismaPromise<unknown>[] = [];
    const metricRows: Prisma.KeywordMetricCreateManyInput[] = [];

    for (const keyword of batch) {
      const metric = byKeyword.get(keyword.normalized);
      if (!metric || metric.searchVolume === null) {
        withoutData += 1;
        continue;
      }

      const { intent } = intentOf(keyword.keyword);
      const opportunity = scoreKeyword(
        {
          keyword: keyword.keyword,
          currentPosition: keyword.currentPosition,
          impressions28d: keyword.impressions28d,
          clicks28d: keyword.clicks28d,
          ctr28d: keyword.ctr28d,
          searchVolume: metric.searchVolume,
          difficulty: keyword.difficulty,
          rankingPageCount: keyword.pageId ? 1 : 0,
          hasTargetPage: keyword.pageId !== null,
          intent,
        },
        { siteProfile, maxImpressions, competitorsRanking: null },
      );

      operations.push(
        prisma.keyword.update({
          where: { id: keyword.id },
          data: {
            searchVolume: metric.searchVolume,
            cpc: metric.cpc,
            competition: metric.competition,
            volumeSource: metric.source,
            opportunityScore: opportunity.score,
            opportunityReason: truncate(opportunity.summary, 800),
            opportunityFactors: json(opportunity.factors),
          },
        }),
      );
      metricRows.push({
        keywordId: keyword.id,
        date: today,
        searchVolume: metric.searchVolume,
        cpc: metric.cpc,
        source: metric.source,
      });
      enriched += 1;
    }

    await runChunked(operations, 100);
    if (metricRows.length) await createManyChunked(prisma.keywordMetric, metricRows, 250);

    await ctx.updateProgress(
      Math.min(95, ((i + batch.length) / keywords.length) * 100),
      `Enriched ${enriched} of ${keywords.length}`,
    );
  }

  await ctx.updateProgress(100, 'Keyword enrichment complete');
  if (enriched === 0 && stoppedEarly) return skip(stoppedEarly);

  const result: KeywordEnrichResult = {
    status: 'completed',
    provider: provider.name,
    requested: keywords.length,
    enriched,
    withoutData,
    ...(stoppedEarly ? { stoppedEarly } : {}),
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// keywords.cluster
// ─────────────────────────────────────────────────────────────

export interface KeywordClusterResultSummary {
  status: 'completed';
  method: 'embedding' | 'lexical';
  keywords: number;
  clusters: number;
  assigned: number;
  truncated: boolean;
}

export const keywordsCluster: JobHandler<'keywords.cluster'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, 'Loading keywords');

  const keywords = await prisma.keyword.findMany({
    where: {
      websiteId: website.id,
      ...(payload.keywordIds?.length ? { id: { in: payload.keywordIds } } : {}),
    },
    orderBy: { impressions28d: 'desc' },
    take: CLUSTER_LIMIT + 1,
    select: {
      id: true,
      keyword: true,
      normalized: true,
      impressions28d: true,
      clicks28d: true,
      searchVolume: true,
      currentPosition: true,
      intent: true,
      rankingUrl: true,
      opportunityScore: true,
    },
  });

  if (keywords.length === 0) {
    return skip(`${website.domain} has no keywords to cluster yet.`, [
      'Run keyword discovery first',
    ]);
  }

  const truncated = keywords.length > CLUSTER_LIMIT;
  const working = truncated ? keywords.slice(0, CLUSTER_LIMIT) : keywords;

  // Embeddings are used when the AI provider has already produced them; the engine falls back
  // to lexical similarity by itself when the vectors are absent.
  const vectors = new Map<string, number[]>();
  if (payload.method !== 'lexical') {
    for (let i = 0; i < working.length; i += 500) {
      const ids = working.slice(i, i + 500).map((row) => row.id);
      const rows = await prisma.embeddingRecord.findMany({
        where: { websiteId: website.id, ownerType: 'KEYWORD', keywordId: { in: ids } },
        select: { keywordId: true, vector: true },
      });
      for (const row of rows) {
        if (row.keywordId) vectors.set(row.keywordId, row.vector);
      }
    }
  }

  const clusterable: ClusterableKeyword[] = working.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    normalized: row.normalized,
    impressions: row.impressions28d,
    clicks: row.clicks28d,
    searchVolume: row.searchVolume,
    position: row.currentPosition,
    intent: row.intent,
    rankingUrl: row.rankingUrl,
    embedding: vectors.get(row.id) ?? null,
  }));

  await ctx.updateProgress(40, `Clustering ${clusterable.length} keywords`);
  const clusters = clusterKeywords(clusterable, {
    ...(payload.minClusterSize ? { minClusterSize: payload.minClusterSize } : {}),
  });

  const opportunityById = new Map(working.map((row) => [row.id, row.opportunityScore]));
  let assigned = 0;

  for (const cluster of clusters) {
    const members = cluster.keywordIds;
    const scores = members
      .map((id) => opportunityById.get(id))
      .filter((score): score is number => typeof score === 'number');
    const ranked = members.filter((id) => {
      const keyword = working.find((row) => row.id === id);
      return keyword?.currentPosition !== null && keyword?.currentPosition !== undefined;
    }).length;

    const row = await prisma.keywordCluster.upsert({
      where: { websiteId_slug: { websiteId: website.id, slug: cluster.slug } },
      create: {
        websiteId: website.id,
        slug: cluster.slug,
        name: cluster.name,
        parentTopic: cluster.parentTopic,
        intent: cluster.intent as SearchIntent,
        keywordCount: members.length,
        totalVolume: cluster.totalVolume,
        totalImpressions: cluster.totalImpressions,
        totalClicks: cluster.totalClicks,
        avgPosition: cluster.avgPosition,
        coverageScore: round(ranked / Math.max(1, members.length), 3),
        opportunityScore: scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 1) : null,
        centroid: cluster.centroid,
      },
      update: {
        name: cluster.name,
        parentTopic: cluster.parentTopic,
        intent: cluster.intent as SearchIntent,
        keywordCount: members.length,
        totalVolume: cluster.totalVolume,
        totalImpressions: cluster.totalImpressions,
        totalClicks: cluster.totalClicks,
        avgPosition: cluster.avgPosition,
        coverageScore: round(ranked / Math.max(1, members.length), 3),
        opportunityScore: scores.length ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 1) : null,
        centroid: cluster.centroid,
      },
      select: { id: true },
    });

    for (let i = 0; i < members.length; i += 500) {
      const batch = members.slice(i, i + 500);
      const updated = await prisma.keyword.updateMany({
        where: { id: { in: batch } },
        data: { clusterId: row.id },
      });
      assigned += updated.count;
    }
  }

  await ctx.updateProgress(100, `Wrote ${clusters.length} clusters`);
  log.info('keywords clustered', {
    websiteId: website.id,
    clusters: clusters.length,
    keywords: clusterable.length,
  });

  const result: KeywordClusterResultSummary = {
    status: 'completed',
    method: vectors.size > 0 ? 'embedding' : 'lexical',
    keywords: clusterable.length,
    clusters: clusters.length,
    assigned,
    truncated,
  };
  return result;
};

/** Slug helper kept local: cluster slugs come from the engine, this is only for fallbacks. */
export function clusterSlug(name: string): string {
  return slugify(name, 60);
}
