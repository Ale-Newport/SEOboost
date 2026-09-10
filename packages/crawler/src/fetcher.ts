/**
 * HTTP layer for the crawler.
 *
 * Built on global `fetch` with three things `fetch` does not give us and a crawler needs:
 * a hard cap on how much of a body we are willing to buffer, a full redirect chain (so an
 * audit can show `/a → /b → /c`), and per-host pacing so we never hammer a site we are
 * auditing on the owner's behalf.
 */

import { RateLimiter, createLogger, env, errorMessage, retry } from '@seo/shared';
import type { FetchResult } from './types';

const log = createLogger('crawler:fetch');

export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_REDIRECTS = 5;

const HTML_CONTENT_TYPE = /^(?:text\/html|application\/xhtml\+xml)\b/i;
const TEXTUAL_CONTENT_TYPE =
  /^(?:text\/|application\/(?:xml|xhtml\+xml|json|ld\+json|rss\+xml|atom\+xml|javascript)|[a-z.-]+\/[a-z.-]+\+(?:xml|json))/i;

/** True for `text/html` and XHTML, the only types worth handing to the HTML parser. */
export function isHtmlContentType(contentType: string | null): boolean {
  return Boolean(contentType && HTML_CONTENT_TYPE.test(contentType.trim()));
}

/** True for anything we can usefully decode to a string (HTML, XML, JSON, plain text). */
export function isTextualContentType(contentType: string | null): boolean {
  return Boolean(contentType && TEXTUAL_CONTENT_TYPE.test(contentType.trim()));
}

export interface FetcherOptions {
  /** Defaults to `env.crawlerUserAgent` so ad-hoc fetches still identify themselves honestly. */
  userAgent?: string;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  /** Minimum gap between two requests to the same host, in ms. */
  minHostIntervalMs?: number;
  /** Total attempts per URL, including the first. */
  retries?: number;
  acceptLanguage?: string;
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Keep the undecoded bytes on the result (gzipped sitemaps need them). */
  raw?: boolean;
  /** Accept any textual type, not just HTML. Sitemaps and robots.txt set this. */
  acceptText?: boolean;
  /**
   * Buffer the body whatever the content type says. Needed for `.xml.gz` sitemaps, which are
   * served as `application/gzip`. Still bounded by `maxBodyBytes`.
   */
  acceptAny?: boolean;
}

interface Deadline {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  dispose(): void;
}

/**
 * A timeout that also honours the caller's cancellation, and remembers which of the two
 * fired — a timeout is worth retrying, a user cancellation never is.
 */
function startDeadline(timeoutMs: number, external?: AbortSignal): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onAbort, { once: true });

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/** Read at most `maxBytes` from a response body, then cancel the stream. */
async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let drained = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    // Any exit that did not read the stream to completion — a cap hit or a read error — leaves
    // the socket held open until GC unless the body is cancelled explicitly.
    if (!drained) await reader.cancel().catch(() => undefined);
  }

  const size = Math.min(total, maxBytes);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const take = Math.min(chunk.byteLength, size - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { bytes: out, truncated };
}

const CHARSET_FROM_HEADER = /charset\s*=\s*["']?([^;"'\s]+)/i;
// Only the first 2 KB matter: the spec requires the charset declaration inside the first 1024 bytes.
const CHARSET_FROM_META = /<meta[^>]+charset\s*=\s*["']?([a-z0-9_:.-]+)/i;

/**
 * Decode bytes using the declared charset. Legacy sites (windows-1252, ISO-8859-1, Shift_JIS)
 * are common enough that decoding everything as UTF-8 mangles their titles and word counts.
 */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
  const headerCharset = CHARSET_FROM_HEADER.exec(contentType ?? '')?.[1];
  const decodeWith = (charset: string): string | null => {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return null;
    }
  };

  if (headerCharset && !/^utf-?8$/i.test(headerCharset)) {
    const decoded = decodeWith(headerCharset);
    if (decoded !== null) return decoded;
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!headerCharset) {
    const metaCharset = CHARSET_FROM_META.exec(utf8.slice(0, 2048))?.[1];
    if (metaCharset && !/^utf-?8$/i.test(metaCharset)) {
      const decoded = decodeWith(metaCharset);
      if (decoded !== null) return decoded;
    }
  }
  return utf8;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 429 and 5xx are transient; everything else is the server's final answer. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Carries a completed-but-retryable response through `retry()` without losing the response. */
class RetryableResponseError extends Error {
  constructor(readonly result: FetchResult) {
    super(`HTTP ${result.statusCode ?? 'error'} for ${result.url}`);
    this.name = 'RetryableResponseError';
  }
}

class AbortedError extends Error {
  constructor(message = 'Request cancelled') {
    super(message);
    this.name = 'AbortedError';
  }
}

function emptyResult(url: string): FetchResult {
  return {
    url,
    finalUrl: url,
    ok: false,
    statusCode: null,
    contentType: null,
    headers: {},
    body: null,
    rawBody: null,
    contentBytes: 0,
    truncated: false,
    redirectChain: [],
    redirectTarget: null,
    redirectStatus: null,
    responseTimeMs: 0,
    attempts: 0,
    aborted: false,
    error: null,
  };
}

export class Fetcher {
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxBodyBytes: number;
  private readonly minHostIntervalMs: number;
  private readonly retries: number;
  private readonly acceptLanguage: string;
  private readonly hostIntervals = new Map<string, number>();

  constructor(options: FetcherOptions = {}) {
    this.userAgent = options.userAgent ?? env.crawlerUserAgent;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.minHostIntervalMs = Math.max(0, options.minHostIntervalMs ?? 0);
    this.retries = Math.max(1, options.retries ?? 3);
    this.acceptLanguage = options.acceptLanguage ?? 'en-US,en;q=0.9';
  }

  /**
   * Raise the pacing for one host, e.g. after reading `Crawl-delay` from robots.txt.
   * Replaces the limiter because its interval is fixed at construction; safe as long as this
   * is called before the host is crawled, which is how the engine uses it.
   */
  setHostInterval(urlOrHost: string, intervalMs: number): void {
    const host = this.hostKey(urlOrHost);
    if (!host) return;
    const next = Math.max(0, Math.round(intervalMs));
    if (this.hostIntervals.get(host) === next) return;
    this.hostIntervals.set(host, next);
    this.limiters.set(host, new RateLimiter(next));
  }

  private hostKey(input: string): string | null {
    try {
      return new URL(input).host.toLowerCase();
    } catch {
      return null;
    }
  }

  private limiterFor(url: string): RateLimiter | null {
    const host = this.hostKey(url);
    if (!host) return null;
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new RateLimiter(this.hostIntervals.get(host) ?? this.minHostIntervalMs);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  /** Fetch a document we intend to parse. Non-textual bodies are dropped, not buffered. */
  async fetchPage(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    return this.run(url, 'GET', options);
  }

  /**
   * Status + content type only, for asset links (images, PDFs) we want to report on but must
   * not download. HEAD first; a few servers answer 405/501 to HEAD, so fall back to a GET
   * whose body we discard.
   */
  async fetchAsset(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const head = await this.run(url, 'HEAD', options);
    if (head.statusCode !== 405 && head.statusCode !== 501 && head.error === null) return head;
    if (head.aborted) return head;
    const get = await this.run(url, 'GET', { ...options, raw: false });
    return { ...get, body: null, rawBody: null };
  }

  private async run(url: string, method: 'GET' | 'HEAD', options: FetchOptions): Promise<FetchResult> {
    let attempts = 0;
    try {
      return await retry(
        async () => {
          attempts += 1;
          const result = await this.attempt(url, method, options, attempts);
          if (result.statusCode !== null && isRetryableStatus(result.statusCode)) {
            throw new RetryableResponseError(result);
          }
          return result;
        },
        {
          attempts: this.retries,
          baseDelayMs: 700,
          maxDelayMs: 15_000,
          shouldRetry: (err) => !(err instanceof AbortedError),
          onRetry: (err, attempt, delayMs) =>
            log.debug('retrying request', { url, attempt, delayMs, error: errorMessage(err) }),
        },
      );
    } catch (err) {
      // Retries exhausted on a real response: report the response, not the wrapper error.
      if (err instanceof RetryableResponseError) return { ...err.result, attempts };
      const aborted = err instanceof AbortedError || options.signal?.aborted === true;
      return {
        ...emptyResult(url),
        attempts,
        aborted,
        error: aborted ? 'Request cancelled' : errorMessage(err),
      };
    }
  }

  private async attempt(
    url: string,
    method: 'GET' | 'HEAD',
    options: FetchOptions,
    attempt: number,
  ): Promise<FetchResult> {
    const redirectChain: string[] = [];
    let current = url;
    // The first 3xx is the one an audit reports on: 301 and 302 mean different things, and
    // only the final hop's status survives into `statusCode`.
    let redirectStatus: number | null = null;
    const startedAt = Date.now();

    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      if (options.signal?.aborted) throw new AbortedError();

      const hopResult = await this.singleRequest(current, method, options);

      if (hopResult.status !== null && isRedirectStatus(hopResult.status)) {
        if (redirectStatus === null) redirectStatus = hopResult.status;
        const location = hopResult.headers['location'];
        if (!location) {
          // A 3xx with no Location is a dead end; report it as the final response.
          return this.buildResult(url, current, hopResult, redirectChain, redirectStatus, startedAt, attempt, options);
        }
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return {
            ...this.buildResult(url, current, hopResult, redirectChain, redirectStatus, startedAt, attempt, options),
            error: `Unresolvable redirect target: ${location}`,
          };
        }
        if (hop === this.maxRedirects) {
          return {
            ...this.buildResult(url, current, hopResult, redirectChain, redirectStatus, startedAt, attempt, options),
            error: `Exceeded ${this.maxRedirects} redirects`,
          };
        }
        redirectChain.push(next);
        current = next;
        continue;
      }

      return this.buildResult(url, current, hopResult, redirectChain, redirectStatus, startedAt, attempt, options);
    }

    return {
      ...emptyResult(url),
      redirectChain,
      redirectTarget: redirectChain.length > 0 ? current : null,
      redirectStatus,
      attempts: attempt,
      responseTimeMs: Date.now() - startedAt,
      error: `Exceeded ${this.maxRedirects} redirects`,
    };
  }

  private buildResult(
    requestedUrl: string,
    finalUrl: string,
    hop: SingleRequestResult,
    redirectChain: string[],
    redirectStatus: number | null,
    startedAt: number,
    attempt: number,
    options: FetchOptions,
  ): FetchResult {
    const contentType = hop.headers['content-type'] ?? null;
    return {
      url: requestedUrl,
      finalUrl,
      ok: hop.status !== null && hop.status >= 200 && hop.status < 300,
      statusCode: hop.status,
      contentType,
      headers: hop.headers,
      body: hop.body,
      rawBody: options.raw ? hop.bytes : null,
      contentBytes: hop.contentBytes,
      truncated: hop.truncated,
      redirectChain,
      redirectTarget: redirectChain.length > 0 ? finalUrl : null,
      redirectStatus,
      responseTimeMs: Date.now() - startedAt,
      attempts: attempt,
      aborted: false,
      error: null,
    };
  }

  /**
   * One HTTP round trip, paced per host. The timeout starts *after* the rate limiter grants
   * the slot, otherwise a polite crawl-delay would show up as a flood of timeouts.
   */
  private async singleRequest(
    url: string,
    method: 'GET' | 'HEAD',
    options: FetchOptions,
  ): Promise<SingleRequestResult> {
    const limiter = this.limiterFor(url);
    const perform = async (): Promise<SingleRequestResult> => {
      if (options.signal?.aborted) throw new AbortedError();
      // Declared outside the try so the catch/finally can inspect and dispose it.
      const deadline = startDeadline(this.timeoutMs, options.signal);
      try {
        const response = await fetch(url, {
          method,
          redirect: 'manual',
          signal: deadline.signal,
          headers: {
            'user-agent': this.userAgent,
            accept: options.acceptText
              ? 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5'
              : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'accept-language': this.acceptLanguage,
            'accept-encoding': 'gzip, deflate, br',
          },
        });

        const headers = headersToObject(response.headers);
        const contentType = headers['content-type'] ?? null;
        const status = response.status;

        if (method === 'HEAD' || isRedirectStatus(status)) {
          await response.body?.cancel().catch(() => undefined);
          return { status, headers, body: null, bytes: null, contentBytes: 0, truncated: false };
        }

        const acceptable =
          options.acceptAny === true ||
          isHtmlContentType(contentType) ||
          isTextualContentType(contentType) ||
          // Some servers omit Content-Type entirely; assume it is worth reading.
          (options.acceptText === true && contentType === null);

        if (!acceptable || !response.body) {
          // Still a useful result: the caller records status + type for the asset.
          await response.body?.cancel().catch(() => undefined);
          return { status, headers, body: null, bytes: null, contentBytes: 0, truncated: false };
        }

        const { bytes, truncated } = await readCapped(response.body, this.maxBodyBytes);
        return {
          status,
          headers,
          body: decodeBody(bytes, contentType),
          bytes,
          contentBytes: bytes.byteLength,
          truncated,
        };
      } catch (err) {
        if (options.signal?.aborted) throw new AbortedError();
        if (deadline.timedOut) throw new Error(`Timed out after ${this.timeoutMs}ms`);
        throw err;
      } finally {
        deadline.dispose();
      }
    };

    return limiter ? limiter.schedule(perform) : perform();
  }
}

interface SingleRequestResult {
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  bytes: Uint8Array | null;
  contentBytes: number;
  truncated: boolean;
}

export function createFetcher(options: FetcherOptions = {}): Fetcher {
  return new Fetcher(options);
}
