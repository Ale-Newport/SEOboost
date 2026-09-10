import { z } from 'zod';
import { FunnelStage, KeywordSource, SearchIntent } from '@seo/db';
import { paginationSchema, round } from '@seo/shared';
import { csvResponse, readQuery, requireWebsite, route } from '@/lib/api';
import { booleanParam, floatParam, formatParam, intParam, listParam } from '@/server/queries/filters';
import {
  type KeywordListItem,
  getKeywordFacets,
  listKeywords,
  listKeywordsForExport,
} from '@/server/queries/keywords';

type Params = { id: string };

const querySchema = paginationSchema.extend({
  format: formatParam,
  intent: listParam(z.nativeEnum(SearchIntent)).optional(),
  funnelStage: listParam(z.nativeEnum(FunnelStage)).optional(),
  source: listParam(z.nativeEnum(KeywordSource)).optional(),
  clusterId: z.string().trim().max(60).optional(),
  cluster: z.literal('none').optional(),
  pageId: z.string().trim().max(60).optional(),
  tracked: booleanParam.optional(),
  branded: booleanParam.optional(),
  contentGap: booleanParam.optional(),
  cannibalization: booleanParam.optional(),
  unranked: booleanParam.optional(),
  positionMin: floatParam.min(1).max(100).optional(),
  positionMax: floatParam.min(1).max(100).optional(),
  minVolume: intParam.min(0).optional(),
  minImpressions: intParam.min(0).optional(),
  facets: booleanParam.optional(),
});

function toCsvRow(keyword: KeywordListItem): Record<string, unknown> {
  return {
    keyword: keyword.keyword,
    locale: keyword.locale,
    intent: keyword.intent,
    funnelStage: keyword.funnelStage,
    source: keyword.source,
    tracked: keyword.isTracked,
    branded: keyword.isBranded,
    searchVolume: keyword.searchVolume ?? '',
    difficulty: keyword.difficulty ?? '',
    cpc: keyword.cpc ?? '',
    currentPosition: keyword.currentPosition ?? '',
    previousPosition: keyword.previousPosition ?? '',
    positionChange: keyword.positionChange ?? '',
    bestPosition: keyword.bestPosition ?? '',
    rankingUrl: keyword.rankingUrl ?? '',
    clicks28d: keyword.clicks28d,
    impressions28d: keyword.impressions28d,
    ctr28dPct: keyword.ctr28d === null ? '' : round(keyword.ctr28d * 100, 2),
    position28d: keyword.position28d ?? '',
    opportunityScore: keyword.opportunityScore ?? '',
    opportunityReason: keyword.opportunityReason ?? '',
    businessValue: keyword.businessValue ?? '',
    geoPotential: keyword.geoPotential ?? '',
    cluster: keyword.clusterName ?? '',
    mappedPage: keyword.pageUrl ?? '',
    contentGap: keyword.isContentGap,
    cannibalization: keyword.hasCannibalization,
  };
}

export const GET = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const query = readQuery(request, querySchema);

  const filters = {
    websiteId: website.id,
    page: query.page,
    pageSize: query.pageSize,
    ...(query.sort === undefined ? {} : { sort: query.sort }),
    order: query.order,
    ...(query.search === undefined ? {} : { search: query.search }),
    ...(query.intent === undefined ? {} : { intent: query.intent }),
    ...(query.funnelStage === undefined ? {} : { funnelStage: query.funnelStage }),
    ...(query.source === undefined ? {} : { source: query.source }),
    ...(query.clusterId === undefined ? {} : { clusterId: query.clusterId }),
    ...(query.cluster === undefined ? {} : { cluster: query.cluster }),
    ...(query.pageId === undefined ? {} : { pageId: query.pageId }),
    ...(query.tracked === undefined ? {} : { tracked: query.tracked }),
    ...(query.branded === undefined ? {} : { branded: query.branded }),
    ...(query.contentGap === undefined ? {} : { contentGap: query.contentGap }),
    ...(query.cannibalization === undefined ? {} : { cannibalization: query.cannibalization }),
    ...(query.unranked === undefined ? {} : { unranked: query.unranked }),
    ...(query.positionMin === undefined ? {} : { positionMin: query.positionMin }),
    ...(query.positionMax === undefined ? {} : { positionMax: query.positionMax }),
    ...(query.minVolume === undefined ? {} : { minVolume: query.minVolume }),
    ...(query.minImpressions === undefined ? {} : { minImpressions: query.minImpressions }),
  };

  if (query.format === 'csv') {
    const { rows, truncated, total } = await listKeywordsForExport(filters);
    const filename = `${website.domain}-keywords-${new Date().toISOString().slice(0, 10)}.csv`;
    const response = csvResponse(filename, rows.map(toCsvRow));
    if (truncated) response.headers.set('X-Export-Truncated', `${rows.length}/${total}`);
    return response;
  }

  const [result, facets] = await Promise.all([
    listKeywords(filters),
    query.facets ? getKeywordFacets(website.id) : Promise.resolve(null),
  ]);

  return { ...result, facets };
});
