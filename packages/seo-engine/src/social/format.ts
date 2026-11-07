import { containsPhrase } from '@seo/shared';

/**
 * Platform text rules: length limits, how each platform counts, UTM tagging, disclosure checks.
 *
 * Kept deterministic and separate from the drafting prompt because a model cannot count
 * graphemes reliably, and a post that is one character over the limit fails at publish time —
 * after a human already approved it.
 */

export type SocialPlatformName =
  | 'REDDIT'
  | 'HACKER_NEWS'
  | 'X'
  | 'BLUESKY'
  | 'MASTODON'
  | 'LINKEDIN'
  | 'DEVTO'
  | 'TELEGRAM'
  | 'DISCORD'
  | 'YOUTUBE'
  | 'GITHUB'
  | 'FACEBOOK'
  | 'INSTAGRAM'
  | 'V2EX';

export interface PlatformTextRules {
  /** Max body length in the platform's own unit (graphemes; X weights URLs separately). */
  bodyLimit: number;
  /** Max title length, or null when the platform has no titles. */
  titleLimit: number | null;
  /** X shortens every URL to a fixed-length t.co link, so a URL costs the same whatever its length. */
  urlWeight: number | null;
  /** Value of `utm_source` for links shared here. */
  utmSource: string;
}

export const PLATFORM_TEXT_RULES: Record<SocialPlatformName, PlatformTextRules> = {
  REDDIT: { bodyLimit: 10_000, titleLimit: 300, urlWeight: null, utmSource: 'reddit' },
  HACKER_NEWS: { bodyLimit: 4_000, titleLimit: 80, urlWeight: null, utmSource: 'hackernews' },
  X: { bodyLimit: 280, titleLimit: null, urlWeight: 23, utmSource: 'x' },
  BLUESKY: { bodyLimit: 300, titleLimit: null, urlWeight: null, utmSource: 'bluesky' },
  MASTODON: { bodyLimit: 500, titleLimit: null, urlWeight: 23, utmSource: 'mastodon' },
  LINKEDIN: { bodyLimit: 3_000, titleLimit: null, urlWeight: null, utmSource: 'linkedin' },
  DEVTO: { bodyLimit: 100_000, titleLimit: 128, urlWeight: null, utmSource: 'devto' },
  TELEGRAM: { bodyLimit: 4_096, titleLimit: null, urlWeight: null, utmSource: 'telegram' },
  DISCORD: { bodyLimit: 2_000, titleLimit: null, urlWeight: null, utmSource: 'discord' },
  YOUTUBE: { bodyLimit: 10_000, titleLimit: null, urlWeight: null, utmSource: 'youtube' },
  GITHUB: { bodyLimit: 65_000, titleLimit: 256, urlWeight: null, utmSource: 'github' },
  FACEBOOK: { bodyLimit: 63_206, titleLimit: null, urlWeight: null, utmSource: 'facebook' },
  INSTAGRAM: { bodyLimit: 2_200, titleLimit: null, urlWeight: null, utmSource: 'instagram' },
  V2EX: { bodyLimit: 20_000, titleLimit: 120, urlWeight: null, utmSource: 'v2ex' },
};

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

let segmenter: Intl.Segmenter | null = null;

/** User-perceived characters. An emoji or an accented letter built from two code points counts once. */
export function graphemeLength(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/** Length as the platform counts it. */
export function platformLength(text: string, platform: SocialPlatformName): number {
  const rules = PLATFORM_TEXT_RULES[platform];
  if (rules.urlWeight === null) return graphemeLength(text);
  const urls = text.match(URL_PATTERN) ?? [];
  const withoutUrls = text.replace(URL_PATTERN, '');
  return graphemeLength(withoutUrls) + urls.length * rules.urlWeight;
}

export interface FittedText {
  text: string;
  length: number;
  limit: number;
  truncated: boolean;
}

/**
 * Make a post fit, keeping the link intact.
 *
 * The body is cut at the last sentence (or failing that, word) boundary that fits and given an
 * ellipsis; the link is appended after it on its own line. Truncating the URL instead would
 * publish a broken link, which is strictly worse than a shorter post.
 */
export function fitToPlatform(body: string, platform: SocialPlatformName, link?: string | null): FittedText {
  const limit = PLATFORM_TEXT_RULES[platform].bodyLimit;
  const suffix = link && !body.includes(link) ? `\n\n${link}` : '';
  const full = `${body.trim()}${suffix}`;
  const fullLength = platformLength(full, platform);
  if (fullLength <= limit) return { text: full, length: fullLength, limit, truncated: false };

  const budget = limit - platformLength(suffix, platform) - 1;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(body.trim())].map((part) => part.segment);
  let cut = graphemes.slice(0, Math.max(0, budget)).join('');
  // Shrink further when URLs inside the body weigh more than their characters (X/Mastodon).
  while (cut.length > 0 && platformLength(cut, platform) > budget) cut = cut.slice(0, -1);

  const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  const wordEnd = cut.lastIndexOf(' ');
  const boundary = sentenceEnd > cut.length * 0.5 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : cut.length;
  const text = `${cut.slice(0, boundary).trimEnd()}…${suffix}`;
  return { text, length: platformLength(text, platform), limit, truncated: true };
}

/** A title clipped to the platform's limit, or null when the platform has no titles. */
export function fitTitle(title: string | null | undefined, platform: SocialPlatformName): string | null {
  const limit = PLATFORM_TEXT_RULES[platform].titleLimit;
  if (limit === null || !title) return null;
  const trimmed = title.trim();
  if (graphemeLength(trimmed) <= limit) return trimmed;
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(trimmed)].map((part) => part.segment);
  return `${graphemes.slice(0, limit - 1).join('').trimEnd()}…`;
}

export interface UtmParams {
  source: string;
  medium?: string;
  campaign: string;
  content?: string | null;
}

/**
 * Tag a link so referral traffic is attributable in analytics.
 *
 * Existing UTM parameters win: if the operator hand-tagged a URL, their tagging is the truth.
 */
export function withUtm(url: string, params: UtmParams): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const set = (key: string, value: string | null | undefined) => {
    if (value && !parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
  };
  set('utm_source', params.source);
  set('utm_medium', params.medium ?? 'social');
  set('utm_campaign', params.campaign);
  set('utm_content', params.content ?? null);
  return parsed.toString();
}

export function utmSourceFor(platform: SocialPlatformName): string {
  return PLATFORM_TEXT_RULES[platform].utmSource;
}

/** Does this text link to the site? Matches the bare domain with or without www. */
export function linksToDomain(text: string, domain: string): boolean {
  const bare = domain.replace(/^www\./, '').toLowerCase();
  return (text.match(URL_PATTERN) ?? []).some((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      return host === bare || host.endsWith(`.${bare}`);
    } catch {
      return false;
    }
  });
}

export function mentionsAny(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => term.trim().length >= 2 && containsPhrase(text, term));
}

const GENERIC_DISCLOSURES = [
  /\b(full )?disclosure\b/,
  /\bi('m| am) (the |a )?(founder|co-?founder|maker|creator|developer|dev|author|owner)\b/,
  /\bi (built|made|created|run|maintain|work on)\b/,
  /\b(we|i) (built|made|created)\b/,
  /\bsoy (el |la |uno de los |una de las )?(fundador|fundadora|cofundador|creador|creadora|desarrollador|desarrolladora|autor|autora)\b/,
  /\b(lo|la) (he|hemos) (creado|hecho|desarrollado)\b/,
  /\btrabajo en\b/,
];

/**
 * Does the text disclose that the author is affiliated with what it recommends?
 *
 * The operator's configured disclosure sentence counts, and so does any ordinary first-person
 * statement of affiliation. Recommending your own product without one is astroturfing — in
 * most communities a bannable offence, and in many jurisdictions an advertising-law problem.
 */
export function hasDisclosure(text: string, configured?: string | null): boolean {
  if (configured && configured.trim().length > 3 && containsPhrase(text, configured)) return true;
  const normalised = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'");
  return GENERIC_DISCLOSURES.some((pattern) => pattern.test(normalised));
}
