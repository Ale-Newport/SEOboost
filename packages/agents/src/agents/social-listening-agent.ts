import { ai, isAiAvailable, socialTriagePrompt } from '@seo/ai';
import { Prisma, type SocialPlatform, json, prisma } from '@seo/db';
import {
  agentReachStatus,
  listen,
  readRedditCredentials,
  redditCommunityInfo,
  type SocialAccountSecrets,
  type SocialFinding,
} from '@seo/integrations';
import {
  classifyPromotionPolicy,
  conversationText,
  matchesNegative,
  MAX_REPLY_AGE_DAYS,
  scoreConversation,
  type CommunityPolicy,
  type TopicKind,
} from '@seo/seo-engine';
import { errorMessage, round, truncate } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import { notifyOnce, pluralise, result, skipped, step, throwIfAborted, toPromptKnowledgeBase } from './shared';
import { loadConnectedAccounts, loadSocialContext, type SocialSiteContext } from './social-shared';

const AGENT = 'SocialListeningAgent' as const;

/** Threads below this are not stored at all — they are noise, and the inbox must stay readable. */
const MIN_STORE_SCORE = 30;
/** Threads at or above this are worth a (paid) triage call. */
const TRIAGE_MIN_SCORE = 45;
const MAX_TRIAGE = 15;
const RESULTS_PER_SEARCH = 15;
/** Community rules are fetched for at most this many new communities per run. */
const MAX_COMMUNITY_LOOKUPS = 10;
const RULES_REFRESH_DAYS = 30;

const triageSchema = z.object({
  conversations: z.array(
    z.object({
      id: z.string(),
      fit: z.number().min(0).max(1),
      approach: z.enum(['REPLY_WITH_PRODUCT', 'HELPFUL_NO_PRODUCT', 'ENGAGE_BRAND_MENTION', 'SKIP']),
      reason: z.string(),
      angle: z.string().nullable(),
    }),
  ),
});

const inputSchema = z.object({
  topicIds: z.array(z.string()).optional(),
  triage: z.boolean().optional(),
});

const NO_TOPICS =
  'There are no active listening topics for this site. Add one on Social → Topics (a phrase your audience ' +
  'would use to describe the problem you solve), or run the Social strategy agent to propose a starting set.';

/**
 * A brand topic is the one listening query every site should have, and it needs no model: if
 * people are talking about the product, the operator should know. Created once, then left to
 * the operator to edit or pause.
 */
async function ensureBrandTopic(ctx: AgentContext, social: SocialSiteContext): Promise<void> {
  const existing = await prisma.socialTopic.findFirst({ where: { websiteId: ctx.websiteId, kind: 'brand' }, select: { id: true } });
  if (existing || social.brandName.length < 3) return;
  await prisma.socialTopic.upsert({
    where: { websiteId_query: { websiteId: ctx.websiteId, query: social.brandName } },
    create: {
      websiteId: ctx.websiteId,
      name: `Mentions of ${social.brandName}`,
      query: social.brandName,
      keywords: social.brandTerms.filter((term) => term !== social.brandName).slice(0, 5),
      platforms: ['REDDIT', 'HACKER_NEWS', 'BLUESKY'],
      kind: 'brand',
      source: 'auto',
    },
    update: {},
  });
}

interface CommunityState {
  policy: CommunityPolicy;
  isBlocked: boolean;
}

/**
 * Known communities, plus rules fetched for Reddit communities seen for the first time (or not
 * checked in a month). Rules are read from Reddit itself and classified deterministically.
 */
async function resolveCommunities(
  ctx: AgentContext,
  findings: readonly SocialFinding[],
  redditAccount: SocialAccountSecrets | null,
  /** Reddit already refused this run (rate limit, block): reading rules would only ask again. */
  redditPaused: boolean,
): Promise<Map<string, CommunityState>> {
  // Only Reddit communities publish moderator rules; "HN" or "Ask HN" is a section, not a
  // community with a self-promotion policy, and recording it would show "rules unchecked" forever.
  const names = [
    ...new Set(
      findings.flatMap((finding) =>
        finding.community && finding.platform === 'REDDIT' ? [`${finding.platform}|${finding.community}`] : [],
      ),
    ),
  ];
  const rows = await prisma.socialCommunity.findMany({
    where: { websiteId: ctx.websiteId },
    select: { platform: true, name: true, promotionPolicy: true, isBlocked: true, lastCheckedAt: true },
  });
  const known = new Map(rows.map((row) => [`${row.platform}|${row.name.toLowerCase()}`, row]));
  const states = new Map<string, CommunityState>();
  const stale = Date.now() - RULES_REFRESH_DAYS * 86_400_000;
  const creds = redditAccount ? readRedditCredentials(redditAccount.credentials) : null;

  let lookups = 0;
  for (const key of names) {
    const [platform, name] = key.split('|') as [SocialPlatform, string];
    const row = known.get(`${platform}|${name.toLowerCase()}`);
    const needsRules = platform === 'REDDIT' && !redditPaused && (!row || !row.lastCheckedAt || row.lastCheckedAt.getTime() < stale);
    if (needsRules && lookups < MAX_COMMUNITY_LOOKUPS) {
      lookups++;
      try {
        const info = await step(ctx, 'read_community_rules', { community: name }, () => redditCommunityInfo(name, creds), (value) => ({
          rules: value.rules.length,
          subscribers: value.subscribers,
        }));
        const classification = classifyPromotionPolicy(info.rules, info.description);
        const saved = await prisma.socialCommunity.upsert({
          where: { websiteId_platform_name: { websiteId: ctx.websiteId, platform, name: row?.name ?? name } },
          create: {
            websiteId: ctx.websiteId,
            platform,
            name,
            title: info.title,
            subscribers: info.subscribers,
            promotionPolicy: classification.policy,
            rulesSummary: classification.summary,
            rules: json(info.rules),
            lastCheckedAt: new Date(),
          },
          update: {
            title: info.title,
            subscribers: info.subscribers,
            promotionPolicy: classification.policy,
            rulesSummary: classification.summary,
            rules: json(info.rules),
            lastCheckedAt: new Date(),
          },
          select: { promotionPolicy: true, isBlocked: true },
        });
        states.set(key, { policy: saved.promotionPolicy, isBlocked: saved.isBlocked });
        continue;
      } catch (err) {
        ctx.log('community rules unavailable', { community: name, error: errorMessage(err) });
      }
    }
    if (row) {
      states.set(key, { policy: row.promotionPolicy, isBlocked: row.isBlocked });
    } else {
      // Record the community so the operator can see it, block it, or set its policy by hand.
      await prisma.socialCommunity.upsert({
        where: { websiteId_platform_name: { websiteId: ctx.websiteId, platform, name } },
        create: { websiteId: ctx.websiteId, platform, name },
        update: {},
      });
      states.set(key, { policy: 'UNKNOWN', isBlocked: false });
    }
  }
  return states;
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const input = inputSchema.parse(ctx.input ?? {});
  const social = await loadSocialContext(ctx.websiteId);
  await ensureBrandTopic(ctx, social);

  const topics = await prisma.socialTopic.findMany({
    where: { websiteId: ctx.websiteId, isActive: true, ...(input.topicIds?.length ? { id: { in: input.topicIds } } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  if (topics.length === 0) return skipped('No listening topics.', NO_TOPICS);

  const accounts = await loadConnectedAccounts(ctx.websiteId);
  const readAccounts: Partial<Record<SocialPlatform, SocialAccountSecrets>> = {};
  for (const { account, secrets } of accounts) {
    if (account.platform === 'REDDIT' || account.platform === 'BLUESKY') readAccounts[account.platform] = secrets;
  }
  const reach = await agentReachStatus();

  // ── gather ────────────────────────────────────────────────
  const since = new Date(Date.now() - 7 * 86_400_000);
  const pausedPlatforms = new Map<SocialPlatform, string>();
  const gathered: Array<{ topic: (typeof topics)[number]; finding: SocialFinding }> = [];
  const searchErrors: string[] = [];

  for (const topic of topics) {
    throwIfAborted(ctx);
    let count = 0;
    const topicErrors: string[] = [];
    for (const platform of topic.platforms) {
      const paused = pausedPlatforms.get(platform);
      if (paused) {
        topicErrors.push(`${platform}: ${paused}`);
        continue;
      }
      const outcome = await step(
        ctx,
        'search_conversations',
        { topic: topic.query, platform },
        () =>
          listen({
            platform,
            query: topic.query,
            limit: RESULTS_PER_SEARCH,
            since,
            accounts: readAccounts,
            ...(platform === 'REDDIT' && topic.communities.length ? { communities: topic.communities } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
        (value) => ({ backend: value.backend, found: value.findings.length, attempts: value.attempts }),
      );
      if (outcome.error) {
        const message = `${platform}: ${outcome.error.message}${outcome.error.hint ? ` (${outcome.error.hint})` : ''}`;
        topicErrors.push(message);
        if (outcome.error.final) pausedPlatforms.set(platform, `paused for this run after ${outcome.error.code}`);
      }
      for (const finding of outcome.findings) gathered.push({ topic, finding });
      count += outcome.findings.length;
    }
    await prisma.socialTopic.update({
      where: { id: topic.id },
      data: { lastRunAt: new Date(), lastResultCount: count, lastError: topicErrors.length ? truncate(topicErrors.join(' · '), 1_000) : null },
    });
    searchErrors.push(...topicErrors.map((error) => `"${topic.name}" — ${error}`));
  }

  const communities = await resolveCommunities(
    ctx,
    gathered.map((entry) => entry.finding),
    readAccounts.REDDIT ?? null,
    pausedPlatforms.has('REDDIT'),
  );

  // ── score & store ─────────────────────────────────────────
  let stored = 0;
  let dropped = 0;
  const brandMentions: Array<{ id: string; url: string; title: string }> = [];
  const seen = new Set<string>();
  for (const { topic, finding } of gathered) {
    throwIfAborted(ctx);
    const key = `${finding.platform}|${finding.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const text = conversationText(finding);
    const community = finding.community ? communities.get(`${finding.platform}|${finding.community}`) : undefined;
    if (matchesNegative(text, topic.negativeKeywords) || community?.isBlocked) {
      dropped++;
      continue;
    }
    const scored = scoreConversation(finding, {
      topicQuery: topic.query,
      topicKeywords: topic.keywords,
      topicKind: (['problem', 'brand', 'competitor'].includes(topic.kind) ? topic.kind : 'problem') as TopicKind,
      brandTerms: social.brandTerms,
      competitorTerms: social.competitorTerms,
      communityPolicy: community?.policy ?? (finding.community && finding.platform === 'REDDIT' ? 'UNKNOWN' : null),
    });
    if (scored.score < MIN_STORE_SCORE && scored.intent !== 'brand-mention') {
      dropped++;
      continue;
    }

    const data = {
      url: finding.url,
      title: finding.title,
      body: finding.body,
      author: finding.author,
      community: finding.community,
      publishedAt: finding.publishedAt,
      score: finding.score,
      commentCount: finding.commentCount,
      isLocked: finding.isLocked,
      intent: scored.intent,
      relevanceScore: scored.score,
      relevanceFactors: json({ factors: scored.factors, summary: scored.summary }),
      backend: finding.backend,
      lastCheckedAt: new Date(),
    } satisfies Prisma.SocialConversationUpdateInput;

    const row = await prisma.socialConversation.upsert({
      where: { websiteId_platform_externalId: { websiteId: ctx.websiteId, platform: finding.platform, externalId: finding.externalId } },
      create: { websiteId: ctx.websiteId, topicId: topic.id, platform: finding.platform, externalId: finding.externalId, ...data },
      update: data,
      select: { id: true, createdAt: true, updatedAt: true, status: true },
    });
    stored++;
    if (scored.intent === 'brand-mention' && row.status === 'NEW') {
      brandMentions.push({ id: row.id, url: finding.url, title: finding.title ?? truncate(finding.body ?? '', 80) });
    }
  }

  // Threads too old to answer leave the inbox; nothing is deleted.
  const expired = await prisma.socialConversation.updateMany({
    where: {
      websiteId: ctx.websiteId,
      status: { in: ['NEW', 'SHORTLISTED'] },
      publishedAt: { lt: new Date(Date.now() - MAX_REPLY_AGE_DAYS * 86_400_000) },
    },
    data: { status: 'EXPIRED' },
  });

  // ── triage (optional, scoped LLM) ────────────────────────
  let triaged = 0;
  let shortlisted = 0;
  let triageNote = 'Triage skipped — no AI provider is configured; conversations are ranked by the deterministic score only.';
  if (input.triage !== false && isAiAvailable()) {
    const candidates = await prisma.socialConversation.findMany({
      where: { websiteId: ctx.websiteId, status: 'NEW', triage: { equals: Prisma.DbNull }, relevanceScore: { gte: TRIAGE_MIN_SCORE } },
      orderBy: { relevanceScore: 'desc' },
      take: MAX_TRIAGE,
    });
    if (candidates.length > 0) {
      const communityPolicies = new Map([...communities.entries()].map(([key, state]) => [key, state.policy]));
      try {
        const answer = await step(
          ctx,
          'triage_conversations',
          { conversations: candidates.length },
          () =>
            ai.generateStructured({
              task: socialTriagePrompt.id,
              websiteId: ctx.websiteId,
              agent: AGENT,
              role: socialTriagePrompt.defaultRole ?? 'fast',
              system: socialTriagePrompt.system,
              prompt: socialTriagePrompt.render({
                brandName: social.brandName,
                domain: social.domain,
                productSummary: social.site.description ?? social.site.knowledgeBase?.businessDescription ?? '',
                knowledgeBase: toPromptKnowledgeBase(social.site.knowledgeBase),
                conversations: candidates.map((conversation) => ({
                  id: conversation.id,
                  platform: conversation.platform,
                  community: conversation.community,
                  title: conversation.title,
                  body: conversation.body,
                  intent: conversation.intent,
                  relevanceScore: conversation.relevanceScore,
                  ageHours: conversation.publishedAt ? round((Date.now() - conversation.publishedAt.getTime()) / 3_600_000, 0) : null,
                  communityPolicy: (conversation.community && communityPolicies.get(`${conversation.platform}|${conversation.community}`)) || 'UNKNOWN',
                })),
              }),
              schema: triageSchema,
              schemaName: 'social_conversation_triage',
              settings: social.site.settings,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            }),
          (value) => ({ triaged: value.data.conversations.length }),
        );
        const byId = new Map(candidates.map((conversation) => [conversation.id, conversation]));
        for (const verdict of answer.data.conversations) {
          if (!byId.has(verdict.id)) continue; // never trust an id the model made up
          const keep = verdict.approach !== 'SKIP' && verdict.fit >= 0.5;
          await prisma.socialConversation.update({
            where: { id: verdict.id },
            data: {
              triage: json({ ...verdict, fit: round(verdict.fit, 2), at: new Date().toISOString() }),
              ...(keep ? { status: 'SHORTLISTED' } : {}),
            },
          });
          triaged++;
          if (keep) shortlisted++;
        }
        triageNote = `${triaged} triaged, ${shortlisted} shortlisted for a reply.`;
      } catch (err) {
        triageNote = `Triage failed (${errorMessage(err)}); the deterministic ranking is unaffected.`;
      }
    } else {
      triageNote = 'Nothing new scored high enough to triage.';
    }
  }

  // ── notify ────────────────────────────────────────────────
  for (const mention of brandMentions.slice(0, 5)) {
    await notifyOnce({
      websiteId: ctx.websiteId,
      userId: ctx.userId ?? null,
      type: 'social.brand-mention',
      severity: 'INFO',
      title: `New mention of ${social.brandName}`,
      message: mention.title,
      link: `/sites/${ctx.websiteId}/social?tab=inbox`,
      data: { conversationId: mention.id, url: mention.url },
      dedupeKey: `social-mention:${mention.id}`,
    });
  }
  if (shortlisted > 0) {
    await notifyOnce({
      websiteId: ctx.websiteId,
      userId: ctx.userId ?? null,
      type: 'social.shortlist',
      severity: 'INFO',
      title: `${shortlisted} ${pluralise(shortlisted, 'conversation')} worth answering`,
      message: 'Social listening found threads where your product is a genuine fit. Review and draft replies from the Social inbox.',
      link: `/sites/${ctx.websiteId}/social?tab=inbox`,
      dedupeKey: `social-shortlist:${ctx.runId}`,
    });
  }

  const agentReachNote = reach.available ? '' : ' agent-reach is not installed, so X, YouTube, GitHub and similar platforms were not searched.';
  return result({
    summary:
      `Searched ${topics.length} ${pluralise(topics.length, 'topic')}: stored ${stored} relevant ${pluralise(stored, 'conversation')}, ` +
      `dropped ${dropped} as noise, expired ${expired.count}. ${triageNote}` +
      `${searchErrors.length ? ` ${searchErrors.length} ${pluralise(searchErrors.length, 'search')} failed.` : ''}${agentReachNote}`,
    confidence: stored > 0 ? 0.7 : 0.5,
    findings: [
      ...brandMentions.map((mention) => ({ kind: 'brand-mention', ...mention })),
      ...searchErrors.map((error) => ({ kind: 'search-error', error })),
    ],
    data: {
      topics: topics.length,
      stored,
      dropped,
      expired: expired.count,
      triaged,
      shortlisted,
      agentReach: reach,
      searchErrors,
      pausedPlatforms: Object.fromEntries(pausedPlatforms),
    },
  });
}

export const socialListeningAgent: AgentDefinition = {
  name: AGENT,
  label: 'Social listening',
  description:
    'Searches Reddit, Hacker News, Bluesky and (through agent-reach) X, YouTube, GitHub and more for conversations about the problem this site solves, scores them, reads community rules and shortlists the ones worth answering.',
  allowedActionTypes: [],
  tools: ['search_conversations', 'read_community_rules', 'triage_conversations'],
  requiresAi: false,
  inputSchema,
  run,
};

registerAgent(socialListeningAgent);
