import 'server-only';
import {
  type IssueCategory,
  type IssueSeverity,
  type IssueStatus,
  Prisma,
  prisma,
} from '@seo/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, SEVERITY_ORDER, type Paginated } from '@seo/shared';

/**
 * Technical issue read models for `/api/websites/[id]/issues` and the Technical SEO screen.
 *
 * Issues are deduplicated in the database by `fingerprint`, so this layer never has to collapse
 * rows: one row is one live problem, and its `lastSeenAt` is how the UI shows staleness.
 */

const ISSUE_SORT_COLUMNS = {
  severity: 'severity',
  category: 'category',
  status: 'status',
  ruleId: 'ruleId',
  url: 'url',
  title: 'title',
  estimatedImpact: 'estimatedImpact',
  confidence: 'confidence',
  discoveredAt: 'discoveredAt',
  lastSeenAt: 'lastSeenAt',
} as const satisfies Record<string, keyof Prisma.TechnicalIssueOrderByWithRelationInput>;

export type IssueSortKey = keyof typeof ISSUE_SORT_COLUMNS;

export function isIssueSortKey(value: string): value is IssueSortKey {
  return Object.hasOwn(ISSUE_SORT_COLUMNS, value);
}

/** The statuses that mean "still a problem". Used by every default filter and count. */
export const LIVE_ISSUE_STATUSES: IssueStatus[] = ['OPEN', 'REGRESSED'];

export interface IssueListFilters {
  websiteId: string;
  page?: number;
  pageSize?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  /** Matches title, url, ruleId or description. */
  search?: string;
  severity?: IssueSeverity[];
  category?: IssueCategory[];
  status?: IssueStatus[];
  ruleId?: string[];
  /** Substring match against the affected URL. */
  url?: string;
  pageId?: string;
  crawlId?: string;
  autoFixable?: boolean;
}

export interface IssueListItem {
  id: string;
  ruleId: string;
  title: string;
  category: IssueCategory;
  severity: IssueSeverity;
  status: IssueStatus;
  url: string | null;
  description: string;
  recommendation: string;
  estimatedImpact: number;
  confidence: number;
  autoFixable: boolean;
  pageId: string | null;
  pageUrl: string | null;
  discoveredAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  ignoredAt: Date | null;
  ignoredReason: string | null;
}

const ISSUE_LIST_SELECT = {
  id: true,
  ruleId: true,
  title: true,
  category: true,
  severity: true,
  status: true,
  url: true,
  description: true,
  recommendation: true,
  estimatedImpact: true,
  confidence: true,
  autoFixable: true,
  pageId: true,
  discoveredAt: true,
  lastSeenAt: true,
  resolvedAt: true,
  ignoredAt: true,
  ignoredReason: true,
  page: { select: { url: true } },
} satisfies Prisma.TechnicalIssueSelect;

type IssueRow = Prisma.TechnicalIssueGetPayload<{ select: typeof ISSUE_LIST_SELECT }>;

function toListItem(row: IssueRow): IssueListItem {
  const { page, ...rest } = row;
  return { ...rest, pageUrl: page?.url ?? null };
}

function buildIssueWhere(filters: IssueListFilters): Prisma.TechnicalIssueWhereInput {
  const where: Prisma.TechnicalIssueWhereInput = { websiteId: filters.websiteId };

  // No explicit status filter means "what is still broken" — resolved history is opt-in.
  where.status = { in: filters.status && filters.status.length > 0 ? filters.status : LIVE_ISSUE_STATUSES };

  if (filters.severity && filters.severity.length > 0) where.severity = { in: filters.severity };
  if (filters.category && filters.category.length > 0) where.category = { in: filters.category };
  if (filters.ruleId && filters.ruleId.length > 0) where.ruleId = { in: filters.ruleId };
  if (filters.pageId) where.pageId = filters.pageId;
  if (filters.crawlId) where.crawlId = filters.crawlId;
  if (filters.autoFixable !== undefined) where.autoFixable = filters.autoFixable;
  if (filters.url) where.url = { contains: filters.url, mode: 'insensitive' };

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { url: { contains: search, mode: 'insensitive' } },
      { ruleId: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }

  return where;
}

function buildIssueOrderBy(
  sort: string | undefined,
  order: 'asc' | 'desc',
): Prisma.TechnicalIssueOrderByWithRelationInput[] {
  const column = sort && isIssueSortKey(sort) ? ISSUE_SORT_COLUMNS[sort] : null;
  if (!column) {
    // Enum order is declaration order in Postgres, and IssueSeverity is declared worst-first,
    // so ascending severity really is "most severe first".
    return [{ severity: 'asc' }, { estimatedImpact: 'desc' }, { lastSeenAt: 'desc' }];
  }
  return [{ [column]: order }, { lastSeenAt: 'desc' }];
}

export async function listIssues(filters: IssueListFilters): Promise<Paginated<IssueListItem>> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(Math.max(1, filters.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  const where = buildIssueWhere(filters);

  const [rows, total] = await Promise.all([
    prisma.technicalIssue.findMany({
      where,
      select: ISSUE_LIST_SELECT,
      orderBy: buildIssueOrderBy(filters.sort, filters.order ?? 'asc'),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.technicalIssue.count({ where }),
  ]);

  return {
    items: rows.map(toListItem),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function listIssuesForExport(
  filters: IssueListFilters,
  limit = 20_000,
): Promise<{ rows: IssueListItem[]; truncated: boolean; total: number }> {
  const where = buildIssueWhere(filters);
  const total = await prisma.technicalIssue.count({ where });
  const rows = await prisma.technicalIssue.findMany({
    where,
    select: ISSUE_LIST_SELECT,
    orderBy: buildIssueOrderBy(filters.sort, filters.order ?? 'asc'),
    take: limit,
  });
  return { rows: rows.map(toListItem), truncated: total > rows.length, total };
}

export interface IssueFacets {
  total: number;
  live: number;
  autoFixable: number;
  severity: Array<{ value: IssueSeverity; count: number }>;
  category: Array<{ value: IssueCategory; count: number }>;
  status: Array<{ value: IssueStatus; count: number }>;
  /** The rules producing the most live issues — the shortlist worth fixing in bulk. */
  topRules: Array<{ ruleId: string; title: string; severity: IssueSeverity; count: number }>;
}

export async function getIssueFacets(websiteId: string): Promise<IssueFacets> {
  const live: Prisma.TechnicalIssueWhereInput = { websiteId, status: { in: LIVE_ISSUE_STATUSES } };

  const [total, liveCount, autoFixable, bySeverity, byCategory, byStatus, byRule] = await Promise.all([
    prisma.technicalIssue.count({ where: { websiteId } }),
    prisma.technicalIssue.count({ where: live }),
    prisma.technicalIssue.count({ where: { ...live, autoFixable: true } }),
    prisma.technicalIssue.groupBy({ by: ['severity'], where: live, _count: { _all: true } }),
    prisma.technicalIssue.groupBy({ by: ['category'], where: live, _count: { _all: true } }),
    prisma.technicalIssue.groupBy({ by: ['status'], where: { websiteId }, _count: { _all: true } }),
    prisma.technicalIssue.groupBy({
      by: ['ruleId', 'title', 'severity'],
      where: live,
      _count: { _all: true },
      orderBy: { _count: { ruleId: 'desc' } },
      take: 25,
    }),
  ]);

  const severityRank = (value: IssueSeverity) => SEVERITY_ORDER.indexOf(value);

  return {
    total,
    live: liveCount,
    autoFixable,
    severity: bySeverity
      .map((row) => ({ value: row.severity, count: row._count._all }))
      .sort((a, b) => severityRank(a.value) - severityRank(b.value)),
    category: byCategory
      .map((row) => ({ value: row.category, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    status: byStatus
      .map((row) => ({ value: row.status, count: row._count._all }))
      .sort((a, b) => b.count - a.count),
    topRules: byRule.map((row) => ({
      ruleId: row.ruleId,
      title: row.title,
      severity: row.severity,
      count: row._count._all,
    })),
  };
}
