import {
  type Prisma,
  type SocialPlatform,
  type SocialPost,
  type SocialPostKind,
  json,
  prisma,
} from '@seo/db';
import {
  canPublishWith,
  getPublisher,
  manualPostUrl,
  MANUAL_ONLY_PLATFORMS,
  SocialSourceError,
  type PostMetrics,
  type PublishInput,
} from '@seo/integrations';
import {
  evaluatePostGuardrails,
  evaluateReplyGuardrails,
  fitToPlatform,
  hasDisclosure,
  linksToDomain,
  mentionsAny,
  riskBandForActionType,
  socialActionTypeFor,
  type GuardDecision,
  type SocialPlatformName,
} from '@seo/seo-engine';
import { NotFoundError, ValidationError, createLogger, errorMessage, truncate } from '@seo/shared';
import { isRecord } from '../agents/shared';
import {
  freshAccountSecrets,
  findCommunity,
  loadSocialContext,
  ownedCommunities,
  postsTodayOnAccount,
  recentlySharedUrls,
  replyCounters,
} from '../agents/social-shared';

/**
 * Publishing a social post, shared by the worker (scheduled and approved posts) and the web app
 * (operator-written posts, manual "I posted it" confirmations).
 *
 * The guardrails run again here, at publish time, from current data. A reply approved this
 * morning is checked against the caps as they stand this afternoon; a post whose community
 * was blocked in the meantime does not go out. Approval says "this text is fine", not "skip the
 * rules".
 */

const log = createLogger('social:publish');

/** A post due within this window is published now rather than waiting for the next sweep. */
const DUE_TOLERANCE_MS = 60_000;

const LINK_IN_TEXT_PLATFORMS = new Set<SocialPlatform>(['X', 'MASTODON', 'TELEGRAM', 'DISCORD', 'BLUESKY', 'REDDIT']);

export type PublishOutcome =
  | { status: 'published'; postId: string; externalId: string; url: string | null; warnings: string[] }
  | { status: 'manual'; postId: string; manualUrl: string | null; reason: string; warnings: string[] }
  | { status: 'scheduled'; postId: string; scheduledFor: Date }
  | { status: 'deferred'; postId: string; retryAt: Date; reason: string }
  | { status: 'blocked'; postId: string; blockers: string[]; warnings: string[] }
  | { status: 'failed'; postId: string; error: string; code: string | null }
  | { status: 'noop'; postId: string; reason: string };

/** Read the operator-editable fields back off the action payload (the approval editor writes there). */
function editedFields(payload: Prisma.JsonValue | null | undefined): { body?: string; title?: string; community?: string; scheduledFor?: Date } {
  if (!isRecord(payload)) return {};
  const out: { body?: string; title?: string; community?: string; scheduledFor?: Date } = {};
  if (typeof payload.body === 'string' && payload.body.trim()) out.body = payload.body;
  if (typeof payload.title === 'string') out.title = payload.title;
  if (typeof payload.community === 'string') out.community = payload.community;
  if (typeof payload.scheduledFor === 'string') {
    const date = new Date(payload.scheduledFor);
    if (!Number.isNaN(date.getTime())) out.scheduledFor = date;
  }
  return out;
}

async function guardFor(post: SocialPost, website: Awaited<ReturnType<typeof loadSocialContext>>): Promise<GuardDecision> {
  const platform = post.platform as SocialPlatformName;
  const community = await findCommunity(post.websiteId, post.platform, post.community);
  const communityState = community
    ? { name: community.name, promotionPolicy: community.promotionPolicy, isBlocked: community.isBlocked }
    : null;

  if (post.kind === 'REPLY') {
    const conversation = post.conversationId
      ? await prisma.socialConversation.findUnique({ where: { id: post.conversationId }, select: { publishedAt: true, isLocked: true } })
      : null;
    const counters = await replyCounters({
      websiteId: post.websiteId,
      conversationId: post.conversationId ?? '',
      community: post.community,
      excludePostId: post.id,
      countPending: false,
    });
    return evaluateReplyGuardrails({
      platform,
      conversation: { publishedAt: conversation?.publishedAt ?? null, isLocked: conversation?.isLocked ?? false },
      community: communityState,
      alreadyEngaged: post.conversationId ? counters.alreadyEngaged : false,
      repliesToday: counters.repliesToday,
      dailyReplyLimit: website.limits.dailyReplyLimit,
      repliesInCommunityThisWeek: counters.repliesInCommunityThisWeek,
      promo: counters.promo,
      maxPromoRatio: website.limits.maxPromoRatio,
      draft: {
        body: post.body,
        includesLink: post.includesLink,
        mentionsBrand: mentionsAny(post.body, website.brandTerms),
        hasDisclosure: hasDisclosure(post.body, website.limits.disclosure),
      },
    });
  }

  const account = post.accountId ? await prisma.socialAccount.findUnique({ where: { id: post.accountId } }) : null;
  const profile = account?.handle ? `u_${account.handle.replace(/^u\//i, '')}` : null;
  const owned = [...ownedCommunities(account), ...(profile ? [profile] : [])];
  return evaluatePostGuardrails({
    platform,
    body: post.body,
    title: post.title,
    linkUrl: post.linkUrl,
    postsTodayOnAccount: post.accountId ? await postsTodayOnAccount(post.accountId, new Date(), post.id) : 0,
    dailyPostLimit: website.limits.dailyPostLimit,
    recentlySharedUrls: await recentlySharedUrls(post.websiteId, post.platform, 30, post.id),
    community: communityState,
    ownsCommunity: post.community ? socialActionTypeFor({ kind: 'ORIGINAL', community: post.community, ownedCommunities: owned }) === 'SOCIAL_POST' : true,
  });
}

/**
 * Publish one post now (or report why not).
 *
 * Never throws for an expected outcome — a blocked, scheduled, manual or rate-limited post is a
 * normal result the caller records. Only infrastructure failures (database down) throw.
 */
export async function publishSocialPost(postId: string, opts: { force?: boolean } = {}): Promise<PublishOutcome> {
  const loaded = await prisma.socialPost.findUnique({
    where: { id: postId },
    include: { action: { select: { payload: true, status: true } }, conversation: { select: { externalId: true, url: true } } },
  });
  if (!loaded) throw new NotFoundError(`Social post ${postId}`);
  if (['PUBLISHED', 'CANCELLED', 'REJECTED', 'PUBLISHING'].includes(loaded.status)) {
    return { status: 'noop', postId, reason: `The post is already ${loaded.status.toLowerCase()}.` };
  }
  // A failed publish may have half-succeeded on the platform's side (the post exists but the
  // response was lost). Retrying automatically could post twice, so only a human retry proceeds.
  if (loaded.status === 'FAILED' && !opts.force) {
    return { status: 'noop', postId, reason: 'The last attempt failed; retry it from Social → Posts after checking the platform.' };
  }

  // The executor publishes exactly what was approved: edits made in the approval editor win.
  const edits = editedFields(loaded.action?.payload);
  const website = await loadSocialContext(loaded.websiteId);
  let post: SocialPost = loaded;
  if (edits.body !== undefined || edits.title !== undefined || edits.community !== undefined || edits.scheduledFor !== undefined) {
    const body = edits.body ?? loaded.body;
    post = await prisma.socialPost.update({
      where: { id: postId },
      data: {
        body,
        ...(edits.title !== undefined ? { title: edits.title.trim() || null } : {}),
        ...(edits.community !== undefined ? { community: edits.community.trim() || null } : {}),
        ...(edits.scheduledFor ? { scheduledFor: edits.scheduledFor } : {}),
        includesLink: linksToDomain(body, website.domain),
      },
    });
  }

  // Most publishers post text only; a link kept beside the text would silently go missing.
  // LinkedIn and Dev.to attach it themselves (article card, canonical URL), so they are left alone.
  if (post.linkUrl && !post.body.includes(post.linkUrl) && LINK_IN_TEXT_PLATFORMS.has(post.platform)) {
    post = await prisma.socialPost.update({
      where: { id: postId },
      data: { body: fitToPlatform(post.body, post.platform as SocialPlatformName, post.linkUrl).text },
    });
  }

  if (!opts.force && post.scheduledFor && post.scheduledFor.getTime() > Date.now() + DUE_TOLERANCE_MS) {
    await prisma.socialPost.update({ where: { id: postId }, data: { status: 'SCHEDULED' } });
    return { status: 'scheduled', postId, scheduledFor: post.scheduledFor };
  }

  const guard = await guardFor(post, website);
  if (!guard.allowed) {
    await prisma.socialPost.update({
      where: { id: postId },
      data: { status: 'FAILED', error: truncate(`Blocked at publish time: ${guard.blockers.join(' ')}`, 2_000) },
    });
    return { status: 'blocked', postId, blockers: guard.blockers, warnings: guard.warnings };
  }

  const input: PublishInput = {
    kind: post.kind,
    title: post.title,
    body: post.body,
    linkUrl: post.linkUrl,
    community: post.community,
    replyTo: loaded.conversation ? { externalId: loaded.conversation.externalId, url: loaded.conversation.url } : null,
    canonicalUrl: post.linkUrl ? post.linkUrl.split('?')[0] ?? post.linkUrl : null,
    tags: [],
  };

  const account = post.accountId
    ? await prisma.socialAccount.findFirst({ where: { id: post.accountId, status: 'CONNECTED' } })
    : await prisma.socialAccount.findFirst({ where: { websiteId: post.websiteId, platform: post.platform, status: 'CONNECTED' } });
  const publisher = getPublisher(post.platform);
  const secrets = account ? await freshAccountSecrets(account) : null;
  const supported =
    publisher &&
    (post.kind === 'REPLY' ? publisher.capabilities.reply : publisher.capabilities.original) &&
    (!secrets || canPublishWith(post.platform, secrets));
  if (!publisher || !secrets || !supported || MANUAL_ONLY_PLATFORMS.includes(post.platform)) {
    const reason = MANUAL_ONLY_PLATFORMS.includes(post.platform)
      ? `${post.platform} has no posting API — post it by hand, then mark it as published.`
      : !account || !secrets
        ? `No connected ${post.platform} account — post it by hand, then mark it as published.`
        : !canPublishWith(post.platform, secrets)
          ? `The connected ${post.platform} account is read-only (no login stored) — post it by hand, or add the login on Social → Accounts.`
          : `The ${post.platform} API cannot post a ${post.kind.toLowerCase()} — post it by hand, then mark it as published.`;
    await prisma.socialPost.update({ where: { id: postId }, data: { status: 'MANUAL_PENDING', error: null } });
    return { status: 'manual', postId, manualUrl: manualPostUrl(post.platform, input), reason, warnings: guard.warnings };
  }

  await prisma.socialPost.update({ where: { id: postId }, data: { status: 'PUBLISHING', accountId: account?.id ?? null } });
  try {
    const published = await publisher.publish(input, secrets);
    const now = new Date();
    await prisma.$transaction([
      prisma.socialPost.update({
        where: { id: postId },
        data: { status: 'PUBLISHED', publishedAt: now, externalId: published.externalId, externalUrl: published.url, error: null },
      }),
      prisma.socialAccount.update({ where: { id: account!.id }, data: { lastPostAt: now, lastError: null } }),
      ...(post.conversationId
        ? [prisma.socialConversation.update({ where: { id: post.conversationId }, data: { status: 'REPLIED' } })]
        : []),
    ]);
    log.info('social post published', { postId, platform: post.platform, kind: post.kind });
    return { status: 'published', postId, externalId: published.externalId, url: published.url, warnings: guard.warnings };
  } catch (err) {
    const code = err instanceof SocialSourceError ? err.code : null;
    if (err instanceof SocialSourceError && err.code === 'RATE_LIMITED') {
      const retryAt = new Date(Date.now() + Math.max(60, err.retryAfterSeconds ?? 600) * 1000);
      await prisma.socialPost.update({ where: { id: postId }, data: { status: 'SCHEDULED', scheduledFor: retryAt, error: truncate(err.message, 1_000) } });
      return { status: 'deferred', postId, retryAt, reason: err.message };
    }
    const message = errorMessage(err);
    await prisma.socialPost.update({ where: { id: postId }, data: { status: 'FAILED', error: truncate(message, 2_000) } });
    if (account) {
      await prisma.socialAccount.update({
        where: { id: account.id },
        data: { lastError: truncate(message, 1_000), ...(code === 'NEED_LOGIN' ? { status: 'ERROR' } : {}) },
      });
    }
    return { status: 'failed', postId, error: message, code };
  }
}

export interface OperatorPostInput {
  websiteId: string;
  userId: string;
  kind: SocialPostKind;
  platform: SocialPlatform;
  accountId?: string | null;
  conversationId?: string | null;
  title?: string | null;
  body: string;
  linkUrl?: string | null;
  community?: string | null;
  scheduledFor?: Date | null;
}

/**
 * A post the operator wrote (or finished editing) themselves.
 *
 * It is recorded as an action the operator proposed *and* approved — the same `SeoAction` +
 * `Approval` trail every agent proposal leaves — so the History screen and the change log show
 * who decided to post what, and the publish-time guardrails still apply.
 */
export async function createOperatorSocialPost(input: OperatorPostInput): Promise<{ postId: string; actionId: string }> {
  const body = input.body.trim();
  if (body.length < 2) throw new ValidationError('The post is empty.');
  const website = await loadSocialContext(input.websiteId);
  const account = input.accountId
    ? await prisma.socialAccount.findFirst({ where: { id: input.accountId, websiteId: input.websiteId } })
    : await prisma.socialAccount.findFirst({ where: { websiteId: input.websiteId, platform: input.platform } });
  const conversation = input.conversationId
    ? await prisma.socialConversation.findFirst({ where: { id: input.conversationId, websiteId: input.websiteId } })
    : null;
  if (input.conversationId && !conversation) throw new NotFoundError('Conversation');
  const community = input.community?.trim() || conversation?.community || null;
  const profile = account?.handle ? `u_${account.handle.replace(/^u\//i, '')}` : null;
  const type = socialActionTypeFor({
    kind: input.kind,
    community: input.kind === 'ORIGINAL' ? community : null,
    ownedCommunities: [...ownedCommunities(account), ...(profile ? [profile] : [])],
  });
  const includesLink = linksToDomain(`${body} ${input.linkUrl ?? ''}`, website.domain);
  const now = new Date();
  const title = truncate(
    input.kind === 'REPLY'
      ? `Reply on ${community ?? input.platform}: ${conversation?.title ?? truncate(body, 80)}`
      : `Post on ${account?.handle ?? input.platform}: ${input.title ?? truncate(body, 80)}`,
    200,
  );

  return prisma.$transaction(async (tx) => {
    const action = await tx.seoAction.create({
      data: {
        websiteId: input.websiteId,
        type,
        title,
        status: 'APPROVED',
        risk: riskBandForActionType(type),
        reasoning: 'Written and approved by the operator.',
        payload: json({ body, ...(input.title ? { title: input.title } : {}), platform: input.platform, community: community ?? '' }),
        sourceType: 'social-operator',
        sourceId: conversation?.id ?? null,
        approvedAt: now,
        autoExecutable: false,
      },
      select: { id: true },
    });
    await tx.approval.create({
      data: {
        websiteId: input.websiteId,
        actionId: action.id,
        userId: input.userId,
        kind: 'ACTION',
        title,
        risk: riskBandForActionType(type),
        status: 'APPROVED',
        decidedAt: now,
        decisionNote: 'Written by the operator.',
        payload: json({ type, payload: { body } }),
      },
    });
    const post = await tx.socialPost.create({
      data: {
        websiteId: input.websiteId,
        accountId: account?.id ?? null,
        conversationId: conversation?.id ?? null,
        actionId: action.id,
        kind: input.kind,
        platform: input.platform,
        status: 'APPROVED',
        community,
        title: input.title?.trim() || null,
        body,
        linkUrl: input.linkUrl?.trim() || null,
        includesLink,
        disclosure: hasDisclosure(body, website.limits.disclosure) ? website.limits.disclosure : null,
        generatedBy: 'operator',
        scheduledFor: input.scheduledFor ?? null,
      },
      select: { id: true },
    });
    await tx.changeLog.create({
      data: {
        websiteId: input.websiteId,
        actionId: action.id,
        userId: input.userId,
        actor: 'user',
        changeType: 'SOCIAL_POST_CREATED',
        targetUrl: conversation?.url ?? null,
        summary: `Operator queued a ${input.kind.toLowerCase()} on ${input.platform}`,
        afterState: json({ body: truncate(body, 1_000), scheduledFor: input.scheduledFor?.toISOString() ?? null }),
        approved: true,
      },
    });
    if (conversation) {
      await tx.socialConversation.update({ where: { id: conversation.id }, data: { status: 'DRAFTED' } });
    }
    return { postId: post.id, actionId: action.id };
  });
}

/** Edit a post that has not gone out yet; the action payload is kept in step so approval shows the same text. */
export async function updateSocialPostDraft(
  postId: string,
  websiteIds: readonly string[],
  patch: { body?: string; title?: string | null; scheduledFor?: Date | null; community?: string | null },
): Promise<SocialPost> {
  const post = await prisma.socialPost.findFirst({ where: { id: postId, websiteId: { in: [...websiteIds] } }, include: { action: true } });
  if (!post) throw new NotFoundError('Social post');
  if (!['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'FAILED', 'MANUAL_PENDING'].includes(post.status)) {
    throw new ValidationError(`A ${post.status.toLowerCase()} post can no longer be edited.`);
  }
  const website = await loadSocialContext(post.websiteId);
  const body = patch.body?.trim() ?? post.body;
  const updated = await prisma.socialPost.update({
    where: { id: postId },
    data: {
      body,
      includesLink: linksToDomain(`${body} ${post.linkUrl ?? ''}`, website.domain),
      ...(patch.title !== undefined ? { title: patch.title?.trim() || null } : {}),
      ...(patch.community !== undefined ? { community: patch.community?.trim() || null } : {}),
      ...(patch.scheduledFor !== undefined ? { scheduledFor: patch.scheduledFor } : {}),
      ...(post.status === 'FAILED' ? { status: post.actionId ? 'APPROVED' : 'DRAFT', error: null } : {}),
    },
  });
  if (post.action) {
    const payload = isRecord(post.action.payload) ? post.action.payload : {};
    await prisma.seoAction.update({
      where: { id: post.action.id },
      data: {
        payload: json({
          ...payload,
          body,
          ...(patch.title !== undefined ? { title: patch.title ?? '' } : {}),
          ...(patch.community !== undefined ? { community: patch.community ?? '' } : {}),
          ...(patch.scheduledFor !== undefined ? { scheduledFor: patch.scheduledFor?.toISOString() ?? '' } : {}),
        }),
        ...(post.status === 'FAILED' ? { status: 'APPROVED', error: null } : {}),
      },
    });
  }
  return updated;
}

/** The operator posted by hand: record where, close the action, mark the thread answered. */
export async function markSocialPostPublished(
  postId: string,
  websiteIds: readonly string[],
  userId: string,
  externalUrl: string | null,
): Promise<SocialPost> {
  const post = await prisma.socialPost.findFirst({ where: { id: postId, websiteId: { in: [...websiteIds] } } });
  if (!post) throw new NotFoundError('Social post');
  if (post.status === 'PUBLISHED') return post;
  const now = new Date();
  const [updated] = await prisma.$transaction([
    prisma.socialPost.update({
      where: { id: postId },
      data: { status: 'PUBLISHED', publishedAt: now, externalUrl: externalUrl?.trim() || null, error: null },
    }),
    ...(post.actionId
      ? [prisma.seoAction.update({ where: { id: post.actionId }, data: { status: 'COMPLETED', completedAt: now, executedAt: now } })]
      : []),
    ...(post.conversationId
      ? [prisma.socialConversation.update({ where: { id: post.conversationId }, data: { status: 'REPLIED' } })]
      : []),
    prisma.changeLog.create({
      data: {
        websiteId: post.websiteId,
        actionId: post.actionId,
        userId,
        actor: 'user',
        changeType: 'SOCIAL_POST_PUBLISHED',
        targetUrl: externalUrl?.trim() || null,
        summary: `Posted by hand on ${post.platform}`,
        afterState: json({ externalUrl }),
        approved: true,
      },
    }),
  ]);
  return updated;
}

/** Posts that are approved (or auto-approved) and due now. */
export async function duePosts(websiteId?: string, now = new Date()): Promise<Array<{ id: string; websiteId: string; actionId: string | null }>> {
  return prisma.socialPost.findMany({
    where: {
      ...(websiteId ? { websiteId } : {}),
      status: { in: ['SCHEDULED', 'APPROVED'] },
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: new Date(now.getTime() + DUE_TOLERANCE_MS) } }],
      action: { status: { in: ['QUEUED', 'APPROVED'] } },
    },
    orderBy: { scheduledFor: 'asc' },
    take: 50,
    select: { id: true, websiteId: true, actionId: true },
  });
}

/** Refresh engagement for recently published posts, one API call per account where possible. */
export async function refreshSocialMetrics(websiteId: string, lookbackDays = 14): Promise<{ checked: number; updated: number; errors: string[] }> {
  const since = new Date(Date.now() - lookbackDays * 86_400_000);
  const posts = await prisma.socialPost.findMany({
    where: { websiteId, status: 'PUBLISHED', externalId: { not: null }, publishedAt: { gte: since }, accountId: { not: null } },
    select: { id: true, externalId: true, accountId: true, platform: true, metrics: true },
    take: 500,
  });
  const byAccount = new Map<string, typeof posts>();
  for (const post of posts) {
    if (!post.accountId) continue;
    byAccount.set(post.accountId, [...(byAccount.get(post.accountId) ?? []), post]);
  }

  let updated = 0;
  const errors: string[] = [];
  for (const [accountId, group] of byAccount) {
    const account = await prisma.socialAccount.findUnique({ where: { id: accountId } });
    const publisher = account ? getPublisher(account.platform) : null;
    const secrets = account ? await freshAccountSecrets(account) : null;
    if (!account || !publisher?.metrics || !secrets) continue;
    try {
      const metrics: Record<string, PostMetrics> = await publisher.metrics(
        group.flatMap((post) => (post.externalId ? [post.externalId] : [])),
        secrets,
      );
      const now = new Date();
      for (const post of group) {
        const value = post.externalId ? metrics[post.externalId] : undefined;
        if (!value) continue;
        await prisma.socialPost.update({
          where: { id: post.id },
          data: { metrics: json({ ...(isRecord(post.metrics) ? post.metrics : {}), ...value }), metricsCheckedAt: now },
        });
        updated++;
      }
    } catch (err) {
      errors.push(`${account.platform}: ${errorMessage(err)}`);
    }
  }
  return { checked: posts.length, updated, errors };
}
