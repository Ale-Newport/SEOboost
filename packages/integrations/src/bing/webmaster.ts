/**
 * Bing Webmaster Tools API (https://ssl.bing.com/webmaster/api.svc/json/…).
 *
 * Auth is a single account-wide API key (`BING_API_KEY`) passed as an `apikey` query
 * parameter — there is no OAuth flow and no per-website secret, so nothing is stored in
 * `Integration.credentials`. The Integration row only carries the non-secret `siteUrl`
 * of the verified Bing property, which we resolve from the website domain on first sync.
 *
 * ## What lands in the database
 * Bing's reporting has no query×page cross-tab: `GetQueryStats` is site-wide per query and
 * `GetPageStats` is site-wide per page. Both are written to `GscQueryMetric` with
 * `source: 'bing'` so the analytics layer stays source-agnostic, using two sentinels:
 *
 *   query rows → `page  = BING_SITE_PAGE_KEY` ('bing://site', deliberately not a http(s)
 *                URL so `normalizeUrl` rejects it and the GSC page-linker never mis-attributes
 *                every Bing query to the homepage)
 *   page rows  → `query = BING_PAGE_ROW_QUERY` ('')
 *
 * `GetRankAndTrafficStats` produces the daily site totals in `SearchConsoleDaily`
 * (`source: 'bing'`, country/device NULL).
 *
 * ## Quirks this module absorbs
 * - Timestamps come back as .NET `/Date(1699920000000)/` literals (see `parseBingDate`).
 * - The payload is wrapped in a `d` envelope; errors can arrive as HTTP 200 with a
 *   `{ Message, ExceptionType }` body instead of a status code.
 * - Several endpoints are not enabled for every tenant/site and answer 404/501. Those
 *   return `{ supported: false, reason }` so a sync degrades to a warning instead of failing.
 * - Bing serves a fixed ~6-month window and ignores date-range parameters, so the requested
 *   `from`/`to` are applied client-side.
 */

import {
  prisma,
  Prisma,
  IntegrationProvider,
  IntegrationStatus,
  createManyChunked,
  json,
  readJson,
} from '@seo/db';
import {
  env,
  isConfigured,
  IntegrationNotConfiguredError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  RateLimiter,
  chunk,
  cleanDomain,
  createLogger,
  errorMessage,
  formatDateKey,
  lastNDays,
  round,
  safeDivide,
  toUtcDate,
} from '@seo/shared';
import {
  ProviderHttpError,
  buildQuery,
  readDate,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readRecord,
  readString,
  requestJson,
} from '../serp/http';
// Provider-agnostic Integration row writers; they happen to live in the Google module.
import { markIntegrationStatus, recordSyncOutcome } from '../google/oauth';
import { emptySyncResult, integrationFail, integrationOk } from '../types';
import type { IntegrationHealth, IntegrationResult, SyncResult } from '../types';

const log = createLogger('integrations:bing');

export const BING_BASE_URL = 'https://ssl.bing.com/webmaster/api.svc/json';
export const BING_REQUIRED_ENV: readonly string[] = ['BING_API_KEY'];

const PROVIDER = 'bing';
/** `SearchConsoleDaily.source` / `GscQueryMetric.source` written by this module. */
export const BING_SOURCE = 'bing';

/**
 * Page key stored on site-level Bing query rows. Not a http(s) URL on purpose: the Search
 * Console page-linker calls `normalizeUrl` and skips anything it cannot normalise, which is
 * exactly what keeps these rows from being attributed to a real page.
 */
export const BING_SITE_PAGE_KEY = 'bing://site';
/** Query value stored on Bing page-level rows (Bing reports no query for them). */
export const BING_PAGE_ROW_QUERY = '';

/** Bing finalises traffic data roughly two days late. */
export const BING_DATA_LAG_DAYS = 2;
export const BING_DEFAULT_WINDOW_DAYS = 28;
/** Bing keeps ~6 months of reporting; asking for more simply returns nothing. */
export const BING_MAX_HISTORY_DAYS = 180;

/** Bing's documented ceiling for one `SubmitUrlBatch` call. */
const SUBMIT_BATCH_SIZE = 500;
/** Bing throttles aggressively per key; ~2.5 requests/second is comfortably inside quota. */
const limiter = new RateLimiter(400);
const REQUEST_TIMEOUT_MS = 30_000;

// ── Configuration ────────────────────────────────────────────

export function isBingConfigured(): boolean {
  return isConfigured.bing();
}

function requireApiKey(): string {
  const key = env.bingApiKey;
  if (!key) {
    throw new IntegrationNotConfiguredError(
      PROVIDER,
      'Bing Webmaster Tools is not configured. Set BING_API_KEY in the environment.',
    );
  }
  return key;
}

// ── Result shapes ────────────────────────────────────────────

/** An endpoint the tenant/site is not entitled to (Bing answers 404 or 501). */
export interface BingUnsupported {
  supported: false;
  reason: string;
}

export type BingEndpointResult<T> = { supported: true; data: T } | BingUnsupported;

function unsupported(reason: string): BingUnsupported {
  return { supported: false, reason };
}

/**
 * Remove the API key from anything that may be logged, persisted or shown to a user.
 *
 * Bing only accepts the key as a query parameter, so any transport error that echoes the
 * request URL would otherwise write `BING_API_KEY` into `Integration.lastError` — a column
 * API routes return to the client. Contract rule 7: secrets never leave the server.
 */
function scrubKey(message: string): string {
  const scrubbed = message.replace(/([?&]apikey=)[^&\s"')\]]+/gi, '$1***');
  const key = env.bingApiKey;
  // Belt and braces: a key echoed outside a query string (a vendor error body) is still a leak.
  return key && key.length >= 8 ? scrubbed.split(key).join('***') : scrubbed;
}

// ── Date parsing ─────────────────────────────────────────────

/**
 * `/Date(1699920000000)/` and `/Date(1699920000000+0100)/` are the WCF JSON date encodings
 * Bing still emits. The number is always epoch milliseconds in UTC — the trailing offset is
 * a display hint only, so it is deliberately ignored rather than added to the timestamp.
 * Anything else falls through to the shared tolerant parser (Bing occasionally returns ISO).
 */
export function parseBingDate(value: unknown): Date | null {
  if (typeof value === 'string') {
    const match = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value.trim());
    if (match) {
      const ms = Number(match[1]);
      return Number.isFinite(ms) ? new Date(ms) : null;
    }
  }
  return readDate(value);
}

// ── Transport ────────────────────────────────────────────────

interface BingRequestOptions {
  /** Query-string parameters; `apikey` is added by this function. */
  params?: Record<string, string | number | boolean | undefined>;
  /** Present ⇒ POST with this JSON body. */
  body?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Call one Bing endpoint and unwrap the `d` envelope.
 *
 * Returns `{ supported: false }` for 404/501/405 — Bing uses those for "this endpoint is not
 * enabled for this site" as much as for genuinely wrong URLs, and a nightly sync must not die
 * because one optional report is unavailable. Everything else throws `ProviderError` so the
 * queue's retry policy can classify it.
 */
async function bingRequest(
  endpoint: string,
  opts: BingRequestOptions = {},
): Promise<BingEndpointResult<unknown>> {
  const query = buildQuery({ ...(opts.params ?? {}), apikey: requireApiKey() });
  let raw: unknown;
  try {
    raw = await requestJson({
      provider: PROVIDER,
      url: `${BING_BASE_URL}/${endpoint}${query}`,
      method: opts.body === undefined ? 'GET' : 'POST',
      ...(opts.body === undefined ? {} : { body: opts.body }),
      timeoutMs: REQUEST_TIMEOUT_MS,
      rateLimiter: limiter,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    if (err instanceof ProviderHttpError && [404, 405, 501].includes(err.status)) {
      return unsupported(`Bing endpoint ${endpoint} is not available for this account (HTTP ${err.status})`);
    }
    throw err;
  }

  const envelope = readRecord(raw);
  if (!envelope) {
    // `SubmitUrl` and friends answer with a bare `null` body on success.
    return { supported: true, data: raw };
  }
  if (!('d' in envelope)) {
    const message = readOptionalString(envelope.Message);
    if (message) {
      // Bing returns some failures as HTTP 200 with a WCF fault body.
      if (/not\s+found|invalid\s+site|no\s+access/i.test(message)) {
        return unsupported(`Bing endpoint ${endpoint}: ${message}`);
      }
      throw new ProviderError(PROVIDER, `${endpoint}: ${message}`, false);
    }
    return { supported: true, data: envelope };
  }
  return { supported: true, data: envelope.d };
}

/** Map an endpoint result through a parser, preserving the unsupported branch. */
function mapResult<T, R>(
  result: BingEndpointResult<T>,
  parse: (data: T) => R,
): BingEndpointResult<R> {
  return result.supported ? { supported: true, data: parse(result.data) } : result;
}

// ── Entity types ─────────────────────────────────────────────

export interface BingSite {
  /** Property URL exactly as Bing stores it, e.g. `https://example.com:443/`. */
  url: string;
  /** Hostname of `url`, lowercased and `www.`-stripped — the domain comparison key. */
  domain: string;
  /** `GetUserSites` only returns sites the key's account can access; false only if Bing says so. */
  isVerified: boolean;
}

export interface BingTrafficStat {
  date: Date;
  clicks: number;
  impressions: number;
}

export interface BingQueryStat {
  query: string;
  date: Date;
  clicks: number;
  impressions: number;
  /** Average position across impressions; 0 when Bing omits it. */
  avgImpressionPosition: number;
  avgClickPosition: number;
}

export interface BingPageStat {
  url: string;
  date: Date;
  clicks: number;
  impressions: number;
  avgImpressionPosition: number;
  avgClickPosition: number;
}

export interface BingUrlTrafficInfo {
  url: string;
  clicks: number;
  impressions: number;
  avgImpressionPosition: number;
  avgClickPosition: number;
}

export interface BingCrawlStat {
  date: Date;
  crawledPages: number;
  inIndex: number;
  inLinks: number;
  blocked: number;
  robotsTxtExclusion: number;
  code2xx: number;
  code301: number;
  code302: number;
  code4xx: number;
  code5xx: number;
  connectionTimeout: number;
  dnsFailures: number;
  allOtherCodes: number;
}

export interface BingCrawlIssue {
  url: string;
  httpCode: number | null;
  inLinks: number;
  /** Raw `CrawlIssues` flags bitmask exactly as Bing returned it. */
  issuesMask: number;
  /** Decoded flag names; unrecognised bits are kept as `Unknown(<bit>)` rather than dropped. */
  issues: string[];
}

export interface BingLinkCount {
  url: string;
  count: number;
}

export interface BingInboundLink {
  url: string;
  anchorText: string | null;
}

export interface BingFeed {
  url: string;
  submittedAt: Date | null;
  lastCrawledAt: Date | null;
  urlCount: number;
  urlsIndexed: number;
  status: string | null;
}

/**
 * Bing's `CrawlIssues` flags enum. Only the documented bits are named; anything else is
 * surfaced as `Unknown(<bit>)` so a newly-added flag shows up instead of silently vanishing.
 */
const CRAWL_ISSUE_FLAGS: ReadonlyArray<{ bit: number; label: string }> = [
  { bit: 1, label: 'Code301' },
  { bit: 2, label: 'Code302' },
  { bit: 4, label: 'Code4xx' },
  { bit: 8, label: 'Code5xx' },
  { bit: 16, label: 'BlockedByRobotsTxt' },
  { bit: 32, label: 'ContainsMalware' },
  { bit: 64, label: 'ImportantUrlBlockedByRobotsTxt' },
];

export function decodeCrawlIssues(mask: number): string[] {
  if (!Number.isFinite(mask) || mask <= 0) return [];
  const out: string[] = [];
  let remaining = Math.trunc(mask);
  for (const flag of CRAWL_ISSUE_FLAGS) {
    if ((remaining & flag.bit) !== 0) {
      out.push(flag.label);
      remaining &= ~flag.bit;
    }
  }
  for (let bit = 1; bit <= remaining; bit <<= 1) {
    if ((remaining & bit) !== 0) out.push(`Unknown(${bit})`);
  }
  return out;
}

// ── Row parsers ──────────────────────────────────────────────
// Bing payloads are untrusted input: every parser drops rows it cannot make sense of
// rather than throwing halfway through a report.

function parseSite(raw: unknown): BingSite | null {
  const record = readRecord(raw);
  const url = record ? readString(record.Url) : '';
  if (!url) return null;
  const verified = record?.IsVerified;
  return {
    url,
    domain: cleanDomain(url),
    isVerified: typeof verified === 'boolean' ? verified : true,
  };
}

function parseTrafficStat(raw: unknown): BingTrafficStat | null {
  const record = readRecord(raw);
  if (!record) return null;
  const date = parseBingDate(record.Date);
  if (!date) return null;
  return {
    date,
    clicks: Math.round(readNumber(record.Clicks, 0)),
    impressions: Math.round(readNumber(record.Impressions, 0)),
  };
}

function parseQueryStat(raw: unknown): BingQueryStat | null {
  const record = readRecord(raw);
  if (!record) return null;
  const query = readString(record.Query).trim();
  const date = parseBingDate(record.Date);
  if (!query || !date) return null;
  return {
    query,
    date,
    clicks: Math.round(readNumber(record.Clicks, 0)),
    impressions: Math.round(readNumber(record.Impressions, 0)),
    avgImpressionPosition: round(readNumber(record.AvgImpressionPosition, 0), 2),
    avgClickPosition: round(readNumber(record.AvgClickPosition, 0), 2),
  };
}

/** `GetPageStats` reuses the query-stat entity and puts the page URL in `Query`. */
function parsePageStat(raw: unknown): BingPageStat | null {
  const record = readRecord(raw);
  if (!record) return null;
  const url = readString(record.Url) || readString(record.Query);
  const date = parseBingDate(record.Date);
  if (!url || !date) return null;
  return {
    url,
    date,
    clicks: Math.round(readNumber(record.Clicks, 0)),
    impressions: Math.round(readNumber(record.Impressions, 0)),
    avgImpressionPosition: round(readNumber(record.AvgImpressionPosition, 0), 2),
    avgClickPosition: round(readNumber(record.AvgClickPosition, 0), 2),
  };
}

function parseCrawlStat(raw: unknown): BingCrawlStat | null {
  const record = readRecord(raw);
  if (!record) return null;
  const date = parseBingDate(record.Date);
  if (!date) return null;
  return {
    date,
    crawledPages: readNumber(record.CrawledPages, 0),
    inIndex: readNumber(record.InIndex, 0),
    inLinks: readNumber(record.InLinks, 0),
    blocked: readNumber(record.Blocked, 0),
    robotsTxtExclusion: readNumber(record.RobotsTxtExclusion, 0),
    code2xx: readNumber(record.Code2xx, 0),
    code301: readNumber(record.Code301, 0),
    code302: readNumber(record.Code302, 0),
    code4xx: readNumber(record.Code4xx, 0),
    code5xx: readNumber(record.Code5xx, 0),
    connectionTimeout: readNumber(record.ConnectionTimeout, 0),
    dnsFailures: readNumber(record.DnsFailures, 0),
    allOtherCodes: readNumber(record.AllOtherCodes, 0),
  };
}

function parseCrawlIssue(raw: unknown): BingCrawlIssue | null {
  const record = readRecord(raw);
  if (!record) return null;
  const url = readString(record.Url);
  if (!url) return null;
  const issuesMask = readNumber(record.Issues, 0);
  return {
    url,
    httpCode: readOptionalNumber(record.HttpCode) ?? null,
    inLinks: readNumber(record.InLinks, 0),
    issuesMask,
    issues: decodeCrawlIssues(issuesMask),
  };
}

function parseFeed(raw: unknown): BingFeed | null {
  const record = readRecord(raw);
  if (!record) return null;
  const url = readString(record.Url);
  if (!url) return null;
  return {
    url,
    submittedAt: parseBingDate(record.Submitted),
    lastCrawledAt: parseBingDate(record.LastCrawled),
    urlCount: readNumber(record.UrlCount, 0),
    urlsIndexed: readNumber(record.UrlsIndexed, 0),
    status: readOptionalString(record.Status) ?? null,
  };
}

/**
 * Several Bing endpoints wrap their list in a named property (`Links`, `Details`) while
 * others return the array directly. Accept both instead of guessing.
 */
function listFrom(data: unknown, ...keys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const record = readRecord(data);
  if (!record) return [];
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

// ── Endpoints ────────────────────────────────────────────────
// Every function here throws IntegrationNotConfiguredError when BING_API_KEY is absent.

/** `GetUserSites` — every property the API key's account can read. */
export async function getUserSites(signal?: AbortSignal): Promise<BingEndpointResult<BingSite[]>> {
  const res = await bingRequest('GetUserSites', { ...(signal ? { signal } : {}) });
  return mapResult(res, (data) =>
    listFrom(data, 'Sites').flatMap((raw) => {
      const site = parseSite(raw);
      return site ? [site] : [];
    }),
  );
}

/** `GetRankAndTrafficStats` — daily clicks/impressions for the whole property. */
export async function getRankAndTrafficStats(
  siteUrl: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingTrafficStat[]>> {
  const res = await bingRequest('GetRankAndTrafficStats', { params: { siteUrl }, ...(signal ? { signal } : {}) });
  return mapResult(res, (data) =>
    listFrom(data).flatMap((raw) => {
      const stat = parseTrafficStat(raw);
      return stat ? [stat] : [];
    }),
  );
}

/** `GetQueryStats` — per-query, per-day totals across the whole property. */
export async function getQueryStats(
  siteUrl: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingQueryStat[]>> {
  const res = await bingRequest('GetQueryStats', { params: { siteUrl }, ...(signal ? { signal } : {}) });
  return mapResult(res, (data) =>
    listFrom(data).flatMap((raw) => {
      const stat = parseQueryStat(raw);
      return stat ? [stat] : [];
    }),
  );
}

/** `GetPageStats` — per-page, per-day totals across the whole property. */
export async function getPageStats(
  siteUrl: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingPageStat[]>> {
  const res = await bingRequest('GetPageStats', { params: { siteUrl }, ...(signal ? { signal } : {}) });
  return mapResult(res, (data) =>
    listFrom(data).flatMap((raw) => {
      const stat = parsePageStat(raw);
      return stat ? [stat] : [];
    }),
  );
}

/** `GetUrlTrafficInfo` — lifetime traffic for a single URL. */
export async function getUrlTrafficInfo(
  siteUrl: string,
  url: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingUrlTrafficInfo | null>> {
  const res = await bingRequest('GetUrlTrafficInfo', {
    params: { siteUrl, url },
    ...(signal ? { signal } : {}),
  });
  return mapResult(res, (data) => {
    const record = readRecord(Array.isArray(data) ? data[0] : data);
    if (!record) return null;
    return {
      url: readString(record.Url) || url,
      clicks: Math.round(readNumber(record.Clicks, 0)),
      impressions: Math.round(readNumber(record.Impressions, 0)),
      avgImpressionPosition: round(readNumber(record.AvgImpressionPosition, 0), 2),
      avgClickPosition: round(readNumber(record.AvgClickPosition, 0), 2),
    };
  });
}

/** `GetCrawlStats` — daily crawl/response-code breakdown for the property. */
export async function getCrawlStats(
  siteUrl: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingCrawlStat[]>> {
  const res = await bingRequest('GetCrawlStats', { params: { siteUrl }, ...(signal ? { signal } : {}) });
  return mapResult(res, (data) =>
    listFrom(data).flatMap((raw) => {
      const stat = parseCrawlStat(raw);
      return stat ? [stat] : [];
    }),
  );
}

/** `GetCrawlIssues` — URLs Bingbot had a problem with, with a flags bitmask per URL. */
export async function getCrawlIssues(
  siteUrl: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingCrawlIssue[]>> {
  const res = await bingRequest('GetCrawlIssues', { params: { siteUrl }, ...(signal ? { signal } : {}) });
  return mapResult(res, (data) =>
    listFrom(data).flatMap((raw) => {
      const issue = parseCrawlIssue(raw);
      return issue ? [issue] : [];
    }),
  );
}

/** `GetLinkCounts` — inbound link counts per referring URL, paged (0-based). */
export async function getLinkCounts(
  siteUrl: string,
  page = 0,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingLinkCount[]>> {
  const res = await bingRequest('GetLinkCounts', {
    params: { siteUrl, page },
    ...(signal ? { signal } : {}),
  });
  return mapResult(res, (data) =>
    listFrom(data, 'Links').flatMap((raw) => {
      const record = readRecord(raw);
      const url = record ? readString(record.Url) : '';
      if (!url) return [];
      return [{ url, count: readNumber(record?.Count, 0) }];
    }),
  );
}

/** `GetUrlLinks` — the individual inbound links pointing at one of our URLs, paged. */
export async function getUrlLinks(
  siteUrl: string,
  link: string,
  page = 0,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingInboundLink[]>> {
  const res = await bingRequest('GetUrlLinks', {
    params: { siteUrl, link, page },
    ...(signal ? { signal } : {}),
  });
  return mapResult(res, (data) =>
    listFrom(data, 'Details', 'Links').flatMap((raw) => {
      const record = readRecord(raw);
      const url = record ? readString(record.Url) : '';
      if (!url) return [];
      return [{ url, anchorText: readOptionalString(record?.AnchorText) ?? null }];
    }),
  );
}

/** `SubmitUrl` — ask Bing to (re)crawl one URL. Counts against the daily submission quota. */
export async function submitUrl(
  siteUrl: string,
  url: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<true>> {
  const res = await bingRequest('SubmitUrl', {
    body: { siteUrl, url },
    ...(signal ? { signal } : {}),
  });
  return mapResult(res, () => true as const);
}

/** `SubmitUrlBatch` — same as `submitUrl` for up to 500 URLs in one call. */
export async function submitUrlBatch(
  siteUrl: string,
  urlList: readonly string[],
  signal?: AbortSignal,
): Promise<BingEndpointResult<true>> {
  const res = await bingRequest('SubmitUrlBatch', {
    body: { siteUrl, urlList: [...urlList] },
    ...(signal ? { signal } : {}),
  });
  return mapResult(res, () => true as const);
}

/** `SubmitFeed` — register or re-submit a sitemap for the property. */
export async function submitFeed(
  siteUrl: string,
  feedUrl: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<true>> {
  const res = await bingRequest('SubmitFeed', {
    body: { siteUrl, feedUrl },
    ...(signal ? { signal } : {}),
  });
  return mapResult(res, () => true as const);
}

/** `GetFeeds` — sitemaps Bing knows about for the property. */
export async function getFeeds(
  siteUrl: string,
  signal?: AbortSignal,
): Promise<BingEndpointResult<BingFeed[]>> {
  const res = await bingRequest('GetFeeds', { params: { siteUrl }, ...(signal ? { signal } : {}) });
  return mapResult(res, (data) =>
    listFrom(data, 'Feeds').flatMap((raw) => {
      const feed = parseFeed(raw);
      return feed ? [feed] : [];
    }),
  );
}

// ── Integration row ──────────────────────────────────────────

/** Non-secret settings stored on `Integration.config` for Bing. Safe to send to a client. */
export interface BingIntegrationConfig {
  /** Verified Bing property URL, e.g. `https://example.com:443/`. */
  siteUrl?: string;
}

export function readBingConfig(value: Prisma.JsonValue | null | undefined): BingIntegrationConfig {
  const raw = readJson<Record<string, unknown>>(value, {});
  return typeof raw.siteUrl === 'string' ? { siteUrl: raw.siteUrl } : {};
}

async function patchBingConfig(integrationId: string, patch: BingIntegrationConfig): Promise<void> {
  const row = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { config: true },
  });
  const existing = readJson<Record<string, unknown>>(row?.config, {});
  await prisma.integration.update({
    where: { id: integrationId },
    data: { config: json({ ...existing, ...patch }) },
  });
}

export interface EnsureBingIntegrationResult {
  integrationId: string;
  siteUrl: string | null;
  /** Why no property could be attached, when `siteUrl` is null. */
  reason?: string;
}

/**
 * Make sure a `BING_WEBMASTER` Integration row exists for the website and knows its property.
 *
 * Unlike Google there is no per-website consent step: the operator sets one account-wide API
 * key and every domain that account has verified is usable immediately. So rather than force a
 * connect flow, the first sync resolves the property from `GetUserSites` by domain and records
 * it. Nothing secret is written — the row only holds the property URL.
 */
export async function ensureBingIntegration(
  websiteId: string,
  signal?: AbortSignal,
): Promise<EnsureBingIntegrationResult> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, domain: true },
  });
  if (!website) throw new NotFoundError('Website');

  const row = await prisma.integration.upsert({
    where: { websiteId_provider: { websiteId, provider: IntegrationProvider.BING_WEBMASTER } },
    create: {
      websiteId,
      provider: IntegrationProvider.BING_WEBMASTER,
      status: IntegrationStatus.NOT_CONFIGURED,
      config: json({}),
    },
    update: {},
  });

  const configured = readBingConfig(row.config);
  if (configured.siteUrl) return { integrationId: row.id, siteUrl: configured.siteUrl };

  const sites = await getUserSites(signal);
  if (!sites.supported) {
    await markIntegrationStatus(row.id, IntegrationStatus.ERROR, sites.reason);
    return { integrationId: row.id, siteUrl: null, reason: sites.reason };
  }

  const bare = cleanDomain(website.domain);
  const match = sites.data.find((site) => site.isVerified && site.domain === bare);
  if (!match) {
    const reason = `No verified Bing Webmaster property matches ${bare}. Add and verify the site in Bing Webmaster Tools.`;
    await markIntegrationStatus(row.id, IntegrationStatus.NOT_CONFIGURED, reason);
    return { integrationId: row.id, siteUrl: null, reason };
  }

  await patchBingConfig(row.id, { siteUrl: match.url });
  await markIntegrationStatus(row.id, IntegrationStatus.CONNECTED);
  log.info('resolved Bing property from domain', { websiteId, siteUrl: match.url });
  return { integrationId: row.id, siteUrl: match.url };
}

// ── Public helpers ───────────────────────────────────────────

/**
 * Every Bing property the configured key can read.
 * Throws `IntegrationNotConfiguredError` when `BING_API_KEY` is unset — callers that render a
 * settings screen should gate on `isBingConfigured()` first.
 */
export async function listBingSites(): Promise<BingSite[]> {
  const res = await getUserSites();
  if (!res.supported) throw new ProviderError(PROVIDER, res.reason, false);
  return res.data;
}

export interface SubmitBingUrlsResult {
  submitted: number;
  /** Batches Bing accepted; a partial failure still reports what got through. */
  batches: number;
}

/**
 * Submit URLs for (re)crawl, chunked to Bing's 500-per-call limit.
 *
 * Returns a typed failure rather than throwing: callers submit URLs opportunistically after a
 * publish, and a missing key or a tenant without the submission API must not break that flow.
 */
export async function submitBingUrls(
  siteUrl: string,
  urls: readonly string[],
): Promise<IntegrationResult<SubmitBingUrlsResult>> {
  if (!isBingConfigured()) {
    return integrationFail('NOT_CONFIGURED', 'Bing Webmaster Tools is not configured (BING_API_KEY).', false);
  }
  const cleaned = [...new Set(urls.map((u) => u.trim()).filter((u) => u.length > 0))];
  if (cleaned.length === 0) return integrationOk({ submitted: 0, batches: 0 });

  let submitted = 0;
  let batches = 0;
  try {
    for (const batch of chunk(cleaned, SUBMIT_BATCH_SIZE)) {
      const res = await submitUrlBatch(siteUrl, batch);
      if (!res.supported) {
        return submitted > 0
          ? integrationOk({ submitted, batches })
          : integrationFail('UNSUPPORTED', res.reason, false);
      }
      submitted += batch.length;
      batches += 1;
    }
    return integrationOk({ submitted, batches });
  } catch (err) {
    // A batch that already landed stays reported: the caller must not re-submit those URLs
    // and burn a second slice of the daily quota.
    if (submitted > 0) {
      log.warn('bing url submission partially failed', {
        submitted,
        batches,
        error: scrubKey(errorMessage(err)),
      });
      return integrationOk({ submitted, batches });
    }
    return toIntegrationFailure(err, `submitting ${cleaned.length} URLs to Bing`);
  }
}

/** Register or refresh a sitemap with Bing. Typed failure instead of throwing. */
export async function submitBingSitemap(
  siteUrl: string,
  feedUrl: string,
): Promise<IntegrationResult<{ siteUrl: string; feedUrl: string; submittedAt: string }>> {
  if (!isBingConfigured()) {
    return integrationFail('NOT_CONFIGURED', 'Bing Webmaster Tools is not configured (BING_API_KEY).', false);
  }
  try {
    const res = await submitFeed(siteUrl, feedUrl);
    if (!res.supported) return integrationFail('UNSUPPORTED', res.reason, false);
    return integrationOk({ siteUrl, feedUrl, submittedAt: new Date().toISOString() });
  } catch (err) {
    return toIntegrationFailure(err, `submitting sitemap ${feedUrl} to Bing`);
  }
}

/** Bingbot's crawl problems for a property, as data — never an exception. */
export async function getBingCrawlIssues(
  siteUrl: string,
): Promise<IntegrationResult<BingCrawlIssue[]>> {
  if (!isBingConfigured()) {
    return integrationFail('NOT_CONFIGURED', 'Bing Webmaster Tools is not configured (BING_API_KEY).', false);
  }
  try {
    const res = await getCrawlIssues(siteUrl);
    if (!res.supported) return integrationFail('UNSUPPORTED', res.reason, false);
    return integrationOk(res.data);
  } catch (err) {
    return toIntegrationFailure(err, `reading Bing crawl issues for ${siteUrl}`);
  }
}

function toIntegrationFailure(err: unknown, context: string) {
  if (err instanceof IntegrationNotConfiguredError) {
    return integrationFail('NOT_CONFIGURED', err.message, false);
  }
  const message = scrubKey(errorMessage(err));
  // `requestJson` raises RateLimitError (not a ProviderHttpError) for 429s.
  if (err instanceof RateLimitError) {
    return integrationFail('RATE_LIMITED', `${context}: ${message}`, true);
  }
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403) {
      return integrationFail('PERMISSION_DENIED', `${context}: ${message}`, false);
    }
    if (err.status === 429) return integrationFail('RATE_LIMITED', `${context}: ${message}`, true);
    if (err.status >= 400 && err.status < 500) {
      return integrationFail('INVALID_REQUEST', `${context}: ${message}`, false);
    }
  }
  log.warn('bing request failed', { context, error: message });
  return integrationFail('PROVIDER_ERROR', `${context}: ${message}`, true);
}

/** Integration-health row for the settings screen. Env-only, synchronous, never throws. */
export function bingIntegrationHealth(): IntegrationHealth {
  const configured = isBingConfigured();
  return {
    provider: IntegrationProvider.BING_WEBMASTER,
    label: 'Bing Webmaster Tools',
    status: configured ? 'CONNECTED' : 'NOT_CONFIGURED',
    ...(configured
      ? {}
      : {
          detail:
            'Set BING_API_KEY (Bing Webmaster Tools → Settings → API access) to import Bing clicks, impressions and crawl issues.',
        }),
    requiredEnv: [...BING_REQUIRED_ENV],
  };
}

// ── Sync ─────────────────────────────────────────────────────

export interface SyncBingInput {
  websiteId: string;
  /** Defaults to the last 28 complete days ending `BING_DATA_LAG_DAYS` ago. */
  from?: Date | string;
  to?: Date | string;
  signal?: AbortSignal;
}

function resolveRange(from?: Date | string, to?: Date | string): { start: Date; end: Date } {
  const fallback = lastNDays(BING_DEFAULT_WINDOW_DAYS, BING_DATA_LAG_DAYS);
  return {
    start: from ? toUtcDate(from) : fallback.start,
    end: to ? toUtcDate(to) : fallback.end,
  };
}

function withinRange(date: Date, range: { start: Date; end: Date }): boolean {
  const t = toUtcDate(date).getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}

/**
 * Import Bing Webmaster reporting for one website.
 *
 * Never throws for a site that is not configured, not verified in Bing, or whose optional
 * reports are unavailable — those come back as a skipped `SyncResult` or a warning so a
 * nightly fan-out over every website keeps going. Genuine provider faults do throw so the
 * queue retries them.
 */
export async function syncBing(input: SyncBingInput): Promise<SyncResult> {
  const { websiteId, signal } = input;
  const range = resolveRange(input.from, input.to);
  const from = formatDateKey(range.start);
  const to = formatDateKey(range.end);

  if (range.end.getTime() < range.start.getTime()) {
    throw new ProviderError(PROVIDER, `invalid date range ${from}..${to}`, false);
  }
  if (!isBingConfigured()) {
    return emptySyncResult(from, to, 'NOT_CONFIGURED', 'Bing Webmaster Tools is not configured (BING_API_KEY).');
  }

  const warnings: string[] = [];
  let integrationId: string | null = null;

  // Bing keeps ~6 months and silently returns nothing older, so say so rather than let the
  // caller read an empty result as "no traffic".
  const oldestAvailable = lastNDays(1, BING_MAX_HISTORY_DAYS).start;
  if (range.start.getTime() < oldestAvailable.getTime()) {
    warnings.push(
      `Bing keeps about ${BING_MAX_HISTORY_DAYS} days of reporting; nothing before ${formatDateKey(oldestAvailable)} can be imported.`,
    );
  }

  try {
    const ensured = await ensureBingIntegration(websiteId, signal);
    integrationId = ensured.integrationId;
    if (!ensured.siteUrl) {
      await recordSyncOutcome(integrationId, { status: 'SKIPPED', error: ensured.reason ?? null });
      return emptySyncResult(from, to, 'NOT_CONNECTED', ensured.reason ?? 'No Bing property for this website');
    }
    const siteUrl = ensured.siteUrl;

    const [traffic, queries, pages] = await Promise.all([
      getRankAndTrafficStats(siteUrl, signal),
      getQueryStats(siteUrl, signal),
      getPageStats(siteUrl, signal),
    ]);

    // Tracked apart from the window warnings above: an endpoint the tenant cannot use is the
    // difference between "Bing has nothing for these days" and "we could not ask".
    const unsupported: string[] = [];
    if (!traffic.supported) unsupported.push(traffic.reason);
    if (!queries.supported) unsupported.push(queries.reason);
    if (!pages.supported) unsupported.push(pages.reason);
    warnings.push(...unsupported);

    const queryRows = queries.supported ? queries.data.filter((r) => withinRange(r.date, range)) : [];
    const pageRows = pages.supported ? pages.data.filter((r) => withinRange(r.date, range)) : [];
    const trafficRows = traffic.supported ? traffic.data.filter((r) => withinRange(r.date, range)) : [];

    let rowsImported = 0;
    let rowsUpdated = 0;

    if (trafficRows.length > 0) {
      const written = await writeDailyTotals(websiteId, range, trafficRows, queryRows);
      rowsImported += written.inserted;
      rowsUpdated += written.replaced;
    }

    if (queryRows.length > 0 || pageRows.length > 0) {
      const written = await writeMetricRows(websiteId, range, queryRows, pageRows);
      rowsImported += written.inserted;
      rowsUpdated += written.replaced;
    }

    if (rowsImported === 0 && unsupported.length === 0) {
      await recordSyncOutcome(integrationId, { status: 'OK' });
      return {
        rowsImported: 0,
        rowsUpdated,
        from,
        to,
        warnings: [...warnings, `Bing returned no rows for ${from}..${to}`],
        skipped: 'NO_DATA',
      };
    }

    await recordSyncOutcome(integrationId, { status: 'OK' });
    log.info('bing sync complete', { websiteId, from, to, rowsImported, rowsUpdated });
    return { rowsImported, rowsUpdated, from, to, warnings };
  } catch (err) {
    if (err instanceof IntegrationNotConfiguredError) {
      if (integrationId) await recordSyncOutcome(integrationId, { status: 'SKIPPED', error: err.message });
      return emptySyncResult(from, to, 'NOT_CONFIGURED', err.message);
    }
    // `lastError` is persisted and rendered in settings, so the key must not survive into it.
    const message = scrubKey(errorMessage(err));
    if (integrationId) {
      await recordSyncOutcome(integrationId, { status: 'FAILED', error: message });
    }
    if (err instanceof ProviderHttpError && (err.status === 401 || err.status === 403)) {
      // A rejected key is a configuration problem; retrying it every hour is pointless.
      if (integrationId) {
        await markIntegrationStatus(
          integrationId,
          IntegrationStatus.ERROR,
          `Bing rejected the API key: ${message}`,
        );
      }
      return emptySyncResult(from, to, 'PERMISSION_DENIED', message);
    }
    // A 429 already carries `retryAfterSeconds`; flattening it into a ProviderError would
    // throw away the only number that says how long to wait.
    if (err instanceof RateLimitError) throw err;
    if (err instanceof ProviderError) {
      // Re-wrap only when the original text carried the key; otherwise keep the error as-is
      // so callers can still branch on its status.
      if (scrubKey(err.message) === err.message) throw err;
      throw new ProviderError(PROVIDER, scrubKey(err.message).replace(`${PROVIDER}: `, ''), err.retryable);
    }
    throw new ProviderError(PROVIDER, message, true);
  }
}

/**
 * Replace the Bing site-total segment of `SearchConsoleDaily` for the window.
 *
 * `position` is the impression-weighted average of that day's query positions: Bing's
 * traffic endpoint reports no site-level position, and averaging the query rows we already
 * fetched is a real derivation rather than an invented number. Days without query data keep
 * position 0, which the analytics layer reads as "unknown", not "rank 0".
 */
async function writeDailyTotals(
  websiteId: string,
  range: { start: Date; end: Date },
  traffic: readonly BingTrafficStat[],
  queries: readonly BingQueryStat[],
): Promise<{ inserted: number; replaced: number }> {
  const positionByDay = new Map<string, { weighted: number; impressions: number }>();
  for (const row of queries) {
    if (row.impressions <= 0 || row.avgImpressionPosition <= 0) continue;
    const key = formatDateKey(row.date);
    const bucket = positionByDay.get(key) ?? { weighted: 0, impressions: 0 };
    bucket.weighted += row.avgImpressionPosition * row.impressions;
    bucket.impressions += row.impressions;
    positionByDay.set(key, bucket);
  }

  // The unique index is (websiteId, date, source, country, device) and `createManyChunked`
  // skips duplicates, so two rows for one day would silently lose a day's clicks. Fold first.
  const totalsByDay = new Map<string, { clicks: number; impressions: number }>();
  for (const row of traffic) {
    const key = formatDateKey(row.date);
    const bucket = totalsByDay.get(key) ?? { clicks: 0, impressions: 0 };
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    totalsByDay.set(key, bucket);
  }

  const rows: Prisma.SearchConsoleDailyCreateManyInput[] = [...totalsByDay.entries()].map(
    ([key, totals]) => {
      const bucket = positionByDay.get(key);
      return {
        websiteId,
        date: toUtcDate(key),
        source: BING_SOURCE,
        clicks: totals.clicks,
        impressions: totals.impressions,
        ctr: round(safeDivide(totals.clicks, totals.impressions, 0), 6),
        position: bucket ? round(safeDivide(bucket.weighted, bucket.impressions, 0), 2) : 0,
      };
    },
  );

  // Same reasoning as the GSC importer: the unique index contains nullable country/device and
  // Postgres treats NULLs as distinct, so skipDuplicates would not prevent a second site total.
  const { count: replaced } = await prisma.searchConsoleDaily.deleteMany({
    where: {
      websiteId,
      source: BING_SOURCE,
      country: null,
      device: null,
      date: { gte: range.start, lte: range.end },
    },
  });
  const inserted = rows.length ? await createManyChunked(prisma.searchConsoleDaily, rows, 500) : 0;
  return { inserted, replaced };
}

/** Replace the Bing slice of `GscQueryMetric` for the window (query rows + page rows). */
async function writeMetricRows(
  websiteId: string,
  range: { start: Date; end: Date },
  queries: readonly BingQueryStat[],
  pages: readonly BingPageStat[],
): Promise<{ inserted: number; replaced: number }> {
  // (websiteId, date, query, page, source) is unique and the insert skips duplicates, so a
  // repeated key would drop a row's clicks on the floor. Fold instead: sum the counts and
  // keep position impression-weighted, which is the only average that means anything here.
  interface Bucket {
    date: Date;
    query: string;
    page: string;
    clicks: number;
    impressions: number;
    weightedPosition: number;
    positionImpressions: number;
    fallbackPosition: number;
  }
  const buckets = new Map<string, Bucket>();

  const add = (date: Date, query: string, page: string, stat: {
    clicks: number;
    impressions: number;
    avgImpressionPosition: number;
  }): void => {
    const day = toUtcDate(date);
    const key = `${day.getTime()} ${query} ${page}`;
    const bucket = buckets.get(key) ?? {
      date: day,
      query,
      page,
      clicks: 0,
      impressions: 0,
      weightedPosition: 0,
      positionImpressions: 0,
      fallbackPosition: 0,
    };
    bucket.clicks += stat.clicks;
    bucket.impressions += stat.impressions;
    if (stat.avgImpressionPosition > 0) {
      if (stat.impressions > 0) {
        bucket.weightedPosition += stat.avgImpressionPosition * stat.impressions;
        bucket.positionImpressions += stat.impressions;
      } else if (bucket.fallbackPosition === 0) {
        bucket.fallbackPosition = stat.avgImpressionPosition;
      }
    }
    buckets.set(key, bucket);
  };

  for (const row of queries) add(row.date, row.query, BING_SITE_PAGE_KEY, row);
  for (const row of pages) add(row.date, BING_PAGE_ROW_QUERY, row.url, row);

  const rows: Prisma.GscQueryMetricCreateManyInput[] = [...buckets.values()].map((bucket) => ({
    websiteId,
    date: bucket.date,
    query: bucket.query,
    page: bucket.page,
    source: BING_SOURCE,
    clicks: bucket.clicks,
    impressions: bucket.impressions,
    ctr: round(safeDivide(bucket.clicks, bucket.impressions, 0), 6),
    position: bucket.positionImpressions
      ? round(bucket.weightedPosition / bucket.positionImpressions, 2)
      : bucket.fallbackPosition,
  }));

  const { count: replaced } = await prisma.gscQueryMetric.deleteMany({
    where: { websiteId, source: BING_SOURCE, date: { gte: range.start, lte: range.end } },
  });
  const inserted = rows.length ? await createManyChunked(prisma.gscQueryMetric, rows, 500) : 0;
  return { inserted, replaced };
}
