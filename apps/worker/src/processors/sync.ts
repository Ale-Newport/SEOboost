/**
 * The sync lane: pulling third-party performance data into the warehouse.
 *
 * Every job here follows the same contract. The integration packages never throw for "this
 * site is not connected" — they return a skipped `SyncResult` — so a nightly fan-out across a
 * portfolio keeps going when one site's OAuth grant has lapsed. This layer turns that into a
 * job result the operator can act on, records the outcome on the `Integration` row that the
 * settings screen reads, and only then chains the analysis that depends on fresh numbers.
 */

import { IntegrationProvider, prisma } from '@seo/db';
import { enqueue, type JobHandler } from '@seo/queue';
import { createLogger, lastNDays, toUtcDate } from '@seo/shared';
import {
  BING_DATA_LAG_DAYS,
  GA4_DATA_LAG_DAYS,
  GSC_DATA_LAG_DAYS,
  backfillSearchConsole,
  linkGscRowsToPages,
  syncBing,
  syncGa4,
  syncSearchConsole,
  type SyncResult,
  type SyncSkipReason,
} from '@seo/integrations';
import { loadWebsite } from '../lib/website';
import { refreshPageMetrics } from '../lib/metrics';
import { skip, type SkippedOutcome } from '../lib/result';

const log = createLogger('worker:sync');

export interface SyncJobResult {
  status: 'completed';
  provider: string;
  rowsImported: number;
  rowsUpdated: number;
  from: string;
  to: string;
  warnings: string[];
  pagesLinked: number;
  keywordsLinked: number;
  keywordsCreated: number;
  pageMetricsUpdated: number;
  analysisEnqueued: boolean;
}

/** Turns a provider's machine-readable skip reason into something the operator can act on. */
function explainSkip(provider: string, reason: SyncSkipReason): SkippedOutcome {
  switch (reason) {
    case 'NOT_CONFIGURED':
      return skip(
        `${provider} is not configured on this deployment, so nothing was imported.`,
        provider === 'Bing Webmaster Tools'
          ? ['BING_API_KEY']
          : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      );
    case 'NOT_CONNECTED':
      return skip(
        `${provider} is not connected for this website.`,
        [`Connect ${provider} in Settings → Integrations`],
      );
    case 'PERMISSION_DENIED':
      return skip(
        `The connected account can no longer read this ${provider} property.`,
        [`Re-grant access to the property, or reconnect ${provider} with an account that has it`],
      );
    case 'CREDENTIALS_EXPIRED':
      return skip(`The ${provider} credentials expired.`, [`Reconnect ${provider} in Settings`]);
    case 'NO_DATA':
      return skip(`${provider} returned no rows for the requested window.`);
    default:
      return skip(`${provider} did not import anything.`);
  }
}

/** Mirrors the run onto the Integration row so Settings can explain the last sync. */
async function recordOutcome(
  websiteId: string,
  provider: IntegrationProvider,
  status: string,
  error: string | null,
): Promise<void> {
  const row = await prisma.integration.findUnique({
    where: { websiteId_provider: { websiteId, provider } },
    select: { id: true },
  });
  if (!row) return;
  await prisma.integration.update({
    where: { id: row.id },
    data: { lastSyncAt: new Date(), lastSyncStatus: status, lastError: error },
  });
}

interface FinishInput {
  websiteId: string;
  provider: IntegrationProvider;
  label: string;
  result: SyncResult;
  /** GA4 and Bing rows are not Search Console queries; only GSC drives keyword linking. */
  linkQueries: boolean;
  /**
   * Whether to roll the window up onto `Page.clicks28d` and friends. Only Search Console may:
   * those columns mean "organic search clicks", and refreshing them from GA4 sessions or Bing
   * impressions would overwrite one meaning with another.
   */
  refreshMetrics: boolean;
}

/**
 * Shared tail for every sync: record the outcome, resolve foreign keys, refresh the rolling
 * page metrics the scores read, and chain the re-score. Skipped syncs stop before all of that.
 */
async function finishSync(input: FinishInput): Promise<SyncJobResult | SkippedOutcome> {
  const { result } = input;

  if (result.skipped) {
    await recordOutcome(input.websiteId, input.provider, `SKIPPED:${result.skipped}`, null);
    return explainSkip(input.label, result.skipped);
  }

  await recordOutcome(input.websiteId, input.provider, 'OK', null);

  let pagesLinked = 0;
  let keywordsLinked = 0;
  let keywordsCreated = 0;
  if (input.linkQueries && result.rowsImported > 0) {
    const linked = await linkGscRowsToPages(input.websiteId);
    pagesLinked = linked.pageRowsLinked;
    keywordsLinked = linked.keywordRowsLinked;
    keywordsCreated = linked.keywordsCreated;
  }

  const metrics =
    input.refreshMetrics && result.rowsImported > 0
      ? await refreshPageMetrics(input.websiteId)
      : { pagesUpdated: 0 };

  const enqueued =
    result.rowsImported > 0
      ? await enqueue(
          'analysis.page-scores',
          { websiteId: input.websiteId },
          { trigger: 'chain', dedupeKey: `page-scores:${input.websiteId}` },
        )
      : { enqueued: false as const };

  log.info('sync complete', {
    websiteId: input.websiteId,
    provider: input.provider,
    rowsImported: result.rowsImported,
  });

  return {
    status: 'completed',
    provider: input.label,
    rowsImported: result.rowsImported,
    rowsUpdated: result.rowsUpdated,
    from: result.from,
    to: result.to,
    warnings: result.warnings,
    pagesLinked,
    keywordsLinked,
    keywordsCreated,
    pageMetricsUpdated: metrics.pagesUpdated,
    analysisEnqueued: enqueued.enqueued,
  };
}

/** Resolves an explicit window, a rolling `days` window, or the provider's own default. */
function resolveWindow(
  from: string | undefined,
  to: string | undefined,
  days: number | undefined,
  lagDays: number,
): { from?: Date; to?: Date } {
  if (from || to) {
    return {
      ...(from ? { from: toUtcDate(from) } : {}),
      ...(to ? { to: toUtcDate(to) } : {}),
    };
  }
  if (days && days > 0) {
    const range = lastNDays(days, lagDays);
    return { from: range.start, to: range.end };
  }
  return {};
}

// ─────────────────────────────────────────────────────────────
// gsc.sync
// ─────────────────────────────────────────────────────────────

export const gscSync: JobHandler<'gsc.sync'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, 'Requesting Search Console data');

  const window = resolveWindow(payload.from, payload.to, payload.days, GSC_DATA_LAG_DAYS);
  const result = await syncSearchConsole({ websiteId: website.id, ...window, link: false });

  await ctx.updateProgress(60, 'Linking rows to pages and keywords');
  const outcome = await finishSync({
    websiteId: website.id,
    provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
    label: 'Search Console',
    result,
    linkQueries: true,
    refreshMetrics: true,
  });

  await ctx.updateProgress(100, 'Search Console sync complete');
  return outcome;
};

// ─────────────────────────────────────────────────────────────
// gsc.backfill
// ─────────────────────────────────────────────────────────────

export const gscBackfill: JobHandler<'gsc.backfill'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);

  // Search Console keeps ~16 months; the integration clamps, we just translate months → days.
  const days = payload.months && payload.months > 0 ? Math.round(payload.months * 30) : undefined;
  await ctx.updateProgress(
    5,
    `Backfilling Search Console${days ? ` for ${payload.months} month(s)` : ''}`,
  );

  const result =
    payload.from || payload.to
      ? await syncSearchConsole({
          websiteId: website.id,
          ...resolveWindow(payload.from, payload.to, undefined, GSC_DATA_LAG_DAYS),
          mode: 'append',
          link: false,
        })
      : await backfillSearchConsole({ websiteId: website.id, ...(days ? { days } : {}) });

  await ctx.updateProgress(70, 'Linking rows to pages and keywords');
  const outcome = await finishSync({
    websiteId: website.id,
    provider: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
    label: 'Search Console',
    result,
    linkQueries: true,
    refreshMetrics: true,
  });

  await ctx.updateProgress(100, 'Backfill complete');
  return outcome;
};

// ─────────────────────────────────────────────────────────────
// bing.sync
// ─────────────────────────────────────────────────────────────

export const bingSync: JobHandler<'bing.sync'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, 'Requesting Bing Webmaster data');

  const window = resolveWindow(undefined, undefined, payload.days, BING_DATA_LAG_DAYS);
  const result = await syncBing({ websiteId: website.id, ...window });

  const outcome = await finishSync({
    websiteId: website.id,
    provider: IntegrationProvider.BING_WEBMASTER,
    label: 'Bing Webmaster Tools',
    result,
    // Bing rows land with an empty query for page rows and are keyed on their own source, so
    // they must not be folded into the Search Console keyword linking pass.
    linkQueries: false,
    refreshMetrics: false,
  });

  await ctx.updateProgress(100, 'Bing sync complete');
  return outcome;
};

// ─────────────────────────────────────────────────────────────
// ga4.sync
// ─────────────────────────────────────────────────────────────

export const ga4Sync: JobHandler<'ga4.sync'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, 'Requesting GA4 data');

  const window = resolveWindow(payload.from, payload.to, payload.days, GA4_DATA_LAG_DAYS);
  const result = await syncGa4({ websiteId: website.id, ...window });

  const outcome = await finishSync({
    websiteId: website.id,
    provider: IntegrationProvider.GOOGLE_ANALYTICS_4,
    label: 'Google Analytics 4',
    result,
    // GA4 metrics occupy the same columns with a different meaning (sessions, users,
    // engagement, conversions); they are never treated as search queries.
    linkQueries: false,
    refreshMetrics: false,
  });

  await ctx.updateProgress(100, 'GA4 sync complete');
  return outcome;
};
