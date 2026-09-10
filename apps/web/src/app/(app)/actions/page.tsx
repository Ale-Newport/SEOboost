import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CheckSquare } from 'lucide-react';
import { ActionRisk, ActionStatus, ActionType, prisma } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { getActionSummary, listActions, type ActionSort } from '@/server/queries/actions';
import { getApprovalSummary } from '@/server/queries/approvals';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { humanizeStatus } from '@/components/ui/badge';
import { ActionQueue, ActionQueueSummary, type ActionQueueRow } from '@/components/actions/action-queue';
import type { FacetOption } from '@/components/data';

export const metadata: Metadata = { title: 'AI actions' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/** `?status=A&status=B` and `?status=A,B` both mean the same thing. */
function paramList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function enumList<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T[] {
  const wanted = new Set(paramList(value).map((entry) => entry.toUpperCase()));
  return allowed.filter((entry) => wanted.has(entry));
}

function intParam(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const SORTS: readonly ActionSort[] = ['priorityScore', 'proposedAt', 'updatedAt', 'impactScore'];

function facets(counts: Record<string, number>, values: readonly string[]): FacetOption[] {
  return values
    .map((value) => ({ value, label: humanizeStatus(value), count: counts[value] ?? 0 }))
    .filter((option) => option.count > 0);
}

export default async function ActionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const query = await searchParams;

  const websites = await prisma.website.findMany({
    where: { userId: user.id, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }],
  });
  const ownedIds = websites.map((website) => website.id);

  // A site filter can only ever narrow the owned set — it can never widen the scope.
  const requestedSites = new Set(paramList(query.site));
  const websiteIds = requestedSites.size === 0 ? ownedIds : ownedIds.filter((id) => requestedSites.has(id));

  const status = enumList(query.status, Object.values(ActionStatus));
  const type = enumList(query.type, Object.values(ActionType));
  const risk = enumList(query.risk, Object.values(ActionRisk));
  const minPriority = intParam(query.minPriority);
  const search = typeof query.search === 'string' ? query.search : '';
  const page = Math.max(1, intParam(query.page) ?? 1);
  const pageSize = Math.min(200, Math.max(1, intParam(query.pageSize) ?? 25));
  const sort = SORTS.find((candidate) => candidate === query.sort) ?? 'priorityScore';
  const order = query.order === 'asc' ? 'asc' : 'desc';

  const [result, summary, approvals, bySite, autoExecutable] = await Promise.all([
    listActions({
      websiteIds,
      ...(status.length ? { status } : {}),
      ...(type.length ? { type } : {}),
      ...(risk.length ? { risk } : {}),
      ...(minPriority === undefined ? {} : { minPriority }),
      ...(search ? { search } : {}),
      page,
      pageSize,
      sort,
      order,
    }),
    getActionSummary(ownedIds),
    getApprovalSummary(ownedIds),
    prisma.seoAction.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: ownedIds } },
      _count: { _all: true },
    }),
    prisma.seoAction.count({ where: { websiteId: { in: ownedIds }, autoExecutable: true } }),
  ]);

  const siteCounts = new Map(bySite.map((row) => [row.websiteId, row._count._all]));
  const siteOptions: FacetOption[] = websites
    .map((website) => ({
      value: website.id,
      label: website.name,
      count: siteCounts.get(website.id) ?? 0,
    }))
    .filter((option) => option.count > 0);

  const rankOffset = (page - 1) * pageSize;
  const rows: ActionQueueRow[] = result.items.map((item, index) => ({ ...item, rank: rankOffset + index + 1 }));

  const filtered =
    requestedSites.size > 0 ||
    status.length > 0 ||
    type.length > 0 ||
    risk.length > 0 ||
    minPriority !== undefined ||
    search.length > 0;

  return (
    <div className="space-y-4 px-4 py-6 md:px-6">
      <PageHeader
        title="AI actions"
        description="Everything the agents propose to do next, across every website you own, ranked by expected value per unit of effort and risk."
        actions={
          approvals.pending > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/approvals">
                <CheckSquare className="mr-1.5 h-3.5 w-3.5" />
                {approvals.pending} waiting on you
              </Link>
            </Button>
          ) : null
        }
      />

      <ActionQueueSummary
        total={summary.total}
        awaitingApproval={summary.awaitingApproval}
        readyToExecute={summary.readyToExecute}
        autoExecutable={autoExecutable}
      />

      <ActionQueue
        rows={rows}
        total={result.total}
        page={page}
        pageSize={pageSize}
        sort={sort}
        order={order}
        siteOptions={siteOptions}
        statusOptions={facets(summary.byStatus, Object.values(ActionStatus))}
        typeOptions={facets(summary.byType, Object.values(ActionType))}
        riskOptions={facets(summary.byRisk, Object.values(ActionRisk))}
        filtered={filtered}
      />
    </div>
  );
}
