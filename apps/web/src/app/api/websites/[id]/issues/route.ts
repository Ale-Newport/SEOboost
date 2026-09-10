import { z } from 'zod';
import { IssueCategory, IssueSeverity, IssueStatus } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { csvResponse, readQuery, requireWebsite, route } from '@/lib/api';
import { booleanParam, formatParam, listParam } from '@/server/queries/filters';
import {
  type IssueListItem,
  getIssueFacets,
  listIssues,
  listIssuesForExport,
} from '@/server/queries/issues';

type Params = { id: string };

const querySchema = paginationSchema.extend({
  format: formatParam,
  severity: listParam(z.nativeEnum(IssueSeverity)).optional(),
  category: listParam(z.nativeEnum(IssueCategory)).optional(),
  status: listParam(z.nativeEnum(IssueStatus)).optional(),
  ruleId: listParam(z.string().min(1).max(120)).optional(),
  url: z.string().trim().max(2048).optional(),
  pageId: z.string().trim().max(60).optional(),
  crawlId: z.string().trim().max(60).optional(),
  autoFixable: booleanParam.optional(),
  facets: booleanParam.optional(),
});

function toCsvRow(issue: IssueListItem): Record<string, unknown> {
  return {
    severity: issue.severity,
    category: issue.category,
    status: issue.status,
    ruleId: issue.ruleId,
    title: issue.title,
    url: issue.url ?? issue.pageUrl ?? '',
    description: issue.description,
    recommendation: issue.recommendation,
    estimatedImpact: issue.estimatedImpact,
    confidence: issue.confidence,
    autoFixable: issue.autoFixable,
    discoveredAt: issue.discoveredAt,
    lastSeenAt: issue.lastSeenAt,
    resolvedAt: issue.resolvedAt ?? '',
    ignoredReason: issue.ignoredReason ?? '',
  };
}

/**
 * Technical issues for a site.
 *
 * With no `status` filter the list shows OPEN and REGRESSED only: a regression is a problem
 * that came back, and burying it in "resolved" history is exactly how it gets missed.
 */
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
    ...(query.severity === undefined ? {} : { severity: query.severity }),
    ...(query.category === undefined ? {} : { category: query.category }),
    ...(query.status === undefined ? {} : { status: query.status }),
    ...(query.ruleId === undefined ? {} : { ruleId: query.ruleId }),
    ...(query.url === undefined ? {} : { url: query.url }),
    ...(query.pageId === undefined ? {} : { pageId: query.pageId }),
    ...(query.crawlId === undefined ? {} : { crawlId: query.crawlId }),
    ...(query.autoFixable === undefined ? {} : { autoFixable: query.autoFixable }),
  };

  if (query.format === 'csv') {
    const { rows, truncated, total } = await listIssuesForExport(filters);
    const filename = `${website.domain}-issues-${new Date().toISOString().slice(0, 10)}.csv`;
    const response = csvResponse(filename, rows.map(toCsvRow));
    if (truncated) response.headers.set('X-Export-Truncated', `${rows.length}/${total}`);
    return response;
  }

  const [result, facets] = await Promise.all([
    listIssues(filters),
    query.facets ? getIssueFacets(website.id) : Promise.resolve(null),
  ]);

  return { ...result, facets };
});
