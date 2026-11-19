import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore, RedisRateLimitStore, consumeRateLimit } from '../rate-limit';

describe('MemoryRateLimitStore', () => {
  it('counts hits inside a window and resets after it', async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore(100, () => now);
    expect((await store.hit('k', 1_000)).count).toBe(1);
    expect((await store.hit('k', 1_000)).count).toBe(2);
    now += 1_001;
    expect(await store.hit('k', 1_000)).toEqual({ count: 1, resetMs: 1_000 });
  });

  it('never tracks more keys than its cap', async () => {
    const store = new MemoryRateLimitStore(50, () => 0);
    for (let i = 0; i < 1_000; i++) await store.hit(`spoofed-${i}`, 60_000);
    expect(store.size).toBeLessThanOrEqual(50);
  });
});

describe('consumeRateLimit', () => {
  it('allows up to the limit, then blocks with a retry-after', async () => {
    let now = 0;
    const store = new MemoryRateLimitStore(100, () => now);
    const rules = [{ key: 'login:ip:1', limit: 3, windowMs: 60_000 }];
    for (let i = 0; i < 3; i++) expect((await consumeRateLimit(rules, store)).allowed).toBe(true);
    now = 15_000;
    expect(await consumeRateLimit(rules, store)).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it('blocks when any rule is exceeded and still charges every rule', async () => {
    const store = new MemoryRateLimitStore(100, () => 0);
    const account = { key: 'login:account:a@b.test', limit: 1, windowMs: 60_000 };
    await consumeRateLimit([{ key: 'login:ip:1', limit: 100, windowMs: 60_000 }, account], store);
    const second = await consumeRateLimit([{ key: 'login:ip:2', limit: 100, windowMs: 60_000 }, account], store);
    expect(second.allowed).toBe(false);
    expect((await store.hit('login:ip:2', 60_000)).count).toBe(2);
  });

  it('a reset clears the counter', async () => {
    const store = new MemoryRateLimitStore(100, () => 0);
    const rules = [{ key: 'k', limit: 1, windowMs: 60_000 }];
    await consumeRateLimit(rules, store);
    expect((await consumeRateLimit(rules, store)).allowed).toBe(false);
    await store.reset('k');
    expect((await consumeRateLimit(rules, store)).allowed).toBe(true);
  });
});

describe('RedisRateLimitStore', () => {
  /** Minimal stand-in for ioredis MULTI with INCR / PEXPIRE NX / PTTL semantics. */
  function fakeRedis() {
    const data = new Map<string, { value: number; ttl: number }>();
    const calls: string[] = [];
    const redis = {
      multi() {
        const ops: Array<() => [null, number]> = [];
        const chain = {
          incr(key: string) {
            ops.push(() => {
              const entry = data.get(key) ?? { value: 0, ttl: -1 };
              entry.value += 1;
              data.set(key, entry);
              return [null, entry.value];
            });
            return chain;
          },
          pexpire(key: string, ms: number, mode: string) {
            calls.push(`pexpire ${mode}`);
            ops.push(() => {
              const entry = data.get(key)!;
              if (mode !== 'NX' || entry.ttl < 0) entry.ttl = ms;
              return [null, 1];
            });
            return chain;
          },
          pttl(key: string) {
            ops.push(() => [null, data.get(key)?.ttl ?? -2]);
            return chain;
          },
          async exec() {
            return ops.map((op) => op());
          },
        };
        return chain;
      },
      async del(key: string) {
        data.delete(key);
        return 1;
      },
    };
    return { redis, data, calls };
  }

  it('increments, sets the expiry only once, and reports the remaining window', async () => {
    const { redis, data, calls } = fakeRedis();
    const store = new RedisRateLimitStore(redis as never, 'test:');
    expect(await store.hit('k', 60_000)).toEqual({ count: 1, resetMs: 60_000 });
    data.get('test:k')!.ttl = 30_000;
    expect(await store.hit('k', 60_000)).toEqual({ count: 2, resetMs: 30_000 });
    expect(calls.every((c) => c === 'pexpire NX')).toBe(true);
    await store.reset('k');
    expect(data.has('test:k')).toBe(false);
  });
});
