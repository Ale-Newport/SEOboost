import {
  type CommunityPromotionPolicy,
  type Prisma,
  type SocialAccount,
  type SocialPlatform,
  type SocialPostStatus,
  prisma,
} from '@seo/db';
import {
  isOAuthPlatform,
  mergeRefreshedCredentials,
  OAUTH_PROVIDERS,
  refreshOAuthTokens,
  SocialSourceError,
  tokenState,
  type SocialAccountSecrets,
} from '@seo/integrations';
import { promotionStats, SOCIAL_HARD_LIMITS, type PromotionStats } from '@seo/seo-engine';
import { cleanDomain, createLogger, errorMessage, toUtcDate, truncate } from '@seo/shared';
import { encryptJson, tryDecryptJson } from '@seo/shared/crypto';
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

const log = createLogger('social:accounts');

async function markUnusable(accountId: string, status: 'EXPIRED' | 'ERROR', message: string): Promise<void> {
  await prisma.socialAccount.update({ where: { id: accountId }, data: { status, lastError: truncate(message, 1_000) } });
}

/**
 * Credentials that are safe to use right now.
 *
 * OAuth access tokens expire (X after two hours, Reddit after a day, LinkedIn after two months);
 * this refreshes them shortly before they do and stores the rotated pair. The refresh runs under
 * a Postgres advisory lock on the account, so the web app and the worker can never both spend
 * the same rotating refresh token — the second caller waits, re-reads, and finds it already
 * fresh. A refused refresh marks the account EXPIRED with a reconnect message and returns null;
 * a transient failure keeps using the current token while it is still valid.
 */
export async function freshAccountSecrets(account: SocialAccount): Promise<SocialAccountSecrets | null> {
  const secrets = accountSecrets(account);
  if (!secrets) return null;
  const state = tokenState(secrets.credentials);
  if (state.kind === 'not-oauth' || state.kind === 'valid' || !isOAuthPlatform(account.platform)) return secrets;

  const label = OAUTH_PROVIDERS[account.platform].label;
  if (state.kind === 'expired') {
    await markUnusable(
      account.id,
      'EXPIRED',
      `The ${label} connection expired on ${state.expiresAt.toISOString().slice(0, 10)} and ${label} issues no refresh token for it. Reconnect it from Social → Accounts.`,
    );
    return null;
  }

  const platform = account.platform;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`social-account:${account.id}`}))`;
        const current = await tx.socialAccount.findUnique({ where: { id: account.id } });
        const currentSecrets = current ? accountSecrets(current) : null;
        if (!currentSecrets) return null;
        if (tokenState(currentSecrets.credentials).kind !== 'refresh') return currentSecrets;

        const instanceUrl = typeof currentSecrets.config.instanceUrl === 'string' ? currentSecrets.config.instanceUrl : null;
        const tokens = await refreshOAuthTokens({
          platform,
          refreshToken: currentSecrets.credentials.refreshToken ?? '',
          instanceUrl,
        });
        const credentials = mergeRefreshedCredentials(currentSecrets.credentials, tokens);
        await tx.socialAccount.update({
          where: { id: account.id },
          data: { credentials: encryptJson(credentials), status: 'CONNECTED', lastError: null },
        });
        log.info('oauth token refreshed', { accountId: account.id, platform });
        return { credentials, config: currentSecrets.config };
      },
      // The refresh is one HTTP call; the lock must outlive it but never hang a job.
      { maxWait: 15_000, timeout: 30_000 },
    );
  } catch (err) {
    if (err instanceof SocialSourceError && (err.code === 'NEED_LOGIN' || err.code === 'NOT_CONFIGURED')) {
      await markUnusable(
        account.id,
        err.code === 'NEED_LOGIN' ? 'EXPIRED' : 'ERROR',
        `${label} refused to renew the connection: ${err.message} ${err.hint ?? ''}`.trim(),
      );
      return null;
    }
    log.warn('oauth refresh failed; keeping the current token while it lasts', { accountId: account.id, error: errorMessage(err) });
    return state.expiresAt.getTime() > Date.now() ? secrets : null;
  }
}

export interface ConnectedAccount {
  account: SocialAccount;
  secrets: SocialAccountSecrets;
}

/** Connected accounts with credentials that work right now (expiring OAuth tokens refreshed). */
export async function loadConnectedAccounts(websiteId: string): Promise<ConnectedAccount[]> {
  const rows = await prisma.socialAccount.findMany({ where: { websiteId, status: 'CONNECTED' } });
  const out: ConnectedAccount[] = [];
  // Sequential on purpose: each refresh takes a per-account lock and one HTTP call.
  for (const account of rows) {
    const secrets = await freshAccountSecrets(account);
    if (secrets) out.push({ account, secrets });
  }
  return out;
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
