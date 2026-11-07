import { ai, isAiAvailable, socialStrategyPrompt } from '@seo/ai';
import { type SocialPlatform, prisma } from '@seo/db';
import { agentReachStatus, bareSubreddit, LISTENING_PLATFORMS, needsAgentReach } from '@seo/integrations';
import { normalizeKeyword, truncate } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import { loadVerifiedFacts, pluralise, result, skipped, step, toPromptKnowledgeBase } from './shared';
import { loadSocialContext } from './social-shared';

const AGENT = 'SocialStrategyAgent' as const;

const PLATFORM_VALUES = [
  'REDDIT', 'HACKER_NEWS', 'X', 'BLUESKY', 'MASTODON', 'LINKEDIN', 'DEVTO', 'TELEGRAM', 'DISCORD',
  'YOUTUBE', 'GITHUB', 'FACEBOOK', 'INSTAGRAM', 'V2EX',
] as const satisfies readonly SocialPlatform[];

const strategySchema = z.object({
  listeningTopics: z.array(
    z.object({
      name: z.string(),
      query: z.string(),
      kind: z.enum(['problem', 'competitor']),
      platforms: z.array(z.enum(PLATFORM_VALUES)),
      keywords: z.array(z.string()),
      negativeKeywords: z.array(z.string()),
      communities: z.array(z.string()),
    }),
  ),
  communities: z.array(
    z.object({
      platform: z.enum(PLATFORM_VALUES),
      name: z.string(),
      expectedPolicy: z.enum(['ALLOWED', 'RESTRICTED', 'FORBIDDEN', 'UNKNOWN']),
      why: z.string(),
    }),
  ),
  contentPillars: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      pageUrls: z.array(z.string()),
      platforms: z.array(z.enum(PLATFORM_VALUES)),
    }),
  ),
  cadence: z.object({ ownedPostsPerDay: z.number(), repliesPerDay: z.number(), notes: z.string() }),
  summary: z.string(),
});

const MAX_NEW_TOPICS = 10;

async function run(ctx: AgentContext): Promise<AgentResult> {
  if (!isAiAvailable()) {
    return skipped(
      'No AI provider configured.',
      'The strategy agent needs an AI provider to propose topics. You can still add listening topics by hand on Social → Topics.',
    );
  }
  const social = await loadSocialContext(ctx.websiteId);
  const site = social.site;

  const [queries, pages, existingTopics, facts, reach] = await Promise.all([
    step(ctx, 'top_queries', { take: 30 }, () =>
      prisma.gscQueryMetric.groupBy({
        by: ['query'],
        where: { websiteId: ctx.websiteId, date: { gte: new Date(Date.now() - 90 * 86_400_000) } },
        _sum: { impressions: true },
        orderBy: { _sum: { impressions: 'desc' } },
        take: 30,
      }),
    ),
    step(ctx, 'top_pages', { take: 20 }, () =>
      prisma.page.findMany({
        where: { websiteId: ctx.websiteId, isIndexable: true, isActive: true },
        orderBy: { clicks28d: 'desc' },
        take: 20,
        select: { url: true, title: true },
      }),
    ),
    prisma.socialTopic.findMany({ where: { websiteId: ctx.websiteId }, select: { query: true } }),
    loadVerifiedFacts(ctx.websiteId),
    agentReachStatus(),
  ]);

  const availablePlatforms = LISTENING_PLATFORMS.filter((platform) => reach.available || !needsAgentReach(platform));

  const answer = await step(
    ctx,
    'propose_social_strategy',
    { platforms: availablePlatforms.length },
    () =>
      ai.generateStructured({
        task: socialStrategyPrompt.id,
        websiteId: ctx.websiteId,
        agent: AGENT,
        role: socialStrategyPrompt.defaultRole ?? 'reasoning',
        system: socialStrategyPrompt.system,
        prompt: socialStrategyPrompt.render({
          siteName: site.name,
          domain: social.domain,
          brandName: site.brandName,
          businessCategory: site.businessCategory,
          targetAudience: site.targetAudience,
          language: site.primaryLanguage,
          knowledgeBase: toPromptKnowledgeBase(site.knowledgeBase),
          brandFacts: facts,
          topQueries: queries.map((row) => row.query),
          topPages: pages,
          competitors: social.competitorTerms,
          existingTopics: existingTopics.map((topic) => topic.query),
          availablePlatforms,
        }),
        schema: strategySchema,
        schemaName: 'social_strategy',
        settings: site.settings,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    (value) => ({ topics: value.data.listeningTopics.length, communities: value.data.communities.length }),
  );
  const strategy = answer.data;

  // ── act: topics ────────────────────────────────────────────
  const known = new Set(existingTopics.map((topic) => normalizeKeyword(topic.query)));
  let topicsCreated = 0;
  for (const topic of strategy.listeningTopics) {
    if (topicsCreated >= MAX_NEW_TOPICS) break;
    const query = truncate(topic.query.trim(), 200);
    if (query.length < 3 || known.has(normalizeKeyword(query))) continue;
    known.add(normalizeKeyword(query));
    // Only platforms this installation can actually read; never an empty list.
    const platforms = topic.platforms.filter((platform) => availablePlatforms.includes(platform));
    await prisma.socialTopic.create({
      data: {
        websiteId: ctx.websiteId,
        name: truncate(topic.name.trim() || query, 120),
        query,
        kind: topic.kind,
        keywords: topic.keywords.slice(0, 8),
        negativeKeywords: topic.negativeKeywords.slice(0, 12),
        platforms: platforms.length ? platforms : ['REDDIT', 'HACKER_NEWS'],
        communities: topic.communities.filter((name) => /^(r\/)?[A-Za-z0-9_]{2,21}$/.test(name.trim())).map((name) => `r/${bareSubreddit(name)}`).slice(0, 8),
        source: 'ai',
      },
    });
    topicsCreated++;
  }

  // ── act: communities (policy left UNKNOWN until the real rules are read) ──
  let communitiesAdded = 0;
  for (const community of strategy.communities.slice(0, 20)) {
    const name = community.platform === 'REDDIT' ? `r/${bareSubreddit(community.name)}` : community.name.trim();
    if (!name || (community.platform === 'REDDIT' && !/^r\/[A-Za-z0-9_]{2,21}$/.test(name))) continue;
    const existing = await prisma.socialCommunity.findUnique({
      where: { websiteId_platform_name: { websiteId: ctx.websiteId, platform: community.platform, name } },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.socialCommunity.create({
      data: {
        websiteId: ctx.websiteId,
        platform: community.platform,
        name,
        notes: truncate(`Suggested by the strategy agent (expected: ${community.expectedPolicy.toLowerCase()}): ${community.why}`, 1_000),
      },
    });
    communitiesAdded++;
  }

  return result({
    summary:
      `${strategy.summary} Added ${topicsCreated} listening ${pluralise(topicsCreated, 'topic')} and ${communitiesAdded} ` +
      `${pluralise(communitiesAdded, 'community', 'communities')} to check. Community rules are verified on the next listening run, before anything is posted.`,
    confidence: 0.6,
    findings: [
      ...strategy.contentPillars.map((pillar) => ({ kind: 'content-pillar', ...pillar })),
      ...strategy.communities.map((community) => ({ kind: 'community', ...community })),
    ],
    data: { topicsCreated, communitiesAdded, cadence: strategy.cadence, contentPillars: strategy.contentPillars, availablePlatforms },
  });
}

export const socialStrategyAgent: AgentDefinition = {
  name: AGENT,
  label: 'Social strategy',
  description:
    'Proposes what to listen for (in the words your audience uses), which communities to watch and which content pillars to post about on your own channels.',
  allowedActionTypes: [],
  tools: ['top_queries', 'top_pages', 'propose_social_strategy'],
  requiresAi: true,
  run,
};

registerAgent(socialStrategyAgent);
