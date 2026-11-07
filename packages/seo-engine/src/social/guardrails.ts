import { round, safeDivide } from '@seo/shared';
import type { CommunityPolicy } from './relevance';
import { ageInDays } from './relevance';
import { PLATFORM_TEXT_RULES, platformLength, type SocialPlatformName } from './format';

/**
 * The social guardrails.
 *
 * These encode the difference between taking part in a community and spamming it, as rules a
 * reviewer can read: one reply per thread, a daily cap, a per-community weekly cap, no
 * necro-posting, the community's own self-promotion rules, a cap on the share of activity that
 * links to us, and mandatory disclosure whenever we mention our own product. They run when a
 * draft is proposed AND again at publish time — the second check is the one that matters,
 * because a day can pass between the two.
 *
 * They are deliberately not configurable to zero: the operator can tighten the caps, not remove
 * them.
 */

/** Never more than this many replies in one community in seven days, whatever the daily cap says. */
export const COMMUNITY_WEEKLY_REPLY_CAP = 2;

/** Replies to threads older than this are refused: nobody reads them and they read as adverts. */
export const MAX_REPLY_AGE_DAYS = 14;

/** Reddit archives threads after six months; nobody can reply at all past this. */
const ARCHIVE_AGE_DAYS: Partial<Record<SocialPlatformName, number>> = { REDDIT: 180 };

/** The same page is not shared twice on one platform within this window. */
export const REPOST_COOLDOWN_DAYS = 30;

/** Upper bounds the operator cannot exceed from settings. */
export const SOCIAL_HARD_LIMITS = {
  dailyReplies: 10,
  dailyPostsPerAccount: 5,
  maxPromoRatio: 0.5,
} as const;

export interface PromotionStats {
  total: number;
  promotional: number;
  ratio: number;
}

/**
 * Share of recent activity that promoted us.
 *
 * The well-known community norm (Reddit's "10% rule" and its descendants) is about the ratio of
 * self-promotion to genuine participation. This counts what *this platform* posted; activity the
 * operator does by hand is invisible to it, so the ratio is an upper bound — which is the safe
 * direction to be wrong in.
 */
export function promotionStats(posts: ReadonlyArray<{ includesLink: boolean }>): PromotionStats {
  const promotional = posts.filter((post) => post.includesLink).length;
  return { total: posts.length, promotional, ratio: round(safeDivide(promotional, posts.length), 3) };
}

export interface GuardDecision {
  /** False when any blocker applies: the post must not be published. */
  allowed: boolean;
  /** Whether a link to our site is acceptable in this reply. False → help without linking. */
  linkAllowed: boolean;
  /** Whether our product may be named at all. */
  mentionAllowed: boolean;
  blockers: string[];
  warnings: string[];
}

export interface ReplyGuardInput {
  platform: SocialPlatformName;
  conversation: { publishedAt: Date | null; isLocked: boolean };
  community: { name: string; promotionPolicy: CommunityPolicy; isBlocked: boolean } | null;
  /** We already have a live (non-rejected, non-failed) reply in this thread. */
  alreadyEngaged: boolean;
  repliesToday: number;
  dailyReplyLimit: number;
  repliesInCommunityThisWeek: number;
  promo: PromotionStats;
  maxPromoRatio: number;
  /** Only set when checking a concrete draft; omitted when deciding whether to draft at all. */
  draft?: {
    body: string;
    includesLink: boolean;
    mentionsBrand: boolean;
    hasDisclosure: boolean;
  };
  now?: Date;
}

/** Whether we may reply in this thread, and on what terms. */
export function evaluateReplyGuardrails(input: ReplyGuardInput): GuardDecision {
  const now = input.now ?? new Date();
  const blockers: string[] = [];
  const warnings: string[] = [];
  let linkAllowed = true;
  let mentionAllowed = true;

  const dailyLimit = Math.min(Math.max(0, input.dailyReplyLimit), SOCIAL_HARD_LIMITS.dailyReplies);
  const maxRatio = Math.min(Math.max(0, input.maxPromoRatio), SOCIAL_HARD_LIMITS.maxPromoRatio);

  if (input.community?.isBlocked) {
    blockers.push(`${input.community.name} is on this site's block list.`);
  }
  if (input.conversation.isLocked) {
    blockers.push('The thread is locked or archived.');
  }
  if (input.alreadyEngaged) {
    blockers.push('We already replied in this thread. One reply per thread — follow-ups are for a human.');
  }
  if (input.repliesToday >= dailyLimit) {
    blockers.push(`Daily reply cap reached (${input.repliesToday}/${dailyLimit}).`);
  }
  if (input.community && input.repliesInCommunityThisWeek >= COMMUNITY_WEEKLY_REPLY_CAP) {
    blockers.push(
      `Already ${input.repliesInCommunityThisWeek} replies in ${input.community.name} this week (cap ${COMMUNITY_WEEKLY_REPLY_CAP}). Showing up every day in one community is how accounts get banned.`,
    );
  }

  const age = ageInDays(input.conversation.publishedAt, now);
  const archiveAge = ARCHIVE_AGE_DAYS[input.platform];
  if (age !== null && archiveAge !== undefined && age >= archiveAge) {
    blockers.push('The platform has archived this thread.');
  } else if (age !== null && age > MAX_REPLY_AGE_DAYS) {
    blockers.push(`The thread is ${Math.round(age)} days old; replies this late are rarely read and read as adverts.`);
  } else if (age !== null && age > 3) {
    warnings.push(`The thread is ${Math.round(age)} days old — expect little visibility.`);
  }

  switch (input.community?.promotionPolicy ?? null) {
    case 'FORBIDDEN':
      linkAllowed = false;
      mentionAllowed = false;
      warnings.push(`${input.community?.name} forbids self-promotion: help without naming or linking the product.`);
      break;
    case 'RESTRICTED':
      linkAllowed = false;
      warnings.push(`${input.community?.name} restricts self-promotion: name the product only if it directly answers the question, with disclosure, and without a link.`);
      break;
    case 'UNKNOWN':
      warnings.push(`${input.community?.name}'s rules have not been checked — read them before approving.`);
      break;
    default:
      break;
  }

  if (input.promo.total > 0 && safeDivide(input.promo.promotional + 1, input.promo.total + 1) > maxRatio) {
    linkAllowed = false;
    warnings.push(
      `${input.promo.promotional} of the last ${input.promo.total} social posts linked to the site; another link would exceed the ${Math.round(maxRatio * 100)}% cap. Reply without a link.`,
    );
  }

  if (input.draft) {
    const { draft } = input;
    if (draft.includesLink && !linkAllowed) {
      blockers.push('The draft links to the site, but a link is not acceptable in this thread (see warnings).');
    }
    if (draft.mentionsBrand && !mentionAllowed) {
      blockers.push('The draft names the product in a community that forbids self-promotion.');
    }
    if ((draft.mentionsBrand || draft.includesLink) && !draft.hasDisclosure) {
      blockers.push('The draft recommends our own product without disclosing the affiliation. Add the disclosure.');
    }
    const limit = PLATFORM_TEXT_RULES[input.platform].bodyLimit;
    const length = platformLength(draft.body, input.platform);
    if (length > limit) blockers.push(`The reply is ${length} characters; the platform allows ${limit}.`);
    if (draft.body.trim().length < 20) blockers.push('The reply is too short to be a genuine answer.');
  }

  return { allowed: blockers.length === 0, linkAllowed, mentionAllowed, blockers, warnings };
}

export interface PostGuardInput {
  platform: SocialPlatformName;
  body: string;
  title: string | null;
  linkUrl: string | null;
  postsTodayOnAccount: number;
  dailyPostLimit: number;
  /** Canonical (UTM-free) URLs shared on this platform within the cooldown window. */
  recentlySharedUrls: readonly string[];
  community: { name: string; promotionPolicy: CommunityPolicy; isBlocked: boolean } | null;
  /** True when the target community is one the operator owns (their profile or subreddit). */
  ownsCommunity: boolean;
}

/** Platforms where a submission without a title is rejected by the platform itself. */
const TITLED_PLATFORMS: readonly SocialPlatformName[] = ['REDDIT', 'HACKER_NEWS', 'DEVTO'];

/** Strip UTM and fragment so the same page shared with different tags is recognised as a repost. */
export function canonicalShareUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** Whether an original post may be published on an account we own. */
export function evaluatePostGuardrails(input: PostGuardInput): GuardDecision {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const dailyLimit = Math.min(Math.max(0, input.dailyPostLimit), SOCIAL_HARD_LIMITS.dailyPostsPerAccount);

  if (input.postsTodayOnAccount >= dailyLimit) {
    blockers.push(`Daily post cap for this account reached (${input.postsTodayOnAccount}/${dailyLimit}).`);
  }
  if (input.linkUrl) {
    const canonical = canonicalShareUrl(input.linkUrl);
    if (input.recentlySharedUrls.some((url) => canonicalShareUrl(url) === canonical)) {
      blockers.push(`This page was already shared on this platform in the last ${REPOST_COOLDOWN_DAYS} days.`);
    }
  }
  const rules = PLATFORM_TEXT_RULES[input.platform];
  const length = platformLength(input.body, input.platform);
  if (length > rules.bodyLimit) blockers.push(`The post is ${length} characters; the platform allows ${rules.bodyLimit}.`);
  if (TITLED_PLATFORMS.includes(input.platform) && !input.title?.trim()) {
    blockers.push('This platform needs a title.');
  }

  if (input.community && !input.ownsCommunity) {
    if (input.community.isBlocked) blockers.push(`${input.community.name} is on this site's block list.`);
    if (input.community.promotionPolicy === 'FORBIDDEN') {
      blockers.push(`${input.community.name} forbids self-promotion; do not submit there.`);
    } else if (input.community.promotionPolicy !== 'ALLOWED') {
      warnings.push(`${input.community.name} is not our community and its rules do not clearly allow this.`);
    }
  }

  return {
    allowed: blockers.length === 0,
    linkAllowed: true,
    mentionAllowed: true,
    blockers,
    warnings,
  };
}

/**
 * Which action type carries a post.
 *
 * Posting into a community we do not own — a reply, or a submission to someone else's
 * subreddit — is participation in another community and is `SOCIAL_REPLY`, which always needs a
 * human. Only posts on the operator's own channels are `SOCIAL_POST`, which a high-autonomy site
 * may publish unattended.
 */
export function socialActionTypeFor(input: {
  kind: 'REPLY' | 'ORIGINAL';
  community: string | null;
  ownedCommunities: readonly string[];
}): 'SOCIAL_REPLY' | 'SOCIAL_POST' {
  if (input.kind === 'REPLY') return 'SOCIAL_REPLY';
  if (!input.community) return 'SOCIAL_POST';
  const wanted = input.community.toLowerCase().replace(/^r\//, '');
  const owned = input.ownedCommunities.some((name) => name.toLowerCase().replace(/^r\//, '') === wanted);
  return owned ? 'SOCIAL_POST' : 'SOCIAL_REPLY';
}
