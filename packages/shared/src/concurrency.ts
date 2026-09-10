/** Dependency-free concurrency primitives (no ESM-only packages in the bundle graph). */

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** Bounded-concurrency runner, equivalent to `p-limit`. */
export function createLimiter(concurrency: number): Limiter {
  const limit = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    const run = queue.shift();
    if (run) run();
  };

  return function limiter<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        void Promise.resolve()
          .then(fn)
          .then(
            (value) => {
              resolve(value);
              next();
            },
            (err) => {
              reject(err);
              next();
            },
          );
      };
      if (active < limit) run();
      else queue.push(run);
    });
  };
}

/** Map over items with bounded concurrency, preserving input order in the result. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = createLimiter(concurrency);
  return Promise.all(items.map((item, i) => limit(() => fn(item, i))));
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  /** Return false to abort retrying immediately (e.g. 4xx that will never succeed). */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    factor = 2,
    jitter = true,
    shouldRetry = () => true,
    onRetry,
    signal,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal?.aborted) throw new Error('Aborted');
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !shouldRetry(err, attempt)) break;
      const exponential = Math.min(maxDelayMs, baseDelayMs * factor ** (attempt - 1));
      const delay = jitter ? exponential * (0.5 + Math.random() * 0.5) : exponential;
      onRetry?.(err, attempt, delay);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reject if a promise exceeds `ms`. Does not cancel the underlying work. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Simple per-host token-bucket rate limiter used by the crawler and API clients. */
export class RateLimiter {
  private lastCall = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastCall);
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      return fn();
    });
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Split an array into fixed-size chunks (for batched DB writes and API calls). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size <= 0) return [items as T[]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}
