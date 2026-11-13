import { type PersonalAccount, type PersonalAccountProvider, type Prisma, json, prisma } from '@seo/db';
import {
  SocialSourceError,
  bareSubreddit,
  readRedditCredentials,
  redditApi,
  redditCommunityInfo,
  getPublisher,
  refreshPersonalTokens,
  tokenState,
  mergeRefreshedCredentials,
  type SocialAccountSecrets,
} from '@seo/integrations';
import {
  classifyPromotionPolicy,
  evaluatePostGuardrails,
  evaluateReplyGuardrails,
  hasDisclosure,
  linksToDomain,
  mentionsAny,
  promotionStats,
  type CommunityPolicy,
  type GuardDecision,
} from '@seo/seo-engine';
import { NotFoundError, ValidationError, cleanDomain, createLogger, errorMessage, toUtcDate, truncate } from '@seo/shared';
import { encryptJson, tryDecryptJson } from '@seo/shared/crypto';
import { createOperatorSocialPost } from '../social/posts';

/**
 * The operator's own GitHub and Reddit accounts.
 *
 * Linked once (Accounts), usable everywhere: the GitHub and Reddit workspaces read and write with
 * them on click, and a Reddit account can be copied into any site's social accounts so listening,
 * reply drafting and daily posts use it — with that site's guardrails. Reddit writes made from the
 * personal workspace without a site still pass the same guardrail functions, counted against the
 * account's own recent activity.
 */

const log = createLogger('personal:accounts');

const REFRESH_LOCK = 'personal-account:';

export interface PersonalSecrets {
  credentials: Record<string, string>;
  config: Record<string, unknown>;
}

function objectOf(value: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function personalSecrets(account: Pick<PersonalAccount, 'credentials' | 'config'>): PersonalSecrets | null {
  const decrypted = tryDecryptJson<Record<string, unknown>>(account.credentials);
  if (!decrypted) return null;
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(decrypted)) if (typeof value === 'string') credentials[key] = value;
  return { credentials, config: objectOf(account.config) };
}

/**
 * Usable credentials, refreshing a Reddit token near expiry under an advisory lock so the web app
 * and the worker never both spend the same refresh token. Null when the account cannot be used,
 * with the reason recorded on the row.
 */
export async function freshPersonalSecrets(account: PersonalAccount): Promise<PersonalSecrets | null> {
  const secrets = personalSecrets(account);
  if (!secrets) return null;
  const state = tokenState(secrets.credentials);
  if (state.kind === 'not-oauth' || state.kind === 'valid') return secrets;
  if (state.kind === 'expired' || account.provider !== 'REDDIT') {
    await prisma.personalAccount.update({
      where: { id: account.id },
      data: { status: 'EXPIRED', lastError: 'The connection expired. Link the account again from Accounts.' },
    });
    return null;
  }
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${REFRESH_LOCK}${account.id}`}))`;
        const current = await tx.personalAccount.findUnique({ where: { id: account.id } });
        const currentSecrets = current ? personalSecrets(current) : null;
        if (!currentSecrets) return null;
        if (tokenState(currentSecrets.credentials).kind !== 'refresh') return currentSecrets;
        const tokens = await refreshPersonalTokens('REDDIT', currentSecrets.credentials.refreshToken ?? '');
        const credentials = mergeRefreshedCredentials(currentSecrets.credentials, { ...tokens, webhook: null });
        await tx.personalAccount.update({
          where: { id: account.id },
          data: { credentials: encryptJson(credentials), status: 'CONNECTED', lastError: null },
        });
        return { credentials, config: currentSecrets.config };
      },
      { maxWait: 15_000, timeout: 30_000 },
    );
  } catch (err) {
    if (err instanceof SocialSourceError && (err.code === 'NEED_LOGIN' || err.code === 'NOT_CONFIGURED')) {
      await prisma.personalAccount.update({
        where: { id: account.id },
        data: { status: 'EXPIRED', lastError: truncate(`Reddit refused to renew the link: ${err.message}`, 1_000) },
      });
      return null;
    }
    log.warn('personal token refresh failed; using the current token while it lasts', { accountId: account.id, error: errorMessage(err) });
    return state.expiresAt.getTime() > Date.now() ? secrets : null;
  }
}

/** The account to use: the named one, else the most recently used connected one. */
export async function loadPersonalAccount(
  userId: string,
  provider: PersonalAccountProvider,
  accountId?: string | null,
): Promise<{ account: PersonalAccount; secrets: PersonalSecrets }> {
  const account = accountId
    ? await prisma.personalAccount.findFirst({ where: { id: accountId, userId, provider } })
    : await prisma.personalAccount.findFirst({
        where: { userId, provider, status: 'CONNECTED' },
        orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      });
  if (!account) throw new NotFoundError(`Linked ${provider === 'GITHUB' ? 'GitHub' : 'Reddit'} account`);
  const secrets = await freshPersonalSecrets(account);
  if (!secrets) {
    throw new ValidationError(account.lastError ?? `The ${provider === 'GITHUB' ? 'GitHub' : 'Reddit'} link needs to be renewed from Accounts.`);
  }
  await prisma.personalAccount.update({ where: { id: account.id }, data: { lastUsedAt: new Date() } });
  return { account, secrets };
}

export async function upsertPersonalAccount(input: {
  userId: string;
  provider: PersonalAccountProvider;
  handle: string;
  displayName: string | null;
  email: string | null;
  credentials: Record<string, string>;
  config?: Record<string, unknown>;
}): Promise<PersonalAccount> {
  const existing = await prisma.personalAccount.findUnique({
    where: { userId_provider_handle: { userId: input.userId, provider: input.provider, handle: input.handle } },
    select: { config: true },
  });
  const data = {
    status: 'CONNECTED' as const,
    credentials: encryptJson(input.credentials),
    config: json({ ...objectOf(existing?.config), ...(input.config ?? {}) }),
    displayName: input.displayName,
    email: input.email,
    lastError: null,
  };
  return prisma.personalAccount.upsert({
    where: { userId_provider_handle: { userId: input.userId, provider: input.provider, handle: input.handle } },
    create: { userId: input.userId, provider: input.provider, handle: input.handle, ...data },
    update: data,
  });
}

/**
 * What a site's `SocialAccount` gets when a personal Reddit account is put to work there.
 * Pure, for tests: the credential record is copied as-is (it is already the shape the social
 * Reddit publisher reads), and the site's own settings — owned communities, default subreddit —
 * win over the personal account's.
 */
export function socialAccountDataFromPersonal(
  personal: { handle: string | null; displayName: string | null; credentials: Record<string, string> },
  existingSiteConfig: Record<string, unknown>,
): { handle: string | null; displayName: string | null; status: 'CONNECTED'; credentials: Record<string, string>; config: Record<string, unknown> } {
  const handle = personal.handle;
  const profile = handle ? `u_${handle.replace(/^u\//i, '')}` : null;
  return {
    handle,
    displayName: personal.displayName,
    status: 'CONNECTED',
    credentials: { ...personal.credentials },
    config: { ...(profile ? { defaultCommunity: profile } : {}), ...existingSiteConfig, linkedFrom: 'personal' },
  };
}

export async function copyPersonalAccountToSite(input: { userId: string; accountId: string; websiteId: string }): Promise<{ socialAccountId: string; handle: string | null }> {
  const website = await prisma.website.findFirst({ where: { id: input.websiteId, userId: input.userId }, select: { id: true } });
  if (!website) throw new NotFoundError('Website');
  const { account, secrets } = await loadPersonalAccount(input.userId, 'REDDIT', input.accountId);
  const existing = await prisma.socialAccount.findUnique({
    where: { websiteId_platform: { websiteId: website.id, platform: 'REDDIT' } },
    select: { config: true },
  });
  const data = socialAccountDataFromPersonal(
    { handle: account.handle, displayName: account.displayName, credentials: secrets.credentials },
    objectOf(existing?.config),
  );
  const row = await prisma.socialAccount.upsert({
    where: { websiteId_platform: { websiteId: website.id, platform: 'REDDIT' } },
    create: { websiteId: website.id, platform: 'REDDIT', ...data, credentials: encryptJson(data.credentials), config: json(data.config), lastTestedAt: new Date() },
    update: { ...data, credentials: encryptJson(data.credentials), config: json(data.config), lastError: null, lastTestedAt: new Date() },
  });
  return { socialAccountId: row.id, handle: row.handle };
}

// ── Reddit writes from the personal workspace ─────────────

interface ActivityEntry {
  at: string;
  kind: 'post' | 'comment';
  community: string | null;
  includesLink: boolean;
}

function activityOf(config: Record<string, unknown>): ActivityEntry[] {
  const raw = Array.isArray(config.recentActivity) ? config.recentActivity : [];
  const cutoff = Date.now() - 30 * 86_400_000;
  return raw.flatMap((entry): ActivityEntry[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const at = typeof record.at === 'string' ? record.at : null;
    if (!at || new Date(at).getTime() < cutoff) return [];
    return [{
      at,
      kind: record.kind === 'post' ? 'post' : 'comment',
      community: typeof record.community === 'string' ? record.community : null,
      includesLink: record.includesLink === true,
    }];
  });
}

/** Brand names and domains across the operator's sites: mentioning any of them needs disclosure. */
async function operatorBrands(userId: string): Promise<{ terms: string[]; domains: string[]; disclosure: string | null }> {
  const sites = await prisma.website.findMany({
    where: { userId },
    select: { name: true, brandName: true, domain: true, settings: { select: { socialDisclosure: true } } },
  });
  const terms = sites.flatMap((site) => [site.brandName ?? '', site.name.replace(/^\[DEMO\]\s*/, ''), cleanDomain(site.domain)]).filter((term) => term.trim().length >= 3);
  return {
    terms,
    domains: sites.map((site) => cleanDomain(site.domain)),
    disclosure: sites.find((site) => site.settings?.socialDisclosure)?.settings?.socialDisclosure ?? null,
  };
}

export interface RedditComposeInput {
  userId: string;
  accountId?: string | null;
  kind: 'post' | 'comment';
  /** Posts: the subreddit. Comments: derived from the thread when omitted. */
  subreddit?: string | null;
  title?: string | null;
  body: string;
  /** Comments: the post or comment being answered (`t3_…`/`t1_…`). */
  thingId?: string | null;
  /** When set, the post goes through that site's social queue and caps instead. */
  websiteId?: string | null;
}

export type RedditComposeOutcome =
  | { status: 'published'; url: string | null; warnings: string[] }
  | { status: 'queued'; websiteId: string; postId: string; copiedAccount: boolean }
  | { status: 'blocked'; blockers: string[]; warnings: string[] };

async function threadInfo(secrets: PersonalSecrets, thingId: string): Promise<{ subreddit: string | null; publishedAt: Date | null; locked: boolean; url: string; title: string | null }> {
  const creds = readRedditCredentials(secrets.credentials);
  if (!creds) throw new ValidationError('The Reddit link has no usable token.');
  const body = await redditApi(creds, '/api/info', { mode: 'user', query: { id: thingId } });
  const children = (typeof body === 'object' && body !== null ? (body as { data?: { children?: unknown[] } }).data?.children : undefined) ?? [];
  const data = (children[0] as { data?: Record<string, unknown> } | undefined)?.data;
  if (!data) throw new NotFoundError('Reddit thread');
  const created = typeof data.created_utc === 'number' ? new Date(data.created_utc * 1000) : null;
  const permalink = typeof data.permalink === 'string' ? data.permalink : '';
  return {
    subreddit: typeof data.subreddit === 'string' ? `r/${data.subreddit}` : null,
    publishedAt: created,
    locked: data.locked === true || data.archived === true,
    url: `https://www.reddit.com${permalink}`,
    title: typeof data.title === 'string' ? data.title : typeof data.link_title === 'string' ? data.link_title : null,
  };
}

async function communityPolicy(secrets: PersonalSecrets, subreddit: string): Promise<{ policy: CommunityPolicy; summary: string }> {
  try {
    const info = await redditCommunityInfo(subreddit, readRedditCredentials(secrets.credentials));
    const classified = classifyPromotionPolicy(info.rules, info.description);
    return { policy: classified.policy, summary: classified.summary };
  } catch (err) {
    return { policy: 'UNKNOWN', summary: `Rules could not be read (${errorMessage(err)}).` };
  }
}

/** Post or comment on Reddit as the operator, after the same guardrails the social module uses. */
export async function composeRedditAsPersonal(input: RedditComposeInput): Promise<RedditComposeOutcome> {
  const { account, secrets } = await loadPersonalAccount(input.userId, 'REDDIT', input.accountId);
  const body = input.body.trim();
  if (input.kind === 'comment' && !input.thingId) throw new ValidationError('A comment needs the post or comment it answers.');
  const thread = input.kind === 'comment' && input.thingId ? await threadInfo(secrets, input.thingId) : null;
  const subreddit = input.subreddit ? `r/${bareSubreddit(input.subreddit)}` : thread?.subreddit ?? null;
  if (input.kind === 'post' && !subreddit) throw new ValidationError('Choose the subreddit to post in.');

  // ── through a site: that site's queue, caps and approvals trail ──
  if (input.websiteId) {
    const website = await prisma.website.findFirst({ where: { id: input.websiteId, userId: input.userId }, select: { id: true } });
    if (!website) throw new NotFoundError('Website');
    const siteAccount = await prisma.socialAccount.findUnique({ where: { websiteId_platform: { websiteId: website.id, platform: 'REDDIT' } } });
    let copiedAccount = false;
    if (!siteAccount || siteAccount.status !== 'CONNECTED' || !siteAccount.credentials) {
      await copyPersonalAccountToSite({ userId: input.userId, accountId: account.id, websiteId: website.id });
      copiedAccount = true;
    }
    let conversationId: string | null = null;
    if (thread && input.thingId) {
      const conversation = await prisma.socialConversation.upsert({
        where: { websiteId_platform_externalId: { websiteId: website.id, platform: 'REDDIT', externalId: input.thingId } },
        create: {
          websiteId: website.id,
          platform: 'REDDIT',
          externalId: input.thingId,
          url: thread.url,
          title: thread.title,
          community: thread.subreddit,
          publishedAt: thread.publishedAt,
          isLocked: thread.locked,
          backend: 'personal',
        },
        update: { isLocked: thread.locked, lastCheckedAt: new Date() },
        select: { id: true },
      });
      conversationId = conversation.id;
    }
    const created = await createOperatorSocialPost({
      websiteId: website.id,
      userId: input.userId,
      kind: input.kind === 'comment' ? 'REPLY' : 'ORIGINAL',
      platform: 'REDDIT',
      conversationId,
      title: input.title ?? null,
      body,
      community: subreddit,
    });
    return { status: 'queued', websiteId: website.id, postId: created.postId, copiedAccount };
  }

  // ── directly: the same guardrail functions, counted against this account's activity ──
  const brands = await operatorBrands(input.userId);
  const activity = activityOf(secrets.config);
  const dayStart = toUtcDate(new Date()).getTime();
  const weekAgo = Date.now() - 7 * 86_400_000;
  const policy = subreddit ? await communityPolicy(secrets, subreddit) : { policy: 'UNKNOWN' as CommunityPolicy, summary: '' };
  const community = subreddit ? { name: subreddit, promotionPolicy: policy.policy, isBlocked: false } : null;
  const includesLink = brands.domains.some((domain) => linksToDomain(body, domain));
  const mentionsBrand = mentionsAny(body, brands.terms);

  let decision: GuardDecision;
  if (input.kind === 'comment') {
    decision = evaluateReplyGuardrails({
      platform: 'REDDIT',
      conversation: { publishedAt: thread?.publishedAt ?? null, isLocked: thread?.locked ?? false },
      community,
      alreadyEngaged: false,
      repliesToday: activity.filter((entry) => entry.kind === 'comment' && new Date(entry.at).getTime() >= dayStart).length,
      dailyReplyLimit: 3,
      repliesInCommunityThisWeek: activity.filter(
        (entry) => entry.community?.toLowerCase() === subreddit?.toLowerCase() && new Date(entry.at).getTime() >= weekAgo,
      ).length,
      promo: promotionStats(activity),
      maxPromoRatio: 0.25,
      draft: { body, includesLink, mentionsBrand, hasDisclosure: hasDisclosure(body, brands.disclosure) },
    });
  } else {
    decision = evaluatePostGuardrails({
      platform: 'REDDIT',
      body,
      title: input.title ?? null,
      linkUrl: null,
      postsTodayOnAccount: activity.filter((entry) => entry.kind === 'post' && new Date(entry.at).getTime() >= dayStart).length,
      dailyPostLimit: 1,
      recentlySharedUrls: [],
      community,
      ownsCommunity: subreddit ? /^r\/u_/i.test(subreddit) : true,
    });
    if ((mentionsBrand || includesLink) && !hasDisclosure(body, brands.disclosure)) {
      decision = { ...decision, allowed: false, blockers: [...decision.blockers, 'The post promotes one of your sites without disclosing that you run it. Add the disclosure.'] };
    }
    if (policy.policy === 'RESTRICTED' && includesLink) {
      decision = { ...decision, allowed: false, blockers: [...decision.blockers, `${subreddit} restricts self-promotion: remove the link to your site.`] };
    }
  }
  if (policy.summary) decision.warnings.push(policy.summary);
  if (!decision.allowed) return { status: 'blocked', blockers: decision.blockers, warnings: decision.warnings };

  const publishSecrets: SocialAccountSecrets = { credentials: secrets.credentials, config: {} };
  const publisher = getPublisher('REDDIT');
  if (!publisher) throw new ValidationError('Reddit publishing is not available in this build.');
  const published = await publisher.publish(
    {
      kind: input.kind === 'comment' ? 'REPLY' : 'ORIGINAL',
      title: input.title ?? null,
      body,
      linkUrl: null,
      community: subreddit,
      replyTo: input.thingId && thread ? { externalId: input.thingId, url: thread.url } : null,
      canonicalUrl: null,
      tags: [],
    },
    publishSecrets,
  );
  const entry: ActivityEntry = { at: new Date().toISOString(), kind: input.kind, community: subreddit, includesLink };
  await prisma.personalAccount.update({
    where: { id: account.id },
    data: { config: json({ ...secrets.config, recentActivity: [...activity, entry].slice(-200) }) },
  });
  log.info('personal reddit write', { accountId: account.id, kind: input.kind });
  return { status: 'published', url: published.url, warnings: decision.warnings };
}
