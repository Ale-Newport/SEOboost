import { clamp, containsPhrase, round, saturate, tokenize, type ExplainableScore, type ScoreFactor } from '@seo/shared';

/**
 * Conversation relevance.
 *
 * Listening produces far more threads than anyone should answer, so every thread gets a
 * deterministic 0-100 score before a model is asked anything: topic fit, what the person is
 * actually asking for, how fresh the thread is, whether anyone is still reading it, and whether
 * the community tolerates a maker showing up. The score decides what reaches the inbox and what
 * is worth a (paid) triage call — never whether something gets posted.
 */

export type SocialIntent =
  | 'seeking-recommendation'
  | 'comparison'
  | 'problem'
  | 'competitor-mention'
  | 'brand-mention'
  | 'discussion';

export type CommunityPolicy = 'ALLOWED' | 'RESTRICTED' | 'FORBIDDEN' | 'UNKNOWN';

export type TopicKind = 'problem' | 'brand' | 'competitor';

export interface ConversationSignals {
  title: string | null;
  body: string | null;
  community: string | null;
  publishedAt: Date | null;
  score: number | null;
  commentCount: number | null;
  isLocked?: boolean;
}

export interface RelevanceContext {
  topicQuery: string;
  topicKeywords: readonly string[];
  topicKind: TopicKind;
  /** Brand name, domain and product names — a match means people are talking about us. */
  brandTerms: readonly string[];
  /** Competitor names and domains. */
  competitorTerms: readonly string[];
  communityPolicy: CommunityPolicy | null;
  now?: Date;
}

/**
 * Published weights. Topic fit and intent dominate together: a thread that merely contains the
 * words is chatter, and a question about something else is not ours to answer.
 */
export const SOCIAL_RELEVANCE_WEIGHTS = {
  topic: 0.35,
  intent: 0.3,
  freshness: 0.12,
  engagement: 0.13,
  community: 0.1,
} as const;

const INTENT_VALUE: Record<SocialIntent, number> = {
  'seeking-recommendation': 1,
  comparison: 0.9,
  problem: 0.8,
  'competitor-mention': 0.7,
  'brand-mention': 0.65,
  discussion: 0.15,
};

/** "X vs Y" with no competitor of ours named is usually an unrelated comparison. */
const UNNAMED_COMPARISON_VALUE = 0.55;

const INTENT_LABEL: Record<SocialIntent, string> = {
  'seeking-recommendation': 'is asking for a recommendation',
  comparison: 'is comparing options or looking for an alternative',
  problem: 'describes a problem they are stuck on',
  'competitor-mention': 'mentions a competitor',
  'brand-mention': 'mentions our brand',
  discussion: 'is general discussion with no explicit ask',
};

const POLICY_VALUE: Record<CommunityPolicy, number> = {
  ALLOWED: 1,
  UNKNOWN: 0.6,
  RESTRICTED: 0.4,
  FORBIDDEN: 0,
};

/**
 * Patterns are matched against accent-stripped lowercase text, so the Spanish forms are written
 * without accents. English and Spanish cover the portfolio this was built for; anything else
 * still scores on topic fit and falls back to "discussion" here.
 */
const SEEKING_PATTERNS = [
  /\b(can|could) (anyone|someone|you) (recommend|suggest)/,
  /\b(any|some) (recommendations?|suggestions?)\b/,
  /\blooking for (an?|some|any) /,
  /\bis there (an?|any) (app|tool|service|site|website|software|plugin|way)\b/,
  /\b(best|good) (app|tool|service|site|software|plugin|way) (for|to)\b/,
  /\bwhat (app|tool|software|service)s? (do|would|should|can)\b/,
  /\brecommend(ations?)? (for|on)\b/,
  /\balguien (me )?(recomienda|conoce|sabe de)\b/,
  /\brecomendacion(es)?\b/,
  /\bbusco (un|una|algun|alguna)\b/,
  /\bque (app|aplicacion|herramienta|programa|web|servicio)s? (usais|usan|recomendais|recomiendan)\b/,
  /\bexiste (algun|alguna)\b/,
  /\bmejor (app|aplicacion|herramienta|forma|manera) (de|para)\b/,
];

const COMPARISON_PATTERNS = [
  /\bvs\.?\b/,
  /\bversus\b/,
  /\balternatives? (to|for)\b/,
  /\bcompared (to|with)\b/,
  /\bbetter than\b/,
  /\bswitch(ing|ed)? (from|to|away)\b/,
  /\balternativas? (a|para)\b/,
  /\bmejor que\b/,
  /\bcomparativa\b/,
];

const PROBLEM_PATTERNS = [
  /\bhow (do|can|should) (i|we|you)\b/,
  /\bhow to\b/,
  /\b(struggling|stuck|frustrat\w*|annoying|tired of|fed up)\b/,
  /\b(can'?t|cannot|unable to) (figure|find|get|make)\b/,
  /\b(need|any) help\b/,
  /\bwaste of time\b/,
  /\bcomo (puedo|hago|se hace|consigo)\b/,
  /\b(necesito|pido) ayuda\b/,
  /\bno (se|puedo|consigo) /,
  /\bme cuesta\b/,
  /\bharto de\b/,
  /\bproblema con\b/,
];

/** Lowercase, strip accents, collapse whitespace — the shape every pattern above expects. */
export function normaliseForMatching(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function conversationText(signals: Pick<ConversationSignals, 'title' | 'body'>): string {
  return [signals.title ?? '', signals.body ?? ''].join('\n').trim();
}

function anyPhrase(text: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    if (term.trim().length >= 2 && containsPhrase(text, term)) return term;
  }
  return null;
}

/**
 * What the person is asking for.
 *
 * A brand mention wins over everything (it is a different job: answer or thank, not pitch);
 * a competitor mention becomes a comparison when the thread is asking for alternatives.
 */
export function detectIntent(
  text: string,
  terms: { brandTerms: readonly string[]; competitorTerms: readonly string[] },
): SocialIntent {
  if (anyPhrase(text, terms.brandTerms)) return 'brand-mention';
  const normalised = normaliseForMatching(text);
  const comparing = COMPARISON_PATTERNS.some((pattern) => pattern.test(normalised));
  if (anyPhrase(text, terms.competitorTerms)) return comparing ? 'comparison' : 'competitor-mention';
  if (SEEKING_PATTERNS.some((pattern) => pattern.test(normalised))) return 'seeking-recommendation';
  if (comparing) return 'comparison';
  if (PROBLEM_PATTERNS.some((pattern) => pattern.test(normalised))) return 'problem';
  return 'discussion';
}

/** True when the thread contains any excluded term — dropped before it is scored or stored. */
export function matchesNegative(text: string, negativeKeywords: readonly string[]): string | null {
  return anyPhrase(text, negativeKeywords);
}

/** Age in days, or null when the platform did not say. */
export function ageInDays(publishedAt: Date | null, now: Date): number | null {
  if (!publishedAt) return null;
  return Math.max(0, (now.getTime() - publishedAt.getTime()) / 86_400_000);
}

function factor(
  key: keyof typeof SOCIAL_RELEVANCE_WEIGHTS,
  label: string,
  value: number,
  explanation: string,
): ScoreFactor {
  const weight = SOCIAL_RELEVANCE_WEIGHTS[key];
  const v = round(clamp(value), 3);
  return { key, label, value: v, weight, contribution: round(v * weight * 100, 1), explanation };
}

/**
 * Score one thread against one listening topic.
 *
 * Topic fit is token recall of the topic query in the thread (a full phrase match counts as
 * complete fit) plus a bonus for the topic's extra keywords. Freshness halves every three days:
 * a reply to a week-old Reddit or HN thread is read by almost nobody, and replying to an old
 * thread mostly reads as an advert. A locked thread scores zero — nobody can reply to it.
 */
export function scoreConversation(signals: ConversationSignals, ctx: RelevanceContext): ExplainableScore & {
  intent: SocialIntent;
} {
  const now = ctx.now ?? new Date();
  const text = conversationText(signals);
  const intent = detectIntent(text, ctx);

  if (signals.isLocked) {
    return {
      score: 0,
      intent,
      factors: [],
      summary: 'The thread is locked or archived, so nobody can reply to it.',
    };
  }

  // ── topic fit ────────────────────────────────────────────
  // The phrase in the title is the strongest evidence; the phrase somewhere in a long body is
  // weaker (a comment can mention anything in passing); scattered words are weaker still.
  const queryTokens = [...new Set(tokenize(ctx.topicQuery))];
  const textTokens = new Set(tokenize(text));
  const recall = queryTokens.length
    ? queryTokens.filter((token) => textTokens.has(token)).length / queryTokens.length
    : 0;
  const inTitle = Boolean(signals.title && containsPhrase(signals.title, ctx.topicQuery));
  const phrase = inTitle || containsPhrase(text, ctx.topicQuery);
  const fit = inTitle ? 1 : phrase ? 0.85 : recall * 0.6;
  const keywordHits = ctx.topicKeywords.filter((keyword) => containsPhrase(text, keyword));
  const topicValue = clamp(fit * 0.75 + Math.min(1, keywordHits.length / 2) * 0.25);
  const topicExplanation = inTitle
    ? `The title contains "${ctx.topicQuery}"`
    : phrase
      ? `The text contains "${ctx.topicQuery}"`
      : `${Math.round(recall * 100)}% of the topic's words appear, but not as a phrase`;

  // ── freshness ────────────────────────────────────────────
  const age = ageInDays(signals.publishedAt, now);
  const freshness = age === null ? 0.5 : 0.5 ** (age / 3);
  const freshnessExplanation =
    age === null
      ? 'The platform did not report when this was posted; scored as middling.'
      : age < 1
        ? 'Posted in the last 24 hours — replies are still being read.'
        : `Posted ${Math.round(age)} day${Math.round(age) === 1 ? '' : 's'} ago; attention halves roughly every three days.`;

  // ── engagement ───────────────────────────────────────────
  const hasEngagement = signals.commentCount !== null || signals.score !== null;
  const engagement = hasEngagement
    ? saturate(signals.commentCount ?? 0, 10) * 0.6 + saturate(Math.max(0, signals.score ?? 0), 25) * 0.4
    : 0.3;
  const engagementExplanation = hasEngagement
    ? `${signals.commentCount ?? 0} comments, score ${signals.score ?? 0}.`
    : 'No engagement figures from the platform; scored as low-unknown.';

  // ── community ────────────────────────────────────────────
  const policy = ctx.communityPolicy ?? 'UNKNOWN';
  const communityExplanation = {
    ALLOWED: 'Community rules allow makers to share relevant tools.',
    UNKNOWN: signals.community
      ? `Rules for ${signals.community} have not been checked yet.`
      : 'No community rules apply (open platform).',
    RESTRICTED: 'Community rules restrict self-promotion — a link-free, helpful answer only.',
    FORBIDDEN: 'Community rules forbid self-promotion — do not mention the product here.',
  }[policy];

  const unnamedComparison = intent === 'comparison' && !anyPhrase(text, ctx.competitorTerms);
  const intentValue = unnamedComparison ? UNNAMED_COMPARISON_VALUE : INTENT_VALUE[intent];
  const intentExplanation = unnamedComparison
    ? 'The author compares options, but none of our competitors is named.'
    : `The author ${INTENT_LABEL[intent]}.`;

  const factors = [
    factor('topic', 'Topic fit', topicValue, `${topicExplanation}${keywordHits.length ? `; also matches ${keywordHits.slice(0, 3).join(', ')}` : ''}.`),
    factor('intent', 'Intent', intentValue, intentExplanation),
    factor('freshness', 'Freshness', freshness, freshnessExplanation),
    factor('engagement', 'Engagement', engagement, engagementExplanation),
    factor('community', 'Community fit', POLICY_VALUE[policy], communityExplanation),
  ];

  const score = round(clamp(factors.reduce((sum, f) => sum + f.contribution, 0) / 100) * 100, 1);
  const strongest = [...factors].sort((a, b) => b.contribution - a.contribution)[0];
  return {
    score,
    intent,
    factors,
    summary: `Relevance ${score}/100 — strongest signal: ${strongest?.label.toLowerCase() ?? 'none'}. The author ${INTENT_LABEL[intent]}.`,
  };
}
