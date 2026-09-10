/**
 * Semrush Analytics API v1 backlink client.
 *
 * Optional add-on keyed by this folder's `backlinkEnv` (see `../env`); without
 * `SEMRUSH_API_KEY` it reports `isConfigured() === false` and any call raises
 * `IntegrationNotConfiguredError`.
 *
 * Semrush's analytics API is the odd one out: it answers with `;`-separated text, not JSON,
 * so this client cannot use `requestJson` and instead fetches text and hands it to the CSV
 * parser in `../csv` with a `;` delimiter. That is exactly the case the configurable
 * delimiter exists for. The transport still goes through the shared `retry` helper so the
 * retry policy matches every other provider.
 *
 * Reports used:
 *   type=backlinks         — individual links
 *   type=backlinks_refdomains — aggregated per referring domain
 */

import {
  IntegrationNotConfiguredError,
  ProviderError,
  RateLimiter,
  cleanDomain,
  retry,
} from '@seo/shared';
import { buildQuery, readDate } from '../../serp/http';
import { parseCsvTable } from '../csv';
import { backlinkEnv } from '../env';
import type {
  BacklinkFetchOptions,
  BacklinkProvider,
  BacklinkRow,
  ReferringDomainRow,
} from '../types';

const PROVIDER = 'semrush';
export const SEMRUSH_BASE_URL = 'https://api.semrush.com/analytics/v1/';
export const SEMRUSH_REQUIRED_ENV: readonly string[] = ['SEMRUSH_API_KEY'];

/** Semrush caps one analytics response at 10 000 rows. */
const PAGE_SIZE = 10_000;
const DEFAULT_LIMIT = 5000;
const MAX_LIMIT = 50_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** Semrush allows 10 req/s per key; 200ms keeps a parallel worker pool inside that. */
const limiter = new RateLimiter(200);

const BACKLINK_COLUMNS = [
  'source_url',
  'target_url',
  'anchor',
  'first_seen',
  'last_seen',
  'nofollow',
  'sponsored',
  'ugc',
  'page_ascore',
].join(',');

const REFDOMAIN_COLUMNS = ['domain', 'domain_ascore', 'backlinks_num', 'first_seen', 'last_seen'].join(',');

export function isSemrushConfigured(): boolean {
  return Boolean(backlinkEnv.semrushApiKey);
}

function requireApiKey(): string {
  const key = backlinkEnv.semrushApiKey;
  if (!key) {
    throw new IntegrationNotConfiguredError(
      PROVIDER,
      'Semrush is not configured. Set SEMRUSH_API_KEY to enable it, or use the CSV importer.',
    );
  }
  return key;
}

/**
 * Fetch one Semrush report as text.
 *
 * Semrush signals failure with HTTP 200 and a body starting `ERROR nnn :: message`, so the
 * status code alone is not a health check. `ERROR 50` ("nothing found") is an empty result,
 * not a fault, and is returned as an empty string.
 */
async function semrushGet(
  params: Record<string, string | number | undefined>,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${SEMRUSH_BASE_URL}${buildQuery({ ...params, key: requireApiKey() })}`;

  const body = await retry(
    () =>
      limiter.schedule(async () => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const response = await fetch(url, {
            headers: { accept: 'text/plain' },
            signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            throw new ProviderError(
              PROVIDER,
              `HTTP ${response.status} — ${text.slice(0, 300)}`,
              response.status === 429 || response.status >= 500,
            );
          }
          return text;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
        }
      }),
    {
      attempts: 3,
      baseDelayMs: 1000,
      shouldRetry: (err) => !(err instanceof ProviderError) || err.retryable,
    },
  );

  const trimmed = body.trim();
  if (trimmed.startsWith('ERROR')) {
    // "ERROR 50 :: NOTHING FOUND" simply means the domain has no rows in this report.
    if (/^ERROR\s+50\b/i.test(trimmed)) return '';
    throw new ProviderError(PROVIDER, trimmed.slice(0, 300), /^ERROR\s+(120|130|131|134)\b/i.test(trimmed));
  }
  return body;
}

function resolveLimit(requested: number | undefined): number {
  return Math.min(Math.max(requested ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

/** Semrush date filters use `YYYYMMDD`. */
function toDateParam(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function columnIndexes(headers: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  headers.forEach((header, index) => map.set(header.trim().toLowerCase(), index));
  return map;
}

function value(row: readonly string[], indexes: Map<string, number>, column: string): string {
  const index = indexes.get(column);
  return index === undefined ? '' : (row[index] ?? '').trim();
}

/** Semrush reports each rel attribute in its own column; any of them removes link equity. */
function isFollowed(row: readonly string[], indexes: Map<string, number>): boolean {
  const flagged = ['nofollow', 'sponsored', 'ugc'].some((column) => {
    const raw = value(row, indexes, column).toLowerCase();
    return raw === 'true' || raw === '1';
  });
  return !flagged;
}

function toAuthority(raw: string): number | null {
  if (raw === '') return null;
  const n = Number(raw);
  // Authority Score is already a 0-100 scale.
  return Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : null;
}

async function fetchBacklinks(domain: string, opts: BacklinkFetchOptions = {}): Promise<BacklinkRow[]> {
  const limit = resolveLimit(opts.limit);
  const out: BacklinkRow[] = [];
  let offset = 0;

  // `offset < limit` bounds the walk by source rows: a column rename would make every row
  // unparsable, and paging on `out.length` alone would then burn API units page after page.
  while (out.length < limit && offset < limit) {
    const pageSize = Math.min(PAGE_SIZE, limit - out.length);
    const text = await semrushGet(
      {
        type: 'backlinks',
        target: opts.targetUrl ?? cleanDomain(domain),
        target_type: opts.targetUrl ? 'url' : 'root_domain',
        export_columns: BACKLINK_COLUMNS,
        display_limit: pageSize,
        display_offset: offset,
        display_sort: 'last_seen_desc',
        ...(opts.since ? { display_date: toDateParam(opts.since) } : {}),
      },
      opts.signal,
    );
    if (text.trim() === '') break;

    const { headers, rows } = parseCsvTable(text, { delimiter: ';' });
    const indexes = columnIndexes(headers);
    for (const row of rows) {
      const sourceUrl = value(row, indexes, 'source_url');
      const targetUrl = value(row, indexes, 'target_url');
      if (!sourceUrl || !targetUrl) continue;
      const lastSeenAt = readDate(value(row, indexes, 'last_seen'));
      out.push({
        referringDomain: cleanDomain(sourceUrl),
        sourceUrl,
        targetUrl,
        anchorText: value(row, indexes, 'anchor') || null,
        isFollow: isFollowed(row, indexes),
        domainAuthority: toAuthority(value(row, indexes, 'page_ascore')),
        firstSeenAt: readDate(value(row, indexes, 'first_seen')),
        lastSeenAt,
        // The `backlinks` report only returns live links, so nothing here is lost.
        lostAt: null,
        provider: PROVIDER,
      });
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
  const text = await semrushGet(
    {
      type: 'backlinks_refdomains',
      target: cleanDomain(domain),
      target_type: 'root_domain',
      export_columns: REFDOMAIN_COLUMNS,
      display_limit: Math.min(PAGE_SIZE, resolveLimit(opts.limit)),
      display_sort: 'domain_ascore_desc',
    },
    opts.signal,
  );
  if (text.trim() === '') return [];

  const { headers, rows } = parseCsvTable(text, { delimiter: ';' });
  const indexes = columnIndexes(headers);
  const out: ReferringDomainRow[] = [];
  for (const row of rows) {
    const name = value(row, indexes, 'domain');
    if (!name) continue;
    const backlinks = Number(value(row, indexes, 'backlinks_num'));
    out.push({
      domain: cleanDomain(name),
      backlinks: Number.isFinite(backlinks) ? backlinks : 0,
      linkedPages: null,
      domainAuthority: toAuthority(value(row, indexes, 'domain_ascore')),
      firstSeenAt: readDate(value(row, indexes, 'first_seen')),
      lastSeenAt: readDate(value(row, indexes, 'last_seen')),
      isFollow: true,
    });
  }
  return out;
}

async function fetchCompetitorBacklinks(
  domains: readonly string[],
  opts: BacklinkFetchOptions = {},
): Promise<BacklinkRow[]> {
  const perDomain = Math.max(1, Math.floor(resolveLimit(opts.limit) / Math.max(1, domains.length)));
  // `targetUrl` points at one of our own pages; a competitor report filtered by it returns
  // nothing, so it is dropped rather than silently producing an empty gap analysis.
  const { targetUrl: _ourPage, ...rest } = opts;
  const out: BacklinkRow[] = [];
  for (const domain of domains) {
    out.push(...(await fetchBacklinks(domain, { ...rest, limit: perDomain })));
  }
  return out;
}

export const semrushBacklinkProvider: BacklinkProvider = {
  name: PROVIDER,
  label: 'Semrush',
  requiredEnv: SEMRUSH_REQUIRED_ENV,
  isConfigured: isSemrushConfigured,
  fetchBacklinks,
  fetchReferringDomains,
  fetchCompetitorBacklinks,
};
