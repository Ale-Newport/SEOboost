'use client';

import { useCallback, useMemo, useState } from 'react';
import { Download, EyeOff, Filter, ListFilter, MoreHorizontal, RotateCcw, ShieldAlert, Sparkles, Wrench } from 'lucide-react';

import { DataTable, type ColumnDef } from '@/components/data/data-table';
import {
  BooleanFilter,
  FacetFilter,
  FilterBar,
  TextFilter,
  useFilterPills,
  type FilterLabelConfig,
} from '@/components/data/filter-bar';
import { SeverityCell } from '@/components/data/severity-cell';
import { StatusCell } from '@/components/data/status-cell';
import { UrlCell } from '@/components/data/url-cell';
import { useTableParams } from '@/components/data/use-table-params';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { formatNumber, formatPercent } from '@/lib/utils';
import { IgnoreIssuesDialog } from './ignore-issues-dialog';
import { IssueDetailSheet } from './issue-detail-sheet';
import {
  categoryLabel,
  severityLabel,
  statusLabel,
  type AuditIssueRow,
  type IssueFacetData,
  type RuleReferenceEntry,
} from './types';
import { useIssueMutations } from './use-issue-mutations';

/** Module scope: `useFilterPills` memoises on this object, so a new literal per render would thrash. */
const FILTER_LABELS: Readonly<Record<string, FilterLabelConfig>> = {
  severity: { label: 'Severity', formatValue: severityLabel },
  category: { label: 'Category', formatValue: categoryLabel },
  status: { label: 'Status', formatValue: statusLabel },
  ruleId: { label: 'Rule' },
  url: { label: 'URL contains' },
  autoFixable: { label: 'Auto-fixable', formatValue: () => 'Yes' },
};

/** Statuses that still describe a live problem — the ones triage can ignore. */
function isLive(row: AuditIssueRow): boolean {
  return row.status === 'OPEN' || row.status === 'REGRESSED';
}

export interface IssueTableProps {
  websiteId: string;
  rows: readonly AuditIssueRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: IssueFacetData;
  rulesById: Readonly<Record<string, RuleReferenceEntry>>;
}

/**
 * The audit's issue list.
 *
 * Every filter, the sort and the page live in the URL, so a narrowed view is a shareable link and
 * the server does the filtering — the table never receives rows it is going to hide. Triage
 * happens in place: one row from its menu, or a whole selection from the bulk bar.
 */
export function IssueTable({
  websiteId,
  rows,
  total,
  page,
  pageSize,
  facets,
  rulesById,
}: IssueTableProps): React.JSX.Element {
  const params = useTableParams({ defaultSort: null, defaultOrder: 'asc' });
  const pills = useFilterPills(FILTER_LABELS);
  const mutations = useIssueMutations(websiteId);

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailIssue, setDetailIssue] = useState<AuditIssueRow | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  /** Ids the open ignore dialog will apply to — one row, or the whole selection. */
  const [ignoreTargets, setIgnoreTargets] = useState<string[] | null>(null);

  const getRowId = useCallback((row: AuditIssueRow) => row.id, []);

  const openDetail = useCallback((row: AuditIssueRow) => {
    setDetailIssue(row);
    setDetailOpen(true);
  }, []);

  const confirmIgnore = useCallback(
    async (reason: string): Promise<boolean> => {
      const targets = ignoreTargets ?? [];
      const ok = await mutations.ignore(targets, reason);
      if (ok) {
        setSelectedIds((current) => current.filter((id) => !targets.includes(id)));
        setDetailOpen(false);
      }
      return ok;
    },
    [ignoreTargets, mutations],
  );

  /** The whole filtered result set, not just this page — an export of 25 rows helps nobody. */
  const exportHref = useMemo(() => {
    const search = new URLSearchParams(params.queryString);
    search.delete('page');
    search.delete('pageSize');
    search.set('format', 'csv');
    return `/api/websites/${websiteId}/issues?${search.toString()}`;
  }, [params.queryString, websiteId]);

  const columns = useMemo<Array<ColumnDef<AuditIssueRow>>>(
    () => [
      {
        id: 'severity',
        header: 'Severity',
        accessor: (row) => row.severity,
        cell: (row) => <SeverityCell severity={row.severity} variant="badge" />,
        sortable: true,
        width: 96,
      },
      {
        id: 'category',
        header: 'Category',
        accessor: (row) => row.category,
        exportValue: (row) => categoryLabel(row.category),
        cell: (row) => (
          <Badge variant="outline" className="whitespace-nowrap">
            {categoryLabel(row.category)}
          </Badge>
        ),
        sortable: true,
        width: 140,
      },
      {
        id: 'ruleId',
        header: 'Rule',
        headerLabel: 'Rule',
        accessor: (row) => row.ruleId,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">{row.title}</p>
            <p className="truncate font-mono text-2xs text-muted-foreground">
              {row.ruleId}
              {row.autoFixable ? <span className="ml-1.5 text-info">auto-fixable</span> : null}
            </p>
          </div>
        ),
        sortable: true,
        width: 240,
      },
      {
        id: 'url',
        header: 'Affected URL',
        accessor: (row) => row.url ?? '',
        exportValue: (row) => row.url ?? '',
        cell: (row) =>
          row.url ? (
            <UrlCell url={row.url} maxLength={44} />
          ) : (
            <span className="text-2xs text-muted-foreground">Site-wide</span>
          ),
        sortable: true,
        width: 260,
      },
      {
        id: 'description',
        header: 'What was found',
        accessor: (row) => row.description,
        cell: (row) => (
          <p title={row.description} className="line-clamp-2 max-w-md text-2xs leading-relaxed text-muted-foreground">
            {row.description}
          </p>
        ),
        width: 320,
      },
      {
        id: 'estimatedImpact',
        header: 'Impact',
        accessor: (row) => row.estimatedImpact,
        exportValue: (row) => row.estimatedImpact,
        cell: (row) => <span className="tabular text-xs">{formatPercent(row.estimatedImpact, 0)}</span>,
        sortable: true,
        align: 'right',
        width: 88,
        defaultHidden: true,
      },
      {
        id: 'confidence',
        header: 'Confidence',
        accessor: (row) => row.confidence,
        exportValue: (row) => row.confidence,
        cell: (row) => <span className="tabular text-xs">{formatPercent(row.confidence, 0)}</span>,
        sortable: true,
        align: 'right',
        width: 100,
        defaultHidden: true,
      },
      {
        id: 'discoveredAt',
        header: 'Discovered',
        accessor: (row) => row.discoveredAt,
        exportValue: (row) => row.discoveredLabel,
        cell: (row) => <span className="whitespace-nowrap text-2xs text-muted-foreground">{row.discoveredLabel}</span>,
        sortable: true,
        width: 116,
      },
      {
        id: 'lastSeenAt',
        header: 'Last seen',
        accessor: (row) => row.lastSeenLabel,
        cell: (row) => <span className="whitespace-nowrap text-2xs text-muted-foreground">{row.lastSeenLabel}</span>,
        sortable: true,
        width: 116,
        defaultHidden: true,
      },
      {
        id: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        exportValue: (row) => statusLabel(row.status),
        cell: (row) => (
          <StatusCell
            status={row.status}
            label={statusLabel(row.status)}
            detail={row.ignoredReason ?? undefined}
          />
        ),
        sortable: true,
        width: 116,
      },
      {
        id: 'actions',
        header: <span className="sr-only">Actions</span>,
        headerLabel: 'Actions',
        accessor: () => '',
        exportValue: () => '',
        align: 'right',
        width: 52,
        cell: (row) => (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Actions for ${row.title}`}
                disabled={mutations.pending}
              >
                <MoreHorizontal aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              <DropdownMenuLabel className="truncate">{row.ruleId}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => openDetail(row)}>
                <ListFilter aria-hidden="true" />
                View details and evidence
              </DropdownMenuItem>
              {isLive(row) ? (
                <>
                  {row.autoFixable ? (
                    <DropdownMenuItem onSelect={() => void mutations.createFixAction(row.id)}>
                      <Sparkles aria-hidden="true" />
                      Create fix action
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => setIgnoreTargets([row.id])}>
                    <EyeOff aria-hidden="true" />
                    Ignore with a reason…
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onSelect={() => void mutations.reopen([row.id])}>
                  <RotateCcw aria-hidden="true" />
                  Reopen
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [mutations, openDetail],
  );

  const severityOptions = useMemo(
    () => facets.severity.map((entry) => ({ value: entry.value, label: entry.label, count: entry.count })),
    [facets.severity],
  );
  const categoryOptions = useMemo(
    () => facets.category.map((entry) => ({ value: entry.value, label: entry.label, count: entry.count })),
    [facets.category],
  );
  const statusOptions = useMemo(
    () => facets.status.map((entry) => ({ value: entry.value, label: entry.label, count: entry.count })),
    [facets.status],
  );
  const ruleOptions = useMemo(
    () => facets.rules.map((entry) => ({ value: entry.value, label: entry.label, count: entry.count })),
    [facets.rules],
  );

  const filtered = params.hasActiveFilters || params.search.length > 0;

  return (
    <>
      <DataTable<AuditIssueRow>
        data={rows}
        columns={columns}
        getRowId={getRowId}
        caption="Technical issues found by the site audit"
        searchable
        manualSearch
        search={params.searchInput}
        onSearchChange={params.setSearch}
        searchPlaceholder="Search titles, URLs, rules…"
        sort={params.sort}
        order={params.order}
        onSortChange={params.setSort}
        page={page}
        pageSize={pageSize}
        total={total}
        onPageChange={params.setPage}
        onPageSizeChange={params.setPageSize}
        itemLabel="issues"
        selectable
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        bulkActions={(_selectedRows, ids) => (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              disabled={mutations.pending}
              onClick={() => void mutations.reopen(ids)}
            >
              <RotateCcw aria-hidden="true" />
              Reopen
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              disabled={mutations.pending}
              onClick={() => setIgnoreTargets([...ids])}
            >
              <EyeOff aria-hidden="true" />
              Ignore {formatNumber(ids.length)}…
            </Button>
          </>
        )}
        onRowClick={openDetail}
        rowClassName={(row) => (row.severity === 'CRITICAL' ? 'bg-destructive/[0.03]' : undefined)}
        filterPills={pills}
        onClearFilters={params.clearFilters}
        exportable={false}
        stickyHeader
        maxHeight="calc(100vh - 18rem)"
        toolbar={
          <FilterBar>
            <FacetFilter paramKey="severity" label="Severity" options={severityOptions} icon={ShieldAlert} />
            <FacetFilter paramKey="category" label="Category" options={categoryOptions} icon={Filter} />
            <FacetFilter paramKey="status" label="Status" options={statusOptions} />
            <FacetFilter paramKey="ruleId" label="Rule" options={ruleOptions} searchable />
            <BooleanFilter paramKey="autoFixable" label="Auto-fixable" icon={Wrench} />
            <TextFilter paramKey="url" label="URL contains" placeholder="URL contains…" />
          </FilterBar>
        }
        toolbarActions={
          <Button asChild variant="outline" size="sm">
            <a href={exportHref} download aria-label="Download every matching issue as CSV">
              <Download aria-hidden="true" />
              Export CSV
            </a>
          </Button>
        }
        emptyState={
          filtered ? (
            <EmptyState
              size="sm"
              icon={Filter}
              title="No issues match these filters"
              description="Nothing in this site's audit matches the current combination. Widen or clear the filters to see the rest."
              action={
                <Button variant="outline" size="sm" onClick={params.reset}>
                  Clear all filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              size="sm"
              icon={Wrench}
              title="No issues in this view"
              description="Every issue matching the current status filter has been dealt with."
            />
          )
        }
      />

      <IgnoreIssuesDialog
        open={ignoreTargets !== null}
        onOpenChange={(next) => {
          if (!next) setIgnoreTargets(null);
        }}
        count={ignoreTargets?.length ?? 0}
        onConfirm={confirmIgnore}
      />

      <IssueDetailSheet
        websiteId={websiteId}
        issue={detailIssue}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        rulesById={rulesById}
        busy={mutations.pending}
        onIgnore={(row) => setIgnoreTargets([row.id])}
        onReopen={async (row) => {
          const ok = await mutations.reopen([row.id]);
          if (ok) setDetailOpen(false);
          return ok;
        }}
        onCreateFixAction={async (row) => {
          const action = await mutations.createFixAction(row.id);
          if (action) setDetailOpen(false);
          return action;
        }}
      />
    </>
  );
}
