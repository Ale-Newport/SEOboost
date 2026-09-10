import { z } from 'zod';
import { PageType } from '@seo/db';
import { paginationSchema, round } from '@seo/shared';
import { csvResponse, readQuery, requireWebsite, route } from '@/lib/api';
import { booleanParam, formatParam, intParam, listParam } from '@/server/queries/filters';
import {
  type PageListItem,
  getPageFacets,
  listPages,
  listPagesForExport,
} from '@/server/queries/pages';

type Params = { id: string };

const querySchema = paginationSchema.extend({
  format: formatParam,
  pageType: listParam(z.nativeEnum(PageType)).optional(),
  statusCode: listParam(intParam).optional(),
  indexable: booleanParam.optional(),
  orphan: booleanParam.optional(),
  inSitemap: booleanParam.optional(),
  hasIssues: booleanParam.optional(),
  minWordCount: intParam.min(0).optional(),
  maxWordCount: intParam.min(0).optional(),
  includeInactive: booleanParam.optional(),
  /** Facets are a second round trip; the table asks for them once, not on every page change. */
  facets: booleanParam.optional(),
});

/** CSV columns are chosen for a spreadsheet, not for the API: flat, labelled, no nested objects. */
function toCsvRow(page: PageListItem): Record<string, unknown> {
  return {
    url: page.url,
    title: page.title ?? '',
    metaDescription: page.metaDescription ?? '',
    h1: page.h1 ?? '',
    pageType: page.pageType,
    statusCode: page.statusCode ?? '',
    indexable: page.isIndexable,
    indexabilityReason: page.indexabilityReason ?? '',
    inSitemap: page.inSitemap,
    orphan: page.isOrphan,
    depth: page.depth,
    wordCount: page.wordCount,
    internalLinksIn: page.internalLinksIn,
    internalLinksOut: page.internalLinksOut,
    clicks28d: page.clicks28d,
    impressions28d: page.impressions28d,
    // Stored as a rate; a percentage is what a spreadsheet reader expects to see.
    ctr28dPct: page.ctr28d === null ? '' : round(page.ctr28d * 100, 2),
    position28d: page.position28d ?? '',
    clicksTrendPct: page.clicksTrendPct ?? '',
    seoScore: page.seoScore ?? '',
    geoScore: page.geoScore ?? '',
    contentScore: page.contentScore ?? '',
    opportunityScore: page.opportunityScore ?? '',
    openIssues: page.openIssues,
    criticalIssues: page.criticalIssues,
    lastCrawledAt: page.lastCrawledAt ?? '',
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
    ...(query.pageType === undefined ? {} : { pageType: query.pageType }),
    ...(query.statusCode === undefined ? {} : { statusCode: query.statusCode }),
    ...(query.indexable === undefined ? {} : { indexable: query.indexable }),
    ...(query.orphan === undefined ? {} : { orphan: query.orphan }),
    ...(query.inSitemap === undefined ? {} : { inSitemap: query.inSitemap }),
    ...(query.hasIssues === undefined ? {} : { hasIssues: query.hasIssues }),
    ...(query.minWordCount === undefined ? {} : { minWordCount: query.minWordCount }),
    ...(query.maxWordCount === undefined ? {} : { maxWordCount: query.maxWordCount }),
    ...(query.includeInactive === undefined ? {} : { includeInactive: query.includeInactive }),
  };

  if (query.format === 'csv') {
    const { rows, truncated, total } = await listPagesForExport(filters);
    const filename = `${website.domain}-pages-${new Date().toISOString().slice(0, 10)}.csv`;
    const response = csvResponse(filename, rows.map(toCsvRow));
    // Announced in a header rather than an extra CSV row, so the file stays machine-readable.
    if (truncated) response.headers.set('X-Export-Truncated', `${rows.length}/${total}`);
    return response;
  }

  const [result, facets] = await Promise.all([
    listPages(filters),
    query.facets ? getPageFacets(website.id) : Promise.resolve(null),
  ]);

  return { ...result, facets };
});
