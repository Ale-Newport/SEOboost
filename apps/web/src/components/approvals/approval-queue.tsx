'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, CheckCheck, Globe, Inbox, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTableToolbar } from '@/components/data/data-table-toolbar';
import { FacetFilter, FilterBar, humanizeFilterValue, useFilterPills } from '@/components/data/filter-bar';
import { Pagination } from '@/components/data/pagination';
import { useTableParams } from '@/components/data/use-table-params';
import type { FacetOption } from '@/components/data/filter-bar';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';

import { ApprovalCard } from './approval-card';
import { RISK_META, RISK_ORDER, riskMeta } from './meta';
import type { ApprovalItem, ApprovalRiskValue } from './types';

/**
 * The central approval queue, across every website the operator owns.
 *
 * Two rules shape the whole screen. Items are grouped by risk band, because the band decides how
 * much reading a decision needs — and "Approve all safe" only ever sees the SAFE band. That
 * restriction is enforced here as well as on the server: the ids sent to the bulk endpoint are
 * built by a function that drops anything not SAFE and refuses to send at all if a non-SAFE item
 * somehow reaches it, so a UI bug cannot turn one press into a live-site rewrite.
 */

const BULK_LIMIT = 200;

interface BulkResponse {
  approved: number;
  skipped: Array<{ id: string; reason: string }>;
  requested?: number;
  jobs?: Array<{ enqueued: boolean }>;
}

/**
 * The client-side half of the safe-only guarantee.
 *
 * Returns the ids that may be bulk-approved, or `null` when the candidate list contains anything
 * that is not a pending SAFE item — in which case nothing is sent and the operator is told why.
 */
function safeApprovalIds(candidates: readonly ApprovalItem[]): string[] | null {
  for (const candidate of candidates) {
    if (candidate.risk !== 'SAFE') return null;
    if (candidate.status !== 'PENDING') return null;
    if (candidate.requiresIndividualDecision) return null;
  }
  return candidates.map((candidate) => candidate.id);
}

export type ApprovalTab = 'pending' | 'decided';

export interface ApprovalQueueProps {
  items: ApprovalItem[];
  total: number;
  page: number;
  pageSize: number;
  tab: ApprovalTab;
  /** Portfolio-wide pending counts, unaffected by the filters. */
  pendingTotal: number;
  pendingByRisk: Record<ApprovalRiskValue, number>;
  decidedTotal: number;
  siteOptions: FacetOption[];
  riskOptions: FacetOption[];
  kindOptions: FacetOption[];
  /** `?focus=<id>` — expand this item and scroll to it. */
  focusId: string | null;
  /**
   * The focused approval when it is not on the current page — a link from a notification can
   * point at something the active tab or filters exclude, and dropping it silently would make
   * the link look broken.
   */
  pinned: ApprovalItem | null;
  hasWebsites: boolean;
}

export function ApprovalQueue({
  items,
  total,
  page,
  pageSize,
  tab,
  pendingTotal,
  pendingByRisk,
  decidedTotal,
  siteOptions,
  riskOptions,
  kindOptions,
  focusId,
  pinned,
  hasWebsites,
}: ApprovalQueueProps): React.JSX.Element {
  const router = useRouter();
  const { searchInput, setSearch, setPage, setPageSize, setFilters, hasActiveFilters, clearFilters } =
    useTableParams({ defaultPageSize: pageSize });
  // Built from the site options so a pill reads "Website: Acme", never a cuid.
  const filterLabels = React.useMemo(
    () => ({
      site: {
        label: 'Website',
        formatValue: (value: string) =>
          siteOptions.find((option) => option.value === value)?.label ?? value,
      },
      risk: { label: 'Risk', formatValue: (value: string) => riskMeta(value).label },
      kind: { label: 'Kind', formatValue: humanizeFilterValue },
    }),
    [siteOptions],
  );
  const pills = useFilterPills(filterLabels);

  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [bulkPending, setBulkPending] = React.useState(false);

  // Collapsed by default, except the focused item and the first card in each risk band — enough
  // to see a real diff on arrival without a 20-diff wall.
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(() => {
    const next = new Set<string>();
    if (focusId !== null) next.add(focusId);
    if (tab === 'pending') {
      for (const risk of RISK_ORDER) {
        const first = items.find((item) => item.risk === risk);
        if (first) next.add(first.id);
      }
    }
    return next;
  });

  const setOpen = React.useCallback((id: string, open: boolean) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const groups = React.useMemo(
    () =>
      RISK_ORDER.map((risk) => ({
        risk,
        items: items.filter((item) => item.risk === risk),
      })).filter((group) => group.items.length > 0),
    [items],
  );

  /** Only the SAFE, pending, individually-unrestricted items on this page. */
  const bulkCandidates = React.useMemo(
    () =>
      items.filter(
        (item) =>
          item.risk === 'SAFE' && item.status === 'PENDING' && !item.requiresIndividualDecision,
      ),
    [items],
  );
  const bulkExcluded = React.useMemo(
    () =>
      items.filter(
        (item) =>
          item.risk === 'SAFE' && item.status === 'PENDING' && item.requiresIndividualDecision,
      ),
    [items],
  );

  const runBulkApprove = async (): Promise<void> => {
    const ids = safeApprovalIds(bulkCandidates);
    if (ids === null || ids.length === 0) {
      toast.error('Nothing was sent', {
        description:
          'The selection contained an item that is not a pending safe change, so the bulk approval was cancelled.',
      });
      setBulkOpen(false);
      return;
    }

    setBulkPending(true);
    try {
      const result = await apiPost<BulkResponse>('/api/approvals/bulk-approve-safe', {
        ids,
        limit: Math.min(BULK_LIMIT, ids.length),
      });
      const queued = result.jobs?.filter((job) => job.enqueued).length ?? 0;
      toast.success(`Approved ${formatNumber(result.approved)} safe change${result.approved === 1 ? '' : 's'}`, {
        description:
          result.skipped.length > 0
            ? `${result.skipped.length} were skipped because their action type always needs an individual decision. ${queued} queued for execution.`
            : `${queued} queued for execution.`,
      });
      setBulkOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not bulk-approve');
    } finally {
      setBulkPending(false);
    }
  };

  const emptyTitle =
    hasActiveFilters || searchInput.length > 0
      ? 'No approvals match these filters'
      : tab === 'decided'
        ? 'Nothing has been decided yet'
        : 'Nothing is waiting on you';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Waiting on you"
          value={formatNumber(pendingTotal)}
          icon={Inbox}
          footer="Across every website you own"
        />
        {RISK_ORDER.map((risk) => {
          const meta = RISK_META[risk];
          return (
            <MetricCard
              key={risk}
              label={meta.label}
              value={formatNumber(pendingByRisk[risk] ?? 0)}
              icon={meta.icon}
              info={meta.description}
              footer={
                risk === 'SAFE'
                  ? 'The only band "Approve all safe" touches'
                  : 'Needs an individual read'
              }
            />
          );
        })}
      </div>

      {pinned ? (
        <section aria-labelledby="linked-approval" className="space-y-2">
          <h2 id="linked-approval" className="text-sm font-semibold tracking-tight text-foreground">
            The approval you opened
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            It is not in the list below — it has either been decided already, or the active tab and
            filters exclude it. It is shown here so the link still lands on something.
          </p>
          <ApprovalCard
            item={pinned}
            open={openIds.has(pinned.id)}
            onOpenChange={(open) => setOpen(pinned.id, open)}
            focused
          />
        </section>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={(value) => setFilters({ tab: value === 'pending' ? null : value })}
      >
        <TabsList>
          <TabsTrigger value="pending">
            Pending
            {pendingTotal > 0 ? (
              <Badge variant="muted" className="ml-1.5">
                {formatNumber(pendingTotal)}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="decided">
            Decided
            {decidedTotal > 0 ? (
              <Badge variant="muted" className="ml-1.5">
                {formatNumber(decidedTotal)}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="rounded-lg border border-border bg-card">
        <DataTableToolbar
          search={searchInput}
          onSearchChange={setSearch}
          searchPlaceholder="Search title or description…"
          resultCount={total}
          filters={pills}
          onClearFilters={clearFilters}
          actions={
            tab === 'pending' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={bulkCandidates.length === 0}
                onClick={() => setBulkOpen(true)}
              >
                <ShieldCheck aria-hidden="true" />
                Approve all safe
                {bulkCandidates.length > 0 ? ` (${bulkCandidates.length})` : ''}
              </Button>
            ) : null
          }
        >
          <FilterBar>
            <FacetFilter paramKey="site" label="Website" options={siteOptions} icon={Globe} searchable />
            <FacetFilter paramKey="risk" label="Risk" options={riskOptions} />
            <FacetFilter paramKey="kind" label="Kind" options={kindOptions} searchable />
          </FilterBar>
        </DataTableToolbar>

        <div className="space-y-5 border-t border-border p-3">
          {items.length === 0 ? (
            <EmptyState
              icon={hasWebsites ? Inbox : Globe}
              title={emptyTitle}
              description={
                !hasWebsites
                  ? 'Add a website first. Approvals are raised against a specific site by the agents that work on it.'
                  : hasActiveFilters || searchInput.length > 0
                    ? 'Clear the filters to see the whole queue.'
                    : tab === 'decided'
                      ? 'Decisions land here the moment you approve or reject something, with the note you wrote and the diff exactly as it was signed off.'
                      : 'Approvals are raised when an agent proposes a change to a live site and the autonomy level requires a human to sign it off. Run the AI SEO manager on a site, or execute an action that needs approval, and it appears here.'
              }
              action={
                !hasWebsites ? (
                  <Button asChild size="sm">
                    <Link href="/sites/new">Add a website</Link>
                  </Button>
                ) : hasActiveFilters || searchInput.length > 0 ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <Link href="/actions">
                      <Bot aria-hidden="true" />
                      Review the action queue
                    </Link>
                  </Button>
                )
              }
            />
          ) : tab === 'decided' ? (
            <ol className="space-y-3">
              {items.map((item) => (
                <li key={item.id}>
                  <ApprovalCard
                    item={item}
                    open={openIds.has(item.id)}
                    onOpenChange={(open) => setOpen(item.id, open)}
                    focused={item.id === focusId}
                  />
                </li>
              ))}
            </ol>
          ) : (
            groups.map((group) => {
              const meta = RISK_META[group.risk];
              const GroupIcon = meta.icon;
              return (
                <section key={group.risk} aria-labelledby={`risk-${group.risk}`} className="space-y-2">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h2
                      id={`risk-${group.risk}`}
                      className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-foreground"
                    >
                      <GroupIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                      {meta.label}
                      <span className="tabular font-normal text-muted-foreground">
                        ({group.items.length})
                      </span>
                    </h2>
                    <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
                      {meta.description}
                    </p>
                  </div>
                  <ol className="space-y-3">
                    {group.items.map((item) => (
                      <li key={item.id}>
                        <ApprovalCard
                          item={item}
                          open={openIds.has(item.id)}
                          onOpenChange={(open) => setOpen(item.id, open)}
                          focused={item.id === focusId}
                        />
                      </li>
                    ))}
                  </ol>
                </section>
              );
            })
          )}
        </div>

        {total > 0 ? (
          <div className="border-t border-border px-3 py-2">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="approvals"
            />
          </div>
        ) : null}
      </div>

      <Dialog open={bulkOpen} onOpenChange={setBulkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Approve {bulkCandidates.length} safe change{bulkCandidates.length === 1 ? '' : 's'}
            </DialogTitle>
            <DialogDescription>
              Only items in the SAFE band on this page are included. Nothing in the medium or high
              bands can be approved this way.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-64 space-y-1.5 overflow-y-auto rounded-md border border-border p-2">
            <ol className="space-y-1">
              {bulkCandidates.map((item) => (
                <li key={item.id} className="flex items-baseline gap-2 text-xs">
                  <CheckCheck className="size-3.5 shrink-0 translate-y-0.5 text-success" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">{item.websiteName}</span>
                </li>
              ))}
            </ol>
          </div>

          {bulkExcluded.length > 0 ? (
            <Alert variant="neutral">
              <AlertDescription>
                {bulkExcluded.length} safe item{bulkExcluded.length === 1 ? ' is' : 's are'} left
                out: their action type always requires an individual decision, whatever the risk
                band says.
              </AlertDescription>
            </Alert>
          ) : null}

          <p className="text-xs leading-relaxed text-muted-foreground">
            {pendingByRisk.SAFE > bulkCandidates.length
              ? `You have ${formatNumber(pendingByRisk.SAFE)} safe items pending in total — this approves the ${bulkCandidates.length} on this page. `
              : ''}
            Each approval queues its action for execution immediately, and every applied change
            records a rollback point.
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkPending}>
              Cancel
            </Button>
            <Button
              onClick={() => void runBulkApprove()}
              loading={bulkPending}
              loadingText="Approving"
              disabled={bulkCandidates.length === 0}
            >
              Approve {bulkCandidates.length} safe change{bulkCandidates.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
