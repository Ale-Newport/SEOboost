/**
 * Fixed-window rate limiting for sensitive endpoints (sign-in, sign-up).
 *
 * Counters live in Redis when it is ready, so limits hold across processes and restarts. When
 * Redis is not configured or not reachable the limiter falls back to an in-process store: weaker
 * across several web processes, but it never fails open to "unlimited" and never blocks a
 * request on a Redis outage.
 */

import type { Redis } from 'ioredis';
import { createLogger, errorMessage, withTimeout } from '@seo/shared';
import { getRedisConnection, isRedisReady } from './connection';

const log = createLogger('queue:rate-limit');

export interface RateLimitHit {
  /** Hits in the current window, including this one. */
  count: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number): Promise<RateLimitHit>;
  reset(key: string): Promise<void>;
}

export interface RateLimitRule {
  /** Stable key, e.g. `login:ip:203.0.113.7`. */
  key: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the most restrictive exceeded window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

/** In-process store with a hard cap on tracked keys, so spoofed keys cannot grow memory unbounded. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly entries = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const now = this.now();
    let entry = this.entries.get(key);
    if (!entry || entry.expiresAt <= now) {
      if (!entry && this.entries.size >= this.maxKeys) this.evict(now);
      entry = { count: 0, expiresAt: now + windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, resetMs: Math.max(0, entry.expiresAt - now) };
  }

  async reset(key: string): Promise<void> {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
    // Still full of live windows: drop the oldest insertions (Map iterates in insertion order).
    const overflow = this.entries.size - this.maxKeys + 1;
    if (overflow > 0) {
      let removed = 0;
      for (const key of this.entries.keys()) {
        if (removed++ >= overflow) break;
        this.entries.delete(key);
      }
    }
  }
}

/** Redis store: INCR, set the expiry only when the key is new (NX), read the remaining TTL. */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly redis: Pick<Redis, 'multi' | 'del'>,
    private readonly prefix = 'seo-os:rl:',
  ) {}

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const fullKey = this.prefix + key;
    const results = await this.redis.multi().incr(fullKey).pexpire(fullKey, windowMs, 'NX').pttl(fullKey).exec();
    if (!results) throw new Error('rate limit transaction aborted');
    const [incr, , ttl] = results;
    if (incr?.[0]) throw incr[0];
    const count = Number(incr?.[1] ?? 0);
    const pttl = Number(ttl?.[1] ?? windowMs);
    return { count, resetMs: pttl > 0 ? pttl : windowMs };
  }

  async reset(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }
}

const memoryStore = new MemoryRateLimitStore();
const REDIS_TIMEOUT_MS = 500;

/** Redis when it is ready right now, otherwise the in-process store. */
export function defaultRateLimitStore(): RateLimitStore {
  const redis = getRedisConnection();
  if (redis && isRedisReady()) {
    const store = new RedisRateLimitStore(redis);
    return {
      hit: (key, windowMs) =>
        withTimeout(store.hit(key, windowMs), REDIS_TIMEOUT_MS, 'rate limit').catch((err: unknown) => {
          log.warn('redis rate limit failed; using in-process limiter', { error: errorMessage(err) });
          return memoryStore.hit(key, windowMs);
        }),
      reset: (key) => store.reset(key).catch(() => memoryStore.reset(key)),
    };
  }
  return memoryStore;
}

/**
 * Count one attempt against every rule. All rules are charged even when one is already exceeded,
 * so a client cannot dodge a counter by tripping another first.
 */
export async function consumeRateLimit(
  rules: readonly RateLimitRule[],
  store: RateLimitStore = defaultRateLimitStore(),
): Promise<RateLimitResult> {
  let retryAfterMs = 0;
  for (const rule of rules) {
    const { count, resetMs } = await store.hit(rule.key, rule.windowMs);
    if (count > rule.limit) retryAfterMs = Math.max(retryAfterMs, resetMs);
  }
  return { allowed: retryAfterMs === 0, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
}

/** Forget a key, e.g. the per-account counter after a successful sign-in. */
export async function resetRateLimit(key: string, store: RateLimitStore = defaultRateLimitStore()): Promise<void> {
  await store.reset(key);
}
