import type { CommunityPolicy } from './relevance';
import { normaliseForMatching } from './relevance';

/**
 * Read a community's own rules for what they say about self-promotion.
 *
 * Deterministic on purpose: the result gates what the reply drafter may do, and "the model
 * thought the rules were fine" is not an acceptable reason to post a link where moderators said
 * not to. Anything ambiguous lands on RESTRICTED (allowed with care, never a link) and anything
 * silent stays UNKNOWN (the reviewer is told to read the rules). Only an explicit allowance
 * yields ALLOWED.
 */

export interface CommunityRule {
  title: string;
  description: string;
}

export interface PolicyClassification {
  policy: CommunityPolicy;
  /** The rule titles (or description excerpt) the decision rests on. */
  evidence: string[];
  summary: string;
}

// "Spam" is deliberately absent: every community bans spam, so the word says nothing about whether
// a disclosed maker answering a direct question is welcome.
const PROMO_TERMS = String.raw`(self[- ]?promo\w*|promot\w*|advertis\w*|ads\b|marketing|shill\w*|plug\w*|own (product|app|website|site|business|startup|project|blog)|links? to your|autopromocion|publicidad|promocion|anuncios?)`;

const FORBIDDEN_PATTERNS = [
  new RegExp(String.raw`\bno ${PROMO_TERMS}`),
  new RegExp(String.raw`\b${PROMO_TERMS} (is|are) (not allowed|prohibited|forbidden|banned|not permitted)`),
  new RegExp(String.raw`\b(do not|don'?t|never) (promote|advertise|self[- ]?promote|shill|plug)\b`),
  new RegExp(String.raw`\bno (se permite|esta permitid[oa]|se admite)n? (la |el )?${PROMO_TERMS}`),
  new RegExp(String.raw`\b(prohibid[oa]|sin) (la |el )?${PROMO_TERMS}`),
];

/** Qualifiers that turn "no promotion" into "promotion, but only like this". */
const RESTRICTION_PATTERNS = [
  /\b(only|solely) (in|on|during) /,
  /\b(saturdays?|sundays?|weekly|monthly|megathreads?|pinned threads?|designated threads?|daily threads?)\b/,
  /\b10 ?% (rule|of)\b/,
  /\b9:1\b/,
  /\b(ratio|ask (the )?mods?|message the mods?|mod approval|with approval|must be approved|flair)\b/,
  /\b(excessive|blatant|low[- ]effort|unsolicited|unrelated)\b/,
  /\b(solo|unicamente) (en|los) /,
  /\bhilo (semanal|mensual|fijado)\b/,
];

const ALLOWED_PATTERNS = [
  new RegExp(String.raw`\b${PROMO_TERMS} (is|are) (allowed|welcome|permitted|encouraged|ok|fine)`),
  /\b(share|show off|post) your (project|app|product|startup|side project|website|work)\b/,
  /\b(feel free|you may|you can) (to )?(share|post|promote)\b/,
  /\b(comparte|muestra) tu (proyecto|app|producto|web)\b/,
];

export function classifyPromotionPolicy(rules: readonly CommunityRule[], description?: string | null): PolicyClassification {
  const entries = [
    ...rules.map((rule) => ({ label: rule.title, text: normaliseForMatching(`${rule.title}. ${rule.description}`) })),
    ...(description ? [{ label: 'Community description', text: normaliseForMatching(description) }] : []),
  ];

  const forbidden: string[] = [];
  const restricted: string[] = [];
  const allowed: string[] = [];
  for (const entry of entries) {
    const promoMention = new RegExp(PROMO_TERMS).test(entry.text);
    if (ALLOWED_PATTERNS.some((pattern) => pattern.test(entry.text))) allowed.push(entry.label);
    if (!promoMention) continue;
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(entry.text))) {
      if (RESTRICTION_PATTERNS.some((pattern) => pattern.test(entry.text))) restricted.push(entry.label);
      else forbidden.push(entry.label);
    } else if (RESTRICTION_PATTERNS.some((pattern) => pattern.test(entry.text))) {
      restricted.push(entry.label);
    }
  }

  if (forbidden.length) {
    return {
      policy: 'FORBIDDEN',
      evidence: forbidden,
      summary: `The rules forbid self-promotion (${forbidden.slice(0, 2).join('; ')}). Help without naming or linking the product.`,
    };
  }
  if (restricted.length) {
    return {
      policy: 'RESTRICTED',
      evidence: restricted,
      summary: `Self-promotion is restricted (${restricted.slice(0, 2).join('; ')}). No links; name the product only when it directly answers, with disclosure.`,
    };
  }
  if (allowed.length) {
    return {
      policy: 'ALLOWED',
      evidence: allowed,
      summary: `The community explicitly welcomes makers sharing their work (${allowed.slice(0, 2).join('; ')}).`,
    };
  }
  return {
    policy: 'UNKNOWN',
    evidence: [],
    summary: entries.length
      ? 'The rules do not mention self-promotion either way — read them before approving anything here.'
      : 'No rules could be read for this community.',
  };
}
