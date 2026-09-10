'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Globe, ShieldCheck, Sparkles } from 'lucide-react';

import type { ActionListItem } from '@/server/queries/actions';
import { Badge, StatusBadge, humanizeStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast';
import {
  DataTable,
  EnumFilter,
  FacetFilter,
  FilterBar,
  useFilterPills,
  useTableParams,
  humanizeFilterValue,
  type ColumnDef,
  type FacetOption,
} from '@/components/data';
import { apiPost } from '@/lib/api-client';
import { cn, shortenUrl } from '@/lib/utils';
import { PriorityScore } from './priority-score';
import { actionPriority } from './priority';
import { RiskBadge } from './risk-badge';

/**
 * The portfolio-wide action queue.
 *
 * Sorting, filtering and pagination all run on the server (the queue routinely holds thousands of
 * rows), so every one of them is a URL param and the table is told to stop doing its own.
 */

export interface ActionQueueRow extends ActionListItem {
  /** Position in the full, server-sorted result set — not the index on this page. */
  rank: number;
}

export interface ActionQueueProps {
  rows: readonly ActionQueueRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  order: 'asc' | 'desc';
  siteOptions: readonly FacetOption[];
  statusOptions: readonly FacetOption[];
  typeOptions: readonly FacetOption[];
  riskOptions: readonly FacetOption[];
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
  risk: { label: 'Risk', formatValue: humanizeFilterValue },
  minPriority: { label: 'Min priority', formatValue: (value: string) => `≥ ${value}` },
} as const;

/** Statuses where an approval decision is still open. */
const APPROVABLE = new Set(['PROPOSED', 'AWAITING_APPROVAL']);

export function ActionQueue({
  rows,
  total,
  page,
  pageSize,
  sort,
  order,
  siteOptions,
  statusOptions,
  typeOptions,
  riskOptions,
  filtered,
}: ActionQueueProps): React.JSX.Element {
  const router = useRouter();
  const params = useTableParams({ defaultPageSize: pageSize, defaultSort: 'priorityScore' });
  const pills = useFilterPills(FILTER_LABELS);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [approving, setApproving] = useState(false);

  const columns = useMemo<ReadonlyArray<ColumnDef<ActionQueueRow>>>(
    () => [
      {
        id: 'rank',
        header: '#',
        headerLabel: 'Rank',
        accessor: (row) => row.rank,
        align: 'right',
        width: 52,
        cell: (row) => <span className="tabular text-2xs text-muted-foreground">{row.rank}</span>,
      },
      {
        id: 'title',
        header: 'Action',
        accessor: (row) => row.title,
        width: 380,
        cell: (row) => (
          <div className="min-w-0 space-y-0.5">
            <Link
              href={`/actions/${row.id}`}
              data-row-ignore
              className="line-clamp-1 font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
            >
              {row.title}
            </Link>
            <p className="line-clamp-1 text-2xs text-muted-foreground">{row.reasoning}</p>
          </div>
        ),
      },
      {
        id: 'site',
        header: 'Site',
        accessor: (row) => row.website.name,
        width: 150,
        cell: (row) => (
          <Link
            href={`/sites/${row.websiteId}`}
            data-row-ignore
            className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <Globe className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate">{row.website.name}</span>
          </Link>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        accessor: (row) => row.type,
        width: 170,
        cell: (row) => (
          <Badge variant="outline" className="max-w-full truncate">
            {humanizeStatus(row.type)}
          </Badge>
        ),
      },
      {
        id: 'priorityScore',
        header: 'Priority',
        accessor: (row) => row.priorityScore,
        sortable: true,
        align: 'right',
        width: 96,
        exportValue: (row) => Math.round(row.priorityScore),
        cell: (row) => (
          <div className="flex justify-end">
            <PriorityScore
              score={actionPriority(row)}
              caption=""
              title={`Why “${row.title}” ranks here`}
            />
          </div>
        ),
      },
      {
        id: 'risk',
        header: 'Risk',
        accessor: (row) => row.risk,
        width: 92,
        cell: (row) => <RiskBadge risk={row.risk} />,
      },
      {
        id: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        width: 150,
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        id: 'autoExecutable',
        header: 'Automation',
        accessor: (row) => (row.autoExecutable ? 'Auto-executable' : 'Needs approval'),
        width: 130,
        cell: (row) =>
          row.autoExecutable ? (
            <SimpleTooltip content="This site's autonomy level allows this action type to run without a human.">
              <Badge variant="success">
                <ShieldCheck className="size-3" aria-hidden="true" />
                Auto
              </Badge>
            </SimpleTooltip>
          ) : (
            <Badge variant="muted">Needs approval</Badge>
          ),
      },
      {
        id: 'affectedUrls',
        header: 'Affected URLs',
        accessor: (row) => row.affectedUrls.length,
        width: 200,
        exportValue: (row) => row.affectedUrls.join(' '),
        cell: (row) =>
          row.affectedUrls.length === 0 ? (
            <span className="text-2xs text-muted-foreground">None recorded</span>
          ) : (
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="truncate font-mono text-2xs text-muted-foreground">
                {shortenUrl(row.affectedUrls[0], 32)}
              </span>
              {row.affectedUrls.length > 1 ? (
                <span className="tabular shrink-0 text-2xs text-muted-foreground">
                  +{row.affectedUrls.length - 1}
                </span>
              ) : null}
            </span>
          ),
      },
      {
        id: 'requiredAgent',
        header: 'Agent',
        accessor: (row) => row.requiredAgent,
        width: 150,
        cell: (row) =>
          row.requiredAgent ? (
            <span className="inline-flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
              <Bot className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{row.requiredAgent}</span>
            </span>
          ) : (
            <span className="text-2xs text-muted-foreground">—</span>
          ),
      },
      {
        id: 'proposedAt',
        header: 'Proposed',
        accessor: (row) => row.proposedAt,
        sortable: true,
        align: 'right',
        width: 110,
        defaultHidden: true,
        exportValue: (row) => row.proposedAt.toISOString(),
        cell: (row) => (
          <time dateTime={row.proposedAt.toISOString()} className="tabular text-2xs text-muted-foreground">
            {row.proposedAt.toLocaleDateString()}
          </time>
        ),
      },
    ],
    [],
  );

  /**
   * Bulk approval is restricted to SAFE rows here as well as on the server. The check runs
   * against the materialised rows on this page — never against the id list alone, because an id
   * from a page that is no longer mounted carries no risk band we can verify.
   */
  async function approveSafe(selected: readonly ActionQueueRow[]): Promise<void> {
    const safe = selected.filter((row) => row.risk === 'SAFE' && APPROVABLE.has(row.status));
    if (safe.length === 0) return;

    setApproving(true);
    const results = await Promise.allSettled(
      safe.map((row) => apiPost(`/api/actions/${row.id}/approve`, { note: 'Bulk-approved (safe risk band).' })),
    );
    setApproving(false);

    const approved = results.filter((result) => result.status === 'fulfilled').length;
    const failed = results.length - approved;

    if (approved > 0) {
      toast.success(`Approved ${approved} safe action${approved === 1 ? '' : 's'}`, {
        description: 'Approving records the decision — run each one to apply it.',
      });
    }
    if (failed > 0) {
      toast.error(`${failed} action${failed === 1 ? '' : 's'} could not be approved`, {
        description: 'They may have moved on since this page loaded. Reload and try again.',
      });
    }
    setSelectedIds([]);
    router.refresh();
  }

  const emptyState = filtered ? (
    <EmptyState
      icon={Sparkles}
      title="No actions match these filters"
      description="Lower the priority threshold or clear a filter to see the rest of the queue."
      action={
        <Button variant="outline" size="sm" onClick={params.reset}>
          Clear all filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={Bot}
      title="No actions have been proposed yet"
      description="Actions come from the agents. Open a site and run the AI SEO Manager — it reads that site's crawl, issues and Search Console data and proposes a prioritised plan."
      action={
        <Button asChild size="sm">
          <Link href="/sites">Pick a site to plan</Link>
        </Button>
      }
    />
  );

  return (
    <DataTable<ActionQueueRow>
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Proposed SEO actions across every website you own, highest priority first."
      searchable
      manualSearch
      search={params.searchInput}
      onSearchChange={params.setSearch}
      searchPlaceholder="Search actions, reasoning and URLs…"
      sort={sort}
      order={order}
      onSortChange={(id, nextOrder) => params.setSort(id, nextOrder)}
      selectable
      selectedIds={selectedIds}
      onSelectionChange={setSelectedIds}
      bulkActions={(selected) => (
        <BulkApproveSafe rows={selected} busy={approving} onApprove={() => void approveSafe(selected)} />
      )}
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={params.setPage}
      onPageSizeChange={params.setPageSize}
      itemLabel="actions"
      rowHref={(row) => `/actions/${row.id}`}
      filterPills={pills}
      onClearFilters={params.clearFilters}
      exportFilename="seo-actions"
      emptyState={emptyState}
      stickyHeader
      maxHeight="calc(100vh - 20rem)"
      toolbar={
        <FilterBar>
          <FacetFilter paramKey="site" label="Site" options={siteOptions} icon={Globe} searchable />
          <FacetFilter paramKey="status" label="Status" options={statusOptions} searchable />
          <FacetFilter paramKey="type" label="Type" options={typeOptions} searchable />
          <FacetFilter paramKey="risk" label="Risk" options={riskOptions} />
          <EnumFilter
            paramKey="minPriority"
            label="Min priority"
            options={MIN_PRIORITY_OPTIONS}
            allLabel="Any score"
          />
        </FilterBar>
      }
    />
  );
}

function BulkApproveSafe({
  rows,
  busy,
  onApprove,
}: {
  rows: readonly ActionQueueRow[];
  busy: boolean;
  onApprove: () => void;
}): React.JSX.Element {
  const safe = rows.filter((row) => row.risk === 'SAFE' && APPROVABLE.has(row.status));
  const blocked = rows.length - safe.length;

  return (
    <div className="flex items-center gap-2">
      {blocked > 0 ? (
        <span className="text-2xs text-muted-foreground">
          {blocked} of {rows.length} skipped — not safe-risk or already decided
        </span>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={safe.length === 0}
        loading={busy}
        loadingText="Approving"
        onClick={onApprove}
      >
        <ShieldCheck aria-hidden="true" />
        Approve {safe.length} safe
      </Button>
    </div>
  );
}

/** Header strip above the table: what the queue currently holds. */
export function ActionQueueSummary({
  total,
  awaitingApproval,
  readyToExecute,
  autoExecutable,
  className,
}: {
  total: number;
  awaitingApproval: number;
  readyToExecute: number;
  autoExecutable: number;
  className?: string;
}): React.JSX.Element {
  const entries = [
    { label: 'In the queue', value: total, hint: 'Every action proposed across your sites.' },
    {
      label: 'Awaiting approval',
      value: awaitingApproval,
      hint: 'Blocked on a human decision. Clear these in Approvals.',
    },
    {
      label: 'Ready to run',
      value: readyToExecute,
      hint: 'Approved or newly proposed — nothing is blocking execution.',
    },
    {
      label: 'Auto-executable',
      value: autoExecutable,
      hint: "Allowed to run unattended at this site's autonomy level.",
    },
  ];

  return (
    <Card className={cn('overflow-hidden', className)}>
      <dl className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
        {entries.map((entry) => (
          <div key={entry.label} className="bg-card px-4 py-3">
            <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{entry.label}</dt>
            <dd className="tabular mt-1 text-xl font-semibold leading-none text-foreground">{entry.value}</dd>
            <dd className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">{entry.hint}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
