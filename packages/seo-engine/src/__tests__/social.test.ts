import { describe, expect, it } from 'vitest';
import {
  detectIntent,
  matchesNegative,
  scoreConversation,
  type RelevanceContext,
} from '../social/relevance';
import {
  fitToPlatform,
  fitTitle,
  graphemeLength,
  hasDisclosure,
  linksToDomain,
  platformLength,
  withUtm,
} from '../social/format';
import {
  canonicalShareUrl,
  evaluatePostGuardrails,
  evaluateReplyGuardrails,
  promotionStats,
  socialActionTypeFor,
  type ReplyGuardInput,
} from '../social/guardrails';
import { planDailyPosts, postingSlot, type ContentCandidate } from '../social/planner';
import { classifyPromotionPolicy } from '../social/community';

const NOW = new Date('2026-11-07T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const ctx = (over: Partial<RelevanceContext> = {}): RelevanceContext => ({
  topicQuery: 'meal planning app',
  topicKeywords: ['grocery list', 'macros'],
  topicKind: 'problem',
  brandTerms: ['Mealwise', 'mealwise.app'],
  competitorTerms: ['Mealime'],
  communityPolicy: 'ALLOWED',
  now: NOW,
  ...over,
});

describe('detectIntent', () => {
  const terms = { brandTerms: ['Mealwise'], competitorTerms: ['Mealime'] };

  it('recognises recommendation requests in English and Spanish', () => {
    expect(detectIntent('Can anyone recommend a meal planning app?', terms)).toBe('seeking-recommendation');
    expect(detectIntent('¿Alguien me recomienda una aplicación para planificar comidas?', terms)).toBe(
      'seeking-recommendation',
    );
    expect(detectIntent('Busco una herramienta para hacer la lista de la compra', terms)).toBe('seeking-recommendation');
  });

  it('separates comparisons from plain competitor mentions', () => {
    expect(detectIntent('Any alternative to Mealime? It got expensive', terms)).toBe('comparison');
    expect(detectIntent('I have been using Mealime for a year', terms)).toBe('competitor-mention');
  });

  it('puts a brand mention ahead of everything else', () => {
    expect(detectIntent('Mealwise vs Mealime, which is better?', terms)).toBe('brand-mention');
  });

  it('detects a described problem and falls back to discussion', () => {
    expect(detectIntent("I'm struggling to plan meals for the week", terms)).toBe('problem');
    expect(detectIntent('¿Cómo puedo organizar las comidas de la semana?', terms)).toBe('problem');
    expect(detectIntent('Here is my lunch today', terms)).toBe('discussion');
  });
});

describe('scoreConversation', () => {
  it('ranks a fresh recommendation request well above a stale chat', () => {
    const fresh = scoreConversation(
      {
        title: 'Can anyone recommend a meal planning app?',
        body: 'Need something that builds a grocery list',
        community: 'r/MealPrepSunday',
        publishedAt: hoursAgo(5),
        score: 30,
        commentCount: 12,
      },
      ctx(),
    );
    const stale = scoreConversation(
      {
        title: 'meal planning',
        body: 'just chatting',
        community: 'r/food',
        publishedAt: hoursAgo(24 * 20),
        score: 1,
        commentCount: 0,
      },
      ctx({ communityPolicy: 'RESTRICTED' }),
    );
    expect(fresh.intent).toBe('seeking-recommendation');
    expect(fresh.score).toBeGreaterThan(70);
    expect(stale.score).toBeLessThan(40);
    expect(fresh.factors.map((f) => f.key)).toEqual(['topic', 'intent', 'freshness', 'engagement', 'community']);
    // The factor contributions are the score — nothing hidden.
    const total = fresh.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(Math.abs(total - fresh.score)).toBeLessThan(0.6);
  });

  it('keeps a passing mention in an unrelated discussion below the auto-draft bar', () => {
    const chatter = scoreConversation(
      {
        title: 'Deus Ex',
        body: 'The meal planning app inventory system in that game was the best part.',
        community: null,
        publishedAt: hoursAgo(6),
        score: null,
        commentCount: null,
      },
      ctx({ communityPolicy: null }),
    );
    expect(chatter.intent).toBe('discussion');
    expect(chatter.score).toBeLessThan(55);
  });

  it('values a comparison less when none of our competitors is named', () => {
    const named = scoreConversation(
      { title: 'Mealime vs Paprika for a meal planning app?', body: null, community: null, publishedAt: hoursAgo(2), score: 5, commentCount: 3 },
      ctx(),
    );
    const unnamed = scoreConversation(
      { title: 'Postgres vs MySQL for my meal planning app?', body: null, community: null, publishedAt: hoursAgo(2), score: 5, commentCount: 3 },
      ctx(),
    );
    expect(named.intent).toBe('comparison');
    expect(unnamed.intent).toBe('comparison');
    expect(named.score).toBeGreaterThan(unnamed.score);
    expect(unnamed.factors.find((f) => f.key === 'intent')?.explanation).toMatch(/none of our competitors/);
  });

  it('scores a locked thread at zero with the reason', () => {
    const result = scoreConversation(
      { title: 'meal planning app?', body: null, community: null, publishedAt: NOW, score: 5, commentCount: 5, isLocked: true },
      ctx(),
    );
    expect(result.score).toBe(0);
    expect(result.summary).toMatch(/locked/);
  });

  it('drops threads that hit a negative keyword', () => {
    expect(matchesNegative('Hiring: meal planning app developer', ['hiring'])).toBe('hiring');
    expect(matchesNegative('meal planning app', ['hiring'])).toBeNull();
  });
});

describe('platform formatting', () => {
  it('counts graphemes, not UTF-16 units', () => {
    expect(graphemeLength('👍🏽')).toBe(1);
    expect(graphemeLength('café')).toBe(4);
  });

  it('weighs URLs as fixed-length on X', () => {
    const text = `hello https://example.com/${'a'.repeat(200)}`;
    expect(platformLength(text, 'X')).toBe('hello '.length + 23);
  });

  it('fits a long post while keeping the link intact', () => {
    const body = 'This is a sentence about planning meals. '.repeat(20);
    const link = 'https://mealwise.app/guide?utm_source=bluesky';
    const fitted = fitToPlatform(body, 'BLUESKY', link);
    expect(fitted.truncated).toBe(true);
    expect(fitted.length).toBeLessThanOrEqual(300);
    expect(fitted.text.endsWith(link)).toBe(true);
    expect(fitted.text).toContain('…');
  });

  it('leaves a short post alone and clips titles', () => {
    expect(fitToPlatform('Short.', 'X', 'https://a.co').truncated).toBe(false);
    expect(fitTitle('x'.repeat(100), 'HACKER_NEWS')).toHaveLength(80);
    expect(fitTitle('Anything', 'X')).toBeNull();
  });

  it('adds UTM parameters without overriding hand-tagged ones', () => {
    const tagged = withUtm('https://mealwise.app/a?utm_source=newsletter', { source: 'reddit', campaign: 'social' });
    const url = new URL(tagged);
    expect(url.searchParams.get('utm_source')).toBe('newsletter');
    expect(url.searchParams.get('utm_medium')).toBe('social');
    expect(url.searchParams.get('utm_campaign')).toBe('social');
  });

  it('recognises links to the site and affiliation disclosures', () => {
    expect(linksToDomain('see https://www.mealwise.app/x', 'mealwise.app')).toBe(true);
    expect(linksToDomain('see https://other.com', 'mealwise.app')).toBe(false);
    expect(hasDisclosure("Full disclosure: I'm the founder of Mealwise.")).toBe(true);
    expect(hasDisclosure('Soy el creador de Mealwise, así que tómalo con cautela.')).toBe(true);
    expect(hasDisclosure('Mealwise is great, try it')).toBe(false);
    expect(hasDisclosure('I make Mealwise', 'I make Mealwise')).toBe(true);
  });
});

describe('reply guardrails', () => {
  const base = (over: Partial<ReplyGuardInput> = {}): ReplyGuardInput => ({
    platform: 'REDDIT',
    conversation: { publishedAt: hoursAgo(10), isLocked: false },
    community: { name: 'r/MealPrepSunday', promotionPolicy: 'ALLOWED', isBlocked: false },
    alreadyEngaged: false,
    repliesToday: 0,
    dailyReplyLimit: 3,
    repliesInCommunityThisWeek: 0,
    promo: { total: 0, promotional: 0, ratio: 0 },
    maxPromoRatio: 0.25,
    now: NOW,
    ...over,
  });

  it('allows a disclosed reply in a permissive community', () => {
    const decision = evaluateReplyGuardrails(
      base({ draft: { body: 'I built Mealwise for exactly this — it makes the grocery list for you.', includesLink: true, mentionsBrand: true, hasDisclosure: true } }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.linkAllowed).toBe(true);
  });

  it('blocks undisclosed self-promotion', () => {
    const decision = evaluateReplyGuardrails(
      base({ draft: { body: 'Mealwise is the best app for this, go try it now.', includesLink: false, mentionsBrand: true, hasDisclosure: false } }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(' ')).toMatch(/disclos/);
  });

  it('enforces one reply per thread, the daily cap and the community weekly cap', () => {
    expect(evaluateReplyGuardrails(base({ alreadyEngaged: true })).allowed).toBe(false);
    expect(evaluateReplyGuardrails(base({ repliesToday: 3 })).allowed).toBe(false);
    expect(evaluateReplyGuardrails(base({ repliesInCommunityThisWeek: 2 })).allowed).toBe(false);
  });

  it('cannot be configured past the hard limits', () => {
    expect(evaluateReplyGuardrails(base({ repliesToday: 10, dailyReplyLimit: 1000 })).allowed).toBe(false);
  });

  it('refuses stale and archived threads', () => {
    expect(evaluateReplyGuardrails(base({ conversation: { publishedAt: hoursAgo(24 * 20), isLocked: false } })).allowed).toBe(false);
    expect(evaluateReplyGuardrails(base({ conversation: { publishedAt: hoursAgo(24 * 200), isLocked: false } })).blockers[0]).toMatch(
      /archived/,
    );
  });

  it('drops the link when the community restricts promotion or the promo ratio is spent', () => {
    expect(
      evaluateReplyGuardrails(base({ community: { name: 'r/x', promotionPolicy: 'RESTRICTED', isBlocked: false } })).linkAllowed,
    ).toBe(false);
    const ratio = evaluateReplyGuardrails(base({ promo: { total: 4, promotional: 1, ratio: 0.25 } }));
    expect(ratio.linkAllowed).toBe(false);
    expect(ratio.allowed).toBe(true);
  });

  it('forbids naming the product where the rules forbid promotion', () => {
    const decision = evaluateReplyGuardrails(
      base({
        community: { name: 'r/strict', promotionPolicy: 'FORBIDDEN', isBlocked: false },
        draft: { body: 'Disclosure: I built Mealwise, which does this automatically.', includesLink: false, mentionsBrand: true, hasDisclosure: true },
      }),
    );
    expect(decision.allowed).toBe(false);
    expect(decision.mentionAllowed).toBe(false);
  });
});

describe('post guardrails and routing', () => {
  it('blocks reposting the same page within the cooldown, ignoring UTM tags', () => {
    const decision = evaluatePostGuardrails({
      platform: 'BLUESKY',
      body: 'New guide out',
      title: null,
      linkUrl: 'https://mealwise.app/guide?utm_source=bluesky',
      postsTodayOnAccount: 0,
      dailyPostLimit: 1,
      recentlySharedUrls: ['https://mealwise.app/guide?utm_source=x&utm_campaign=social'],
      community: null,
      ownsCommunity: true,
    });
    expect(decision.allowed).toBe(false);
    expect(canonicalShareUrl('https://a.com/x/?utm_source=y#top')).toBe('https://a.com/x');
  });

  it('needs a title on Reddit and respects the daily cap', () => {
    const decision = evaluatePostGuardrails({
      platform: 'REDDIT',
      body: 'Body',
      title: null,
      linkUrl: null,
      postsTodayOnAccount: 1,
      dailyPostLimit: 1,
      recentlySharedUrls: [],
      community: null,
      ownsCommunity: true,
    });
    expect(decision.blockers).toHaveLength(2);
  });

  it('routes posts into communities we do not own through the always-approve type', () => {
    expect(socialActionTypeFor({ kind: 'REPLY', community: null, ownedCommunities: [] })).toBe('SOCIAL_REPLY');
    expect(socialActionTypeFor({ kind: 'ORIGINAL', community: 'r/SideProject', ownedCommunities: [] })).toBe('SOCIAL_REPLY');
    expect(socialActionTypeFor({ kind: 'ORIGINAL', community: 'r/Mealwise', ownedCommunities: ['mealwise'] })).toBe('SOCIAL_POST');
    expect(socialActionTypeFor({ kind: 'ORIGINAL', community: null, ownedCommunities: [] })).toBe('SOCIAL_POST');
  });

  it('computes the promotion ratio', () => {
    expect(promotionStats([{ includesLink: true }, { includesLink: false }, { includesLink: false }, { includesLink: false }]).ratio).toBe(0.25);
    expect(promotionStats([]).ratio).toBe(0);
  });
});

describe('planDailyPosts', () => {
  const page = (over: Partial<ContentCandidate> & { pageId: string; url: string }): ContentCandidate => ({
    title: 'Page', pageType: 'ARTICLE', publishedAt: null, updatedAt: null, clicks28d: 0,
    impressions28d: 0, isIndexable: true, wordCount: 1200, ...over,
  });

  it('prefers new content, skips utility pages and respects the cooldown', () => {
    const plan = planDailyPosts({
      now: NOW,
      candidates: [
        page({ pageId: 'new', url: 'https://m.app/new', publishedAt: hoursAgo(24) }),
        page({ pageId: 'evergreen', url: 'https://m.app/evergreen', clicks28d: 400, impressions28d: 9000 }),
        page({ pageId: 'legal', url: 'https://m.app/privacy', pageType: 'LEGAL', clicks28d: 9999 }),
        page({ pageId: 'shared', url: 'https://m.app/shared', publishedAt: hoursAgo(2) }),
      ],
      accounts: [
        { accountId: 'bsky', platform: 'BLUESKY', dailyPostLimit: 2, postsToday: 0 },
        { accountId: 'x', platform: 'X', dailyPostLimit: 1, postsToday: 1 },
      ],
      recentShares: [{ url: 'https://m.app/shared?utm_source=bluesky', platform: 'BLUESKY', sharedAt: hoursAgo(48) }],
    });
    expect(plan.map((p) => p.candidate.pageId)).toEqual(['new', 'evergreen']);
    expect(plan.every((p) => p.accountId === 'bsky')).toBe(true);
    expect(plan[1]!.slot.getTime()).toBeGreaterThan(plan[0]!.slot.getTime());
  });

  it('never schedules a slot in the past', () => {
    const late = new Date('2026-11-07T22:00:00Z');
    expect(postingSlot(late, 0).getTime()).toBeGreaterThan(late.getTime());
    expect(postingSlot(new Date('2026-11-07T06:00:00Z'), 0).toISOString()).toBe('2026-11-07T14:00:00.000Z');
  });
});

describe('classifyPromotionPolicy', () => {
  const rule = (title: string, description = '') => ({ title, description });

  it('reads an outright ban as FORBIDDEN', () => {
    const result = classifyPromotionPolicy([rule('Be civil'), rule('No self-promotion', 'Do not advertise your product or blog.')]);
    expect(result.policy).toBe('FORBIDDEN');
    expect(result.evidence).toEqual(['No self-promotion']);
  });

  it('reads qualified promotion as RESTRICTED', () => {
    expect(classifyPromotionPolicy([rule('Self-promotion Saturdays', 'Self-promotion is only allowed on Saturdays.')]).policy).toBe('RESTRICTED');
    expect(classifyPromotionPolicy([rule('Follow the 10% rule for self-promotion')]).policy).toBe('RESTRICTED');
    expect(classifyPromotionPolicy([rule('No excessive self-promotion')]).policy).toBe('RESTRICTED');
  });

  it('needs an explicit allowance for ALLOWED', () => {
    expect(classifyPromotionPolicy([rule('Share your side project', 'Show off what you built!')]).policy).toBe('ALLOWED');
    expect(classifyPromotionPolicy([rule('Be kind'), rule('No spam')]).policy).toBe('UNKNOWN');
    expect(classifyPromotionPolicy([]).policy).toBe('UNKNOWN');
  });

  it('understands Spanish rules', () => {
    expect(classifyPromotionPolicy([rule('Prohibida la autopromoción')]).policy).toBe('FORBIDDEN');
    expect(classifyPromotionPolicy([rule('Autopromoción', 'La autopromoción solo en el hilo semanal')]).policy).toBe('RESTRICTED');
  });
});
