import { providerMessage, type HttpResult } from '../../adapters/http';
import { SocialSourceError, type SocialAccountSecrets, type SocialPlatformValue } from '../types';

/**
 * Plumbing shared by every publisher.
 *
 * Publishers are the only code in the product that writes to a third-party platform, so they
 * fail loudly and typed: an HTTP status becomes a `SocialSourceError` with the platform's own
 * sentence in it, and nothing is ever silently shortened or retried here — retry policy belongs
 * to the queue, and fitting text belongs to the engine, upstream of the human approval.
 */

/**
 * Body limits as each platform counts them. Mirrors `PLATFORM_TEXT_RULES` in `@seo/seo-engine`
 * (integrations may not depend on the engine); the engine fits the text, this is the last check.
 */
const BODY_LIMITS: Partial<Record<SocialPlatformValue, { limit: number; urlWeight: number | null }>> = {
  REDDIT: { limit: 10_000, urlWeight: null },
  X: { limit: 280, urlWeight: 23 },
  BLUESKY: { limit: 300, urlWeight: null },
  MASTODON: { limit: 500, urlWeight: 23 },
  LINKEDIN: { limit: 3_000, urlWeight: null },
  DEVTO: { limit: 100_000, urlWeight: null },
  TELEGRAM: { limit: 4_096, urlWeight: null },
  DISCORD: { limit: 2_000, urlWeight: null },
};

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;

let segmenter: Intl.Segmenter | null = null;

function graphemes(text: string): number {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  for (const _ of segmenter.segment(text)) count++;
  return count;
}

/** Length the way the platform counts it (graphemes; X and Mastodon weigh every URL the same). */
export function publishLength(platform: SocialPlatformValue, text: string): number {
  const rule = BODY_LIMITS[platform];
  if (!rule || rule.urlWeight === null) return graphemes(text);
  const urls = text.match(URL_PATTERN) ?? [];
  return graphemes(text.replace(URL_PATTERN, '')) + urls.length * rule.urlWeight;
}

/** Refuse — never truncate — a body over the platform limit. */
export function assertWithinLimit(platform: SocialPlatformValue, text: string): void {
  const rule = BODY_LIMITS[platform];
  if (!rule) return;
  const length = publishLength(platform, text);
  if (length > rule.limit) {
    throw new SocialSourceError(
      'BAD_INPUT',
      `The ${platform} post is ${length} characters; the platform allows ${rule.limit}. Edit it before publishing.`,
    );
  }
}

/** Map a failed HTTP response onto the shared error vocabulary. */
export function httpFailure(res: HttpResult, label: string, operation: string): SocialSourceError {
  const message = `${label} ${operation} failed (HTTP ${res.status}): ${providerMessage(res)}`;
  if (res.status === 401) return new SocialSourceError('NEED_LOGIN', message, `Reconnect the ${label} account — the credentials were rejected.`);
  if (res.status === 403) return new SocialSourceError('BLOCKED', message, `${label} refused the request: check the token's permissions or the account's standing.`);
  if (res.status === 404) return new SocialSourceError('NOT_FOUND', message);
  if (res.status === 429) return new SocialSourceError('RATE_LIMITED', message, null, retryAfterSeconds(res));
  if (res.status === 400 || res.status === 422) return new SocialSourceError('BAD_INPUT', message);
  return new SocialSourceError('UPSTREAM', message);
}

/** Seconds to wait, from `retry-after` (seconds or HTTP date) or a unix-epoch reset header. */
export function retryAfterSeconds(res: HttpResult): number {
  const retry = res.headers.get('retry-after');
  if (retry) {
    const seconds = Number(retry);
    if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
    const at = Date.parse(retry);
    if (!Number.isNaN(at)) return Math.max(1, Math.ceil((at - Date.now()) / 1000));
  }
  for (const header of ['x-rate-limit-reset', 'x-ratelimit-reset', 'ratelimit-reset']) {
    const value = Number(res.headers.get(header));
    if (Number.isFinite(value) && value > 0) {
      // Epoch seconds when large; a relative number of seconds otherwise.
      return value > 1_000_000_000 ? Math.max(1, Math.ceil(value - Date.now() / 1000)) : Math.ceil(value);
    }
  }
  return 60;
}

/** A required secret, or a NOT_CONFIGURED error naming the missing field. */
export function requireCredential(secrets: SocialAccountSecrets, key: string, label: string): string {
  const value = secrets.credentials[key]?.trim();
  if (!value) throw new SocialSourceError('NOT_CONFIGURED', `${label} is missing "${key}".`);
  return value;
}

/** A non-secret config value as a trimmed string, or null. */
export function configString(secrets: SocialAccountSecrets, key: string): string | null {
  const value = secrets.config[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Raised when a publisher is asked for something its platform cannot do. */
export function unsupported(label: string, what: string): SocialSourceError {
  return new SocialSourceError('UNSUPPORTED', `${label} cannot ${what} through its API.`);
}
