/**
 * DataForSEO Backlinks API client.
 *
 * Reuses the SERP module's DataForSEO transport (`dataForSeoRequest`) so auth, the envelope
 * status-code protocol, rate limiting and retries are implemented once. Credentials are the
 * same `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` pair from the shared env contract — an
 * install that already pays for DataForSEO SERP data gets backlinks with no extra key.
 *
 * Endpoints used:
 *   POST /v3/backlinks/backlinks/live         — individual links
 *   POST /v3/backlinks/referring_domains/live — aggregated per referring domain
 */

import { cleanDomain, createLogger } from '@seo/shared';
import {
  DATAFORSEO_REQUIRED_ENV,
  dataForSeoRequest,
  isDataForSeoConfigured,
} from '../../serp/providers/dataforseo';
import {
  readArray,
  readBoolean,
  readDate,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readRecord,
  readString,
} from '../../serp/http';
import type {
  BacklinkFetchOptions,
  BacklinkProvider,
  BacklinkRow,
  ReferringDomainRow,
} from '../types';

const log = createLogger('backlinks:dataforseo');

const PROVIDER = 'dataforseo';
/** DataForSEO's per-call ceiling for the backlinks endpoints. */
const PAGE_SIZE = 1000;
/** Default cap so one call on a huge domain cannot pull a million rows into memory. */
const DEFAULT_LIMIT = 5000;
/** Hard ceiling regardless of what the caller asks for. */
const MAX_LIMIT = 50_000;

export function isDataForSeoBacklinksConfigured(): boolean {
  return isDataForSeoConfigured();
}

/** DataForSEO filter timestamps are `YYYY-MM-DD HH:mm:ss +00:00`. */
function toFilterTimestamp(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} +00:00`;
}

/**
 * DataForSEO publishes rank on a 0-1000 scale; every other vendor (and our `Backlink`
 * model) uses 0-100, so divide rather than store two incompatible scales in one column.
 */
function toDomainAuthority(value: unknown): number | null {
  const rank = readOptionalNumber(value);
  if (rank === undefined) return null;
  return Math.round(Math.min(1000, Math.max(0, rank)) / 10);
}

function parseBacklink(raw: unknown): BacklinkRow | null {
  const item = readRecord(raw);
  if (!item) return null;
  const sourceUrl = readString(item.url_from);
  const targetUrl = readString(item.url_to);
  if (!sourceUrl || !targetUrl) return null;

  const isLost = readBoolean(item.is_lost, false);
  const lastSeen = readDate(item.last_seen) ?? readDate(item.prev_seen);
  const referringDomain = readString(item.domain_from) || cleanDomain(sourceUrl);

  return {
    referringDomain: cleanDomain(referringDomain),
    sourceUrl,
    targetUrl,
    anchorText: readOptionalString(item.anchor) ?? null,
    isFollow: readBoolean(item.dofollow, true),
    domainAuthority: toDomainAuthority(item.domain_from_rank),
    firstSeenAt: readDate(item.first_seen),
    lastSeenAt: lastSeen,
    lostAt: isLost ? lastSeen : null,
    provider: PROVIDER,
  };
}

function parseReferringDomain(raw: unknown): ReferringDomainRow | null {
  const item = readRecord(raw);
  if (!item) return null;
  const domain = readString(item.domain);
  if (!domain) return null;
  const dofollow = readOptionalNumber(item.referring_links_types_dofollow);
  return {
    domain: cleanDomain(domain),
    backlinks: readNumber(item.backlinks, 0),
    linkedPages: readOptionalNumber(item.referring_pages) ?? null,
    domainAuthority: toDomainAuthority(item.rank),
    firstSeenAt: readDate(item.first_seen),
    lastSeenAt: readDate(item.last_seen),
    // Absent breakdown ⇒ assume followed rather than silently marking every link nofollow.
    isFollow: dofollow === undefined ? true : dofollow > 0,
  };
}

interface LivePayload {
  target: string;
  limit: number;
  offset: number;
  backlinks_status_type: 'live' | 'all';
  mode?: string;
  filters?: unknown[];
  order_by?: string[];
  include_subdomains?: boolean;
}

/** Page a `*_live` endpoint until the caller's limit or the API's supply runs out. */
async function fetchPaged<T>(
  path: string,
  basePayload: Omit<LivePayload, 'limit' | 'offset'>,
  limit: number,
  parse: (raw: unknown) => T | null,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;

  // `offset < limit` bounds the walk by *source* rows, not just parsed ones: if a payload
  // change made every row unparsable, `out.length` would never grow and paging on
  // `out.length < limit` alone would keep requesting (and billing) pages until the vendor
  // ran out of links.
  while (out.length < limit && offset < limit) {
    const pageSize = Math.min(PAGE_SIZE, limit - out.length);
    const results = await dataForSeoRequest(
      path,
      [{ ...basePayload, limit: pageSize, offset }],
      { ...(signal ? { signal } : {}) },
    );
    const first = readRecord(results[0]);
    const items = first ? readArray(first.items) : [];

    for (const raw of items) {
      const parsed = parse(raw);
      if (parsed) out.push(parsed);
    }
    if (items.length === 0 || items.length < pageSize) break;
    offset += items.length;
  }

  if (out.length === 0 && offset > 0) {
    log.warn('dataforseo returned rows this client could not parse', { path, offset });
  }
  return out;
}

function resolveLimit(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function buildFilters(opts: BacklinkFetchOptions): unknown[] | undefined {
  const filters: unknown[] = [];
  if (opts.since) filters.push(['first_seen', '>', toFilterTimestamp(opts.since)]);
  if (opts.targetUrl) {
    if (filters.length) filters.push('and');
    filters.push(['url_to', '=', opts.targetUrl]);
  }
  return filters.length ? filters : undefined;
}

async function fetchBacklinks(domain: string, opts: BacklinkFetchOptions = {}): Promise<BacklinkRow[]> {
  const target = cleanDomain(domain);
  const filters = buildFilters(opts);
  const rows = await fetchPaged(
    '/backlinks/backlinks/live',
    {
      target,
      backlinks_status_type: opts.includeLost ? 'all' : 'live',
      // `as_is` returns every link; the alternatives collapse to one row per domain and would
      // silently hide sitewide-link patterns, which the suspicious-link heuristics depend on.
      mode: 'as_is',
      include_subdomains: true,
      order_by: ['domain_from_rank,desc'],
      ...(filters ? { filters } : {}),
    },
    resolveLimit(opts.limit),
    parseBacklink,
    opts.signal,
  );
  log.debug('fetched backlinks', { target, rows: rows.length });
  return rows;
}

async function fetchReferringDomains(
  domain: string,
  opts: BacklinkFetchOptions = {},
): Promise<ReferringDomainRow[]> {
  return fetchPaged(
    '/backlinks/referring_domains/live',
    {
      target: cleanDomain(domain),
      backlinks_status_type: opts.includeLost ? 'all' : 'live',
      include_subdomains: true,
      order_by: ['rank,desc'],
    },
    resolveLimit(opts.limit),
    parseReferringDomain,
    opts.signal,
  );
}

/**
 * Links pointing at competitors, for gap analysis. One request per competitor: DataForSEO's
 * backlinks endpoint takes a single `target`, and merging them client-side keeps each row's
 * `targetUrl` on the competitor so these can never be mistaken for our own links.
 */
async function fetchCompetitorBacklinks(
  domains: readonly string[],
  opts: BacklinkFetchOptions = {},
): Promise<BacklinkRow[]> {
  const perDomain = Math.max(1, Math.floor(resolveLimit(opts.limit) / Math.max(1, domains.length)));
  // `targetUrl` names a page on *our* site; carrying it into a competitor lookup would filter
  // their link graph by a URL they never link to and quietly return nothing.
  const { targetUrl: _ourPage, ...rest } = opts;
  const out: BacklinkRow[] = [];
  for (const domain of domains) {
    const rows = await fetchBacklinks(domain, { ...rest, limit: perDomain });
    out.push(...rows);
  }
  return out;
}

export const dataForSeoBacklinkProvider: BacklinkProvider = {
  name: PROVIDER,
  label: 'DataForSEO Backlinks',
  requiredEnv: DATAFORSEO_REQUIRED_ENV,
  isConfigured: isDataForSeoBacklinksConfigured,
  fetchBacklinks,
  fetchReferringDomains,
  fetchCompetitorBacklinks,
};
