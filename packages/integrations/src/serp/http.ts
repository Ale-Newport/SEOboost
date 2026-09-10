/**
 * Shared HTTP + JSON-narrowing helpers for third-party provider clients.
 *
 * Every outbound provider call must (a) stop within a hard timeout so a hung vendor cannot
 * pin a worker forever, (b) retry only on 429/5xx, and (c) surface a typed `ProviderError`
 * instead of a raw fetch rejection. Doing that once here keeps each client thin and makes
 * provider failures uniformly classifiable by the queue's retry policy.
 *
 * The Bing and backlink clients import from here too — one implementation, no drift.
 */

import { ProviderError, RateLimitError, RateLimiter, retry, createLogger } from '@seo/shared';

const log = createLogger('integrations:http');

/** Default hard timeout. Live SERP endpoints block on the search engine, so this is generous. */
export const DEFAULT_TIMEOUT_MS = 45_000;

/** Raised internally when a provider answers with a non-2xx status; never escapes this module. */
class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly bodyText: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
  }
}

/**
 * A `ProviderError` that keeps the HTTP status, so callers can branch on it
 * (Bing, for example, treats 404/501 as "endpoint not available for this tenant").
 */
export class ProviderHttpError extends ProviderError {
  constructor(
    provider: string,
    override readonly status: number,
    message: string,
    retryable: boolean,
  ) {
    super(provider, message, retryable);
  }
}

export interface JsonRequestOptions {
  /** Provider slug used in error messages and logs. */
  provider: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  /** Serialised as JSON when present. */
  body?: unknown;
  timeoutMs?: number;
  /** Total attempts including the first one. */
  attempts?: number;
  /** Serialises calls to the same vendor so we stay under their per-second quota. */
  rateLimiter?: RateLimiter;
  signal?: AbortSignal;
}

function isNetworkError(err: unknown): boolean {
  // undici surfaces connection resets / DNS failures as TypeError with a cause.
  return err instanceof TypeError;
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - Date.now()) / 1000));
}

async function performRequest(opts: JsonRequestOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  opts.signal?.addEventListener('abort', abortOuter, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined && headers['content-type'] === undefined) {
      headers['content-type'] = 'application/json';
    }

    const response = await fetch(opts.url, {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        text.slice(0, 800),
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError(opts.provider, 'response was not valid JSON', false);
    }
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abortOuter);
  }
}

/**
 * Perform a JSON request with retry, rate limiting and a hard timeout.
 * Returns `unknown`: callers narrow with the `read*` helpers below rather than casting,
 * so a vendor changing their payload shape degrades instead of throwing at a random depth.
 */
export async function requestJson(opts: JsonRequestOptions): Promise<unknown> {
  const run = () => performRequest(opts);

  try {
    return await retry(
      () => (opts.rateLimiter ? opts.rateLimiter.schedule(run) : run()),
      {
        attempts: opts.attempts ?? 3,
        baseDelayMs: 800,
        maxDelayMs: 20_000,
        shouldRetry: (err) =>
          (err instanceof HttpStatusError && retryableStatus(err.status)) || isNetworkError(err),
        onRetry: (err, attempt, delayMs) =>
          log.warn('provider request failed, retrying', {
            provider: opts.provider,
            attempt,
            delayMs,
            status: err instanceof HttpStatusError ? err.status : undefined,
          }),
      },
    );
  } catch (err) {
    if (err instanceof HttpStatusError) {
      if (err.status === 429) {
        throw new RateLimitError(
          `${opts.provider}: rate limited`,
          err.retryAfterSeconds ?? 60,
        );
      }
      throw new ProviderHttpError(
        opts.provider,
        err.status,
        `HTTP ${err.status}${err.bodyText ? ` — ${err.bodyText}` : ''}`,
        retryableStatus(err.status),
      );
    }
    if (err instanceof ProviderError) throw err;
    if (controllerAborted(err)) {
      throw new ProviderError(opts.provider, `request aborted or timed out`, true);
    }
    throw new ProviderError(opts.provider, errorText(err), true);
  }
}

function controllerAborted(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build a query string, dropping undefined/null values. */
export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

// ── unknown → typed narrowing ─────────────────────────────────────────────────
// Provider payloads are untrusted input. These helpers keep every parser total:
// a missing or wrongly-typed field yields a fallback instead of a runtime throw.

export function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

export function readOptionalString(value: unknown): string | undefined {
  const s = readString(value).trim();
  return s === '' ? undefined : s;
}

export function readNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function readOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = readNumber(value, Number.NaN);
  return Number.isFinite(n) ? n : undefined;
}

export function readBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(v)) return true;
    if (['false', '0', 'no', 'n'].includes(v)) return false;
  }
  return fallback;
}

/** Parse a date from a provider payload; returns null rather than an Invalid Date. */
export function readDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs milliseconds: anything below year 2286 in ms is under 1e13.
    return new Date(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : new Date(t);
}
