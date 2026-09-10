/**
 * Moz Links API v2 client.
 *
 * Optional add-on keyed by this folder's `backlinkEnv` (see `../env`): Moz authenticates with
 * an Access ID / Secret Key pair over HTTP Basic. Without both, `isConfigured()` is false and
 * any call raises `IntegrationNotConfiguredError` — never a fabricated row.
 *
 * Endpoints used:
 *   POST /v2/links                 — individual links
 *   POST /v2/linking_root_domains  — aggregated per referring domain
 *
 * Moz pages with an opaque `next_token` rather than an offset, so paging follows the token
 * until it stops changing. Field names are read defensively (`source`/`source_url`,
 * `date_first_seen`/`first_seen`) because Moz has shipped both spellings.
 */

import { IntegrationNotConfiguredError, RateLimiter, cleanDomain } from '@seo/shared';
import {
  readArray,
  readBoolean,
  readDate,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readRecord,
  readString,
  requestJson,
} from '../../serp/http';
import { backlinkEnv } from '../env';
import type {
  BacklinkFetchOptions,
  BacklinkProvider,
  BacklinkRow,
  ReferringDomainRow,
} from '../types';

const PROVIDER = 'moz';
export const MOZ_BASE_URL = 'https://lsapi.seomoz.com/v2';
export const MOZ_REQUIRED_ENV: readonly string[] = ['MOZ_ACCESS_ID', 'MOZ_SECRET_KEY'];

/** Moz caps a single `/links` response at 50 rows. */
const PAGE_SIZE = 50;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 20_000;
/** Moz's default plan allows 10 requests every 10 seconds. */
const limiter = new RateLimiter(1100);
/**
 * Page ceiling for one token walk. Moz stops by returning no (or a repeated) `next_token`,
 * but a vendor bug — or rows this client cannot parse — would otherwise page indefinitely at
 * 50 rows and 1.1s a call; the slack over `limit / PAGE_SIZE` absorbs pages of unusable rows.
 */
function maxPagesFor(limit: number): number {
  return Math.ceil(limit / PAGE_SIZE) + 20;
}

export function isMozConfigured(): boolean {
  return Boolean(backlinkEnv.mozAccessId && backlinkEnv.mozSecretKey);
}

function authHeader(): string {
  const accessId = backlinkEnv.mozAccessId;
  const secretKey = backlinkEnv.mozSecretKey;
  if (!accessId || !secretKey) {
    throw new IntegrationNotConfiguredError(
      PROVIDER,
      'Moz is not configured. Set MOZ_ACCESS_ID and MOZ_SECRET_KEY to enable it, or use the CSV importer.',
    );
  }
  return `Basic ${Buffer.from(`${accessId}:${secretKey}`).toString('base64')}`;
}

async function mozPost(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const raw = await requestJson({
    provider: PROVIDER,
    url: `${MOZ_BASE_URL}${path}`,
    method: 'POST',
    headers: { authorization: authHeader() },
    body,
    rateLimiter: limiter,
    ...(signal ? { signal } : {}),
  });
  return readRecord(raw);
}

function resolveLimit(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/** Moz has used both a flat and a nested shape for the linking page; accept either. */
function readSourceUrl(item: Record<string, unknown>): string {
  const nested = readRecord(item.source);
  if (nested) return readString(nested.page) || readString(nested.url);
  return readString(item.source) || readString(item.source_url);
}

function readTargetUrl(item: Record<string, unknown>): string {
  const nested = readRecord(item.target);
  if (nested) return readString(nested.page) || readString(nested.url);
  return readString(item.target) || readString(item.target_url);
}

function readSourceAuthority(item: Record<string, unknown>): number | null {
  const nested = readRecord(item.source);
  const raw = nested
    ? (nested.domain_authority ?? nested.root_domain_authority)
    : (item.source_domain_authority ?? item.domain_authority);
  const value = readOptionalNumber(raw);
  // Moz DA is already 0-100, the scale `Backlink.domainAuthority` stores.
  return value === undefined ? null : Math.round(Math.min(100, Math.max(0, value)));
}

function parseLink(raw: unknown): BacklinkRow | null {
  const item = readRecord(raw);
  if (!item) return null;
  const sourceUrl = readSourceUrl(item);
  const targetUrl = readTargetUrl(item);
  if (!sourceUrl || !targetUrl) return null;

  const nofollow = readBoolean(item.nofollow, false);
  const rel = readString(item.rel_attributes ?? item.rel).toLowerCase();
  return {
    referringDomain: cleanDomain(sourceUrl),
    sourceUrl,
    targetUrl,
    anchorText: readOptionalString(item.anchor_text) ?? null,
    isFollow: !nofollow && !/\b(nofollow|ugc|sponsored)\b/.test(rel),
    domainAuthority: readSourceAuthority(item),
    firstSeenAt: readDate(item.date_first_seen ?? item.first_seen),
    lastSeenAt: readDate(item.date_last_seen ?? item.last_seen),
    // `/v2/links` returns live links only; Moz has no "lost" flag on this endpoint.
    lostAt: null,
    provider: PROVIDER,
  };
}

function parseRootDomain(raw: unknown): ReferringDomainRow | null {
  const item = readRecord(raw);
  if (!item) return null;
  const domain = readString(item.root_domain) || readString(item.domain);
  if (!domain) return null;
  const authority = readOptionalNumber(item.domain_authority);
  return {
    domain: cleanDomain(domain),
    backlinks: readNumber(item.links_to_target ?? item.backlinks, 0),
    linkedPages: readOptionalNumber(item.pages_to_target) ?? null,
    domainAuthority: authority === undefined ? null : Math.round(authority),
    firstSeenAt: readDate(item.date_first_seen ?? item.first_seen),
    lastSeenAt: readDate(item.date_last_seen ?? item.last_seen),
    isFollow: true,
  };
}

async function fetchBacklinks(domain: string, opts: BacklinkFetchOptions = {}): Promise<BacklinkRow[]> {
  const limit = resolveLimit(opts.limit);
  const maxPages = maxPagesFor(limit);
  const out: BacklinkRow[] = [];
  let nextToken: string | undefined;

  for (let page = 0; out.length < limit && page < maxPages; page += 1) {
    const payload = await mozPost(
      '/links',
      {
        target: opts.targetUrl ?? cleanDomain(domain),
        target_scope: opts.targetUrl ? 'page' : 'root_domain',
        // Moz's own scope for "links from other sites", i.e. what a backlink report means.
        scope: 'external',
        sort: 'source_domain_authority',
        limit: Math.min(PAGE_SIZE, limit - out.length),
        ...(nextToken ? { next_token: nextToken } : {}),
      },
      opts.signal,
    );
    const items = payload ? readArray(payload.results) : [];
    for (const raw of items) {
      const parsed = parseLink(raw);
      if (parsed) out.push(parsed);
    }

    const token = payload ? readOptionalString(payload.next_token) : undefined;
    // No token, an unchanged token, or an empty page all mean Moz has nothing more to give.
    if (!token || token === nextToken || items.length === 0) break;
    nextToken = token;
  }

  // `since` has no server-side filter on this endpoint, so apply it here rather than lie
  // about having asked Moz for it.
  const since = opts.since;
  return since ? out.filter((row) => !row.firstSeenAt || row.firstSeenAt >= since) : out;
}

async function fetchReferringDomains(
  domain: string,
  opts: BacklinkFetchOptions = {},
): Promise<ReferringDomainRow[]> {
  const limit = resolveLimit(opts.limit);
  const maxPages = maxPagesFor(limit);
  const out: ReferringDomainRow[] = [];
  let nextToken: string | undefined;

  for (let page = 0; out.length < limit && page < maxPages; page += 1) {
    const payload = await mozPost(
      '/linking_root_domains',
      {
        target: cleanDomain(domain),
        target_scope: 'root_domain',
        sort: 'domain_authority',
        limit: Math.min(PAGE_SIZE, limit - out.length),
        ...(nextToken ? { next_token: nextToken } : {}),
      },
      opts.signal,
    );
    const items = payload ? readArray(payload.results) : [];
    for (const raw of items) {
      const parsed = parseRootDomain(raw);
      if (parsed) out.push(parsed);
    }

    const token = payload ? readOptionalString(payload.next_token) : undefined;
    if (!token || token === nextToken || items.length === 0) break;
    nextToken = token;
  }

  return out;
}

/**
 * Moz exposes no dedicated competitor endpoint — a "gap" is just the same `/links` report run
 * against each competitor, so this is a loop rather than a bulk call.
 */
async function fetchCompetitorBacklinks(
  domains: readonly string[],
  opts: BacklinkFetchOptions = {},
): Promise<BacklinkRow[]> {
  const perDomain = Math.max(1, Math.floor(resolveLimit(opts.limit) / Math.max(1, domains.length)));
  // `targetUrl` is a page on our own site; scoping a competitor's link report to it would
  // return an empty list rather than their backlinks.
  const { targetUrl: _ourPage, ...rest } = opts;
  const out: BacklinkRow[] = [];
  for (const domain of domains) {
    out.push(...(await fetchBacklinks(domain, { ...rest, limit: perDomain })));
  }
  return out;
}

export const mozBacklinkProvider: BacklinkProvider = {
  name: PROVIDER,
  label: 'Moz',
  requiredEnv: MOZ_REQUIRED_ENV,
  isConfigured: isMozConfigured,
  fetchBacklinks,
  fetchReferringDomains,
  fetchCompetitorBacklinks,
};
