/**
 * Google Analytics 4 — Data API (`analyticsdata` v1beta) + Admin API (`analyticsadmin` v1beta).
 *
 * Shares the OAuth grant in `./oauth`: the same consent that connects Search Console also
 * carries `analytics.readonly`, so connecting GA4 is only "pick a property".
 *
 * ## Where the numbers land
 * The schema has no GA4-specific table; `SearchConsoleDaily` and `GscQueryMetric` are the
 * shared daily-metrics tables and both carry a `source` discriminator for exactly this reason.
 * GA4 has four metrics and those tables have four numeric slots, so the mapping is fixed and
 * published as `GA4_METRIC_SLOTS` — read it rather than assuming a column means clicks:
 *
 *   clicks      ← sessions
 *   impressions ← totalUsers
 *   ctr         ← engagementRate   (already 0-1, same scale as a CTR)
 *   position    ← conversions      (a count, NOT a rank — only meaningful for source 'ga4')
 *
 * `SearchConsoleDaily` is keyed `(websiteId, date, source, country, device)` and therefore
 * cannot hold a page dimension, so it receives the **daily site totals** while the
 * **landing-page × date** detail goes to `GscQueryMetric` (which does have a `page` column)
 * with an empty `query`, mirroring how the Bing importer stores its page rows.
 *
 * GA4 reports in the property's own timezone, not UTC. We store the date key GA4 returns
 * as-is: re-interpreting it in UTC would shift a day's traffic onto the wrong date.
 */

import { google } from 'googleapis';
import type { analyticsdata_v1beta } from 'googleapis';
import { prisma, Prisma, IntegrationProvider, IntegrationStatus, createManyChunked } from '@seo/db';
import {
  IntegrationNotConfiguredError,
  NotFoundError,
  ProviderError,
  createLogger,
  errorMessage,
  formatDateKey,
  lastNDays,
  retry,
  round,
  toUtcDate,
} from '@seo/shared';
import {
  classifyGoogleFailure,
  findGoogleIntegration,
  getAuthorizedClient,
  googleErrorMessage,
  httpStatusOf,
  isRetryableGoogleError,
  markIntegrationStatus,
  patchGoogleConfig,
  readGoogleConfig,
  recordSyncOutcome,
} from './oauth';
import type { AuthorizedGoogleClient } from './oauth';
import { emptySyncResult, integrationFail, integrationOk } from '../types';
import type { IntegrationResult, SyncResult } from '../types';

const log = createLogger('integrations:ga4');

/** `SearchConsoleDaily.source` / `GscQueryMetric.source` written by this module. */
export const GA4_SOURCE = 'ga4';
/** Query value on GA4 landing-page rows — GA4 has no query dimension. */
export const GA4_PAGE_ROW_QUERY = '';

/**
 * How GA4 metrics are packed into the shared daily tables. Exported so the analytics layer
 * can label a `source: 'ga4'` row correctly instead of hard-coding the same assumption twice.
 */
export const GA4_METRIC_SLOTS = {
  clicks: 'sessions',
  impressions: 'totalUsers',
  ctr: 'engagementRate',
  /** GA4's newer properties call this metric `keyEvents`; the stored numbers are the same. */
  position: 'conversions',
} as const;

/** GA4 finalises most reports within 24-48h; two days back avoids re-importing moving data. */
export const GA4_DATA_LAG_DAYS = 2;
export const GA4_DEFAULT_WINDOW_DAYS = 28;

/** One `runReport` page; the API's hard ceiling is 250 000 rows. */
const REPORT_PAGE_SIZE = 100_000;
/** Stop paging one report here so a pathological property cannot run forever. */
const MAX_REPORT_ROWS = 500_000;
/** 200 summaries per page — an account list this long is a broken cursor, not a real tenant. */
const MAX_ACCOUNT_SUMMARY_PAGES = 50;

type AnalyticsDataApi = analyticsdata_v1beta.Analyticsdata;

function dataApiFor(auth: AuthorizedGoogleClient): AnalyticsDataApi {
  return google.analyticsdata({ version: 'v1beta', auth: auth.client });
}

// ── Properties ───────────────────────────────────────────────

export interface Ga4Property {
  /** Resource name, e.g. `properties/123456789`. */
  propertyId: string;
  displayName: string;
  /** Owning account resource name, e.g. `accounts/1000`. */
  account: string;
  accountName: string;
  /** IANA timezone the property reports in; empty when the summary does not include it. */
  timeZone: string;
}

/**
 * GA4 properties the connected account can read.
 *
 * Uses `accountSummaries.list`, which returns every account *and* its properties in one
 * paged call — listing accounts and then properties per account costs an extra request per
 * account and hits the Admin API's low quota much faster.
 */
export async function listGa4Properties(integrationId: string): Promise<Ga4Property[]> {
  const auth = await getAuthorizedClient(integrationId);
  const admin = google.analyticsadmin({ version: 'v1beta', auth: auth.client });

  const out: Ga4Property[] = [];
  let pageToken: string | undefined;
  try {
    // A page token that never changes (or an endlessly paging account) must not spin forever.
    for (let page = 0; page < MAX_ACCOUNT_SUMMARY_PAGES; page += 1) {
      const res = await retry(
        () => admin.accountSummaries.list({ pageSize: 200, ...(pageToken ? { pageToken } : {}) }),
        { attempts: 3, baseDelayMs: 1000, shouldRetry: isRetryableGoogleError },
      );
      for (const account of res.data.accountSummaries ?? []) {
        for (const property of account.propertySummaries ?? []) {
          if (!property.property) continue;
          out.push({
            propertyId: property.property,
            displayName: property.displayName ?? property.property,
            account: account.account ?? '',
            accountName: account.displayName ?? '',
            timeZone: '',
          });
        }
      }
      const next = res.data.nextPageToken ?? undefined;
      if (!next || next === pageToken) break;
      pageToken = next;
    }
  } catch (err) {
    const failure = await classifyGoogleFailure(integrationId, err, 'listing GA4 properties');
    throw new ProviderError('ga4', failure.error, failure.retryable);
  }

  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Read a property's timezone and store it on the integration config.
 * Best effort: a property we can report on but not describe is still usable.
 */
async function resolveTimeZone(auth: AuthorizedGoogleClient, propertyId: string): Promise<string | null> {
  try {
    const admin = google.analyticsadmin({ version: 'v1beta', auth: auth.client });
    const res = await admin.properties.get({ name: propertyId });
    return res.data.timeZone ?? null;
  } catch (err) {
    log.debug('could not read GA4 property timezone', { propertyId, error: googleErrorMessage(err) });
    return null;
  }
}

// ── Report plumbing ──────────────────────────────────────────

interface Ga4Metrics {
  sessions: number;
  totalUsers: number;
  engagementRate: number;
  conversions: number;
}

interface Ga4Row extends Ga4Metrics {
  /** `YYYYMMDD` as GA4 returns it, in the property's timezone. */
  dateKey: string;
  landingPage: string;
}

/** Daily site total straight from GA4 — not a sum over landing pages (see `fetchDailyRows`). */
interface Ga4DailyRow extends Ga4Metrics {
  dateKey: string;
}

/**
 * GA4 renamed the `conversions` metric to `keyEvents`; properties migrated at different times
 * and a report asking for a metric the property does not know fails the *whole* request with
 * 400. Try the classic name, fall back once, and remember which one this process should use so
 * a nightly fan-out pays for the discovery at most once.
 */
const CONVERSION_METRICS = ['conversions', 'keyEvents'] as const;
type ConversionMetric = (typeof CONVERSION_METRICS)[number];
let conversionMetric: ConversionMetric = 'conversions';

function reportMetrics(conversions: ConversionMetric): string[] {
  return ['sessions', 'totalUsers', 'engagementRate', conversions];
}

/** True for the 400 GA4 returns when a metric name is not valid for the property. */
function isUnknownMetricError(err: unknown, metric: string): boolean {
  if (httpStatusOf(err) !== 400) return false;
  const message = googleErrorMessage(err).toLowerCase();
  return message.includes(metric.toLowerCase());
}

/**
 * Run one `runReport`, transparently switching between `conversions` and `keyEvents` the first
 * time GA4 rejects the name this process was using.
 */
async function runReport(
  api: AnalyticsDataApi,
  requestBody: (metrics: string[]) => analyticsdata_v1beta.Schema$RunReportRequest,
  propertyId: string,
): Promise<analyticsdata_v1beta.Schema$RunReportResponse> {
  const attempt = async (metric: ConversionMetric) => {
    const res = await retry(
      () => api.properties.runReport({ property: propertyId, requestBody: requestBody(reportMetrics(metric)) }),
      { attempts: 4, baseDelayMs: 1000, shouldRetry: isRetryableGoogleError },
    );
    return res.data;
  };

  try {
    return await attempt(conversionMetric);
  } catch (err) {
    if (!isUnknownMetricError(err, conversionMetric)) throw err;
    const alternative: ConversionMetric = conversionMetric === 'conversions' ? 'keyEvents' : 'conversions';
    log.info('GA4 rejected the conversion metric name; switching', {
      from: conversionMetric,
      to: alternative,
    });
    const data = await attempt(alternative);
    conversionMetric = alternative;
    return data;
  }
}

function metricValue(row: analyticsdata_v1beta.Schema$Row, index: number): number {
  const raw = row.metricValues?.[index]?.value;
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function dimensionValue(row: analyticsdata_v1beta.Schema$Row, index: number): string {
  return row.dimensionValues?.[index]?.value ?? '';
}

function readMetrics(row: analyticsdata_v1beta.Schema$Row): Ga4Metrics {
  return {
    sessions: metricValue(row, 0),
    totalUsers: metricValue(row, 1),
    engagementRate: metricValue(row, 2),
    conversions: metricValue(row, 3),
  };
}

/**
 * Daily site totals, asked of GA4 with `date` as the only dimension.
 *
 * This deliberately does *not* sum the landing-page report: `totalUsers` is a de-duplicated
 * count, so a user who landed on three pages would be counted three times, and
 * `engagementRate` is a ratio that cannot be added at all. GA4 does that de-duplication
 * itself only when asked for the aggregate, which is what this second (cheap) report is for.
 */
async function fetchDailyRows(
  api: AnalyticsDataApi,
  propertyId: string,
  from: string,
  to: string,
  warnings: string[],
): Promise<Ga4DailyRow[]> {
  const data = await runReport(
    api,
    (metrics) => ({
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: 'date' }],
      metrics: metrics.map((name) => ({ name })),
      // One row per day: a window can never exceed the page size, so no paging is needed.
      limit: String(REPORT_PAGE_SIZE),
      keepEmptyRows: false,
    }),
    propertyId,
  );

  const rows: Ga4DailyRow[] = [];
  for (const row of data.rows ?? []) {
    const dateKey = dimensionValue(row, 0);
    if (!/^\d{8}$/.test(dateKey)) continue;
    rows.push({ dateKey, ...readMetrics(row) });
  }
  if (data.metadata?.dataLossFromOtherRow && !warnings.includes(DATA_LOSS_WARNING)) {
    warnings.push(DATA_LOSS_WARNING);
  }
  return rows;
}

/**
 * Run `properties.runReport` for date × landingPage, following `offset` until GA4 stops
 * returning a full page. GA4 caps one response at 250 000 rows, so paging is the only way to
 * see a full window for a large site.
 */
async function fetchLandingPageRows(
  api: AnalyticsDataApi,
  propertyId: string,
  from: string,
  to: string,
  warnings: string[],
): Promise<Ga4Row[]> {
  const rows: Ga4Row[] = [];
  let offset = 0;

  for (;;) {
    const data = await runReport(
      api,
      (metrics) => ({
        dateRanges: [{ startDate: from, endDate: to }],
        dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
        metrics: metrics.map((name) => ({ name })),
        limit: String(REPORT_PAGE_SIZE),
        offset: String(offset),
        keepEmptyRows: false,
      }),
      propertyId,
    );

    const page = data.rows ?? [];
    for (const row of page) {
      const dateKey = dimensionValue(row, 0);
      const landingPage = dimensionValue(row, 1);
      if (!/^\d{8}$/.test(dateKey)) continue;
      rows.push({ dateKey, landingPage, ...readMetrics(row) });
    }

    // GA4 folds low-cardinality rows into "(other)" and says so here; surfacing that beats
    // silently storing partial landing-page totals.
    if (data.metadata?.dataLossFromOtherRow && !warnings.includes(DATA_LOSS_WARNING)) {
      warnings.push(DATA_LOSS_WARNING);
    }

    if (page.length < REPORT_PAGE_SIZE) break;
    offset += REPORT_PAGE_SIZE;
    if (rows.length >= MAX_REPORT_ROWS) {
      warnings.push(`Truncated GA4 landing-page data for ${from}..${to} at ${MAX_REPORT_ROWS} rows`);
      break;
    }
  }

  return rows;
}

const DATA_LOSS_WARNING =
  'GA4 aggregated some rows into "(other)" for this window; landing-page totals may be incomplete.';

/** `YYYYMMDD` → midnight UTC, keeping GA4's own (property-timezone) calendar day. */
function ga4DateToUtc(dateKey: string): Date {
  return new Date(
    Date.UTC(
      Number(dateKey.slice(0, 4)),
      Number(dateKey.slice(4, 6)) - 1,
      Number(dateKey.slice(6, 8)),
    ),
  );
}

// ── Sync ─────────────────────────────────────────────────────

export interface SyncGa4Input {
  websiteId: string;
  /** Defaults to the last 28 complete days ending `GA4_DATA_LAG_DAYS` ago. */
  from?: Date | string;
  to?: Date | string;
}

/** Returned instead of throwing when GA4 has never been connected for the website. */
export interface Ga4NotConnected {
  connected: false;
  reason: string;
}

export interface Ga4PropertyStatus {
  connected: true;
  integrationId: string;
  propertyId: string;
  propertyDisplayName: string | null;
  timeZone: string | null;
}

/**
 * Typed connection check for UI and callers that must not throw. GA4 counts as connected only
 * when the OAuth row exists, is not disabled, and a property has actually been chosen —
 * a grant without a property cannot report anything.
 */
export async function getGa4Status(websiteId: string): Promise<Ga4PropertyStatus | Ga4NotConnected> {
  const integration = await findGoogleIntegration(websiteId, IntegrationProvider.GOOGLE_ANALYTICS_4);
  if (!integration) {
    return { connected: false, reason: 'Google Analytics 4 is not connected for this website.' };
  }
  if (integration.status === IntegrationStatus.DISABLED) {
    return { connected: false, reason: 'The Google Analytics 4 connection is disabled.' };
  }
  const config = readGoogleConfig(integration.config);
  if (!config.propertyId) {
    return {
      connected: false,
      reason: 'No GA4 property is selected for this website. Pick one in the integration settings.',
    };
  }
  return {
    connected: true,
    integrationId: integration.id,
    propertyId: config.propertyId,
    propertyDisplayName: config.propertyDisplayName ?? null,
    timeZone: config.timeZone ?? null,
  };
}

/**
 * Choose the GA4 property a website reports from. Kept here (rather than in the OAuth module)
 * because it validates the id against the properties the grant can actually read.
 */
export async function selectGa4Property(
  integrationId: string,
  propertyId: string,
): Promise<IntegrationResult<Ga4Property>> {
  try {
    const properties = await listGa4Properties(integrationId);
    const match = properties.find((p) => p.propertyId === propertyId);
    if (!match) {
      return integrationFail('NOT_FOUND', `The connected Google account cannot read ${propertyId}.`, false);
    }
    const auth = await getAuthorizedClient(integrationId);
    const timeZone = await resolveTimeZone(auth, propertyId);
    await patchGoogleConfig(integrationId, {
      propertyId,
      propertyDisplayName: match.displayName,
      ...(timeZone ? { timeZone } : {}),
    });
    await markIntegrationStatus(integrationId, IntegrationStatus.CONNECTED);
    return integrationOk({ ...match, timeZone: timeZone ?? '' });
  } catch (err) {
    if (err instanceof IntegrationNotConfiguredError) {
      return integrationFail('NOT_CONFIGURED', err.message, false);
    }
    return classifyGoogleFailure(integrationId, err, `selecting GA4 property ${propertyId}`);
  }
}

function resolveRange(from?: Date | string, to?: Date | string): { start: Date; end: Date } {
  const fallback = lastNDays(GA4_DEFAULT_WINDOW_DAYS, GA4_DATA_LAG_DAYS);
  return {
    start: from ? toUtcDate(from) : fallback.start,
    end: to ? toUtcDate(to) : fallback.end,
  };
}

/**
 * Import GA4 sessions / users / engagement rate / conversions for a website.
 *
 * Not-connected, no-property and permission problems come back as a skipped `SyncResult`
 * (never an exception) so a nightly fan-out across a portfolio keeps going; transient
 * provider faults throw so the queue retries them.
 */
export async function syncGa4(input: SyncGa4Input): Promise<SyncResult> {
  const { websiteId } = input;
  const range = resolveRange(input.from, input.to);
  const from = formatDateKey(range.start);
  const to = formatDateKey(range.end);

  if (range.end.getTime() < range.start.getTime()) {
    throw new ProviderError('ga4', `invalid date range ${from}..${to}`, false);
  }

  const website = await prisma.website.findUnique({ where: { id: websiteId }, select: { id: true } });
  if (!website) throw new NotFoundError('Website');

  const status = await getGa4Status(websiteId);
  if (!status.connected) return emptySyncResult(from, to, 'NOT_CONNECTED', status.reason);

  const warnings: string[] = [];
  try {
    const auth = await getAuthorizedClient(status.integrationId);
    const api = dataApiFor(auth);
    const dailyRows = await fetchDailyRows(api, status.propertyId, from, to, warnings);
    const rows = await fetchLandingPageRows(api, status.propertyId, from, to, warnings);

    if (rows.length === 0 && dailyRows.length === 0) {
      await recordSyncOutcome(status.integrationId, { status: 'OK' });
      return {
        rowsImported: 0,
        rowsUpdated: 0,
        from,
        to,
        warnings: [...warnings, `GA4 returned no rows for ${from}..${to}`],
        skipped: 'NO_DATA',
      };
    }

    const daily = await writeDailyTotals(websiteId, range, dailyRows);
    const pages = await writeLandingPageRows(websiteId, range, rows);

    await recordSyncOutcome(status.integrationId, { status: 'OK' });
    log.info('ga4 sync complete', {
      websiteId,
      propertyId: status.propertyId,
      from,
      to,
      rows: rows.length,
    });
    return {
      rowsImported: daily.inserted + pages.inserted,
      rowsUpdated: daily.replaced + pages.replaced,
      from,
      to,
      warnings,
    };
  } catch (err) {
    if (err instanceof IntegrationNotConfiguredError) {
      await recordSyncOutcome(status.integrationId, { status: 'SKIPPED', error: err.message });
      return emptySyncResult(from, to, 'CREDENTIALS_EXPIRED', err.message);
    }
    const failure = await classifyGoogleFailure(status.integrationId, err, 'GA4 sync');
    await recordSyncOutcome(status.integrationId, { status: 'FAILED', error: failure.error });

    if (failure.code === 'PERMISSION_DENIED' || failure.code === 'CREDENTIALS_EXPIRED') {
      return {
        rowsImported: 0,
        rowsUpdated: 0,
        from,
        to,
        warnings: [...warnings, failure.error],
        skipped: failure.code,
      };
    }
    if (failure.code === 'NOT_FOUND') {
      // The stored property was deleted or moved out of this account. Retrying nightly will
      // never fix that, so flag the row for the settings screen and skip instead of throwing.
      await markIntegrationStatus(
        status.integrationId,
        IntegrationStatus.ERROR,
        `${failure.error}. Choose a GA4 property again in the integration settings.`,
      );
      return {
        rowsImported: 0,
        rowsUpdated: 0,
        from,
        to,
        warnings: [...warnings, failure.error],
        skipped: 'NOT_CONNECTED',
      };
    }
    throw new ProviderError('ga4', failure.error, failure.retryable);
  }
}

/**
 * Daily site totals, written straight from GA4's own date-only aggregate.
 *
 * Folding by date key is defensive only — GA4 returns one row per day — but the unique index
 * (websiteId, date, source, country, device) plus `skipDuplicates` would drop, not merge, a
 * repeated key, so a duplicate would silently lose a day.
 */
async function writeDailyTotals(
  websiteId: string,
  range: { start: Date; end: Date },
  rows: readonly Ga4DailyRow[],
): Promise<{ inserted: number; replaced: number }> {
  const byDate = new Map<string, { sessions: number; users: number; engaged: number; conversions: number }>();
  for (const row of rows) {
    const bucket = byDate.get(row.dateKey) ?? { sessions: 0, users: 0, engaged: 0, conversions: 0 };
    bucket.sessions += row.sessions;
    bucket.users += row.totalUsers;
    // A ratio cannot be summed; carry it as engaged sessions and divide once at the end.
    bucket.engaged += row.engagementRate * row.sessions;
    bucket.conversions += row.conversions;
    byDate.set(row.dateKey, bucket);
  }

  const daily: Prisma.SearchConsoleDailyCreateManyInput[] = [];
  for (const [dateKey, bucket] of byDate) {
    daily.push({
      websiteId,
      date: ga4DateToUtc(dateKey),
      source: GA4_SOURCE,
      clicks: Math.round(bucket.sessions),
      impressions: Math.round(bucket.users),
      ctr: bucket.sessions > 0 ? round(bucket.engaged / bucket.sessions, 6) : 0,
      position: round(bucket.conversions, 2),
    });
  }

  // Nullable country/device in the unique index make NULLs distinct in Postgres, so
  // skipDuplicates cannot keep this idempotent — delete the segment first, like the GSC import.
  const { count: replaced } = await prisma.searchConsoleDaily.deleteMany({
    where: {
      websiteId,
      source: GA4_SOURCE,
      country: null,
      device: null,
      date: { gte: range.start, lte: range.end },
    },
  });
  const inserted = daily.length ? await createManyChunked(prisma.searchConsoleDaily, daily, 500) : 0;
  return { inserted, replaced };
}

/** Landing page × date detail rows, keyed by `page` with an empty `query`. */
async function writeLandingPageRows(
  websiteId: string,
  range: { start: Date; end: Date },
  rows: readonly Ga4Row[],
): Promise<{ inserted: number; replaced: number }> {
  // GA4 can emit the same (date, landingPage) pair more than once across pages when a report
  // is re-sampled mid-scan; fold duplicates rather than let `skipDuplicates` drop one.
  interface PageBucket {
    date: Date;
    page: string;
    sessions: number;
    users: number;
    engaged: number;
    conversions: number;
  }
  const merged = new Map<string, PageBucket>();
  for (const row of rows) {
    const page = row.landingPage || '(not set)';
    const key = `${row.dateKey} ${page}`;
    const bucket = merged.get(key) ?? {
      date: ga4DateToUtc(row.dateKey),
      page,
      sessions: 0,
      users: 0,
      engaged: 0,
      conversions: 0,
    };
    bucket.sessions += row.sessions;
    bucket.users += row.totalUsers;
    // Engagement rate is a ratio: carry engaged sessions and divide once, or a one-session
    // duplicate row would weigh as much as a thousand-session one.
    bucket.engaged += row.engagementRate * row.sessions;
    bucket.conversions += row.conversions;
    merged.set(key, bucket);
  }

  const pageRows: Prisma.GscQueryMetricCreateManyInput[] = [...merged.values()].map((bucket) => ({
    websiteId,
    date: bucket.date,
    query: GA4_PAGE_ROW_QUERY,
    page: bucket.page,
    source: GA4_SOURCE,
    clicks: Math.round(bucket.sessions),
    impressions: Math.round(bucket.users),
    ctr: bucket.sessions > 0 ? round(bucket.engaged / bucket.sessions, 6) : 0,
    position: round(bucket.conversions, 2),
  }));

  const { count: replaced } = await prisma.gscQueryMetric.deleteMany({
    where: { websiteId, source: GA4_SOURCE, date: { gte: range.start, lte: range.end } },
  });
  const inserted = pageRows.length
    ? await createManyChunked(prisma.gscQueryMetric, pageRows, 500)
    : 0;
  return { inserted, replaced };
}

/** Human-readable reason a GA4 call failed, for logs and integration `lastError`. */
export function ga4ErrorMessage(err: unknown): string {
  return err instanceof Error ? googleErrorMessage(err) : errorMessage(err);
}
