import { createLogger, errorMessage } from '@seo/shared';
import type { AdapterErrorCode, AdapterResult, JsonObject, JsonValue } from './types';
import { adapterFail } from './types';

/**
 * Tiny HTTP layer shared by every adapter.
 *
 * Deliberately dependency-free (global `fetch`, Node >= 20) and deliberately
 * *untyped at the boundary*: `body` comes back as `unknown` and adapters pull
 * fields out with the readers below. Casting a JSON response straight to an
 * interface would let a changed upstream shape become an `undefined` written to
 * a customer's live site.
 */

const log = createLogger('adapters:http');

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialised as JSON unless `rawBody` is set. */
  body?: unknown;
  rawBody?: string;
  timeoutMs?: number;
  /** Query parameters; `undefined` values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
}

export interface HttpResult {
  ok: boolean;
  status: number;
  /** Parsed JSON when the response was JSON, otherwise null. */
  body: unknown;
  text: string;
  headers: Headers;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

export function withQuery(url: string, query?: HttpRequestOptions['query']): string {
  if (!query) return url;
  const entries = Object.entries(query).filter((e): e is [string, string | number | boolean] => e[1] !== undefined);
  if (!entries.length) return url;
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
  return url.includes('?') ? `${url}&${qs}` : `${url}?${qs}`;
}

/** Thrown only for transport-level failures; HTTP error statuses come back as an `HttpResult`. */
export class HttpTransportError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }
}

export async function httpRequest(url: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
  const method = opts.method ?? 'GET';
  const target = withQuery(url, opts.query);
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };

  let payload: string | undefined;
  if (opts.rawBody !== undefined) {
    payload = opts.rawBody;
  } else if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers['content-type'] = headers['content-type'] ?? 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'follow',
    });
  } catch (err) {
    log.debug('request failed', { url: target, method, error: errorMessage(err) });
    throw new HttpTransportError(errorMessage(err), err);
  }

  const text = await response.text();
  let body: unknown = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (text && (contentType.includes('json') || text.startsWith('{') || text.startsWith('['))) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  return { ok: response.ok, status: response.status, body, text, headers: response.headers };
}

/** Map an HTTP status onto the adapter error taxonomy. */
export function codeForStatus(status: number): AdapterErrorCode {
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422 || status === 400) return 'VALIDATION';
  if (status === 429) return 'RATE_LIMITED';
  return 'PROVIDER_ERROR';
}

/** Best-effort extraction of the provider's own error sentence, for actionable messages. */
export function providerMessage(res: HttpResult, fallback = ''): string {
  const body = res.body;
  if (isRecord(body)) {
    const direct =
      readString(body.message) ??
      readString(body.error) ??
      readString(body.error_description) ??
      readString(body.detail) ??
      readString(body.description);
    if (direct) return direct;
    // Shopify returns { errors: "..." } or { errors: { field: ["..."] } }
    const errors = body.errors;
    if (typeof errors === 'string') return errors;
    if (isRecord(errors)) {
      const parts: string[] = [];
      for (const [field, value] of Object.entries(errors)) {
        const list = Array.isArray(value) ? value.map((v) => String(v)).join(', ') : String(value);
        parts.push(`${field}: ${list}`);
      }
      if (parts.length) return parts.join('; ');
    }
    if (Array.isArray(errors) && errors.length) return errors.map((e) => String(e)).join('; ');
  }
  if (fallback) return fallback;
  return res.text.slice(0, 300) || `HTTP ${res.status}`;
}

/** Turn a transport exception into a typed adapter failure without leaking stack traces. */
export function failFromThrown<T>(adapter: string, operation: string, err: unknown): AdapterResult<T> {
  if (err instanceof HttpTransportError) {
    return adapterFail<T>(
      'NETWORK',
      `${adapter}: could not reach the ${operation} endpoint (${err.message}). Check the site is online and the base URL is correct.`,
    );
  }
  return adapterFail<T>('PROVIDER_ERROR', `${adapter}: ${operation} failed — ${errorMessage(err)}`);
}

// ── defensive JSON readers ────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

export function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * WordPress and friends return `{ rendered: '…' }` for renderable fields; accept both
 * that shape and a plain string.
 */
export function readRendered(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value)) return readString(value.rendered);
  return undefined;
}

/** Recursively strip anything JSON cannot represent so a value is safe for a Prisma Json column. */
export function toJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) return null;
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => toJsonValue(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonValue(v, depth + 1);
    return out;
  }
  return null;
}

export function toJsonObject(value: unknown): JsonObject {
  const json = toJsonValue(value);
  return isRecord(json) ? (json as JsonObject) : {};
}

/** ISO-8601 or undefined — never an invalid date string in a snapshot. */
export function readIsoDate(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
