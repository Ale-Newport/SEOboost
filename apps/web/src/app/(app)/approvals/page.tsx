import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bot } from 'lucide-react';

import { ActionRisk, ApprovalStatus, prisma } from '@seo/db';
import { ALWAYS_REQUIRES_APPROVAL } from '@seo/shared/constants';

import { getCurrentUser } from '@/lib/auth';
import { getApproval, getApprovalSummary, listApprovals } from '@/server/queries/approvals';
import type { ApprovalListItem } from '@/server/queries/approvals';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import type { FacetOption } from '@/components/data/filter-bar';
import { ApprovalQueue, type ApprovalTab } from '@/components/approvals/approval-queue';
import { humanizeKind, riskMeta } from '@/components/approvals/meta';
import {
  toApprovalRisk,
  toApprovalStatus,
  type ApprovalItem,
  type ApprovalRiskValue,
} from '@/components/approvals/types';

/**
 * The portfolio-wide approval queue.
 *
 * Everything on this page is read straight from the approval records: the diff the agent wrote,
 * the payload it will apply, and the decision history. Nothing is derived, and an approval with
 * no recorded diff says so rather than being dressed up as an empty change.
 */

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const PAGE_SIZE = 20;
const DECIDED_STATUSES = [ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.EXPIRED];

function paramList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function paramOne(value: string | string[] | undefined): string | undefined {
  const [first] = paramList(value);
  return first;
}

function intParam(value: string | string[] | undefined, fallback: number): number {
  const parsed = Number(paramOne(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function enumList<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T[] {
  const wanted = new Set(paramList(value).map((entry) => entry.toUpperCase()));
  return allowed.filter((entry) => wanted.has(entry));
}

/** Bulk approval is refused for these action types however the risk band is labelled. */
function requiresIndividualDecision(type: string | undefined): boolean {
  return type !== undefined && (ALWAYS_REQUIRES_APPROVAL as readonly string[]).includes(type);
}

function toItem(row: ApprovalListItem): ApprovalItem {
  return {
    id: row.id,
    websiteId: row.websiteId,
    websiteName: row.website.name,
    websiteDomain: row.website.domain,
    actionId: row.actionId,
    action: row.action
      ? {
          id: row.action.id,
          type: row.action.type,
          status: row.action.status,
          risk: toApprovalRisk(row.action.risk),
          reasoning: row.action.reasoning,
          affectedUrls: row.action.affectedUrls,
          priorityScore: row.action.priorityScore,
        }
      : null,
    kind: row.kind,
    title: row.title,
    description: row.description,
    risk: toApprovalRisk(row.risk),
    status: toApprovalStatus(row.status),
    diff: row.diff,
    rawDiff: row.rawDiff,
    payload: row.payload,
    editedPayload: row.editedPayload,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    decidedBy: row.decidedBy?.name ?? row.decidedBy?.email ?? null,
    createdAt: row.createdAt.toISOString(),
    requiresIndividualDecision: requiresIndividualDecision(row.action?.type),
  };
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const query = await searchParams;

  const websites = await prisma.website.findMany({
    where: { userId: user.id, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }],
  });
  const ownedIds = websites.map((website) => website.id);

  // A site filter can only narrow the owned set — never widen the scope.
  const requestedSites = new Set(paramList(query.site));
  const websiteIds = requestedSites.size === 0 ? ownedIds : ownedIds.filter((id) => requestedSites.has(id));

  const tab: ApprovalTab = paramOne(query.tab) === 'decided' ? 'decided' : 'pending';
  const risk = enumList(query.risk, Object.values(ActionRisk));
  const kind = paramOne(query.kind);
  const search = paramOne(query.search) ?? '';
  const page = intParam(query.page, 1);
  const pageSize = Math.min(100, intParam(query.pageSize, PAGE_SIZE));
  const focusId = paramOne(query.focus) ?? null;

  const statuses = tab === 'decided' ? DECIDED_STATUSES : [ApprovalStatus.PENDING];

  const [result, summary, decidedTotal, bySite, byKind] = await Promise.all([
    listApprovals({
      websiteIds,
      status: statuses,
      ...(risk.length ? { risk } : {}),
      ...(kind ? { kind } : {}),
      ...(search ? { search } : {}),
      page,
      pageSize,
      // Newest first: the queue is read top-down and the freshest proposal is the one an
      // operator has the most context for.
      order: 'desc',
    }),
    getApprovalSummary(ownedIds),
    prisma.approval.count({
      where: { websiteId: { in: ownedIds }, status: { in: DECIDED_STATUSES } },
    }),
    prisma.approval.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: ownedIds }, status: { in: statuses } },
      _count: { _all: true },
    }),
    prisma.approval.groupBy({
      by: ['kind'],
      where: { websiteId: { in: ownedIds }, status: { in: statuses } },
      _count: { _all: true },
    }),
  ]);

  const items = result.items.map(toItem);

  /**
   * `?focus=` may point at an approval the active tab or the filters exclude (a link from a
   * notification, say). It is fetched separately so the link still resolves — the ownership
   * check lives in `getApproval`, and a miss simply means no pinned card.
   */
  let pinned: ApprovalItem | null = null;
  if (focusId !== null && !items.some((item) => item.id === focusId)) {
    try {
      pinned = toItem(await getApproval(user.id, focusId));
    } catch {
      pinned = null;
    }
  }

  const siteCounts = new Map(bySite.map((row) => [row.websiteId, row._count._all]));
  const siteOptions: FacetOption[] = websites
    .map((website) => ({
      value: website.id,
      label: website.name,
      count: siteCounts.get(website.id) ?? 0,
    }))
    .filter((option) => option.count > 0);

  // Counts are only shown on the pending tab: `getApprovalSummary` counts pending rows, and a
  // count that silently described a different set would be worse than no count at all.
  const riskOptions: FacetOption[] = Object.values(ActionRisk).map((value) => ({
    value,
    label: riskMeta(value).label,
    ...(tab === 'pending' ? { count: summary.byRisk[value] ?? 0 } : {}),
  }));

  const kindOptions: FacetOption[] = byKind
    .map((row) => ({ value: row.kind, label: humanizeKind(row.kind), count: row._count._all }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const pendingByRisk: Record<ApprovalRiskValue, number> = {
    HIGH: summary.byRisk[ActionRisk.HIGH] ?? 0,
    MEDIUM: summary.byRisk[ActionRisk.MEDIUM] ?? 0,
    SAFE: summary.safePending,
  };

  return (
    <div className="space-y-4 px-4 py-6 md:px-6">
      <PageHeader
        title="Approvals"
        description="Every change an agent wants to make to a live site, waiting on your decision. Each item shows the exact diff that will be applied — nothing is executed until you approve it."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/actions">
              <Bot aria-hidden="true" />
              Action queue
            </Link>
          </Button>
        }
      />

      <ApprovalQueue
        items={items}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        tab={tab}
        pendingTotal={summary.pending}
        pendingByRisk={pendingByRisk}
        decidedTotal={decidedTotal}
        siteOptions={siteOptions}
        riskOptions={riskOptions}
        kindOptions={kindOptions}
        focusId={focusId}
        pinned={pinned}
        hasWebsites={websites.length > 0}
      />
    </div>
  );
}
