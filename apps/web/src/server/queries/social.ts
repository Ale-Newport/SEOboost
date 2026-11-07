import 'server-only';
import { type Prisma, type SocialConversationStatus, prisma } from '@seo/db';
import { ForbiddenError, NotFoundError, cleanDomain } from '@seo/shared';
import { isAiAvailable } from '@seo/ai';
import {
  AGENT_REACH_INSTALL_HINT,
  LISTENING_PLATFORMS,
  MANUAL_ONLY_PLATFORMS,
  agentReachStatus,
  canPublishWith,
  getPublisher,
  listPublishers,
  manualPostUrl,
  needsAgentReach,
} from '@seo/integrations';
import { PLATFORM_TEXT_RULES, SOCIAL_HARD_LIMITS } from '@seo/seo-engine';
import { tryDecryptJson } from '@seo/shared/crypto';
import { listSchedules } from '@seo/queue';
import type {
  ConversationFilter,
  ScoreFactorWire,
  SocialAccountRow,
  SocialAgentRunRow,
  SocialCommunityRow,
  SocialConversationRow,
  SocialOverview,
  SocialPlatformValue,
  SocialPostRow,
  SocialTopicRow,
  TopicKindValue,
  TriageWire,
} from '@/components/social/types';

/**
 * Read model for the Social screen — everything in one call so the page renders from a single
 * consistent snapshot.
 *
 * Two things this module never does: return an account's credentials (only whether some are
 * stored), and fill a gap with a guess. A conversation with no triage comes back with
 * `triage: null`, not a made-up verdict, and engagement figures are only what the platform
 * reported.
 */

const CONVERSATION_LIMIT = 200;
const POST_LIMIT = 150;

const FILTER_STATUSES: Record<ConversationFilter, SocialConversationStatus[] | null> = {
  open: ['NEW', 'SHORTLISTED', 'DRAFTED'],
  replied: ['REPLIED'],
  dismissed: ['DISMISSED'],
  expired: ['EXPIRED'],
  all: null,
};

/** Agents shown in the header's "last run" strip, keyed the way `AgentRun.agent` stores them. */
const SOCIAL_AGENTS = [
  { name: 'SocialListeningAgent', key: 'social-listening', label: 'Listening' },
  { name: 'SocialEngagementAgent', key: 'social-engagement', label: 'Reply drafts' },
  { name: 'SocialContentAgent', key: 'social-content', label: 'Daily posts' },
  { name: 'SocialStrategyAgent', key: 'social-strategy', label: 'Strategy' },
] as const;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `relevanceFactors` is `{ factors, summary }` as written by the listening agent; checked, not cast. */
function readFactors(value: Prisma.JsonValue): { factors: ScoreFactorWire[]; summary: string | null } {
  const raw = record(value);
  const factors = Array.isArray(raw.factors)
    ? raw.factors.flatMap((entry): ScoreFactorWire[] => {
        const factor = record(entry);
        const key = str(factor.key);
        const label = str(factor.label);
        if (!key || !label) return [];
        return [
          {
            key,
            label,
            value: num(factor.value) ?? 0,
            weight: num(factor.weight) ?? 0,
            contribution: num(factor.contribution) ?? 0,
            explanation: str(factor.explanation) ?? '',
          },
        ];
      })
    : [];
  return { factors, summary: str(raw.summary) };
}

function readTriage(value: Prisma.JsonValue | null): TriageWire | null {
  if (value === null) return null;
  const raw = record(value);
  if (Object.keys(raw).length === 0) return null;
  return {
    fit: num(raw.fit),
    approach: str(raw.approach),
    reason: str(raw.reason),
    angle: str(raw.angle),
    draftSkipReason: str(raw.draftSkipReason),
  };
}

function readMetrics(value: Prisma.JsonValue): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === 'number' || typeof entry === 'boolean') out[key] = entry;
  }
  return out;
}

function readConfig(value: Prisma.JsonValue): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') out[key] = entry;
  }
  return out;
}

function topicKind(value: string): TopicKindValue {
  return value === 'brand' || value === 'competitor' ? value : 'problem';
}

export interface SocialOverviewOptions {
  conversationFilter?: ConversationFilter;
}

/** Ownership-checked load of the site row the screen is about. */
async function requireOwnedWebsite(userId: string, websiteId: string) {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: {
      id: true,
      userId: true,
      name: true,
      domain: true,
      brandName: true,
      settings: {
        select: {
          autonomyLevel: true,
          socialDailyPostLimit: true,
          socialDailyReplyLimit: true,
          socialMaxPromoRatio: true,
          socialDisclosure: true,
          socialUtmCampaign: true,
        },
      },
    },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');
  return website;
}

export async function getSocialOverview(
  userId: string,
  websiteId: string,
  opts: SocialOverviewOptions = {},
): Promise<SocialOverview> {
  const website = await requireOwnedWebsite(userId, websiteId);
  const filter: ConversationFilter = opts.conversationFilter ?? 'open';
  const statuses = FILTER_STATUSES[filter];
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [
    conversationGroups,
    postGroups,
    published7d,
    conversations,
    posts,
    topics,
    topicCounts,
    communities,
    accounts,
    schedules,
    runs,
    agentReach,
  ] = await Promise.all([
    prisma.socialConversation.groupBy({ by: ['status'], where: { websiteId }, _count: { _all: true } }),
    prisma.socialPost.groupBy({ by: ['status'], where: { websiteId }, _count: { _all: true } }),
    prisma.socialPost.count({ where: { websiteId, status: 'PUBLISHED', publishedAt: { gte: weekAgo } } }),
    prisma.socialConversation.findMany({
      where: { websiteId, ...(statuses ? { status: { in: statuses } } : {}) },
      orderBy: [{ relevanceScore: 'desc' }, { discoveredAt: 'desc' }],
      take: CONVERSATION_LIMIT,
      include: {
        topic: { select: { name: true } },
        posts: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, externalUrl: true } },
      },
    }),
    prisma.socialPost.findMany({
      where: { websiteId },
      orderBy: { updatedAt: 'desc' },
      take: POST_LIMIT,
      include: {
        account: { select: { handle: true, status: true } },
        conversation: { select: { id: true, title: true, url: true, externalId: true } },
        action: {
          select: {
            id: true,
            approvals: { where: { status: 'PENDING' }, select: { id: true }, take: 1 },
          },
        },
      },
    }),
    prisma.socialTopic.findMany({ where: { websiteId }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] }),
    prisma.socialConversation.groupBy({ by: ['topicId'], where: { websiteId, topicId: { not: null } }, _count: { _all: true } }),
    prisma.socialCommunity.findMany({ where: { websiteId }, orderBy: [{ isBlocked: 'asc' }, { name: 'asc' }] }),
    prisma.socialAccount.findMany({ where: { websiteId }, orderBy: { platform: 'asc' } }),
    listSchedules(websiteId),
    prisma.agentRun.findMany({
      where: {
        websiteId,
        agent: { in: SOCIAL_AGENTS.flatMap((agent) => [agent.name, agent.key]) },
      },
      orderBy: { startedAt: 'desc' },
      take: 40,
      select: { agent: true, status: true, summary: true, startedAt: true, finishedAt: true },
    }),
    agentReachStatus(),
  ]);

  const conversationCount = (status: SocialConversationStatus): number =>
    conversationGroups.find((group) => group.status === status)?._count._all ?? 0;
  const postCount = (status: string): number => postGroups.find((group) => group.status === status)?._count._all ?? 0;

  const communityByKey = new Map(
    communities.map((community) => [`${community.platform}|${community.name.toLowerCase()}`, community]),
  );

  const conversationRows: SocialConversationRow[] = conversations.map((conversation) => {
    const community = conversation.community
      ? communityByKey.get(`${conversation.platform}|${conversation.community.toLowerCase()}`)
      : undefined;
    const factors = readFactors(conversation.relevanceFactors);
    const latestPost = conversation.posts[0];
    return {
      id: conversation.id,
      platform: conversation.platform,
      url: conversation.url,
      title: conversation.title,
      body: conversation.body,
      author: conversation.author,
      community: conversation.community,
      // Only Reddit communities publish moderator rules; "HN" is a section with no policy to check.
      communityPolicy: community
        ? community.promotionPolicy
        : conversation.community && conversation.platform === 'REDDIT'
          ? 'UNKNOWN'
          : null,
      communityRulesSummary: community?.rulesSummary ?? null,
      publishedAt: iso(conversation.publishedAt),
      discoveredAt: conversation.discoveredAt.toISOString(),
      score: conversation.score,
      commentCount: conversation.commentCount,
      isLocked: conversation.isLocked,
      intent: conversation.intent,
      relevanceScore: conversation.relevanceScore,
      relevanceSummary: factors.summary,
      relevanceFactors: factors.factors,
      triage: readTriage(conversation.triage),
      status: conversation.status,
      backend: conversation.backend,
      topicName: conversation.topic?.name ?? null,
      post: latestPost ? { id: latestPost.id, status: latestPost.status, externalUrl: latestPost.externalUrl } : null,
    };
  });

  const connectedPlatforms = new Set(
    accounts.filter((account) => account.status === 'CONNECTED' && account.credentials).map((account) => account.platform),
  );

  const postRows: SocialPostRow[] = posts.map((post) => {
    const publisher = getPublisher(post.platform);
    const automatable =
      connectedPlatforms.has(post.platform) &&
      !MANUAL_ONLY_PLATFORMS.includes(post.platform) &&
      Boolean(publisher && (post.kind === 'REPLY' ? publisher.capabilities.reply : publisher.capabilities.original));
    const open = !['PUBLISHED', 'REJECTED', 'CANCELLED'].includes(post.status);
    const manual =
      post.status === 'MANUAL_PENDING' || (open && !automatable)
        ? manualPostUrl(post.platform, {
            kind: post.kind,
            title: post.title,
            body: post.body,
            linkUrl: post.linkUrl,
            community: post.community,
            replyTo: post.conversation ? { externalId: post.conversation.externalId, url: post.conversation.url } : null,
            canonicalUrl: null,
            tags: [],
          })
        : null;
    return {
      id: post.id,
      kind: post.kind,
      platform: post.platform,
      status: post.status,
      community: post.community,
      title: post.title,
      body: post.body,
      linkUrl: post.linkUrl,
      includesLink: post.includesLink,
      generatedBy: post.generatedBy,
      scheduledFor: iso(post.scheduledFor),
      publishedAt: iso(post.publishedAt),
      externalUrl: post.externalUrl,
      error: post.error,
      metrics: readMetrics(post.metrics),
      metricsCheckedAt: iso(post.metricsCheckedAt),
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      accountId: post.accountId,
      accountHandle: post.account?.handle ?? null,
      conversation: post.conversation ? { id: post.conversation.id, title: post.conversation.title, url: post.conversation.url } : null,
      actionId: post.action?.id ?? null,
      pendingApprovalId: post.action?.approvals[0]?.id ?? null,
      manualPostUrl: manual,
    };
  });

  const countByTopic = new Map(topicCounts.map((group) => [group.topicId, group._count._all]));
  const topicRows: SocialTopicRow[] = topics.map((topic) => ({
    id: topic.id,
    name: topic.name,
    query: topic.query,
    keywords: topic.keywords,
    negativeKeywords: topic.negativeKeywords,
    platforms: topic.platforms,
    communities: topic.communities,
    kind: topicKind(topic.kind),
    isActive: topic.isActive,
    source: topic.source,
    lastRunAt: iso(topic.lastRunAt),
    lastResultCount: topic.lastResultCount,
    lastError: topic.lastError,
    conversationCount: countByTopic.get(topic.id) ?? 0,
  }));

  const communityRows: SocialCommunityRow[] = communities.map((community) => ({
    id: community.id,
    platform: community.platform,
    name: community.name,
    title: community.title,
    subscribers: community.subscribers,
    promotionPolicy: community.promotionPolicy,
    rulesSummary: community.rulesSummary,
    isBlocked: community.isBlocked,
    notes: community.notes,
    lastCheckedAt: iso(community.lastCheckedAt),
  }));

  const accountRows: SocialAccountRow[] = accounts.map((account) => ({
    id: account.id,
    platform: account.platform,
    status: account.status,
    handle: account.handle,
    displayName: account.displayName,
    config: readConfig(account.config),
    hasCredentials: Boolean(account.credentials),
    canPost: canPostWith(account.platform, account.credentials),
    lastPostAt: iso(account.lastPostAt),
    lastError: account.lastError,
    lastTestedAt: iso(account.lastTestedAt),
  }));

  const agentRuns: SocialAgentRunRow[] = SOCIAL_AGENTS.map((agent) => {
    const run = runs.find((row) => row.agent === agent.name || row.agent === agent.key);
    return {
      key: agent.key,
      label: agent.label,
      status: run?.status ?? null,
      summary: run?.summary ?? null,
      startedAt: iso(run?.startedAt),
      finishedAt: iso(run?.finishedAt),
    };
  });

  // Plain data (limits per platform), so the client can count characters the way the platform does.
  const textRules: SocialOverview['textRules'] = { ...PLATFORM_TEXT_RULES };

  const domain = cleanDomain(website.domain);
  const brandTerms = [...new Set([website.brandName ?? '', website.name, domain].map((term) => term.trim()).filter((term) => term.length >= 3))];

  return {
    website: { id: website.id, name: website.name, domain, brandName: website.brandName, brandTerms },
    settings: {
      autonomyLevel: website.settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
      socialDailyPostLimit: website.settings?.socialDailyPostLimit ?? 1,
      socialDailyReplyLimit: website.settings?.socialDailyReplyLimit ?? 3,
      socialMaxPromoRatio: website.settings?.socialMaxPromoRatio ?? 0.25,
      socialDisclosure: website.settings?.socialDisclosure ?? null,
      socialUtmCampaign: website.settings?.socialUtmCampaign ?? 'social',
    },
    counts: {
      newConversations: conversationCount('NEW'),
      shortlisted: conversationCount('SHORTLISTED'),
      awaitingApproval: postCount('AWAITING_APPROVAL'),
      scheduled: postCount('SCHEDULED') + postCount('APPROVED'),
      published7d,
      manualPending: postCount('MANUAL_PENDING'),
      failed: postCount('FAILED'),
    },
    conversationFilter: filter,
    conversationFilterCounts: {
      open: conversationCount('NEW') + conversationCount('SHORTLISTED') + conversationCount('DRAFTED'),
      replied: conversationCount('REPLIED'),
      dismissed: conversationCount('DISMISSED'),
      expired: conversationCount('EXPIRED'),
      all: conversationGroups.reduce((sum, group) => sum + group._count._all, 0),
    },
    conversations: conversationRows,
    posts: postRows,
    topics: topicRows,
    communities: communityRows,
    accounts: accountRows,
    publishers: listPublishers(),
    listeningPlatforms: LISTENING_PLATFORMS.map((platform: SocialPlatformValue) => ({
      platform,
      needsAgentReach: needsAgentReach(platform),
    })),
    manualOnlyPlatforms: [...MANUAL_ONLY_PLATFORMS],
    agentReach: { ...agentReach, installHint: AGENT_REACH_INSTALL_HINT },
    aiConfigured: isAiAvailable(),
    textRules,
    hardLimits: { ...SOCIAL_HARD_LIMITS },
    schedules: schedules
      .filter((schedule) => schedule.name.startsWith('social-'))
      .map((schedule) => ({
        id: schedule.id,
        name: schedule.name,
        jobName: schedule.jobName,
        cron: schedule.cron,
        isEnabled: schedule.isEnabled,
        lastRunAt: iso(schedule.lastRunAt),
        lastStatus: schedule.lastStatus,
        nextRunAt: iso(schedule.nextRunAt),
      })),
    agentRuns,
  };
}

/**
 * Whether stored credentials allow writing, not just reading. Decrypted here and reduced to a
 * boolean so nothing secret leaves the server — a Reddit app connected without its owner's login
 * is listening-only and must not be offered as a posting account.
 */
function canPostWith(platform: SocialPlatformValue, credentials: string | null): boolean {
  const decrypted = tryDecryptJson<Record<string, unknown>>(credentials);
  if (!decrypted) return false;
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(decrypted)) if (typeof value === 'string') strings[key] = value;
  return canPublishWith(platform, { credentials: strings, config: {} });
}
