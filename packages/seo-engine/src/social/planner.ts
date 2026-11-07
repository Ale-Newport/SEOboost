import { clamp, round, saturate, type ScoreFactor } from '@seo/shared';
import { canonicalShareUrl, REPOST_COOLDOWN_DAYS } from './guardrails';
import type { SocialPlatformName } from './format';

/**
 * The daily-post planner.
 *
 * Decides, deterministically, *what* each connected account shares today; the model only writes
 * the words. Two kinds of page earn a slot: new or freshly updated content (an announcement has
 * a short shelf life) and pages that already prove useful in search (evergreen pages people
 * click on are the ones worth putting in front of a social audience). Nothing is shared twice on
 * one platform inside the cooldown, and utility pages never qualify.
 */

export interface ContentCandidate {
  pageId: string;
  url: string;
  title: string | null;
  pageType: string;
  publishedAt: Date | null;
  updatedAt: Date | null;
  clicks28d: number;
  impressions28d: number;
  isIndexable: boolean;
  wordCount: number | null;
}

export interface PlannerAccount {
  accountId: string;
  platform: SocialPlatformName;
  dailyPostLimit: number;
  postsToday: number;
}

export interface SharedRecord {
  url: string;
  platform: SocialPlatformName;
  sharedAt: Date;
}

export interface PlannedPost {
  accountId: string;
  platform: SocialPlatformName;
  candidate: ContentCandidate;
  score: number;
  factors: ScoreFactor[];
  reason: string;
  slot: Date;
}

/** Page types that are never worth a social post on their own. */
const EXCLUDED_PAGE_TYPES = new Set(['LEGAL', 'CONTACT', 'AUTHOR', 'CATEGORY', 'BLOG_INDEX']);

/** Thin pages make poor posts and invite "this is just an advert" replies. */
const MIN_WORDS = 250;

/**
 * UTC hour the first post of the day goes out. Mid-morning on the US east coast and mid-afternoon
 * in Europe — a compromise without knowing where a site's audience lives.
 */
export const DEFAULT_POSTING_HOUR_UTC = 14;

/** Minutes between consecutive posts in one day, so accounts do not all fire in the same second. */
const SLOT_SPACING_MINUTES = 25;

export function scoreCandidate(candidate: ContentCandidate, now: Date): { score: number; factors: ScoreFactor[]; reason: string } {
  const freshDate = candidate.publishedAt ?? candidate.updatedAt;
  const ageDays = freshDate ? Math.max(0, (now.getTime() - freshDate.getTime()) / 86_400_000) : null;
  // Halves every two weeks: a launch is news for days, not months.
  const freshness = ageDays === null ? 0 : 0.5 ** (ageDays / 14);
  const proven = clamp(saturate(candidate.clicks28d, 50) * 0.7 + saturate(candidate.impressions28d, 2_000) * 0.3);
  const depth = candidate.wordCount ? clamp(saturate(candidate.wordCount, 900)) : 0.4;

  const factors: ScoreFactor[] = [
    {
      key: 'freshness', label: 'New or updated', value: round(freshness, 3), weight: 0.45,
      contribution: round(freshness * 45, 1),
      explanation: ageDays === null
        ? 'No publish or update date known.'
        : `Published or updated ${Math.round(ageDays)} day${Math.round(ageDays) === 1 ? '' : 's'} ago.`,
    },
    {
      key: 'proven', label: 'Proven in search', value: round(proven, 3), weight: 0.4,
      contribution: round(proven * 40, 1),
      explanation: `${candidate.clicks28d} clicks and ${candidate.impressions28d} impressions in the last 28 days.`,
    },
    {
      key: 'depth', label: 'Substance', value: round(depth, 3), weight: 0.15,
      contribution: round(depth * 15, 1),
      explanation: candidate.wordCount ? `${candidate.wordCount} words.` : 'Word count unknown.',
    },
  ];
  const score = round(factors.reduce((sum, f) => sum + f.contribution, 0), 1);
  const reason = freshness >= 0.5
    ? 'Recently published or updated — worth announcing while it is new.'
    : proven >= 0.4
      ? 'An evergreen page that already earns search clicks.'
      : 'The best remaining page not shared recently on this platform.';
  return { score, factors, reason };
}

export function isShareable(candidate: ContentCandidate): boolean {
  return (
    candidate.isIndexable &&
    !EXCLUDED_PAGE_TYPES.has(candidate.pageType) &&
    (candidate.wordCount === null || candidate.wordCount >= MIN_WORDS || candidate.pageType === 'HOMEPAGE' || candidate.pageType === 'PRODUCT' || candidate.pageType === 'LANDING')
  );
}

/** The `index`-th posting slot today, or a few minutes from now when today's slot has passed. */
export function postingSlot(now: Date, index: number, hourUtc = DEFAULT_POSTING_HOUR_UTC): Date {
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, 0, 0));
  slot.setUTCMinutes(index * SLOT_SPACING_MINUTES);
  const earliest = new Date(now.getTime() + (10 + index * SLOT_SPACING_MINUTES) * 60_000);
  return slot.getTime() >= earliest.getTime() ? slot : earliest;
}

/**
 * Pick today's posts: for each account, its remaining daily quota filled with the best pages not
 * shared on that platform within the cooldown, never the same page twice on one account.
 */
export function planDailyPosts(input: {
  candidates: readonly ContentCandidate[];
  accounts: readonly PlannerAccount[];
  recentShares: readonly SharedRecord[];
  now?: Date;
  hourUtc?: number;
}): PlannedPost[] {
  const now = input.now ?? new Date();
  const cutoff = now.getTime() - REPOST_COOLDOWN_DAYS * 86_400_000;
  const ranked = input.candidates
    .filter(isShareable)
    .map((candidate) => ({ candidate, ...scoreCandidate(candidate, now) }))
    .sort((a, b) => b.score - a.score);

  const plan: PlannedPost[] = [];
  let slotIndex = 0;
  for (const account of input.accounts) {
    const remaining = Math.max(0, account.dailyPostLimit - account.postsToday);
    if (remaining === 0) continue;
    const sharedHere = new Set(
      input.recentShares
        .filter((share) => share.platform === account.platform && share.sharedAt.getTime() >= cutoff)
        .map((share) => canonicalShareUrl(share.url)),
    );
    let taken = 0;
    for (const entry of ranked) {
      if (taken >= remaining) break;
      const key = canonicalShareUrl(entry.candidate.url);
      if (sharedHere.has(key)) continue;
      sharedHere.add(key);
      plan.push({
        accountId: account.accountId,
        platform: account.platform,
        candidate: entry.candidate,
        score: entry.score,
        factors: entry.factors,
        reason: entry.reason,
        slot: postingSlot(now, slotIndex++, input.hourUtc),
      });
      taken++;
    }
  }
  return plan;
}
