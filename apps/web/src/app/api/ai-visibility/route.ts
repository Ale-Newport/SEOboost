import { z } from 'zod';
import { prisma } from '@seo/db';
import { formatDateKey, round, safeDivide } from '@seo/shared';
import { getAvailableProviders, isAiAvailable } from '@seo/ai';
import { readQuery, route } from '@/lib/api';
import { requireScopedWebsite, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/ai-visibility?websiteId=` — how the brand shows up in AI answers.
 *
 * Every number here is counted from stored `AiVisibilityRun` rows. With no runs recorded the
 * rates are `null` rather than 0 — "we have never measured this" and "we measured 0%" are
 * different facts, and showing the second when we mean the first is the kind of invented
 * metric this codebase refuses to produce.
 */

const querySchema = websiteScopeSchema.extend({
  days: z.coerce.number().int().min(1).max(365).default(90),
  /** Cap on the number of individual runs returned in `recentRuns`. */
  runLimit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Upper bound on rows folded into the aggregates, so one busy site cannot blow up the request. */
const MAX_RUNS_SCANNED = 5_000;

interface RateBucket {
  runs: number;
  mentions: number;
  citations: number;
}

function emptyBucket(): RateBucket {
  return { runs: 0, mentions: 0, citations: 0 };
}

function rates(bucket: RateBucket): {
  runs: number;
  mentions: number;
  citations: number;
  mentionRate: number | null;
  citationRate: number | null;
} {
  return {
    ...bucket,
    mentionRate: bucket.runs === 0 ? null : round(safeDivide(bucket.mentions, bucket.runs, 0) * 100, 1),
    citationRate: bucket.runs === 0 ? null : round(safeDivide(bucket.citations, bucket.runs, 0) * 100, 1),
  };
}

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireScopedWebsite(user, query.websiteId);
  const since = new Date(Date.now() - query.days * 86_400_000);

  const [prompts, runs, recentRuns, promptCount] = await Promise.all([
    prisma.aiVisibilityPrompt.findMany({
      where: { websiteId: website.id },
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
      where: { websiteId: website.id, runAt: { gte: since }, error: null },
      orderBy: { runAt: 'desc' },
      take: MAX_RUNS_SCANNED,
      select: {
        promptId: true,
        provider: true,
        method: true,
        brandMentioned: true,
        brandPosition: true,
        ourUrlsCited: true,
        competitorsMentioned: true,
        runAt: true,
      },
    }),
    prisma.aiVisibilityRun.findMany({
      where: { websiteId: website.id },
      orderBy: { runAt: 'desc' },
      take: query.runLimit,
      select: {
        id: true,
        promptId: true,
        provider: true,
        model: true,
        method: true,
        brandMentioned: true,
        brandPosition: true,
        brandSentiment: true,
        citedUrls: true,
        ourUrlsCited: true,
        competitorsMentioned: true,
        confidence: true,
        error: true,
        runAt: true,
        prompt: { select: { id: true, prompt: true, category: true } },
      },
    }),
    prisma.aiVisibilityPrompt.count({ where: { websiteId: website.id, isActive: true } }),
  ]);

  const overall = emptyBucket();
  const byProvider = new Map<string, RateBucket>();
  const byDay = new Map<string, RateBucket>();
  const shareOfVoice = new Map<string, number>();
  const brandName = website.brandName?.trim() || website.name;
  let brandMentionCount = 0;

  for (const run of runs) {
    overall.runs += 1;
    const provider = byProvider.get(run.provider) ?? emptyBucket();
    provider.runs += 1;
    const dayKey = formatDateKey(run.runAt);
    const day = byDay.get(dayKey) ?? emptyBucket();
    day.runs += 1;

    if (run.brandMentioned) {
      overall.mentions += 1;
      provider.mentions += 1;
      day.mentions += 1;
      brandMentionCount += 1;
    }
    if (run.ourUrlsCited.length > 0) {
      overall.citations += 1;
      provider.citations += 1;
      day.citations += 1;
    }
    for (const competitor of run.competitorsMentioned) {
      const name = competitor.trim();
      if (!name) continue;
      shareOfVoice.set(name, (shareOfVoice.get(name) ?? 0) + 1);
    }

    byProvider.set(run.provider, provider);
    byDay.set(dayKey, day);
  }

  // Share of voice is measured against every brand mentioned across the answers, ours included:
  // a competitor's 40% only means something relative to the whole field.
  const totalMentions =
    brandMentionCount + [...shareOfVoice.values()].reduce((sum, count) => sum + count, 0);

  const competitors = [...shareOfVoice.entries()]
    .map(([name, mentions]) => ({
      name,
      mentions,
      sharePct: totalMentions === 0 ? null : round((mentions / totalMentions) * 100, 1),
      isOurBrand: false,
    }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 25);

  const ourShare = {
    name: brandName,
    mentions: brandMentionCount,
    sharePct: totalMentions === 0 ? null : round((brandMentionCount / totalMentions) * 100, 1),
    isOurBrand: true,
  };

  const trend = [...byDay.entries()]
    .map(([date, bucket]) => ({ date, ...rates(bucket) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    websiteId: website.id,
    brandName,
    window: { days: query.days, since: formatDateKey(since), runsScanned: runs.length, capped: runs.length === MAX_RUNS_SCANNED },
    totals: rates(overall),
    byProvider: [...byProvider.entries()]
      .map(([provider, bucket]) => ({ provider, ...rates(bucket) }))
      .sort((a, b) => b.runs - a.runs),
    shareOfVoice: [ourShare, ...competitors],
    trend,
    prompts,
    activePrompts: promptCount,
    recentRuns,
    /** Which providers this installation can query directly; the rest need manual import. */
    providers: getAvailableProviders().map((provider) => ({
      name: provider.name,
      configured: provider.configured,
      envVar: provider.envVar,
    })),
    aiConfigured: isAiAvailable(),
  };
});
