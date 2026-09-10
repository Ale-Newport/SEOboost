/**
 * Ahrefs API v3 (Site Explorer) backlink client.
 *
 * Optional add-on: the key lives in this folder's own `backlinkEnv`, not the shared env
 * contract. Without `AHREFS_API_KEY` this provider reports `isConfigured() === false` and the
 * registry never selects it; calling it anyway raises `IntegrationNotConfiguredError` rather
 * than returning invented rows.
 *
 * Endpoints used:
 *   GET /v3/site-explorer/all-backlinks — individual links
 *   GET /v3/site-explorer/refdomains    — aggregated per referring domain
 */

import { IntegrationNotConfiguredError, RateLimiter, cleanDomain } from '@seo/shared';
import {
  buildQuery,
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

const PROVIDER = 'ahrefs';
export const AHREFS_BASE_URL = 'https://api.ahrefs.com/v3';
export const AHREFS_REQUIRED_ENV: readonly string[] = ['AHREFS_API_KEY'];

/** Ahrefs' list endpoints cap one response at 1 000 rows. */
const PAGE_SIZE = 1000;
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50_000;
/** Ahrefs bills per row and throttles per minute; one request every 1.2s stays inside the free tier. */
const limiter = new RateLimiter(1200);

/** Columns requested from `all-backlinks`; asking for fewer columns costs fewer Ahrefs units. */
const BACKLINK_COLUMNS = [
  'url_from',
  'url_to',
  'anchor',
  'domain_rating_source',
  'first_seen',
  'last_seen',
  'is_dofollow',
  'is_lost',
  'link_type',
].join(',');

const REFDOMAIN_COLUMNS = ['domain', 'domain_rating', 'links_to_target', 'first_seen', 'last_seen'].join(',');

export function isAhrefsConfigured(): boolean {
  return Boolean(backlinkEnv.ahrefsApiKey);
}

function requireApiKey(): string {
  const key = backlinkEnv.ahrefsApiKey;
  if (!key) {
    throw new IntegrationNotConfiguredError(
      PROVIDER,
      'Ahrefs is not configured. Set AHREFS_API_KEY to enable it, or use the CSV importer.',
    );
  }
  return key;
}

async function ahrefsGet(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<unknown> {
  return requestJson({
    provider: PROVIDER,
    url: `${AHREFS_BASE_URL}${path}${buildQuery(params)}`,
    method: 'GET',
    headers: { authorization: `Bearer ${requireApiKey()}` },
    rateLimiter: limiter,
    ...(signal ? { signal } : {}),
  });
}

function resolveLimit(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/** Ahrefs date filters are plain `YYYY-MM-DD`. */
function toDateParam(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseBacklink(raw: unknown): BacklinkRow | null {
  const item = readRecord(raw);
  if (!item) return null;
  const sourceUrl = readString(item.url_from);
  const targetUrl = readString(item.url_to);
  if (!sourceUrl || !targetUrl) return null;

  const lastSeen = readDate(item.last_seen);
  const isLost = readBoolean(item.is_lost, false);
  const rating = readOptionalNumber(item.domain_rating_source);

  return {
    referringDomain: cleanDomain(sourceUrl),
    sourceUrl,
    targetUrl,
    anchorText: readOptionalString(item.anchor) ?? null,
    isFollow: readBoolean(item.is_dofollow, true),
    // Ahrefs DR is already 0-100, the scale `Backlink.domainAuthority` stores.
    domainAuthority: rating === undefined ? null : Math.round(rating),
    firstSeenAt: readDate(item.first_seen),
    lastSeenAt: lastSeen,
    lostAt: isLost ? lastSeen : null,
    provider: PROVIDER,
  };
}

function parseRefdomain(raw: unknown): ReferringDomainRow | null {
  const item = readRecord(raw);
  if (!item) return null;
  const domain = readString(item.domain);
  if (!domain) return null;
  const rating = readOptionalNumber(item.domain_rating);
  return {
    domain: cleanDomain(domain),
    backlinks: readNumber(item.links_to_target, 0),
    linkedPages: null,
    domainAuthority: rating === undefined ? null : Math.round(rating),
    firstSeenAt: readDate(item.first_seen),
    lastSeenAt: readDate(item.last_seen),
    isFollow: true,
  };
}

/** Ahrefs returns its rows under a per-endpoint key; accept either that key or a bare array. */
function rowsFrom(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = readRecord(payload);
  return record ? readArray(record[key]) : [];
}

async function fetchBacklinks(domain: string, opts: BacklinkFetchOptions = {}): Promise<BacklinkRow[]> {
  const limit = resolveLimit(opts.limit);
  const out: BacklinkRow[] = [];
  let offset = 0;

  // `offset < limit` bounds the walk by source rows: if a schema change made every row
  // unparsable, paging on `out.length` alone would keep requesting (and billing for) pages
  // until Ahrefs ran out of links.
  while (out.length < limit && offset < limit) {
    const pageSize = Math.min(PAGE_SIZE, limit - out.length);
    const payload = await ahrefsGet(
      '/site-explorer/all-backlinks',
      {
        target: opts.targetUrl ?? cleanDomain(domain),
        mode: opts.targetUrl ? 'exact' : 'domain',
        select: BACKLINK_COLUMNS,
        limit: pageSize,
        offset,
        order_by: 'domain_rating_source:desc',
        // Ahrefs defaults to live links; `history=all` is the only way to see lost ones.
        ...(opts.includeLost ? { history: 'all' } : {}),
        ...(opts.since ? { date_from: toDateParam(opts.since) } : {}),
      },
      opts.signal,
    );

    const rows = rowsFrom(payload, 'backlinks');
    for (const raw of rows) {
      const parsed = parseBacklink(raw);
      if (parsed) out.push(parsed);
    }
    if (rows.length === 0 || rows.length < pageSize) break;
    offset += rows.length;
  }

  return out;
}

async function fetchReferringDomains(
  domain: string,
  opts: BacklinkFetchOptions = {},
): Promise<ReferringDomainRow[]> {
  const limit = resolveLimit(opts.limit);
  const payload = await ahrefsGet(
    '/site-explorer/refdomains',
    {
      target: cleanDomain(domain),
      mode: 'domain',
      select: REFDOMAIN_COLUMNS,
      limit: Math.min(PAGE_SIZE, limit),
      order_by: 'domain_rating:desc',
    },
    opts.signal,
  );
  return rowsFrom(payload, 'refdomains').flatMap((raw) => {
    const parsed = parseRefdomain(raw);
    return parsed ? [parsed] : [];
  });
}

async function fetchCompetitorBacklinks(
  domains: readonly string[],
  opts: BacklinkFetchOptions = {},
): Promise<BacklinkRow[]> {
  const perDomain = Math.max(1, Math.floor(resolveLimit(opts.limit) / Math.max(1, domains.length)));
  // `targetUrl` is one of *our* pages; passing it on would ask Ahrefs for links from the
  // competitor to a URL on our site, which is not what a gap analysis wants.
  const { targetUrl: _ourPage, ...rest } = opts;
  const out: BacklinkRow[] = [];
  for (const domain of domains) {
    out.push(...(await fetchBacklinks(domain, { ...rest, limit: perDomain })));
  }
  return out;
}

export const ahrefsBacklinkProvider: BacklinkProvider = {
  name: PROVIDER,
  label: 'Ahrefs',
  requiredEnv: AHREFS_REQUIRED_ENV,
  isConfigured: isAhrefsConfigured,
  fetchBacklinks,
  fetchReferringDomains,
  fetchCompetitorBacklinks,
};
