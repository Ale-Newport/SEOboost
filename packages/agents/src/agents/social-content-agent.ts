import { ai, isAiAvailable, socialPostDraftPrompt } from '@seo/ai';
import { prisma } from '@seo/db';
import { canPublishWith, getPublisher } from '@seo/integrations';
import {
  canonicalShareUrl,
  evaluatePostGuardrails,
  fitTitle,
  fitToPlatform,
  planDailyPosts,
  PLATFORM_TEXT_RULES,
  socialActionTypeFor,
  utmSourceFor,
  withUtm,
  type ContentCandidate,
  type PlannedPost,
  type SocialPlatformName,
} from '@seo/seo-engine';
import { clamp, errorMessage, truncate } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  jsonObject,
  loadVerifiedFacts,
  pluralise,
  propose,
  result,
  skipped,
  step,
  throwIfAborted,
  toPromptKnowledgeBase,
} from './shared';
import {
  findCommunity,
  LIVE_POST_STATUSES,
  loadConnectedAccounts,
  loadSocialContext,
  ownedCommunities,
  postsTodayOnAccount,
  type SocialSiteContext,
} from './social-shared';

const AGENT = 'SocialContentAgent' as const;

const draftSchema = z.object({
  title: z.string().nullable(),
  body: z.string(),
  hashtags: z.array(z.string()),
  reviewerNotes: z.array(z.string()),
});

const inputSchema = z.object({
  /** Plan for these accounts only. */
  accountIds: z.array(z.string()).optional(),
  /** Share exactly this page instead of letting the planner choose. */
  pageId: z.string().optional(),
});

/** Platforms where hashtags are part of the culture; elsewhere they read as spam. */
const HASHTAG_PLATFORMS = new Set<SocialPlatformName>(['X', 'BLUESKY', 'MASTODON', 'LINKEDIN']);

const NO_ACCOUNTS =
  'No social account is connected for posting. Connect one on Social → Accounts (Bluesky, Mastodon, X, LinkedIn, ' +
  'Reddit, Dev.to, Telegram or Discord) — the agent only ever posts to accounts you own and connected yourself.';

async function pageExcerpt(pageId: string): Promise<string | null> {
  const crawlPage = await prisma.crawlPage.findFirst({
    where: { pageId, textContent: { not: null } },
    orderBy: { crawledAt: 'desc' },
    select: { textContent: true },
  });
  return crawlPage?.textContent ? truncate(crawlPage.textContent, 6_000) : null;
}

/** Without a model the post is the page's own title and description — honest, if plain. */
function fallbackDraft(candidate: ContentCandidate, summary: string | null): z.infer<typeof draftSchema> {
  return {
    title: candidate.title,
    body: [candidate.title, summary].filter(Boolean).join('\n\n') || candidate.url,
    hashtags: [],
    reviewerNotes: ['Written without an AI provider: this is the page title and meta description. Edit before approving.'],
  };
}

async function draftPost(
  ctx: AgentContext,
  social: SocialSiteContext,
  planned: PlannedPost,
  facts: Awaited<ReturnType<typeof loadVerifiedFacts>>,
): Promise<{ draft: z.infer<typeof draftSchema>; summary: string | null; usedAi: boolean }> {
  const page = await prisma.page.findUnique({
    where: { id: planned.candidate.pageId },
    select: { metaDescription: true, h1: true },
  });
  const summary = page?.metaDescription ?? page?.h1 ?? null;
  if (!isAiAvailable()) return { draft: fallbackDraft(planned.candidate, summary), summary, usedAi: false };

  const recent = await prisma.socialPost.findMany({
    where: { accountId: planned.accountId, kind: 'ORIGINAL', status: { in: LIVE_POST_STATUSES } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { body: true },
  });
  const rules = PLATFORM_TEXT_RULES[planned.platform];
  const excerpt = await pageExcerpt(planned.candidate.pageId);
  const answer = await step(
    ctx,
    'draft_post',
    { platform: planned.platform, page: planned.candidate.url },
    () =>
      ai.generateStructured({
        task: socialPostDraftPrompt.id,
        websiteId: ctx.websiteId,
        agent: AGENT,
        role: socialPostDraftPrompt.defaultRole ?? 'writing',
        system: socialPostDraftPrompt.system,
        prompt: socialPostDraftPrompt.render({
          platform: planned.platform,
          maxLength: rules.bodyLimit,
          needsTitle: rules.titleLimit !== null,
          allowsHashtags: HASHTAG_PLATFORMS.has(planned.platform),
          brandName: social.brandName,
          language: social.site.primaryLanguage,
          page: { url: planned.candidate.url, title: planned.candidate.title, summary, excerpt },
          reason: planned.reason,
          recentPosts: recent.map((post) => truncate(post.body, 200)),
          knowledgeBase: toPromptKnowledgeBase(social.site.knowledgeBase),
          brandFacts: facts,
        }),
        schema: draftSchema,
        schemaName: 'social_post_draft',
        settings: social.site.settings,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    (value) => ({ chars: value.data.body.length }),
  );
  return { draft: answer.data, summary, usedAi: true };
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const input = inputSchema.parse(ctx.input ?? {});
  const social = await loadSocialContext(ctx.websiteId);
  const connected = (await loadConnectedAccounts(ctx.websiteId)).filter(
    ({ account, secrets }) =>
      getPublisher(account.platform)?.capabilities.original &&
      canPublishWith(account.platform, secrets) &&
      (!input.accountIds?.length || input.accountIds.includes(account.id)),
  );
  if (connected.length === 0) return skipped('No connected accounts.', NO_ACCOUNTS);

  const now = new Date();
  const accounts = await Promise.all(
    connected.map(async ({ account }) => ({
      accountId: account.id,
      platform: account.platform as SocialPlatformName,
      dailyPostLimit: social.limits.dailyPostLimit,
      postsToday: await postsTodayOnAccount(account.id, now),
    })),
  );

  const pages = await prisma.page.findMany({
    where: {
      websiteId: ctx.websiteId,
      isActive: true,
      isIndexable: true,
      ...(input.pageId ? { id: input.pageId } : {}),
    },
    orderBy: [{ clicks28d: 'desc' }],
    take: 400,
    select: {
      id: true, url: true, title: true, pageType: true, publishedAt: true, contentUpdatedAt: true,
      firstSeenAt: true, clicks28d: true, impressions28d: true, isIndexable: true, wordCount: true,
    },
  });
  if (pages.length === 0) {
    return skipped('No pages to share.', 'This site has no crawled, indexable pages yet. Run a crawl first so the planner has content to choose from.');
  }
  const candidates: ContentCandidate[] = pages.map((page) => ({
    pageId: page.id,
    url: page.url,
    title: page.title,
    pageType: page.pageType,
    // A page first seen recently is new to us even when the CMS reports no publish date.
    publishedAt: page.publishedAt ?? page.firstSeenAt,
    updatedAt: page.contentUpdatedAt,
    clicks28d: page.clicks28d,
    impressions28d: page.impressions28d,
    isIndexable: page.isIndexable,
    wordCount: page.wordCount || null,
  }));

  const recentShares = await prisma.socialPost.findMany({
    where: {
      websiteId: ctx.websiteId,
      kind: 'ORIGINAL',
      linkUrl: { not: null },
      status: { in: LIVE_POST_STATUSES },
      createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) },
    },
    select: { linkUrl: true, platform: true, publishedAt: true, createdAt: true },
  });

  const plan = await step(ctx, 'plan_daily_posts', { accounts: accounts.length, candidates: candidates.length }, async () =>
    planDailyPosts({
      candidates,
      accounts,
      recentShares: recentShares.flatMap((share) =>
        share.linkUrl ? [{ url: share.linkUrl, platform: share.platform as SocialPlatformName, sharedAt: share.publishedAt ?? share.createdAt }] : [],
      ),
      now,
    }),
  );
  if (plan.length === 0) {
    return skipped(
      'Nothing to post today.',
      'Every connected account has reached its daily post cap, or every shareable page was already shared on that platform in the last 30 days.',
      { accounts },
    );
  }

  const facts = await loadVerifiedFacts(ctx.websiteId);
  const collector = new ActionCollector();
  const outcomes: Array<{ platform: string; page: string; status: string; reason: string }> = [];
  let aiUsed = false;

  for (const planned of plan) {
    throwIfAborted(ctx);
    const account = connected.find(({ account: row }) => row.id === planned.accountId)?.account;
    if (!account) continue;
    try {
      const { draft, usedAi } = await draftPost(ctx, social, planned, facts);
      aiUsed ||= usedAi;
      const platform = planned.platform;
      const link = withUtm(planned.candidate.url, { source: utmSourceFor(platform), campaign: social.limits.utmCampaign, content: 'daily' });
      const hashtags = HASHTAG_PLATFORMS.has(platform)
        ? draft.hashtags.slice(0, 2).map((tag) => `#${tag.replace(/^#/, '').replace(/\s+/g, '')}`).join(' ')
        : '';
      const body = platform === 'DEVTO'
        ? `${draft.body.trim()}\n\n---\n*Originally published at [${social.domain}](${link}).*`
        : fitToPlatform([draft.body.trim(), hashtags].filter(Boolean).join('\n\n'), platform, link).text;
      const title = fitTitle(draft.title ?? planned.candidate.title, platform);
      const config = jsonObject(account.config);
      const community = platform === 'REDDIT' && typeof config.defaultCommunity === 'string' && config.defaultCommunity.trim()
        ? config.defaultCommunity.trim()
        : null;
      // The account's own profile (`u_<name>` on Reddit) is a community it owns by definition.
      const profile = account.handle ? `u_${account.handle.replace(/^u\//i, '')}` : null;
      const owned = [...ownedCommunities(account), ...(profile ? [profile] : [])];
      const ownsCommunity = community
        ? owned.some((name) => name.toLowerCase().replace(/^r\//, '') === community.toLowerCase().replace(/^r\//, ''))
        : true;
      const communityRow = await findCommunity(ctx.websiteId, account.platform, community);

      const guard = evaluatePostGuardrails({
        platform,
        body,
        title,
        linkUrl: link,
        postsTodayOnAccount: await postsTodayOnAccount(account.id, now),
        dailyPostLimit: social.limits.dailyPostLimit,
        recentlySharedUrls: recentShares.flatMap((share) => (share.platform === account.platform && share.linkUrl ? [share.linkUrl] : [])),
        community: community ? { name: community, promotionPolicy: communityRow?.promotionPolicy ?? 'UNKNOWN', isBlocked: communityRow?.isBlocked ?? false } : null,
        ownsCommunity,
      });
      if (!guard.allowed) {
        outcomes.push({ platform, page: planned.candidate.url, status: 'blocked', reason: guard.blockers.join(' ') });
        continue;
      }

      const type = socialActionTypeFor({ kind: 'ORIGINAL', community, ownedCommunities: owned });
      const socialPost = await prisma.socialPost.create({
        data: {
          websiteId: ctx.websiteId,
          accountId: account.id,
          pageId: planned.candidate.pageId,
          kind: 'ORIGINAL',
          platform: account.platform,
          status: 'DRAFT',
          community,
          title,
          body,
          linkUrl: link,
          includesLink: true,
          generatedBy: AGENT,
          scheduledFor: planned.slot,
        },
        select: { id: true },
      });
      const created = await propose(ctx, collector, {
        type,
        title: truncate(`${account.handle ?? platform}: share "${planned.candidate.title ?? planned.candidate.url}"`, 200),
        reasoning: `${planned.reason} Scheduled for ${planned.slot.toISOString().slice(0, 16).replace('T', ' ')} UTC.${
          guard.warnings.length ? ` Check: ${guard.warnings.join(' ')}` : ''
        }`,
        evidence: { plannerScore: planned.score, factors: planned.factors, reviewerNotes: draft.reviewerNotes, warnings: guard.warnings },
        affectedUrls: [canonicalShareUrl(planned.candidate.url)],
        payload: {
          ...(title ? { title } : {}),
          body,
          socialPostId: socialPost.id,
          platform: account.platform,
          scheduledFor: planned.slot.toISOString(),
        },
        impact: clamp(planned.score / 100),
        confidence: 0.6,
        effort: 1,
        sourceType: 'social-daily-post',
        sourceId: `${account.id}:${canonicalShareUrl(planned.candidate.url)}:${planned.slot.toISOString().slice(0, 10)}`,
        requiredAgent: AGENT,
      });
      if (!created) {
        await prisma.socialPost.delete({ where: { id: socialPost.id } });
        outcomes.push({ platform, page: planned.candidate.url, status: 'duplicate', reason: 'Already planned.' });
        continue;
      }
      const actionId = collector.actionsCreated[collector.actionsCreated.length - 1] ?? null;
      const action = actionId ? await prisma.seoAction.findUnique({ where: { id: actionId }, select: { autoExecutable: true } }) : null;
      const status = action?.autoExecutable ? 'SCHEDULED' : 'AWAITING_APPROVAL';
      await prisma.socialPost.update({ where: { id: socialPost.id }, data: { actionId, status } });
      outcomes.push({ platform, page: planned.candidate.url, status: status.toLowerCase(), reason: planned.reason });
    } catch (err) {
      outcomes.push({ platform: planned.platform, page: planned.candidate.url, status: 'failed', reason: errorMessage(err) });
    }
  }

  const scheduled = outcomes.filter((outcome) => outcome.status === 'scheduled').length;
  const awaiting = outcomes.filter((outcome) => outcome.status === 'awaiting_approval').length;
  return result({
    summary:
      `Planned ${plan.length} ${pluralise(plan.length, 'post')}: ${scheduled} scheduled automatically, ${awaiting} waiting for approval.` +
      (aiUsed ? '' : ' No AI provider is configured, so posts use the page title and description — edit them before approving.'),
    confidence: aiUsed ? 0.65 : 0.45,
    actionsCreated: collector.actionsCreated,
    approvalsCreated: collector.approvalsCreated,
    findings: outcomes.map((outcome) => ({ kind: 'daily-post', ...outcome })),
    data: { planned: plan.length, scheduled, awaiting, outcomes },
  });
}

export const socialContentAgent: AgentDefinition = {
  name: AGENT,
  label: 'Daily social posts',
  description:
    "Picks today's best page for each connected account (new content first, then proven evergreen pages), writes a platform-native post and schedules it — automatically at high autonomy, otherwise through Approvals.",
  allowedActionTypes: ['SOCIAL_POST', 'SOCIAL_REPLY'],
  tools: ['plan_daily_posts', 'draft_post'],
  requiresAi: false,
  inputSchema,
  run,
};

registerAgent(socialContentAgent);
