import {
  ai,
  aiVisibilityAnswerAnalysisPrompt,
  aiVisibilityPromptDiscoveryPrompt,
  isAiAvailable,
  resolveModel,
} from '@seo/ai';
import { json, prisma } from '@seo/db';
import { clamp, errorMessage, isSameSite, round, safeDivide, truncate } from '@seo/shared';
import type { ScoreFactor } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  loadSite,
  loadVerifiedFacts,
  pluralise,
  result,
  skipped,
  step,
  throwIfAborted,
  toPromptKnowledgeBase,
  unique,
} from './shared';

const AGENT = 'AIVisibilityAgent' as const;

const NO_AI =
  'AI visibility tracking needs a configured AI provider. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or ' +
  'GOOGLE_AI_API_KEY (Settings → AI). The platform only ever queries these official APIs — it never ' +
  'scrapes a consumer assistant interface.';

/** Discovery is capped hard: a thousand low-value prompts is a cost centre, not a benchmark. */
const MAX_DISCOVERED = 25;
const MAX_TRACKED_PROMPTS = 60;
const DEFAULT_RUN_LIMIT = 15;

const CATEGORY_PRIORITY: Record<string, number> = {
  RECOMMENDATION: 90,
  COMPARISON: 85,
  PROBLEM_SOLVING: 80,
  CATEGORY_DISCOVERY: 70,
  BUYING_PROCESS: 65,
  USE_CASE: 60,
  BRAND_DIRECT: 50,
};

const discoverySchema = z.object({
  prompts: z.array(
    z.object({
      prompt: z.string(),
      category: z.enum([
        'CATEGORY_DISCOVERY',
        'RECOMMENDATION',
        'COMPARISON',
        'BRAND_DIRECT',
        'PROBLEM_SOLVING',
        'BUYING_PROCESS',
        'USE_CASE',
      ]),
      buyerStage: z.string(),
      whyBrandShouldAppear: z.string(),
      likelyCompetitors: z.array(z.string()),
      brandMentionExpected: z.boolean(),
    }),
  ),
});

const analysisSchema = z.object({
  brandMentioned: z.boolean(),
  mentionPosition: z.number().int().positive().nullable(),
  mentionContext: z.enum([
    'RECOMMENDED',
    'LISTED_AMONG_OPTIONS',
    'COMPARED_UNFAVOURABLY',
    'MENTIONED_IN_PASSING',
    'CAUTIONED_AGAINST',
    'ABSENT',
  ]),
  sentiment: z.enum(['POSITIVE', 'NEUTRAL', 'NEGATIVE']),
  sentimentEvidence: z.string().nullable(),
  claimsAboutBrand: z.array(
    z.object({
      quote: z.string(),
      accuracy: z.enum(['ACCURATE', 'INACCURATE', 'UNVERIFIABLE']),
      whatIsWrong: z.string().nullable(),
    }),
  ),
  competitorsMentioned: z.array(
    z.object({ name: z.string(), position: z.number().int().positive().nullable(), characterisation: z.string() }),
  ),
  winningAttributes: z.array(z.string()),
  citedSources: z.array(z.string()),
  visibilityGap: z.string(),
});

// ── Scoring (pure) ────────────────────────────────────────────────────────────

export interface VisibilityTotals {
  runs: number;
  mentions: number;
  withOurCitation: number;
  positionSum: number;
  positioned: number;
  competitorMentions: number;
}

/**
 * The AI visibility score, 0-100, with its factors.
 *
 * This is an OBSERVATIONAL metric: it says how often the brand appeared in answers the platform
 * itself requested, from the providers it has keys for. It is not a market share, not a ranking,
 * and not comparable across sites with different prompt sets.
 */
export function aiVisibilityScore(totals: VisibilityTotals): { score: number; factors: ScoreFactor[]; summary: string } {
  const mentionRate = safeDivide(totals.mentions, totals.runs);
  const citationRate = safeDivide(totals.withOurCitation, totals.runs);
  const avgPosition = totals.positioned > 0 ? totals.positionSum / totals.positioned : null;
  // First mention is worth far more than sixth; 1 → 1.0, 6+ → ~0.
  const positionQuality = avgPosition === null ? 0 : clamp(1 - (avgPosition - 1) / 5);
  const shareOfVoice = safeDivide(totals.mentions, totals.mentions + totals.competitorMentions);

  const factors: ScoreFactor[] = [
    {
      key: 'mentionRate',
      label: 'Mention rate',
      value: clamp(mentionRate),
      weight: 0.45,
      contribution: round(clamp(mentionRate) * 45, 1),
      explanation: `The brand was named in ${totals.mentions} of ${totals.runs} tracked answers.`,
    },
    {
      key: 'citationRate',
      label: 'Citation rate',
      value: clamp(citationRate),
      weight: 0.25,
      contribution: round(clamp(citationRate) * 25, 1),
      explanation: `A URL on this domain was cited in ${totals.withOurCitation} of ${totals.runs} answers.`,
    },
    {
      key: 'positionQuality',
      label: 'Mention prominence',
      value: positionQuality,
      weight: 0.15,
      contribution: round(positionQuality * 15, 1),
      explanation:
        avgPosition === null
          ? 'The brand was never positioned among the named options.'
          : `Average position among named brands: ${avgPosition.toFixed(1)}.`,
    },
    {
      key: 'shareOfVoice',
      label: 'Share of voice',
      value: clamp(shareOfVoice),
      weight: 0.15,
      contribution: round(clamp(shareOfVoice) * 15, 1),
      explanation: `${totals.mentions} brand mentions against ${totals.competitorMentions} competitor mentions across the same answers.`,
    },
  ];

  const score = round(
    factors.reduce((total, factor) => total + factor.value * factor.weight, 0) * 100,
    1,
  );

  return {
    score,
    factors,
    summary:
      `Observed across ${totals.runs} tracked prompts run against the configured provider APIs. ` +
      `Mention rate ${(mentionRate * 100).toFixed(0)}%, citation rate ${(citationRate * 100).toFixed(0)}%.`,
  };
}

// ── Agent ─────────────────────────────────────────────────────────────────────

async function run(ctx: AgentContext): Promise<AgentResult> {
  if (!isAiAvailable()) return skipped('No AI provider configured.', NO_AI);

  const site = await loadSite(ctx.websiteId);
  const mode = ctx.input.mode === 'discover' ? 'discover' : ctx.input.mode === 'run' ? 'run' : 'auto';

  const activeCount = await prisma.aiVisibilityPrompt.count({
    where: { websiteId: ctx.websiteId, isActive: true },
  });

  if (mode === 'discover' || (mode === 'auto' && activeCount === 0)) {
    return discover(ctx, site, activeCount);
  }
  if (activeCount === 0) {
    return skipped(
      'No prompts to run.',
      'No AI visibility prompts are configured for this site. Run this agent with mode "discover" first.',
    );
  }
  return execute(ctx, site);
}

async function discover(
  ctx: AgentContext,
  site: Awaited<ReturnType<typeof loadSite>>,
  activeCount: number,
): Promise<AgentResult> {
  if (activeCount >= MAX_TRACKED_PROMPTS) {
    return result({
      summary: `${activeCount} prompts are already tracked — at the cap of ${MAX_TRACKED_PROMPTS}. Retire some before discovering more.`,
      confidence: 1,
      data: { activePrompts: activeCount, cap: MAX_TRACKED_PROMPTS },
    });
  }

  const [keywords, competitors, existing, facts] = await Promise.all([
    prisma.keyword.findMany({
      where: { websiteId: ctx.websiteId },
      orderBy: { opportunityScore: 'desc' },
      take: 60,
      select: { keyword: true },
    }),
    prisma.competitor.findMany({
      where: { websiteId: ctx.websiteId, isActive: true },
      select: { domain: true, name: true },
      take: 15,
    }),
    prisma.aiVisibilityPrompt.findMany({ where: { websiteId: ctx.websiteId }, select: { prompt: true }, take: 200 }),
    loadVerifiedFacts(ctx.websiteId),
  ]);

  const budget = Math.min(MAX_DISCOVERED, MAX_TRACKED_PROMPTS - activeCount);
  const answer = await step(
    ctx,
    'discover_ai_prompts',
    { keywords: keywords.length, competitors: competitors.length, budget },
    () =>
      ai.generateStructured({
        task: aiVisibilityPromptDiscoveryPrompt.id,
        websiteId: ctx.websiteId,
        agent: AGENT,
        role: aiVisibilityPromptDiscoveryPrompt.defaultRole ?? 'reasoning',
        system: aiVisibilityPromptDiscoveryPrompt.system,
        prompt: aiVisibilityPromptDiscoveryPrompt.render({
          siteName: site.name,
          domain: site.domain,
          brandName: site.brandName,
          businessCategory: site.businessCategory,
          audience: site.targetAudience,
          keywords: keywords.map((keyword) => keyword.keyword),
          competitors: competitors.map((competitor) => competitor.name ?? competitor.domain),
          existingPrompts: existing.map((entry) => entry.prompt),
          count: budget,
          knowledgeBase: toPromptKnowledgeBase(site.knowledgeBase),
          brandFacts: facts,
        }),
        schema: discoverySchema,
        schemaName: 'ai_visibility_prompts',
        settings: site.settings,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    (value) => ({ prompts: value.data.prompts.length }),
  );

  const locale = site.targetLocales[0] ?? 'en-US';
  const known = new Set(existing.map((entry) => entry.prompt.trim().toLowerCase()));
  let created = 0;

  for (const entry of answer.data.prompts.slice(0, budget)) {
    const text = entry.prompt.trim();
    if (!text || known.has(text.toLowerCase())) continue;
    known.add(text.toLowerCase());
    try {
      await prisma.aiVisibilityPrompt.create({
        data: {
          websiteId: ctx.websiteId,
          prompt: text,
          category: entry.category,
          locale,
          // Prompts where the brand is not expected to appear are still tracked, but below the
          // ones that measure whether we hold ground we should already hold.
          priority: (CATEGORY_PRIORITY[entry.category] ?? 50) - (entry.brandMentionExpected ? 0 : 10),
          isActive: true,
          source: 'ai',
          expectedBrand: entry.brandMentionExpected ? site.brandName ?? site.name : null,
        },
      });
      created++;
    } catch {
      // Unique on (websiteId, prompt, locale) — a concurrent run won the race.
    }
  }

  return result({
    summary: `Discovered ${created} new AI visibility ${pluralise(created, 'prompt')} (${activeCount + created} tracked, cap ${MAX_TRACKED_PROMPTS}).`,
    confidence: 0.7,
    findings: answer.data.prompts.slice(0, MAX_DISCOVERED).map((entry) => ({ kind: 'ai-prompt', ...entry })),
    data: {
      created,
      activePrompts: activeCount + created,
      cap: MAX_TRACKED_PROMPTS,
      note: 'These prompts become a fixed benchmark. Changing the set breaks comparability with earlier runs.',
    },
  });
}

async function execute(ctx: AgentContext, site: Awaited<ReturnType<typeof loadSite>>): Promise<AgentResult> {
  const limit =
    typeof ctx.input.limit === 'number' ? Math.max(1, Math.min(MAX_TRACKED_PROMPTS, ctx.input.limit)) : DEFAULT_RUN_LIMIT;

  const prompts = await step(
    ctx,
    'list_ai_prompts',
    { limit },
    () =>
      prisma.aiVisibilityPrompt.findMany({
        where: { websiteId: ctx.websiteId, isActive: true },
        orderBy: [{ priority: 'desc' }, { lastRunAt: 'asc' }],
        take: limit,
        select: { id: true, prompt: true, category: true, locale: true },
      }),
    (rows) => ({ prompts: rows.length }),
  );

  const brandName = site.brandName ?? site.name;
  const competitors = await prisma.competitor.findMany({
    where: { websiteId: ctx.websiteId, isActive: true },
    select: { domain: true, name: true },
    take: 25,
  });
  const competitorNames = unique(competitors.flatMap((competitor) => [competitor.name, competitor.domain].filter((value): value is string => Boolean(value))));

  // The model that answers the tracked prompt: an official provider API, never a scraped UI.
  const route = await resolveModel('reasoning', { settings: site.settings });

  const totals: VisibilityTotals = {
    runs: 0,
    mentions: 0,
    withOurCitation: 0,
    positionSum: 0,
    positioned: 0,
    competitorMentions: 0,
  };
  const findings: unknown[] = [];
  const competitorShare = new Map<string, number>();
  let failures = 0;

  for (const prompt of prompts) {
    throwIfAborted(ctx);
    try {
      const answer = await step(
        ctx,
        'ask_ai_assistant',
        { promptId: prompt.id, provider: route.providerName, model: route.model },
        () =>
          ai.generate({
            task: 'ai-visibility-probe',
            websiteId: ctx.websiteId,
            agent: AGENT,
            role: 'reasoning',
            // No system prompt: the point is to observe the assistant's unprompted answer.
            prompt: prompt.prompt,
            settings: site.settings,
            maxTokens: 1200,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        (value) => ({ chars: value.text.length }),
      );

      const analysis = await step(
        ctx,
        'analyse_ai_answer',
        { promptId: prompt.id },
        () =>
          ai.generateStructured({
            task: aiVisibilityAnswerAnalysisPrompt.id,
            websiteId: ctx.websiteId,
            agent: AGENT,
            role: aiVisibilityAnswerAnalysisPrompt.defaultRole ?? 'fast',
            system: aiVisibilityAnswerAnalysisPrompt.system,
            prompt: aiVisibilityAnswerAnalysisPrompt.render({
              prompt: prompt.prompt,
              answer: answer.text,
              engine: `${answer.provider}/${answer.model}`,
              brandName,
              domain: site.domain,
              competitors: competitorNames,
            }),
            schema: analysisSchema,
            schemaName: 'ai_answer_analysis',
            settings: site.settings,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        (value) => ({ mentioned: value.data.brandMentioned }),
      );

      const data = analysis.data;
      const citedUrls = unique(data.citedSources.filter((url) => url.startsWith('http')));
      const ourUrls = citedUrls.filter((url) => isSameSite(url, site.domain));

      const visibilityRun = await prisma.aiVisibilityRun.create({
        data: {
          websiteId: ctx.websiteId,
          promptId: prompt.id,
          provider: answer.provider,
          model: answer.model,
          method: 'api',
          answerText: truncate(answer.text, 20_000, ''),
          brandMentioned: data.brandMentioned,
          brandPosition: data.mentionPosition,
          brandSentiment: data.sentiment,
          citedUrls,
          ourUrlsCited: ourUrls,
          competitorsMentioned: data.competitorsMentioned.map((competitor) => competitor.name),
          confidence: 0.6,
          tokensUsed: answer.tokensIn + answer.tokensOut,
          costUsd: round(answer.costUsd + analysis.costUsd, 6),
        },
        select: { id: true },
      });

      if (data.brandMentioned) {
        await prisma.aiVisibilityMention.create({
          data: {
            runId: visibilityRun.id,
            entityName: brandName,
            isOurBrand: true,
            position: data.mentionPosition,
            context: data.mentionContext,
            sentiment: data.sentiment,
            citedUrl: ourUrls[0] ?? null,
          },
        });
      }
      for (const competitor of data.competitorsMentioned) {
        await prisma.aiVisibilityMention.create({
          data: {
            runId: visibilityRun.id,
            entityName: competitor.name,
            isOurBrand: false,
            position: competitor.position,
            context: competitor.characterisation,
          },
        });
        competitorShare.set(competitor.name, (competitorShare.get(competitor.name) ?? 0) + 1);
      }

      totals.runs++;
      if (data.brandMentioned) totals.mentions++;
      if (ourUrls.length > 0) totals.withOurCitation++;
      if (data.mentionPosition !== null) {
        totals.positionSum += data.mentionPosition;
        totals.positioned++;
      }
      totals.competitorMentions += data.competitorsMentioned.length;

      await prisma.aiVisibilityPrompt.update({
        where: { id: prompt.id },
        data: { lastRunAt: new Date() },
      });

      findings.push({
        kind: 'ai-visibility-answer',
        prompt: prompt.prompt,
        brandMentioned: data.brandMentioned,
        mentionContext: data.mentionContext,
        sentiment: data.sentiment,
        competitors: data.competitorsMentioned.map((competitor) => competitor.name),
        inaccurateClaims: data.claimsAboutBrand.filter((claim) => claim.accuracy === 'INACCURATE'),
        winningAttributes: data.winningAttributes,
        visibilityGap: data.visibilityGap,
        ourUrlsCited: ourUrls,
      });
    } catch (err) {
      failures++;
      ctx.log('ai visibility probe failed', { promptId: prompt.id, error: errorMessage(err) });
      await prisma.aiVisibilityRun.create({
        data: {
          websiteId: ctx.websiteId,
          promptId: prompt.id,
          provider: route.providerName,
          model: route.model,
          method: 'api',
          answerText: '',
          error: errorMessage(err),
        },
      });
    }
  }

  if (totals.runs === 0) {
    return skipped(
      'Every tracked prompt failed.',
      `All ${prompts.length} prompts failed against the configured provider (${route.providerName}). Check the API key and quota.`,
      { failures },
    );
  }

  const score = aiVisibilityScore(totals);
  await prisma.website.update({ where: { id: ctx.websiteId }, data: { aiVisibilityScore: score.score } });

  // Per-prompt rates, computed over that prompt's full history rather than this run alone.
  for (const prompt of prompts) {
    const runs = await prisma.aiVisibilityRun.findMany({
      where: { promptId: prompt.id, error: null },
      select: { brandMentioned: true, ourUrlsCited: true },
      take: 200,
    });
    if (runs.length === 0) continue;
    await prisma.aiVisibilityPrompt.update({
      where: { id: prompt.id },
      data: {
        mentionRate: round(safeDivide(runs.filter((entry) => entry.brandMentioned).length, runs.length), 3),
        citationRate: round(safeDivide(runs.filter((entry) => entry.ourUrlsCited.length > 0).length, runs.length), 3),
      },
    });
  }

  const shareOfVoice = [...competitorShare.entries()]
    .map(([name, mentions]) => ({ name, mentions, share: round(safeDivide(mentions, totals.runs), 3) }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 15);

  return result({
    summary:
      `Ran ${totals.runs} tracked ${pluralise(totals.runs, 'prompt')} against ${route.providerName}/${route.model}. ` +
      `The brand was mentioned in ${totals.mentions} (${Math.round(safeDivide(totals.mentions, totals.runs) * 100)}%) and ` +
      `a page on ${site.domain} was cited in ${totals.withOurCitation}. AI visibility score ${score.score}/100.` +
      (failures > 0 ? ` ${failures} ${pluralise(failures, 'prompt')} failed.` : ''),
    confidence: 0.6,
    findings,
    data: {
      metricType: 'OBSERVATIONAL',
      caveat:
        'These are observations of answers this platform requested from the AI provider APIs it has keys for, ' +
        'at one point in time. Assistant answers vary between runs, accounts and regions, and this is not a ' +
        'measurement of what any real user sees. No consumer assistant interface is scraped.',
      provider: route.providerName,
      model: route.model,
      promptsRun: totals.runs,
      failures,
      mentionRate: round(safeDivide(totals.mentions, totals.runs), 3),
      citationRate: round(safeDivide(totals.withOurCitation, totals.runs), 3),
      competitorShareOfVoice: shareOfVoice,
      score: score.score,
      scoreFactors: score.factors,
      scoreSummary: score.summary,
    },
  });
}

export const aiVisibilityAgent: AgentDefinition = {
  name: AGENT,
  label: 'AI visibility',
  description:
    'Tracks whether the brand appears in AI assistant answers, using the configured provider APIs only, and reports it as an observational metric.',
  allowedActionTypes: [],
  tools: ['discover_ai_prompts', 'list_ai_prompts', 'ask_ai_assistant', 'analyse_ai_answer'],
  requiresAi: true,
  run,
};

registerAgent(aiVisibilityAgent);
