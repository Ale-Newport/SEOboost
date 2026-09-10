import 'server-only';
import { prisma } from '@seo/db';
import { ForbiddenError, NotFoundError, formatDateKey, round, safeDivide } from '@seo/shared';
import { getAvailableProviders, isAiAvailable } from '@seo/ai';

/**
 * Read model for the AI visibility screen.
 *
 * Every number here is *counted* from stored `AiVisibilityRun` rows. With no runs recorded the
 * rates come back `null` rather than 0 — "we have never measured this" and "we measured 0%" are
 * different facts, and rendering the second when we mean the first would be an invented metric.
 *
 * These are observational measurements of what assistants said when we asked them, not rankings
 * and not a ranking signal. The screen says so; this module keeps the data honest enough for it
 * to be true.
 */

/** Upper bound on rows folded into the aggregates, so one busy site cannot blow up a render. */
const MAX_RUNS_SCANNED = 5_000;
/** Individual runs returned to the runs table. */
const RUN_LIMIT = 60;
/** Answers longer than this are truncated for the wire; the UI says when that happened. */
const ANSWER_SNAPSHOT_CHARS = 12_000;

export interface AiVisibilityRates {
  runs: number;
  mentions: number;
  citations: number;
  /** Percentage, or null when nothing has been measured. */
  mentionRate: number | null;
  citationRate: number | null;
}

export interface AiVisibilityPromptRow {
  id: string;
  prompt: string;
  category: string | null;
  locale: string;
  priority: number;
  isActive: boolean;
  /** `manual` for operator-entered prompts, `ai` for discovered ones. */
  source: string;
  expectedBrand: string | null;
  /** Rolling rate stored on the prompt, as a percentage. Null when never run. */
  mentionRate: number | null;
  citationRate: number | null;
  lastRunAt: Date | null;
  runCount: number;
  createdAt: Date;
}

export interface AiVisibilityRunRow {
  id: string;
  promptId: string;
  promptText: string;
  promptCategory: string | null;
  provider: string;
  model: string | null;
  /** `api` when we queried the provider, `manual` when an operator pasted the answer. */
  method: string;
  brandMentioned: boolean;
  brandPosition: number | null;
  brandSentiment: string | null;
  citedUrls: string[];
  ourUrlsCited: string[];
  competitorsMentioned: string[];
  confidence: number;
  error: string | null;
  runAt: Date;
  /** The stored answer, trimmed to a readable snapshot. */
  answerText: string;
  answerTruncated: boolean;
}

export interface ShareOfVoiceRow {
  name: string;
  mentions: number;
  /** Share of every brand mention across the window, or null when nothing was measured. */
  sharePct: number | null;
  isOurBrand: boolean;
}

export interface AiVisibilityProvider {
  name: string;
  configured: boolean;
  envVar: string;
}

export interface AiVisibilityData {
  website: { id: string; name: string; domain: string; protocol: string; aiVisibilityScore: number | null };
  brandName: string;
  window: { days: number; since: string; runsScanned: number; capped: boolean };
  totals: AiVisibilityRates;
  /** Active prompts with at least one run inside the window, over all active prompts. */
  promptCoverage: { covered: number; active: number; pct: number | null };
  byProvider: Array<{ provider: string } & AiVisibilityRates>;
  byMethod: Array<{ method: string } & AiVisibilityRates>;
  trend: Array<{ date: string } & AiVisibilityRates>;
  shareOfVoice: ShareOfVoiceRow[];
  prompts: AiVisibilityPromptRow[];
  runs: AiVisibilityRunRow[];
  totalRuns: number;
  providers: AiVisibilityProvider[];
  aiConfigured: boolean;
}

interface RateBucket {
  runs: number;
  mentions: number;
  citations: number;
}

function emptyBucket(): RateBucket {
  return { runs: 0, mentions: 0, citations: 0 };
}

function rates(bucket: RateBucket): AiVisibilityRates {
  return {
    ...bucket,
    mentionRate: bucket.runs === 0 ? null : round(safeDivide(bucket.mentions, bucket.runs, 0) * 100, 1),
    citationRate: bucket.runs === 0 ? null : round(safeDivide(bucket.citations, bucket.runs, 0) * 100, 1),
  };
}

/** Stored rolling rates are 0-1 fractions; the UI shows percentages. */
function toPercent(value: number | null): number | null {
  return value === null ? null : round(value * 100, 1);
}

/**
 * Everything the AI visibility screen renders, in one pass.
 *
 * `days` bounds the aggregation window; the prompts and the most recent runs are returned
 * regardless of it so the operator can always see the tracked set and the latest observations.
 */
export async function getAiVisibility(
  userId: string,
  websiteId: string,
  days = 90,
): Promise<AiVisibilityData> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: {
      id: true,
      userId: true,
      name: true,
      domain: true,
      protocol: true,
      brandName: true,
      aiVisibilityScore: true,
    },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const windowDays = Math.min(365, Math.max(1, Math.floor(days)));
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const [prompts, windowRuns, recentRuns, activePrompts, totalRuns] = await Promise.all([
    prisma.aiVisibilityPrompt.findMany({
      where: { websiteId },
      orderBy: [{ isActive: 'desc' }, { priority: 'desc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        prompt: true,
        category: true,
        locale: true,
        priority: true,
        isActive: true,
        source: true,
        expectedBrand: true,
        mentionRate: true,
        citationRate: true,
        lastRunAt: true,
        createdAt: true,
        _count: { select: { runs: true } },
      },
    }),
    prisma.aiVisibilityRun.findMany({
      where: { websiteId, runAt: { gte: since }, error: null },
      orderBy: { runAt: 'desc' },
      take: MAX_RUNS_SCANNED,
      select: {
        promptId: true,
        provider: true,
        method: true,
        brandMentioned: true,
        ourUrlsCited: true,
        competitorsMentioned: true,
        runAt: true,
      },
    }),
    prisma.aiVisibilityRun.findMany({
      where: { websiteId },
      orderBy: { runAt: 'desc' },
      take: RUN_LIMIT,
      select: {
        id: true,
        promptId: true,
        provider: true,
        model: true,
        method: true,
        answerText: true,
        brandMentioned: true,
        brandPosition: true,
        brandSentiment: true,
        citedUrls: true,
        ourUrlsCited: true,
        competitorsMentioned: true,
        confidence: true,
        error: true,
        runAt: true,
        prompt: { select: { prompt: true, category: true } },
      },
    }),
    prisma.aiVisibilityPrompt.count({ where: { websiteId, isActive: true } }),
    prisma.aiVisibilityRun.count({ where: { websiteId } }),
  ]);

  const brandName = website.brandName?.trim() || website.name;

  const overall = emptyBucket();
  const byProvider = new Map<string, RateBucket>();
  const byMethod = new Map<string, RateBucket>();
  const byDay = new Map<string, RateBucket>();
  const competitorMentions = new Map<string, number>();
  const promptsWithRuns = new Set<string>();
  let brandMentionCount = 0;

  for (const run of windowRuns) {
    promptsWithRuns.add(run.promptId);
    overall.runs += 1;

    const provider = byProvider.get(run.provider) ?? emptyBucket();
    provider.runs += 1;
    const method = byMethod.get(run.method) ?? emptyBucket();
    method.runs += 1;
    const dayKey = formatDateKey(run.runAt);
    const day = byDay.get(dayKey) ?? emptyBucket();
    day.runs += 1;

    if (run.brandMentioned) {
      overall.mentions += 1;
      provider.mentions += 1;
      method.mentions += 1;
      day.mentions += 1;
      brandMentionCount += 1;
    }
    if (run.ourUrlsCited.length > 0) {
      overall.citations += 1;
      provider.citations += 1;
      method.citations += 1;
      day.citations += 1;
    }
    for (const competitor of run.competitorsMentioned) {
      const name = competitor.trim();
      if (!name) continue;
      competitorMentions.set(name, (competitorMentions.get(name) ?? 0) + 1);
    }

    byProvider.set(run.provider, provider);
    byMethod.set(run.method, method);
    byDay.set(dayKey, day);
  }

  // Share of voice is measured against every brand named across the answers, ours included:
  // a competitor's 40% only means something relative to the whole field.
  const totalMentions =
    brandMentionCount + [...competitorMentions.values()].reduce((sum, count) => sum + count, 0);

  const shareOfVoice: ShareOfVoiceRow[] = [
    {
      name: brandName,
      mentions: brandMentionCount,
      sharePct: totalMentions === 0 ? null : round((brandMentionCount / totalMentions) * 100, 1),
      isOurBrand: true,
    },
    ...[...competitorMentions.entries()]
      .map(([name, mentions]) => ({
        name,
        mentions,
        sharePct: totalMentions === 0 ? null : round((mentions / totalMentions) * 100, 1),
        isOurBrand: false,
      }))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, 15),
  ];

  const coveredPrompts = prompts.filter(
    (prompt) => prompt.isActive && promptsWithRuns.has(prompt.id),
  ).length;

  return {
    website: {
      id: website.id,
      name: website.name,
      domain: website.domain,
      protocol: website.protocol,
      aiVisibilityScore: website.aiVisibilityScore,
    },
    brandName,
    window: {
      days: windowDays,
      since: formatDateKey(since),
      runsScanned: windowRuns.length,
      capped: windowRuns.length === MAX_RUNS_SCANNED,
    },
    totals: rates(overall),
    promptCoverage: {
      covered: coveredPrompts,
      active: activePrompts,
      pct: activePrompts === 0 ? null : round((coveredPrompts / activePrompts) * 100, 1),
    },
    byProvider: [...byProvider.entries()]
      .map(([provider, bucket]) => ({ provider, ...rates(bucket) }))
      .sort((a, b) => b.runs - a.runs),
    byMethod: [...byMethod.entries()]
      .map(([method, bucket]) => ({ method, ...rates(bucket) }))
      .sort((a, b) => b.runs - a.runs),
    trend: [...byDay.entries()]
      .map(([date, bucket]) => ({ date, ...rates(bucket) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    shareOfVoice,
    prompts: prompts.map((prompt) => ({
      id: prompt.id,
      prompt: prompt.prompt,
      category: prompt.category,
      locale: prompt.locale,
      priority: prompt.priority,
      isActive: prompt.isActive,
      source: prompt.source,
      expectedBrand: prompt.expectedBrand,
      mentionRate: toPercent(prompt.mentionRate),
      citationRate: toPercent(prompt.citationRate),
      lastRunAt: prompt.lastRunAt,
      runCount: prompt._count.runs,
      createdAt: prompt.createdAt,
    })),
    runs: recentRuns.map((run) => ({
      id: run.id,
      promptId: run.promptId,
      promptText: run.prompt.prompt,
      promptCategory: run.prompt.category,
      provider: run.provider,
      model: run.model,
      method: run.method,
      brandMentioned: run.brandMentioned,
      brandPosition: run.brandPosition,
      brandSentiment: run.brandSentiment,
      citedUrls: run.citedUrls,
      ourUrlsCited: run.ourUrlsCited,
      competitorsMentioned: run.competitorsMentioned,
      confidence: run.confidence,
      error: run.error,
      runAt: run.runAt,
      answerText: run.answerText.slice(0, ANSWER_SNAPSHOT_CHARS),
      answerTruncated: run.answerText.length > ANSWER_SNAPSHOT_CHARS,
    })),
    totalRuns,
    providers: getAvailableProviders().map((provider) => ({
      name: provider.name,
      configured: provider.configured,
      envVar: provider.envVar,
    })),
    aiConfigured: isAiAvailable(),
  };
}
