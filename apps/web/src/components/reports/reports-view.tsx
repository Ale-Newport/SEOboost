'use client';

import * as React from 'react';
import Link from 'next/link';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Delta } from '@/components/ui/delta';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { FacetFilter, FilterBar, useFilterPills } from '@/components/data/filter-bar';
import { useTableParams } from '@/components/data/use-table-params';
import { cn, formatCompact, formatNumber } from '@/lib/utils';
import { GenerateReportDialog, type GenerateReportSite } from './generate-report-dialog';

export interface ReportRow {
  id: string;
  title: string;
  type: string;
  websiteId: string | null;
  websiteName: string | null;
  /** ISO instants — formatting happens in the browser so periods read in the reader's locale. */
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  summary: string | null;
  clicks: number | null;
  clicksChangePct: number | null;
  impressions: number | null;
  impressionsChangePct: number | null;
  highlights: number;
}

export interface ReportsViewProps {
  rows: readonly ReportRow[];
  total: number;
  page: number;
  pageSize: number;
  sites: readonly GenerateReportSite[];
  /** Report types actually present in the library, with their counts. */
  typeOptions: ReadonlyArray<{ value: string; label: string; count: number }>;
  /** True when the account has no reports at all, filters aside. */
  libraryEmpty: boolean;
}

const FILTER_LABELS = {
  site: { label: 'Site' },
  type: { label: 'Type' },
} as const;

function formatPeriod(start: string, end: string): string {
  const from = new Date(start);
  const to = new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return '—';

  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();
  if (sameMonth) return `${format(from, 'd')} – ${format(to, 'd MMM yyyy')}`;
  if (sameYear) return `${format(from, 'd MMM')} – ${format(to, 'd MMM yyyy')}`;
  return `${format(from, 'd MMM yyyy')} – ${format(to, 'd MMM yyyy')}`;
}

function relative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

/** `weekly` → `Weekly`, `WEEKLY` → `Weekly`. The column is free-form, so normalise for display. */
function typeLabel(type: string): string {
  const lower = type.replace(/[_-]+/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * The report library.
 *
 * Filtering, sorting and paging all live in the URL and are executed by the server component
 * above this one, so a link to a filtered library reproduces exactly what the sender saw.
 */
export function ReportsView({
  rows,
  total,
  page,
  pageSize,
  sites,
  typeOptions,
  libraryEmpty,
}: ReportsViewProps): React.JSX.Element {
  const params = useTableParams({ defaultSort: 'periodEnd', defaultOrder: 'desc' });
  const pills = useFilterPills(FILTER_LABELS);

  const siteOptions = React.useMemo(
    () => sites.map((site) => ({ value: site.id, label: site.name })),
    [sites],
  );

  const columns = React.useMemo<Array<ColumnDef<ReportRow>>>(
    () => [
      {
        id: 'title',
        header: 'Report',
        accessor: (row) => row.title,
        sortable: true,
        sticky: true,
        width: 320,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">{row.title}</p>
            <p className="mt-0.5 truncate text-2xs text-muted-foreground">
              {row.websiteName ?? 'Portfolio-wide'}
              {row.summary ? ` · ${row.summary}` : ''}
            </p>
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        accessor: (row) => row.type,
        sortable: true,
        width: 110,
        cell: (row) => <Badge variant="outline">{typeLabel(row.type)}</Badge>,
      },
      {
        id: 'periodEnd',
        header: 'Period',
        accessor: (row) => row.periodEnd,
        sortable: true,
        width: 190,
        exportValue: (row) => `${row.periodStart} – ${row.periodEnd}`,
        cell: (row) => <span className="tabular text-xs">{formatPeriod(row.periodStart, row.periodEnd)}</span>,
      },
      {
        id: 'clicks',
        header: 'Clicks',
        accessor: (row) => row.clicks,
        align: 'right',
        width: 130,
        cell: (row) =>
          row.clicks === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="inline-flex items-baseline gap-1.5">
              <span className="tabular text-xs">{formatNumber(row.clicks)}</span>
              <Delta value={row.clicksChangePct} />
            </span>
          ),
      },
      {
        id: 'impressions',
        header: 'Impressions',
        accessor: (row) => row.impressions,
        align: 'right',
        width: 140,
        cell: (row) =>
          row.impressions === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span className="inline-flex items-baseline gap-1.5">
              <span className="tabular text-xs">{formatCompact(row.impressions)}</span>
              <Delta value={row.impressionsChangePct} />
            </span>
          ),
      },
      {
        id: 'highlights',
        header: 'Highlights',
        accessor: (row) => row.highlights,
        align: 'right',
        width: 100,
        cell: (row) =>
          row.highlights > 0 ? (
            <span className="tabular text-xs">{formatNumber(row.highlights)}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'createdAt',
        header: 'Generated',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 150,
        cell: (row) => <span className="text-xs text-muted-foreground">{relative(row.createdAt)}</span>,
      },
    ],
    [],
  );

  if (libraryEmpty) {
    return (
      <EmptyState
        bordered
        icon={FileText}
        title="No reports have been generated yet"
        description="A report is a snapshot of one period: organic performance with deltas, what improved, what slipped, the problems found, what the agents did, and what to do next. Generate one now, or let the scheduler produce them weekly."
        action={<GenerateReportDialog sites={sites} triggerLabel="Generate the first report" />}
      />
    );
  }

  return (
    <DataTable<ReportRow>
      data={rows}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Generated reports, newest period first"
      searchable
      manualSearch
      search={params.searchInput}
      onSearchChange={params.setSearch}
      searchPlaceholder="Search report titles…"
      sort={params.sort}
      order={params.order}
      onSortChange={(id, order) => params.setSort(id, order)}
      page={page}
      pageSize={pageSize}
      total={total}
      onPageChange={params.setPage}
      onPageSizeChange={params.setPageSize}
      itemLabel="report"
      rowHref={(row) => `/reports/${row.id}`}
      filterPills={pills}
      onClearFilters={params.clearFilters}
      stickyHeader
      toolbar={
        <FilterBar>
          {siteOptions.length > 1 ? (
            <FacetFilter paramKey="site" label="Site" options={siteOptions} searchable />
          ) : null}
          {typeOptions.length > 1 ? (
            <FacetFilter
              paramKey="type"
              label="Type"
              options={typeOptions.map((option) => ({
                value: option.value,
                label: option.label,
                count: option.count,
              }))}
            />
          ) : null}
        </FilterBar>
      }
      toolbarActions={<GenerateReportDialog sites={sites} />}
      emptyState={
        <EmptyState
          size="sm"
          icon={FileText}
          title="No reports match these filters"
          description="Clear the filters to see the whole library, or generate a report for this site and period."
          action={
            <Button variant="outline" size="sm" onClick={params.clearFilters}>
              Clear filters
            </Button>
          }
        />
      }
      className={cn('min-w-0')}
    />
  );
}

export { formatPeriod, typeLabel };

/** Convenience re-export so the detail page links back with the same label vocabulary. */
export function ReportBackLink({ className }: { className?: string }): React.JSX.Element {
  return (
    <Link href="/reports" className={cn('text-xs font-medium text-primary hover:underline', className)}>
      All reports
    </Link>
  );
}
