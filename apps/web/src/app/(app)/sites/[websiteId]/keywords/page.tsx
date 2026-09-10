import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { FunnelStage, KeywordSource, SearchIntent } from '@seo/db';
import { getCurrentUser } from '@/lib/auth';
import { getWebsiteDetail, websiteIdsForUser } from '@/server/queries/websites';
import {
  getKeywordFacets,
  isKeywordSortKey,
  listKeywords,
  type KeywordListFilters,
} from '@/server/queries/keywords';
import { KeywordsView } from '@/components/keywords/keywords-view';
import { POSITION_BANDS, isPositionBandId } from '@/components/keywords/position-bands';
import { getKeywordProfile, listKeywordClusters } from './queries';

export const metadata: Metadata = { title: 'Keywords' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** `?intent=A&intent=B` and `?intent=A,B` both mean the same thing to the filter bar. */
function list(params: SearchParams, key: string): string[] {
  const value = params[key];
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return raw.flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function enums<T extends string>(params: SearchParams, key: string, allowed: readonly T[]): T[] | undefined {
  const values = list(params, key).filter((value): value is T => (allowed as readonly string[]).includes(value));
  return values.length > 0 ? values : undefined;
}

function flag(params: SearchParams, key: string): boolean | undefined {
  const value = first(params, key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function positiveInt(params: SearchParams, key: string): number | undefined {
  const value = Number(first(params, key));
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : undefined;
}

/** URL params → the filter object `listKeywords` understands. One place, so the count matches the rows. */
function buildFilters(websiteId: string, params: SearchParams): KeywordListFilters {
  const sort = first(params, 'sort');
  const order = first(params, 'order');
  const clusterId = first(params, 'clusterId');
  const bandId = first(params, 'band');
  const band = bandId !== undefined && isPositionBandId(bandId) ? POSITION_BANDS[bandId] : null;

  const intent = enums(params, 'intent', Object.values(SearchIntent));
  const funnelStage = enums(params, 'funnelStage', Object.values(FunnelStage));
  const source = enums(params, 'source', Object.values(KeywordSource));
  const tracked = flag(params, 'tracked');
  const branded = flag(params, 'branded');
  const contentGap = flag(params, 'contentGap');
  const cannibalization = flag(params, 'cannibalization');
  const search = first(params, 'search');
  const page = positiveInt(params, 'page');
  const pageSize = positiveInt(params, 'pageSize');

  return {
    websiteId,
    ...(page === undefined ? {} : { page }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(sort !== undefined && isKeywordSortKey(sort) ? { sort } : {}),
    order: order === 'asc' ? 'asc' : 'desc',
    ...(search === undefined ? {} : { search }),
    ...(intent === undefined ? {} : { intent }),
    ...(funnelStage === undefined ? {} : { funnelStage }),
    ...(source === undefined ? {} : { source }),
    ...(clusterId === undefined ? {} : clusterId === 'none' ? { cluster: 'none' as const } : { clusterId }),
    ...(tracked === undefined ? {} : { tracked }),
    ...(branded === undefined ? {} : { branded }),
    ...(contentGap === undefined ? {} : { contentGap }),
    ...(cannibalization === undefined ? {} : { cannibalization }),
    ...(band === null
      ? {}
      : band.unranked
        ? { unranked: true }
        : {
            ...(band.min === undefined ? {} : { positionMin: band.min }),
            ...(band.max === undefined ? {} : { positionMax: band.max }),
          }),
  };
}

export default async function KeywordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  const query = await searchParams;

  // Ownership first: every read below is website-scoped but none of them proves the site is ours.
  const owned = await websiteIdsForUser(user.id, { includeArchived: true });
  if (!owned.includes(websiteId)) notFound();

  const website = await getWebsiteDetail(websiteId);
  if (!website) notFound();

  const filters = buildFilters(websiteId, query);
  // `?id=` is the open keyword. Resolving it here (rather than fetching from the Sheet) makes an
  // opened keyword a real, linkable, refresh-proof URL.
  const selectedId = first(query, 'id');

  const [keywords, facets, clusters, selected] = await Promise.all([
    listKeywords(filters),
    getKeywordFacets(websiteId),
    listKeywordClusters(websiteId),
    selectedId === undefined ? Promise.resolve(null) : getKeywordProfile(websiteId, selectedId),
  ]);

  const searchConsole = website.integrations.find(
    (integration) => integration.provider === 'GOOGLE_SEARCH_CONSOLE',
  );

  return (
    <KeywordsView
      website={{ id: website.id, name: website.name, domain: website.domain, url: website.url }}
      keywords={keywords}
      facets={facets}
      clusters={clusters}
      selected={selected}
      searchConsoleConnected={searchConsole?.status === 'CONNECTED'}
      defaultLocale={website.targetLocales[0] ?? website.primaryLanguage}
    />
  );
}
