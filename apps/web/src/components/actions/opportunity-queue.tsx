'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, FileText, Globe, KeyRound, Target, TrendingUp, X } from 'lucide-react';

import type { ContentOpportunityListItem } from '@/server/queries/content';
import { Badge, StatusBadge, humanizeStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import {
  DataTableToolbar,
  EnumFilter,
  FacetFilter,
  FilterBar,
  Pagination,
  useFilterPills,
  useTableParams,
  humanizeFilterValue,
  type FacetOption,
} from '@/components/data';
import { apiPost } from '@/lib/api-client';
import { cn, formatCompact, formatNumber, shortenUrl } from '@/lib/utils';
import { PriorityScore } from './priority-score';
import { opportunityPriority } from './priority';

/**
 * The cross-site opportunity queue.
 *
 * Every filter is a URL parameter (`useTableParams`), so a filtered queue is a link a teammate
 * can open, and the server component above re-queries from exactly those params — the list never
 * disagrees with the address bar.
 */

export interface OpportunityQueueProps {
  items: readonly ContentOpportunityListItem[];
  total: number;
  page: number;
  pageSize: number;
  siteOptions: readonly FacetOption[];
  statusOptions: readonly FacetOption[];
  typeOptions: readonly FacetOption[];
  /** True when the account has opportunities but this filter combination matched none. */
  filtered: boolean;
}

const MIN_PRIORITY_OPTIONS: FacetOption[] = [
  { value: '25', label: '25 and above' },
  { value: '50', label: '50 and above' },
  { value: '70', label: '70 and above' },
  { value: '85', label: '85 and above' },
];

const FILTER_LABELS = {
  site: { label: 'Site' },
  status: { label: 'Status', formatValue: humanizeFilterValue },
  type: { label: 'Type', formatValue: humanizeFilterValue },
  minPriority: { label: 'Min priority', formatValue: (value: string) => `≥ ${value}` },
} as const;

export function OpportunityQueue({
  items,
  total,
  page,
  pageSize,
  siteOptions,
  statusOptions,
  typeOptions,
  filtered,
}: OpportunityQueueProps): React.JSX.Element {
  const router = useRouter();
  const params = useTableParams({ defaultPageSize: pageSize });
  const pills = useFilterPills(FILTER_LABELS);

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ContentOpportunityListItem | null>(null);
  const [reason, setReason] = useState('');

  const rankOffset = (page - 1) * pageSize;

  async function accept(item: ContentOpportunityListItem): Promise<void> {
    setPendingId(item.id);
    try {
      await apiPost(`/api/content/opportunities/${item.id}/accept`, {});
      toast.success('Opportunity accepted', {
        description: 'Create a brief from it to turn it into a draft.',
      });
      router.refresh();
    } catch (error) {
      toast.error('Could not accept this opportunity', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setPendingId(null);
    }
  }

  async function reject(): Promise<void> {
    if (!rejecting) return;
    setPendingId(rejecting.id);
    try {
      await apiPost(`/api/content/opportunities/${rejecting.id}/reject`, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      toast.success('Opportunity rejected', {
        description: 'The reason is recorded so discovery stops re-proposing it.',
      });
      setRejecting(null);
      setReason('');
      router.refresh();
    } catch (error) {
      toast.error('Could not reject this opportunity', {
        description: error instanceof Error ? error.message : 'Please try again.',
      });
    } finally {
      setPendingId(null);
    }
  }

  const toolbar = (
    <DataTableToolbar
      search={params.searchInput}
      onSearchChange={params.setSearch}
      searchPlaceholder="Search titles, keywords and reasoning…"
      resultCount={total}
      filters={pills}
      onClearFilters={params.clearFilters}
      className="rounded-lg border border-border bg-card"
    >
      <FilterBar>
        <FacetFilter paramKey="site" label="Site" options={siteOptions} icon={Globe} searchable />
        <FacetFilter paramKey="status" label="Status" options={statusOptions} />
        <FacetFilter paramKey="type" label="Type" options={typeOptions} searchable />
        <EnumFilter
          paramKey="minPriority"
          label="Min priority"
          options={MIN_PRIORITY_OPTIONS}
          allLabel="Any score"
        />
      </FilterBar>
    </DataTableToolbar>
  );

  return (
    <div className="space-y-3">
      {toolbar}

      {items.length === 0 ? (
        <Card>
          {filtered ? (
            <EmptyState
              icon={Target}
              title="No opportunities match these filters"
              description="Widen the score threshold or clear a filter to see the rest of the queue."
              action={
                <Button variant="outline" size="sm" onClick={params.reset}>
                  Clear all filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Target}
              title="No content opportunities yet"
              description="Opportunities come from the Content Strategy agent, which compares your keywords and pages against what already ranks. Run it on a site once that site has been crawled and its Search Console data imported."
              action={
                <Button asChild size="sm">
                  <Link href="/sites">Pick a site to analyse</Link>
                </Button>
              }
            />
          )}
        </Card>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => (
            <OpportunityCard
              key={item.id}
              item={item}
              rank={rankOffset + index + 1}
              busy={pendingId === item.id}
              onAccept={() => void accept(item)}
              onReject={() => {
                setReason('');
                setRejecting(item);
              }}
            />
          ))}
        </ol>
      )}

      {total > 0 ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={params.setPage}
            onPageSizeChange={params.setPageSize}
            itemLabel="opportunities"
            className="border-t-0"
          />
        </div>
      ) : null}

      <Dialog open={rejecting !== null} onOpenChange={(open) => !open && setRejecting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this opportunity</DialogTitle>
            <DialogDescription>
              The row is kept and the reason is written to its evidence, so the next discovery run
              knows not to raise it again.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="opportunity-reject-reason">Reason (optional)</Label>
            <Textarea
              id="opportunity-reject-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="e.g. we do not sell this product line any more"
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={pendingId !== null && pendingId === rejecting?.id}
              loadingText="Rejecting"
              onClick={() => void reject()}
            >
              Reject opportunity
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface OpportunityCardProps {
  item: ContentOpportunityListItem;
  rank: number;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}

/** Statuses where accepting or rejecting is still a meaningful decision. */
const DECIDABLE = new Set(['IDENTIFIED', 'IN_PROGRESS']);

function OpportunityCard({ item, rank, busy, onAccept, onReject }: OpportunityCardProps): React.JSX.Element {
  const score = useMemo(
    () =>
      opportunityPriority({
        priorityScore: item.priorityScore,
        impactScore: item.impactScore,
        confidenceScore: item.confidenceScore,
        effortScore: item.effortScore,
        evidence: item.evidence,
      }),
    [item],
  );

  const decidable = DECIDABLE.has(item.status);
  const cannibalisationRisk = item.cannibalizationRisk ?? null;

  return (
    <li>
      <Card className="transition-colors hover:border-border/80">
        <CardContent className="flex gap-3 p-4">
          <span
            aria-hidden="true"
            className="tabular mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground"
          >
            {rank}
          </span>

          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                href={`/sites/${item.websiteId}/opportunities?focus=${item.id}`}
                className="text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
              >
                {item.title}
              </Link>
              <StatusBadge status={item.status} />
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
              <Link
                href={`/sites/${item.websiteId}`}
                className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
              >
                <Globe className="size-3" aria-hidden="true" />
                {item.website.name}
              </Link>
              <span aria-hidden="true">·</span>
              <Badge variant="outline">{humanizeStatus(item.type)}</Badge>
              {item.targetKeyword ? (
                <span className="inline-flex items-center gap-1">
                  <KeyRound className="size-3" aria-hidden="true" />
                  {item.targetKeyword}
                  {item.keyword?.searchVolume ? (
                    <span className="tabular">({formatCompact(item.keyword.searchVolume)}/mo)</span>
                  ) : null}
                </span>
              ) : null}
              {item.cluster ? <span>Cluster: {item.cluster.name}</span> : null}
            </div>

            <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.reasoning}</p>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              {item.estimatedTrafficGain !== null ? (
                <span className="inline-flex items-center gap-1">
                  <TrendingUp className="size-3" aria-hidden="true" />
                  <span className="tabular font-medium text-foreground">
                    +{formatNumber(item.estimatedTrafficGain)}
                  </span>
                  est. clicks/mo
                </span>
              ) : null}
              {item.page ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileText className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate font-mono">{shortenUrl(item.page.url, 40)}</span>
                </span>
              ) : item.suggestedUrl ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FileText className="size-3 shrink-0" aria-hidden="true" />
                  <span className="truncate font-mono">New: {shortenUrl(item.suggestedUrl, 40)}</span>
                </span>
              ) : null}
              {cannibalisationRisk !== null && cannibalisationRisk >= 0.4 ? (
                <span className={cn('font-medium', cannibalisationRisk >= 0.7 ? 'text-destructive' : 'text-warning')}>
                  Cannibalisation risk {Math.round(cannibalisationRisk * 100)}%
                </span>
              ) : null}
              {item._count.briefs > 0 ? (
                <span>
                  {item._count.briefs} brief{item._count.briefs === 1 ? '' : 's'} created
                </span>
              ) : null}
            </div>

            {decidable ? (
              <div className="flex flex-wrap items-center gap-2 pt-0.5">
                <Button size="sm" variant="outline" loading={busy} loadingText="Saving" onClick={onAccept}>
                  <Check aria-hidden="true" />
                  Accept
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>
                  <X aria-hidden="true" />
                  Reject
                </Button>
              </div>
            ) : null}
          </div>

          <div className="shrink-0">
            <PriorityScore score={score} size="md" title="Why this ranks here" />
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
