import { z } from 'zod';
import { prisma } from '@seo/db';
import { dateRangeSchema, formatDateKey } from '@seo/shared';
import { readQuery, requireWebsite, route } from '@/lib/api';
import { booleanParam, intParam } from '@/server/queries/filters';
import {
  getKeywordCounts,
  getPerformanceSeries,
  getPerformanceSummary,
  getRankingDistribution,
  getSegmentBreakdown,
  getTopQueries,
  resolveRange,
} from '@/server/queries/analytics';

type Params = { id: string };

const querySchema = dateRangeSchema.extend({
  country: z.string().trim().min(2).max(3).optional(),
  device: z.enum(['DESKTOP', 'MOBILE', 'TABLET']).optional(),
  /**
   * 'gsc' (default) or 'bing'; both land in the same tables under different source keys.
   * Closed to an enum on purpose — a typo used to select a source that exists nowhere, and
   * the screen would render "no traffic" for a site that has plenty.
   */
  source: z.enum(['gsc', 'bing']).optional(),
  queryLimit: intParam.min(1).max(200).optional(),
  /** Segment breakdowns are two extra scans; the summary cards do not need them. */
  segments: booleanParam.optional(),
  /**
   * `dateRangeSchema.compare` is a `z.coerce.boolean()`, which turns the string "false" into
   * `true` — so `?compare=false` would silently draw a comparison overlay. Re-declared here
   * with the wire-format parser every other filter in this app uses.
   */
  compare: booleanParam.optional(),
});

/**
 * Search performance for one site.
 *
 * Everything comes from imported Search Console / Bing rows. With no integration connected the
 * totals are zero, the series is a flat line of real zeros and `hasData` is false — the screen
 * then points at the integration settings instead of drawing an invented trend.
 *
 * The default window ends three days short of today because Search Console data lags: charting
 * a partial final day makes every site look like it fell off a cliff this morning.
 */
export const GET = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const query = readQuery(request, querySchema);

  const filters = {
    websiteId: website.id,
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.days === undefined ? {} : { days: query.days }),
    ...(query.country === undefined ? {} : { country: query.country }),
    ...(query.device === undefined ? {} : { device: query.device }),
    ...(query.source === undefined ? {} : { source: query.source }),
    compare: query.compare ?? false,
  };

  const { range } = resolveRange(filters);
  const wantsSegments = query.segments ?? true;

  const [summary, series, topQueries, countries, devices, rankingDistribution, keywordCounts, integration] =
    await Promise.all([
      getPerformanceSummary(filters),
      getPerformanceSeries(filters),
      getTopQueries(website.id, range, query.queryLimit ?? 50, { source: filters.source ?? 'gsc' }),
      wantsSegments ? getSegmentBreakdown(website.id, range, 'country') : Promise.resolve([]),
      wantsSegments ? getSegmentBreakdown(website.id, range, 'device') : Promise.resolve([]),
      getRankingDistribution(website.id),
      getKeywordCounts([website.id]),
      prisma.integration.findFirst({
        where: { websiteId: website.id, provider: 'GOOGLE_SEARCH_CONSOLE' },
        select: { status: true, lastSyncAt: true, lastSyncStatus: true },
      }),
    ]);

  return {
    range: { from: formatDateKey(range.start), to: formatDateKey(range.end) },
    summary,
    series,
    topQueries,
    segments: { country: countries, device: devices },
    rankingDistribution,
    keywordCounts,
    // Lets the UI tell "no traffic" apart from "never connected", which are very different
    // messages to show someone staring at an empty chart.
    searchConsole: {
      status: integration?.status ?? 'NOT_CONFIGURED',
      lastSyncAt: integration?.lastSyncAt ?? null,
      lastSyncStatus: integration?.lastSyncStatus ?? null,
    },
  };
});
