import 'server-only';
import {
  type FunnelStage,
  type KeywordSource,
  Prisma,
  type SearchIntent,
  prisma,
} from '@seo/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, type Paginated } from '@seo/shared';

/**
 * Keyword read models for `/api/websites/[id]/keywords` and the Keywords screen.
 *
 * Positions and traffic come from the denormalised columns the GSC sync maintains. A site with
 * no Search Console connection has keywords with null positions and zero impressions — that is
 * the truth, and the screen shows it as "connect Search Console", not as rank 0.
 */

const KEYWORD_SORT_COLUMNS = {
  keyword: 'keyword',
  currentPosition: 'currentPosition',
  positionChange: 'positionChange',
  bestPosition: 'bestPosition',
  searchVolume: 'searchVolume',
  difficulty: 'difficulty',
  cpc: 'cpc',
  clicks28d: 'clicks28d',
  impressions28d: 'impressions28d',
  ctr28d: 'ctr28d',
  position28d: 'position28d',
  opportunityScore: 'opportunityScore',
  businessValue: 'businessValue',
  geoPotential: 'geoPotential',
  firstSeenAt: 'firstSeenAt',
  lastSeenAt: 'lastSeenAt',
} as const satisfies Record<string, keyof Prisma.KeywordOrderByWithRelationInput>;

export type KeywordSortKey = keyof typeof KEYWORD_SORT_COLUMNS;

export function isKeywordSortKey(value: string): value is KeywordSortKey {
  return Object.hasOwn(KEYWORD_SORT_COLUMNS, value);
}

export interface KeywordListFilters {
  websiteId: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
  intent?: SearchIntent[];
  funnelStage?: FunnelStage[];
  source?: KeywordSource[];
  clusterId?: string;
  /** 'none' selects keywords that clustering has not assigned yet. */
  cluster?: 'none';
  pageId?: string;
  tracked?: boolean;
  branded?: boolean;
  contentGap?: boolean;
  cannibalization?: boolean;
  /** Inclusive rank window; combine with `positionMax` for a striking-distance view. */
  positionMin?: number;
  positionMax?: number;
  /** Keywords that rank nowhere at all — the discovery backlog. */
  unranked?: boolean;
  minVolume?: number;
  minImpressions?: number;
}

export interface KeywordListItem {
  id: string;
  keyword: string;
  normalized: string;
  locale: string;
  intent: SearchIntent;
  funnelStage: FunnelStage;
  source: KeywordSource;
  isTracked: boolean;
  isBranded: boolean;
  isContentGap: boolean;
  hasCannibalization: boolean;
  searchVolume: number | null;
  difficulty: number | null;
  cpc: number | null;
  currentPosition: number | null;
  previousPosition: number | null;
  positionChange: number | null;
  bestPosition: number | null;
  rankingUrl: string | null;
  clicks28d: number;
  impressions28d: number;
  ctr28d: number | null;
  position28d: number | null;
  opportunityScore: number | null;
  opportunityReason: string | null;
  businessValue: number | null;
  geoPotential: number | null;
  clusterId: string | null;
  clusterName: string | null;
  pageId: string | null;
  pageUrl: string | null;
  lastSeenAt: Date;
}

const KEYWORD_LIST_SELECT = {
  id: true,
  keyword: true,
  normalized: true,
  locale: true,
  intent: true,
  funnelStage: true,
  source: true,
  isTracked: true,
  isBranded: true,
  isContentGap: true,
  hasCannibalization: true,
  searchVolume: true,
  difficulty: true,
  cpc: true,
  currentPosition: true,
  previousPosition: true,
  positionChange: true,
  bestPosition: true,
  rankingUrl: true,
  clicks28d: true,
  impressions28d: true,
  ctr28d: true,
  position28d: true,
  opportunityScore: true,
  opportunityReason: true,
  businessValue: true,
  geoPotential: true,
  clusterId: true,
  pageId: true,
  lastSeenAt: true,
  cluster: { select: { name: true } },
  page: { select: { url: true } },
} satisfies Prisma.KeywordSelect;

type KeywordRow = Prisma.KeywordGetPayload<{ select: typeof KEYWORD_LIST_SELECT }>;

function toListItem(row: KeywordRow): KeywordListItem {
  const { cluster, page, ...rest } = row;
  return { ...rest, clusterName: cluster?.name ?? null, pageUrl: page?.url ?? null };
}

function buildKeywordWhere(filters: KeywordListFilters): Prisma.KeywordWhereInput {
  const where: Prisma.KeywordWhereInput = { websiteId: filters.websiteId };

  if (filters.intent && filters.intent.length > 0) where.intent = { in: filters.intent };
  if (filters.funnelStage && filters.funnelStage.length > 0) where.funnelStage = { in: filters.funnelStage };
  if (filters.source && filters.source.length > 0) where.source = { in: filters.source };
  if (filters.clusterId) where.clusterId = filters.clusterId;
  if (filters.cluster === 'none') where.clusterId = null;
  if (filters.pageId) where.pageId = filters.pageId;
  if (filters.tracked !== undefined) where.isTracked = filters.tracked;
  if (filters.branded !== undefined) where.isBranded = filters.branded;
  if (filters.contentGap !== undefined) where.isContentGap = filters.contentGap;
  if (filters.cannibalization !== undefined) where.hasCannibalization = filters.cannibalization;
  if (filters.minVolume !== undefined) where.searchVolume = { gte: filters.minVolume };
  if (filters.minImpressions !== undefined) where.impressions28d = { gte: filters.minImpressions };

  if (filters.unranked) {
    where.currentPosition = null;
  } else if (filters.positionMin !== undefined || filters.positionMax !== undefined) {
    where.currentPosition = {
      ...(filters.positionMin !== undefined ? { gte: filters.positionMin } : {}),
      ...(filters.positionMax !== undefined ? { lte: filters.positionMax } : {}),
    };
  }

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { keyword: { contains: search, mode: 'insensitive' } },
      { normalized: { contains: search.toLowerCase() } },
    ];
  }

  return where;
}

function buildKeywordOrderBy(
  sort: string | undefined,
  order: 'asc' | 'desc',
): Prisma.KeywordOrderByWithRelationInput[] {
  const column = sort && isKeywordSortKey(sort) ? KEYWORD_SORT_COLUMNS[sort] : null;
  if (!column) {
    return [
      { opportunityScore: { sort: 'desc', nulls: 'last' } },
      { impressions28d: 'desc' },
      { keyword: 'asc' },
    ];
  }
  return [{ [column]: { sort: order, nulls: 'last' } }, { keyword: 'asc' }];
}

export async function listKeywords(filters: KeywordListFilters): Promise<Paginated<KeywordListItem>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const where = buildKeywordWhere(filters);

  const [rows, total] = await Promise.all([
    prisma.keyword.findMany({
      where,
      select: KEYWORD_LIST_SELECT,
      orderBy: buildKeywordOrderBy(filters.sort, filters.order ?? 'desc'),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.keyword.count({ where }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Capped export of the current filter selection. `truncated` tells the UI the file is partial. */
export async function listKeywordsForExport(
  filters: KeywordListFilters,
  limit = 20_000,
): Promise<{ rows: KeywordListItem[]; truncated: boolean; total: number }> {
  const where = buildKeywordWhere(filters);
  const total = await prisma.keyword.count({ where });
  const rows = await prisma.keyword.findMany({
    where,
    select: KEYWORD_LIST_SELECT,
    orderBy: buildKeywordOrderBy(filters.sort, filters.order ?? 'desc'),
    take: limit,
  });
  return { rows: rows.map(toListItem), truncated: total > rows.length, total };
}

export interface KeywordFacets {
  total: number;
  tracked: number;
  branded: number;
  contentGaps: number;
  cannibalized: number;
  unclustered: number;
  intent: Array<{ value: SearchIntent; count: number }>;
  funnelStage: Array<{ value: FunnelStage; count: number }>;
  source: Array<{ value: KeywordSource; count: number }>;
  clusters: Array<{ id: string; name: string; keywordCount: number; opportunityScore: number | null }>;
  positionBuckets: Array<{ bucket: string; count: number }>;
}

/** Counts behind the Keywords filter bar. Every number is a real count, including the zeros. */
export async function getKeywordFacets(websiteId: string): Promise<KeywordFacets> {
  const where = { websiteId };

  const [
    total,
    tracked,
    branded,
    contentGaps,
    cannibalized,
    unclustered,
    byIntent,
    byFunnel,
    bySource,
    clusters,
    top3,
    top10,
    top20,
    top50,
    top100,
  ] = await Promise.all([
    prisma.keyword.count({ where }),
    prisma.keyword.count({ where: { ...where, isTracked: true } }),
    prisma.keyword.count({ where: { ...where, isBranded: true } }),
    prisma.keyword.count({ where: { ...where, isContentGap: true } }),
    prisma.keyword.count({ where: { ...where, hasCannibalization: true } }),
    prisma.keyword.count({ where: { ...where, clusterId: null } }),
    prisma.keyword.groupBy({ by: ['intent'], where, _count: { _all: true } }),
    prisma.keyword.groupBy({ by: ['funnelStage'], where, _count: { _all: true } }),
    prisma.keyword.groupBy({ by: ['source'], where, _count: { _all: true } }),
    prisma.keywordCluster.findMany({
      where,
      select: { id: true, name: true, keywordCount: true, opportunityScore: true },
      orderBy: [{ opportunityScore: { sort: 'desc', nulls: 'last' } }, { keywordCount: 'desc' }],
      take: 200,
    }),
    prisma.keyword.count({ where: { ...where, currentPosition: { gt: 0, lte: 3 } } }),
    prisma.keyword.count({ where: { ...where, currentPosition: { gt: 3, lte: 10 } } }),
    prisma.keyword.count({ where: { ...where, currentPosition: { gt: 10, lte: 20 } } }),
    prisma.keyword.count({ where: { ...where, currentPosition: { gt: 20, lte: 50 } } }),
    prisma.keyword.count({ where: { ...where, currentPosition: { gt: 50, lte: 100 } } }),
  ]);

  return {
    total,
    tracked,
    branded,
    contentGaps,
    cannibalized,
    unclustered,
    intent: byIntent
      .map((row) => ({ value: row.intent, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    funnelStage: byFunnel
      .map((row) => ({ value: row.funnelStage, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    source: bySource
      .map((row) => ({ value: row.source, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    clusters,
    positionBuckets: [
      { bucket: '1-3', count: top3 },
      { bucket: '4-10', count: top10 },
      { bucket: '11-20', count: top20 },
      { bucket: '21-50', count: top50 },
      { bucket: '51-100', count: top100 },
    ],
  };
}
