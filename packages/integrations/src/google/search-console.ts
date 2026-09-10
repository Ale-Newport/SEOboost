/**
 * Google Search Console API v3 (served by the `searchconsole` v1 discovery doc).
 *
 * What lands in the database:
 *   dimension `date`            → SearchConsoleDaily site totals      (country/device NULL)
 *   dimension `date+query+page` → GscQueryMetric rows                 (the keyword corpus)
 *   dimension `date+country`    → SearchConsoleDaily country segments (device NULL)
 *   dimension `date+device`     → SearchConsoleDaily device segments  (country NULL)
 *
 * Search Console finalises data ~2-3 days late, so the default window ends three days ago;
 * asking for fresher days returns partial numbers that change under us.
 */

import { google } from 'googleapis';
import type { searchconsole_v1 } from 'googleapis';
import { prisma, Prisma, IntegrationProvider, IntegrationStatus, createManyChunked } from '@seo/db';
import { KeywordSource } from '@seo/db';
import {
  createLogger,
  chunk,
  mapWithConcurrency,
  retry,
  round,
  RateLimiter,
  normalizeUrl,
  normalizeKeyword,
  cleanDomain,
  toUtcDate,
  formatDateKey,
  eachDay,
  addDays,
  lastNDays,
  daysBetween,
  errorMessage,
  IntegrationNotConfiguredError,
  ProviderError,
  NotFoundError,
} from '@seo/shared';
import {
  getAuthorizedClient,
  findGoogleIntegration,
  patchGoogleConfig,
  markIntegrationStatus,
  recordSyncOutcome,
  classifyGoogleFailure,
  isRetryableGoogleError,
  googleErrorMessage,
} from './oauth';
import type { AuthorizedGoogleClient } from './oauth';
import { emptySyncResult, integrationFail, integrationOk, mergeSyncResults } from '../types';
import type { IntegrationResult, SyncResult } from '../types';

const log = createLogger('integrations:gsc');

/** Search Console finalises data 2-3 days late. */
export const GSC_DATA_LAG_DAYS = 3;
export const GSC_DEFAULT_WINDOW_DAYS = 28;
/** Search Console keeps 16 months of history; anything older simply returns no rows. */
export const GSC_MAX_BACKFILL_DAYS = 480;

const GSC_ROW_LIMIT = 25_000;
/** Stop paging a single query here so one pathological site cannot run forever. */
const MAX_ROWS_PER_QUERY = 400_000;
/** Search Console allows 1200 queries/minute; stay well under it. */
const REQUEST_INTERVAL_MS = 150;
const DAY_CONCURRENCY = 3;
/** Cap the distinct values pulled into memory by the linker. */
const MAX_DISTINCT_LINK_KEYS = 200_000;
const SOURCE = 'gsc';

export type GscDimensionSet = 'date' | 'query-page' | 'country' | 'device';

export const DEFAULT_GSC_DIMENSION_SETS: readonly GscDimensionSet[] = [
  'date',
  'query-page',
  'country',
  'device',
];

export interface GscProperty {
  siteUrl: string;
  permissionLevel: string;
  /** Domain properties (`sc-domain:example.com`) cover every subdomain and protocol. */
  isDomainProperty: boolean;
  /** Unverified users can see the property but not its data. */
  isVerified: boolean;
}

type SearchConsoleApi = searchconsole_v1.Searchconsole;

function apiFor(auth: AuthorizedGoogleClient): SearchConsoleApi {
  return google.searchconsole({ version: 'v1', auth: auth.client });
}

// ── Properties ───────────────────────────────────────────────

/** Sites the connected account can read, most useful (owner/full user) first. */
export async function listProperties(integrationId: string): Promise<GscProperty[]> {
  const auth = await getAuthorizedClient(integrationId);
  const api = apiFor(auth);
  try {
    const res = await retry(() => api.sites.list(), {
      attempts: 3,
      shouldRetry: isRetryableGoogleError,
    });
    const entries = res.data.siteEntry ?? [];
    return entries
      .filter((entry): entry is searchconsole_v1.Schema$WmxSite & { siteUrl: string } =>
        typeof entry.siteUrl === 'string',
      )
      .map((entry) => ({
        siteUrl: entry.siteUrl,
        permissionLevel: entry.permissionLevel ?? 'siteUnverifiedUser',
        isDomainProperty: entry.siteUrl.startsWith('sc-domain:'),
        isVerified: entry.permissionLevel !== 'siteUnverifiedUser',
      }))
      .sort((a, b) => Number(b.isVerified) - Number(a.isVerified));
  } catch (err) {
    const failure = await classifyGoogleFailure(integrationId, err, 'listing Search Console properties');
    throw new ProviderError('search-console', failure.error, failure.retryable);
  }
}

/**
 * Which property to query for a website. Uses the operator's explicit choice when present,
 * otherwise matches the website domain against the account's verified properties and
 * remembers the match so the guess only happens once.
 */
async function resolveSiteUrl(
  integrationId: string,
  configuredSiteUrl: string | undefined,
  domain: string,
): Promise<string | null> {
  if (configuredSiteUrl) return configuredSiteUrl;

  const properties = await listProperties(integrationId);
  const bare = cleanDomain(domain);
  const match =
    properties.find((p) => p.isVerified && p.siteUrl === `sc-domain:${bare}`) ??
    properties.find((p) => {
      if (!p.isVerified || p.isDomainProperty) return false;
      const host = normalizeUrl(p.siteUrl);
      return host !== null && cleanDomain(host) === bare;
    });
  if (!match) return null;

  await patchGoogleConfig(integrationId, {
    siteUrl: match.siteUrl,
    permissionLevel: match.permissionLevel,
  });
  log.info('resolved Search Console property from domain', { integrationId, siteUrl: match.siteUrl });
  return match.siteUrl;
}

// ── Query plumbing ───────────────────────────────────────────

interface QuerySpec {
  dimensions: string[];
  startDate: string;
  endDate: string;
}

/**
 * Run one searchAnalytics.query and follow `startRow` until the API stops returning a full
 * page. The API caps a response at 25 000 rows, so paging is the only way to see a whole
 * day of query×page data.
 */
async function fetchAllRows(
  api: SearchConsoleApi,
  siteUrl: string,
  spec: QuerySpec,
  limiter: RateLimiter,
  warnings: string[],
): Promise<searchconsole_v1.Schema$ApiDataRow[]> {
  const rows: searchconsole_v1.Schema$ApiDataRow[] = [];
  let startRow = 0;

  for (;;) {
    const res = await limiter.schedule(() =>
      retry(
        () =>
          api.searchanalytics.query({
            siteUrl,
            requestBody: {
              startDate: spec.startDate,
              endDate: spec.endDate,
              dimensions: spec.dimensions,
              rowLimit: GSC_ROW_LIMIT,
              startRow,
              type: 'web',
              // 'final' excludes the still-moving fresh data; we already respect the lag.
              dataState: 'final',
            },
          }),
        { attempts: 4, baseDelayMs: 1000, shouldRetry: isRetryableGoogleError },
      ),
    );

    const page = res.data.rows ?? [];
    rows.push(...page);
    if (page.length < GSC_ROW_LIMIT) break;

    startRow += GSC_ROW_LIMIT;
    if (rows.length >= MAX_ROWS_PER_QUERY) {
      warnings.push(
        `Truncated ${spec.dimensions.join('+')} data for ${spec.startDate}..${spec.endDate} at ${MAX_ROWS_PER_QUERY} rows`,
      );
      break;
    }
  }
  return rows;
}

interface ParsedRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

function parseRow(row: searchconsole_v1.Schema$ApiDataRow): ParsedRow | null {
  const keys = row.keys ?? [];
  if (keys.length === 0) return null;
  return {
    keys,
    clicks: Math.round(row.clicks ?? 0),
    impressions: Math.round(row.impressions ?? 0),
    ctr: round(row.ctr ?? 0, 6),
    position: round(row.position ?? 0, 2),
  };
}

// ── Persistence ──────────────────────────────────────────────

type DailySegment = 'total' | 'country' | 'device';

/**
 * Replace a segment of SearchConsoleDaily for a date range.
 *
 * The unique index includes nullable `country`/`device`, and Postgres treats NULLs as
 * distinct — so `createMany({ skipDuplicates: true })` would happily insert a second site
 * total for the same day. Deleting the segment first is what actually makes re-syncing
 * idempotent.
 */
async function replaceDailyRows(
  websiteId: string,
  segment: DailySegment,
  range: { start: Date; end: Date },
  rows: Prisma.SearchConsoleDailyCreateManyInput[],
): Promise<{ inserted: number; replaced: number }> {
  const segmentFilter: Prisma.SearchConsoleDailyWhereInput =
    segment === 'total'
      ? { country: null, device: null }
      : segment === 'country'
        ? { country: { not: null }, device: null }
        : { device: { not: null }, country: null };

  const { count: replaced } = await prisma.searchConsoleDaily.deleteMany({
    where: {
      websiteId,
      source: SOURCE,
      date: { gte: toUtcDate(range.start), lte: toUtcDate(range.end) },
      ...segmentFilter,
    },
  });
  const inserted = rows.length ? await createManyChunked(prisma.searchConsoleDaily, rows, 500) : 0;
  return { inserted, replaced };
}

async function writeQueryMetrics(
  websiteId: string,
  day: Date,
  rows: Prisma.GscQueryMetricCreateManyInput[],
  mode: SyncMode,
): Promise<{ inserted: number; replaced: number }> {
  let replaced = 0;
  if (mode === 'replace') {
    // Recent days get revised by Google; a backfill of settled months does not need this.
    const del = await prisma.gscQueryMetric.deleteMany({
      where: { websiteId, source: SOURCE, date: toUtcDate(day) },
    });
    replaced = del.count;
  }
  const inserted = rows.length ? await createManyChunked(prisma.gscQueryMetric, rows, 500) : 0;
  return { inserted, replaced };
}

// ── Sync ─────────────────────────────────────────────────────

export type SyncMode = 'replace' | 'append';

export interface SyncSearchConsoleInput {
  websiteId: string;
  /** Defaults to the last 28 complete days ending GSC_DATA_LAG_DAYS ago. */
  from?: Date | string;
  to?: Date | string;
  dimensions?: readonly GscDimensionSet[];
  /**
   * `replace` (default) re-imports the window so revised numbers land; `append` only adds
   * missing rows, which is what a months-long backfill wants.
   */
  mode?: SyncMode;
  /** Resolve page/keyword foreign keys after importing. Default true. */
  link?: boolean;
}

/**
 * Pull Search Console performance data for a website into the warehouse tables.
 *
 * Never throws for a site that simply is not connected or whose account lost access: those
 * come back as a skipped SyncResult so a nightly fan-out over every website keeps going.
 * Transient provider failures do throw, so the queue retries them.
 */
export async function syncSearchConsole(input: SyncSearchConsoleInput): Promise<SyncResult> {
  const { websiteId, mode = 'replace', link = true } = input;
  const range = resolveRange(input.from, input.to);
  const from = formatDateKey(range.start);
  const to = formatDateKey(range.end);
  const dimensionSets = input.dimensions ?? DEFAULT_GSC_DIMENSION_SETS;

  if (daysBetween(range.start, range.end) < 0) {
    throw new ProviderError('search-console', `invalid date range ${from}..${to}`, false);
  }

  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, domain: true },
  });
  if (!website) throw new NotFoundError('Website');

  const integration = await findGoogleIntegration(websiteId, IntegrationProvider.GOOGLE_SEARCH_CONSOLE);
  if (!integration || integration.status === IntegrationStatus.DISABLED) {
    return emptySyncResult(from, to, 'NOT_CONNECTED', 'Search Console is not connected for this website');
  }

  const warnings: string[] = [];
  let rowsImported = 0;
  let rowsUpdated = 0;

  try {
    const auth = await getAuthorizedClient(integration.id);
    const siteUrl = await resolveSiteUrl(integration.id, auth.config.siteUrl, website.domain);
    if (!siteUrl) {
      const message =
        'No verified Search Console property matches this domain. Pick one in the integration settings.';
      await markIntegrationStatus(integration.id, IntegrationStatus.ERROR, message);
      return emptySyncResult(from, to, 'NOT_CONFIGURED', message);
    }

    const api = apiFor(auth);
    const limiter = new RateLimiter(REQUEST_INTERVAL_MS);

    if (dimensionSets.includes('date')) {
      const rows = await fetchAllRows(
        api,
        siteUrl,
        { dimensions: ['date'], startDate: from, endDate: to },
        limiter,
        warnings,
      );
      const daily: Prisma.SearchConsoleDailyCreateManyInput[] = [];
      for (const raw of rows) {
        const parsed = parseRow(raw);
        const dateKey = parsed?.keys[0];
        if (!parsed || !dateKey) continue;
        daily.push({
          websiteId,
          date: toUtcDate(dateKey),
          source: SOURCE,
          clicks: parsed.clicks,
          impressions: parsed.impressions,
          ctr: parsed.ctr,
          position: parsed.position,
        });
      }
      const res = await replaceDailyRows(websiteId, 'total', range, daily);
      rowsImported += res.inserted;
      rowsUpdated += res.replaced;
    }

    for (const segment of ['country', 'device'] as const) {
      if (!dimensionSets.includes(segment)) continue;
      const rows = await fetchAllRows(
        api,
        siteUrl,
        { dimensions: ['date', segment], startDate: from, endDate: to },
        limiter,
        warnings,
      );
      const daily: Prisma.SearchConsoleDailyCreateManyInput[] = [];
      for (const raw of rows) {
        const parsed = parseRow(raw);
        const dateKey = parsed?.keys[0];
        const value = parsed?.keys[1];
        if (!parsed || !dateKey || !value) continue;
        daily.push({
          websiteId,
          date: toUtcDate(dateKey),
          source: SOURCE,
          clicks: parsed.clicks,
          impressions: parsed.impressions,
          ctr: parsed.ctr,
          position: parsed.position,
          // Uppercased so segments line up with Website.targetCountry ("USA") and read
          // consistently in the UI; Google returns 'usa' / 'desktop'.
          ...(segment === 'country' ? { country: value.toUpperCase() } : { device: value.toUpperCase() }),
        });
      }
      const res = await replaceDailyRows(websiteId, segment, range, daily);
      rowsImported += res.inserted;
      rowsUpdated += res.replaced;
    }

    if (dimensionSets.includes('query-page')) {
      const days = eachDay(range);
      // One request set per day: a whole 28-day window of query×page data blows past the
      // API's practical paging limit, and per-day writes keep partial progress on failure.
      const outcomes = await mapWithConcurrency(days, DAY_CONCURRENCY, async (day) => {
        const dayKey = formatDateKey(day);
        try {
          const raw = await fetchAllRows(
            api,
            siteUrl,
            { dimensions: ['date', 'query', 'page'], startDate: dayKey, endDate: dayKey },
            limiter,
            warnings,
          );
          const rows: Prisma.GscQueryMetricCreateManyInput[] = [];
          for (const item of raw) {
            const parsed = parseRow(item);
            if (!parsed) continue;
            const [dateKey, query, page] = parsed.keys;
            if (!dateKey || !query || !page) continue;
            rows.push({
              websiteId,
              date: toUtcDate(dateKey),
              query,
              page,
              source: SOURCE,
              clicks: parsed.clicks,
              impressions: parsed.impressions,
              ctr: parsed.ctr,
              position: parsed.position,
            });
          }
          const written = await writeQueryMetrics(websiteId, day, rows, mode);
          return { ...written, error: null as unknown };
        } catch (err) {
          return { inserted: 0, replaced: 0, error: err as unknown };
        }
      });

      const failure = outcomes.find((o) => o.error !== null);
      for (const outcome of outcomes) {
        rowsImported += outcome.inserted;
        rowsUpdated += outcome.replaced;
      }
      if (failure?.error) throw failure.error;
    }

    if (link && rowsImported > 0) {
      const linked = await linkGscRowsToPages(websiteId);
      if (linked.unresolvedPageUrls > 0) {
        warnings.push(
          `${linked.unresolvedPageUrls} Search Console URLs have no crawled page yet; run a crawl to connect them`,
        );
      }
    }

    await recordSyncOutcome(integration.id, { status: 'OK' });
    log.info('search console sync complete', { websiteId, from, to, rowsImported, rowsUpdated });
    return { rowsImported, rowsUpdated, from, to, warnings };
  } catch (err) {
    if (err instanceof IntegrationNotConfiguredError) {
      await recordSyncOutcome(integration.id, { status: 'SKIPPED', error: err.message });
      return emptySyncResult(from, to, 'CREDENTIALS_EXPIRED', err.message);
    }
    const failure = await classifyGoogleFailure(integration.id, err, 'Search Console sync');
    await recordSyncOutcome(integration.id, { status: 'FAILED', error: failure.error });

    if (failure.code === 'PERMISSION_DENIED') {
      return {
        rowsImported,
        rowsUpdated,
        from,
        to,
        warnings: [...warnings, failure.error],
        skipped: 'PERMISSION_DENIED',
      };
    }
    if (failure.code === 'CREDENTIALS_EXPIRED') {
      return {
        rowsImported,
        rowsUpdated,
        from,
        to,
        warnings: [...warnings, failure.error],
        skipped: 'CREDENTIALS_EXPIRED',
      };
    }
    // Anything else is a real failure: let the queue retry it.
    throw new ProviderError('search-console', failure.error, failure.retryable);
  }
}

function resolveRange(from?: Date | string, to?: Date | string): { start: Date; end: Date } {
  if (from && to) return { start: toUtcDate(from), end: toUtcDate(to) };
  const fallback = lastNDays(GSC_DEFAULT_WINDOW_DAYS, GSC_DATA_LAG_DAYS);
  return {
    start: from ? toUtcDate(from) : fallback.start,
    end: to ? toUtcDate(to) : fallback.end,
  };
}

// ── Backfill ─────────────────────────────────────────────────

export interface BackfillInput {
  websiteId: string;
  /** Days of history to request; capped at 16 months, which is all Google keeps. */
  days?: number;
  dimensions?: readonly GscDimensionSet[];
}

/**
 * Walk backwards a month at a time. One request per month keeps each response small enough
 * to page reliably, and `append` mode means an interrupted backfill can simply be re-run.
 */
export async function backfillSearchConsole(input: BackfillInput): Promise<SyncResult> {
  const { websiteId, dimensions } = input;
  const days = Math.min(Math.max(input.days ?? GSC_MAX_BACKFILL_DAYS, 1), GSC_MAX_BACKFILL_DAYS);
  const full = lastNDays(days, GSC_DATA_LAG_DAYS);

  const windows: Array<{ start: Date; end: Date }> = [];
  let cursorEnd = full.end;
  while (cursorEnd >= full.start) {
    const windowStart = addDays(cursorEnd, -29);
    windows.push({ start: windowStart < full.start ? full.start : windowStart, end: cursorEnd });
    cursorEnd = addDays(windowStart, -1);
  }
  windows.reverse(); // oldest first, so a partial run still leaves a contiguous history

  const results: SyncResult[] = [];
  for (const window of windows) {
    const result = await syncSearchConsole({
      websiteId,
      from: window.start,
      to: window.end,
      ...(dimensions ? { dimensions } : {}),
      mode: 'append',
      link: false,
    });
    results.push(result);
    // A property we cannot read will not become readable in the next window.
    if (result.skipped && result.skipped !== 'NO_DATA') break;
  }

  const merged = mergeSyncResults(results);
  if (merged.rowsImported > 0) await linkGscRowsToPages(websiteId);
  log.info('search console backfill complete', {
    websiteId,
    windows: windows.length,
    rowsImported: merged.rowsImported,
  });
  return merged;
}

// ── Linking ──────────────────────────────────────────────────

export interface GscLinkResult {
  pageRowsLinked: number;
  keywordRowsLinked: number;
  keywordsCreated: number;
  /** Distinct GSC URLs with no matching crawled Page (usually: not crawled yet). */
  unresolvedPageUrls: number;
}

/**
 * Resolve GscQueryMetric.page → Page.id and .query → Keyword.id.
 *
 * A busy site accumulates 100k+ metric rows per month, so this works on the *distinct*
 * URLs and queries and pushes the join into Postgres with a VALUES list — one statement per
 * thousand keys instead of one UPDATE per row.
 */
export async function linkGscRowsToPages(websiteId: string): Promise<GscLinkResult> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { targetLocales: true, primaryLanguage: true, targetCountry: true },
  });
  if (!website) throw new NotFoundError('Website');

  const pageResult = await linkPages(websiteId);
  const keywordResult = await linkKeywords(websiteId, {
    locale: website.targetLocales[0] ?? 'en-US',
    language: website.primaryLanguage,
    country: website.targetCountry,
  });

  log.info('linked search console rows', { websiteId, ...pageResult, ...keywordResult });
  return { ...pageResult, ...keywordResult };
}

async function linkPages(websiteId: string): Promise<Pick<GscLinkResult, 'pageRowsLinked' | 'unresolvedPageUrls'>> {
  const distinct = await prisma.gscQueryMetric.groupBy({
    by: ['page'],
    where: { websiteId, pageId: null },
    _sum: { impressions: true },
    orderBy: { _sum: { impressions: 'desc' } },
    take: MAX_DISTINCT_LINK_KEYS,
  });
  if (distinct.length === 0) return { pageRowsLinked: 0, unresolvedPageUrls: 0 };

  // Several raw GSC URLs (http/https, www, tracking params) can collapse onto one Page.
  const byNormalized = new Map<string, string[]>();
  for (const row of distinct) {
    const normalized = normalizeUrl(row.page);
    if (!normalized) continue;
    const bucket = byNormalized.get(normalized);
    if (bucket) bucket.push(row.page);
    else byNormalized.set(normalized, [row.page]);
  }

  const tuples: Array<[string, string]> = [];
  let matchedNormalized = 0;
  for (const keys of chunk([...byNormalized.keys()], 1000)) {
    const pages = await prisma.page.findMany({
      where: { websiteId, normalizedUrl: { in: keys } },
      select: { id: true, normalizedUrl: true },
    });
    for (const page of pages) {
      const rawUrls = byNormalized.get(page.normalizedUrl);
      if (!rawUrls) continue;
      matchedNormalized += 1;
      for (const raw of rawUrls) tuples.push([raw, page.id]);
    }
  }

  let pageRowsLinked = 0;
  for (const batch of chunk(tuples, 1000)) {
    pageRowsLinked += await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "GscQueryMetric" AS m
        SET "pageId" = v.page_id
        FROM (VALUES ${Prisma.join(batch.map(([url, id]) => Prisma.sql`(${url}::text, ${id}::text)`))})
          AS v(url, page_id)
        WHERE m."websiteId" = ${websiteId} AND m."pageId" IS NULL AND m."page" = v.url`,
    );
  }

  return { pageRowsLinked, unresolvedPageUrls: byNormalized.size - matchedNormalized };
}

async function linkKeywords(
  websiteId: string,
  defaults: { locale: string; language: string; country: string },
): Promise<Pick<GscLinkResult, 'keywordRowsLinked' | 'keywordsCreated'>> {
  const distinct = await prisma.gscQueryMetric.groupBy({
    by: ['query'],
    where: { websiteId, keywordId: null },
    _sum: { impressions: true },
    orderBy: { _sum: { impressions: 'desc' } },
    take: MAX_DISTINCT_LINK_KEYS,
  });
  if (distinct.length === 0) return { keywordRowsLinked: 0, keywordsCreated: 0 };

  // Many raw queries normalise to the same keyword; keep the first raw form as the label.
  const byNormalized = new Map<string, { label: string; rawQueries: string[] }>();
  for (const row of distinct) {
    const normalized = normalizeKeyword(row.query);
    if (!normalized) continue;
    const bucket = byNormalized.get(normalized);
    if (bucket) bucket.rawQueries.push(row.query);
    else byNormalized.set(normalized, { label: row.query, rawQueries: [row.query] });
  }

  const idByNormalized = new Map<string, string>();
  const normalizedKeys = [...byNormalized.keys()];
  for (const keys of chunk(normalizedKeys, 1000)) {
    const existing = await prisma.keyword.findMany({
      where: { websiteId, normalized: { in: keys } },
      select: { id: true, normalized: true, locale: true },
    });
    for (const row of existing) {
      // Prefer the site's own locale when the same phrase is tracked for several.
      if (!idByNormalized.has(row.normalized) || row.locale === defaults.locale) {
        idByNormalized.set(row.normalized, row.id);
      }
    }
  }

  const missing = normalizedKeys.filter((key) => !idByNormalized.has(key));
  let keywordsCreated = 0;
  if (missing.length > 0) {
    const rows = missing.map((normalized) => ({
      websiteId,
      keyword: byNormalized.get(normalized)?.label ?? normalized,
      normalized,
      locale: defaults.locale,
      language: defaults.language,
      country: defaults.country,
      source: KeywordSource.SEARCH_CONSOLE,
    }));
    keywordsCreated = await createManyChunked(prisma.keyword, rows, 500);

    for (const keys of chunk(missing, 1000)) {
      const created = await prisma.keyword.findMany({
        where: { websiteId, normalized: { in: keys }, locale: defaults.locale },
        select: { id: true, normalized: true },
      });
      for (const row of created) idByNormalized.set(row.normalized, row.id);
    }
  }

  const tuples: Array<[string, string]> = [];
  for (const [normalized, entry] of byNormalized) {
    const keywordId = idByNormalized.get(normalized);
    if (!keywordId) continue;
    for (const raw of entry.rawQueries) tuples.push([raw, keywordId]);
  }

  let keywordRowsLinked = 0;
  for (const batch of chunk(tuples, 1000)) {
    keywordRowsLinked += await prisma.$executeRaw(
      Prisma.sql`
        UPDATE "GscQueryMetric" AS m
        SET "keywordId" = v.keyword_id
        FROM (VALUES ${Prisma.join(batch.map(([q, id]) => Prisma.sql`(${q}::text, ${id}::text)`))})
          AS v(query, keyword_id)
        WHERE m."websiteId" = ${websiteId} AND m."keywordId" IS NULL AND m."query" = v.query`,
    );
  }

  return { keywordRowsLinked, keywordsCreated };
}

// ── Sitemaps & inspection ────────────────────────────────────

/**
 * Submit a sitemap for (re)processing. Needs the read/write `webmasters` scope — an account
 * connected with only the readonly scope gets a typed PERMISSION_DENIED, not an exception.
 *
 * Note: Google offers no general-purpose indexing API for ordinary pages — the Indexing API
 * only accepts JobPosting and BroadcastEvent — so sitemap submission plus URL inspection is
 * the full extent of the control we have. Nothing here should be presented to a user as
 * "force this page into the index".
 */
export async function submitSitemap(
  integrationId: string,
  siteUrl: string,
  sitemapUrl: string,
): Promise<IntegrationResult<{ siteUrl: string; sitemapUrl: string; submittedAt: string }>> {
  try {
    const auth = await getAuthorizedClient(integrationId);
    await apiFor(auth).sitemaps.submit({ siteUrl, feedpath: sitemapUrl });
    return integrationOk({ siteUrl, sitemapUrl, submittedAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof IntegrationNotConfiguredError) {
      return integrationFail('NOT_CONFIGURED', err.message, false);
    }
    log.warn('sitemap submission failed', { integrationId, sitemapUrl, error: errorMessage(err) });
    return classifyGoogleFailure(integrationId, err, `submitting sitemap ${sitemapUrl}`);
  }
}

export interface UrlInspectionSummary {
  url: string;
  /** `PASS`, `NEUTRAL`, `FAIL`… as returned by Google. */
  verdict: string | null;
  coverageState: string | null;
  indexingState: string | null;
  robotsTxtState: string | null;
  pageFetchState: string | null;
  crawledAs: string | null;
  lastCrawlTime: string | null;
  googleCanonical: string | null;
  userCanonical: string | null;
  sitemaps: string[];
  referringUrls: string[];
  richResultsVerdict: string | null;
  mobileUsabilityVerdict: string | null;
  inspectionResultLink: string | null;
}

/**
 * URL Inspection API. Quota is 2000 URLs/day and 600/minute per property, and the account
 * must be an owner or full user of the property — a restricted user gets PERMISSION_DENIED
 * back as data rather than an exception, since callers inspect URLs in bulk loops.
 */
export async function inspectUrl(
  integrationId: string,
  siteUrl: string,
  url: string,
  languageCode = 'en-US',
): Promise<IntegrationResult<UrlInspectionSummary>> {
  try {
    const auth = await getAuthorizedClient(integrationId);
    const res = await retry(
      () =>
        apiFor(auth).urlInspection.index.inspect({
          requestBody: { siteUrl, inspectionUrl: url, languageCode },
        }),
      { attempts: 3, baseDelayMs: 1000, shouldRetry: isRetryableGoogleError },
    );
    const result = res.data.inspectionResult;
    if (!result) return integrationFail('PROVIDER_ERROR', `Search Console returned no inspection result for ${url}`, true);

    const index = result.indexStatusResult ?? {};
    return integrationOk({
      url,
      verdict: index.verdict ?? null,
      coverageState: index.coverageState ?? null,
      indexingState: index.indexingState ?? null,
      robotsTxtState: index.robotsTxtState ?? null,
      pageFetchState: index.pageFetchState ?? null,
      crawledAs: index.crawledAs ?? null,
      lastCrawlTime: index.lastCrawlTime ?? null,
      googleCanonical: index.googleCanonical ?? null,
      userCanonical: index.userCanonical ?? null,
      sitemaps: index.sitemap ?? [],
      referringUrls: index.referringUrls ?? [],
      richResultsVerdict: result.richResultsResult?.verdict ?? null,
      mobileUsabilityVerdict: result.mobileUsabilityResult?.verdict ?? null,
      inspectionResultLink: result.inspectionResultLink ?? null,
    });
  } catch (err) {
    if (err instanceof IntegrationNotConfiguredError) {
      return integrationFail('NOT_CONFIGURED', err.message, false);
    }
    log.debug('url inspection failed', { url, error: googleErrorMessage(err) });
    return classifyGoogleFailure(integrationId, err, `inspecting ${url}`);
  }
}
