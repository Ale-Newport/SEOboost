import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { type Prisma, prisma, readJson } from '@seo/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@seo/shared/constants';

import { PageHeader } from '@/components/ui/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ReportsView, type ReportRow } from '@/components/reports/reports-view';
import { parseReportData, readHighlights, humanizeKey } from '@/components/reports/report-data';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Reports' };
export const dynamic = 'force-dynamic';

/**
 * Ordering is resolved from a closed set rather than by interpolating the URL value into the
 * `orderBy` object — a param must never be able to name an arbitrary column.
 */
function orderByFor(sort: string | undefined, order: Prisma.SortOrder): Prisma.ReportOrderByWithRelationInput[] {
  const primary: Prisma.ReportOrderByWithRelationInput =
    sort === 'title'
      ? { title: order }
      : sort === 'type'
        ? { type: order }
        : sort === 'createdAt'
          ? { createdAt: order }
          : { periodEnd: order };
  return [primary, { createdAt: 'desc' }];
}

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function many(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry !== '');
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;

  const websites = await prisma.website.findMany({
    where: { userId: user.id, status: { not: 'ARCHIVED' } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const ownedIds = websites.map((site) => site.id);

  // A site filter can only ever narrow the ids this user owns, so it cannot widen the result set.
  const requestedSites = many(params.site).filter((id) => ownedIds.includes(id));
  const scopedIds = requestedSites.length > 0 ? requestedSites : ownedIds;
  const types = many(params.type);
  const search = one(params.search)?.trim() ?? '';

  const ownership: Prisma.ReportWhereInput[] = [{ websiteId: { in: scopedIds } }];
  // Portfolio reports belong to no site; they only make sense when no site filter is applied.
  if (requestedSites.length === 0) ownership.push({ websiteId: null });

  const where: Prisma.ReportWhereInput = {
    OR: ownership,
    ...(types.length > 0 ? { type: { in: types } } : {}),
    ...(search ? { title: { contains: search, mode: 'insensitive' } } : {}),
  };

  const page = positiveInt(one(params.page), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(one(params.pageSize), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const order: Prisma.SortOrder = one(params.order) === 'asc' ? 'asc' : 'desc';

  const [reports, total, libraryTotal, typeGroups] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: orderByFor(one(params.sort), order),
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        websiteId: true,
        type: true,
        title: true,
        periodStart: true,
        periodEnd: true,
        summary: true,
        highlights: true,
        data: true,
        createdAt: true,
        website: { select: { name: true } },
      },
    }),
    prisma.report.count({ where }),
    prisma.report.count({ where: { OR: [{ websiteId: { in: ownedIds } }, { websiteId: null }] } }),
    prisma.report.groupBy({
      by: ['type'],
      where: { OR: [{ websiteId: { in: ownedIds } }, { websiteId: null }] },
      _count: { _all: true },
    }),
  ]);

  const rows: ReportRow[] = reports.map((report) => {
    // The headline numbers come from the stored payload — nothing is recomputed or invented
    // here, so a report generated before Search Console was connected shows an em dash.
    const parsed = parseReportData(readJson<Record<string, unknown>>(report.data, {}));
    return {
      id: report.id,
      title: report.title,
      type: report.type,
      websiteId: report.websiteId,
      websiteName: report.website?.name ?? null,
      periodStart: report.periodStart.toISOString(),
      periodEnd: report.periodEnd.toISOString(),
      createdAt: report.createdAt.toISOString(),
      summary: report.summary,
      clicks: parsed.performance?.clicks?.value ?? null,
      clicksChangePct: parsed.performance?.clicks?.changePct ?? null,
      impressions: parsed.performance?.impressions?.value ?? null,
      impressionsChangePct: parsed.performance?.impressions?.changePct ?? null,
      highlights: readHighlights(readJson<unknown[]>(report.highlights, [])).length,
    };
  });

  const typeOptions = typeGroups
    .map((group) => ({
      value: group.type,
      label: humanizeKey(group.type),
      count: group._count._all,
    }))
    .sort((a, b) => b.count - a.count);

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Reports"
        description={
          libraryTotal === 0
            ? 'Period summaries for a single site or for the whole portfolio.'
            : `${libraryTotal} report${libraryTotal === 1 ? '' : 's'} across ${websites.length} site${websites.length === 1 ? '' : 's'}`
        }
      />

      {websites.length === 0 ? (
        <Alert variant="warning">
          <AlertTitle>No websites yet</AlertTitle>
          <AlertDescription>
            Reports summarise a site&rsquo;s period. Add a website first and the scheduler will start
            producing weekly summaries for it.
          </AlertDescription>
        </Alert>
      ) : null}

      <ReportsView
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        sites={websites}
        typeOptions={typeOptions}
        libraryEmpty={libraryTotal === 0}
      />
    </div>
  );
}
