import {
  type CommunityPromotionPolicy,
  type Prisma,
  type SocialAccount,
  type SocialPlatform,
  type SocialPostStatus,
  prisma,
} from '@seo/db';
import type { SocialAccountSecrets } from '@seo/integrations';
import { promotionStats, SOCIAL_HARD_LIMITS, type PromotionStats } from '@seo/seo-engine';
import { cleanDomain, toUtcDate } from '@seo/shared';
import { tryDecryptJson } from '@seo/shared/crypto';
import { jsonArray, jsonObject, loadSite, type SiteContext } from './shared';

/**
 * Plumbing shared by the four social agents and the publish-time executor.
 *
 * The counts here feed the guardrails, so they are computed the same way everywhere: a reply
 * that is awaiting approval already counts against today's cap (otherwise one run could queue
 * fifty "within the limit" drafts), and promotion is measured over everything published or
 * handed to a human to post.
 */

/** Statuses that mean "this post exists or is about to" — they all count against caps. */
export const LIVE_POST_STATUSES: SocialPostStatus[] = [
  'AWAITING_APPROVAL',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'MANUAL_PENDING',
];

/** What has actually gone out (or been handed to a human to post). */
export const PUBLISHED_POST_STATUSES: SocialPostStatus[] = ['PUBLISHED', 'MANUAL_PENDING'];

export interface SocialLimits {
  dailyPostLimit: number;
  dailyReplyLimit: number;
  maxPromoRatio: number;
  disclosure: string | null;
  utmCampaign: string;
}

export interface SocialSiteContext {
  site: SiteContext;
  domain: string;
  brandName: string;
  /** Brand name, site name, domain and product names: a mention of any means "they mean us". */
  brandTerms: string[];
  competitorTerms: string[];
  limits: SocialLimits;
}

export async function loadSocialContext(websiteId: string): Promise<SocialSiteContext> {
  const site = await loadSite(websiteId);
  const competitors = await prisma.competitor.findMany({
    where: { websiteId, isActive: true },
    select: { domain: true, name: true },
    take: 30,
  });
  const domain = cleanDomain(site.domain);
  const products = jsonArray(site.knowledgeBase?.products).flatMap((entry) =>
    typeof entry.name === 'string' && entry.name.trim().length >= 3 ? [entry.name.trim()] : [],
  );
  const brandName = site.brandName?.trim() || site.name;
  const brandTerms = unique([brandName, site.name, domain, ...products].filter((term) => term.trim().length >= 3));
  const competitorTerms = unique(
    competitors.flatMap((competitor) => [competitor.name ?? '', cleanDomain(competitor.domain)]).filter((term) => term.trim().length >= 3),
  );
  const settings = site.settings;
  return {
    site,
    domain,
    brandName,
    brandTerms,
    competitorTerms,
    limits: {
      dailyPostLimit: Math.min(settings?.socialDailyPostLimit ?? 1, SOCIAL_HARD_LIMITS.dailyPostsPerAccount),
      dailyReplyLimit: Math.min(settings?.socialDailyReplyLimit ?? 3, SOCIAL_HARD_LIMITS.dailyReplies),
      maxPromoRatio: Math.min(settings?.socialMaxPromoRatio ?? 0.25, SOCIAL_HARD_LIMITS.maxPromoRatio),
      disclosure: settings?.socialDisclosure?.trim() || null,
      utmCampaign: settings?.socialUtmCampaign?.trim() || 'social',
    },
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Decrypt an account's credentials. A row that cannot be decrypted is treated as not connected. */
export function accountSecrets(account: Pick<SocialAccount, 'credentials' | 'config'>): SocialAccountSecrets | null {
  if (!account.credentials) return null;
  const decrypted = tryDecryptJson<Record<string, unknown>>(account.credentials);
  if (!decrypted) return null;
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(decrypted)) {
    if (typeof value === 'string') credentials[key] = value;
  }
  return { credentials, config: jsonObject(account.config) };
}

export interface ConnectedAccount {
  account: SocialAccount;
  secrets: SocialAccountSecrets;
}

export async function loadConnectedAccounts(websiteId: string): Promise<ConnectedAccount[]> {
  const rows = await prisma.socialAccount.findMany({ where: { websiteId, status: 'CONNECTED' } });
  return rows.flatMap((account) => {
    const secrets = accountSecrets(account);
    return secrets ? [{ account, secrets }] : [];
  });
}

/** Subreddits (or other communities) the operator owns, from the account's config. */
export function ownedCommunities(account: Pick<SocialAccount, 'config'> | null | undefined): string[] {
  const raw = jsonObject(account?.config).ownedCommunities;
  const list = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw.map(String) : [];
  return list.map((name) => name.trim()).filter(Boolean);
}

export interface CommunityRow {
  name: string;
  promotionPolicy: CommunityPromotionPolicy;
  isBlocked: boolean;
  rulesSummary: string | null;
}

export async function findCommunity(
  websiteId: string,
  platform: SocialPlatform,
  name: string | null,
): Promise<CommunityRow | null> {
  if (!name) return null;
  return prisma.socialCommunity.findFirst({
    where: { websiteId, platform, name: { equals: name, mode: 'insensitive' } },
    select: { name: true, promotionPolicy: true, isBlocked: true, rulesSummary: true },
  });
}

export interface ReplyCounters {
  repliesToday: number;
  repliesInCommunityThisWeek: number;
  alreadyEngaged: boolean;
  promo: PromotionStats;
}

/**
 * The numbers the reply guardrail needs.
 *
 * `countPending` decides whether drafts waiting for approval count: they do when deciding
 * whether to draft (so the queue cannot overflow the cap), and they do not at publish time
 * (where only what actually went out today matters — counting the post being published against
 * itself would block it).
 */
export async function replyCounters(input: {
  websiteId: string;
  conversationId: string;
  community: string | null;
  excludePostId?: string;
  countPending: boolean;
  now?: Date;
}): Promise<ReplyCounters> {
  const now = input.now ?? new Date();
  const dayStart = toUtcDate(now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const statuses = input.countPending ? LIVE_POST_STATUSES : PUBLISHED_POST_STATUSES;
  const exclude: Prisma.SocialPostWhereInput = input.excludePostId ? { id: { not: input.excludePostId } } : {};

  const [repliesToday, repliesInCommunityThisWeek, engaged, recent] = await Promise.all([
    prisma.socialPost.count({
      where: {
        websiteId: input.websiteId,
        kind: 'REPLY',
        status: { in: statuses },
        OR: [{ publishedAt: { gte: dayStart } }, { publishedAt: null, createdAt: { gte: dayStart } }],
        ...exclude,
      },
    }),
    input.community
      ? prisma.socialPost.count({
          where: {
            websiteId: input.websiteId,
            community: { equals: input.community, mode: 'insensitive' },
            status: { in: statuses },
            OR: [{ publishedAt: { gte: weekAgo } }, { publishedAt: null, createdAt: { gte: weekAgo } }],
            ...exclude,
          },
        })
      : Promise.resolve(0),
    prisma.socialPost.findFirst({
      where: { conversationId: input.conversationId, status: { in: LIVE_POST_STATUSES }, ...exclude },
      select: { id: true },
    }),
    prisma.socialPost.findMany({
      where: {
        websiteId: input.websiteId,
        status: { in: PUBLISHED_POST_STATUSES },
        OR: [{ publishedAt: { gte: monthAgo } }, { publishedAt: null, createdAt: { gte: monthAgo } }],
        ...exclude,
      },
      select: { includesLink: true },
      take: 500,
    }),
  ]);

  return {
    repliesToday,
    repliesInCommunityThisWeek,
    alreadyEngaged: engaged !== null,
    promo: promotionStats(recent),
  };
}

/** Original posts already planned or published on one account today. */
export async function postsTodayOnAccount(accountId: string, now = new Date(), excludePostId?: string): Promise<number> {
  const dayStart = toUtcDate(now);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  return prisma.socialPost.count({
    where: {
      accountId,
      kind: 'ORIGINAL',
      status: { in: LIVE_POST_STATUSES },
      ...(excludePostId ? { id: { not: excludePostId } } : {}),
      OR: [
        { scheduledFor: { gte: dayStart, lt: dayEnd } },
        { scheduledFor: null, publishedAt: { gte: dayStart, lt: dayEnd } },
        { scheduledFor: null, publishedAt: null, createdAt: { gte: dayStart, lt: dayEnd } },
      ],
    },
  });
}

/** Links shared on a platform in the last `days`, for the repost cooldown. */
export async function recentlySharedUrls(websiteId: string, platform: SocialPlatform, days = 30, excludePostId?: string): Promise<string[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.socialPost.findMany({
    where: {
      websiteId,
      platform,
      linkUrl: { not: null },
      status: { in: LIVE_POST_STATUSES },
      createdAt: { gte: since },
      ...(excludePostId ? { id: { not: excludePostId } } : {}),
    },
    select: { linkUrl: true },
    take: 500,
  });
  return rows.flatMap((row) => (row.linkUrl ? [row.linkUrl] : []));
}
