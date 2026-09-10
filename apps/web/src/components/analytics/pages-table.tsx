'use client';

import { useCallback, useMemo } from 'react';
import { FileText } from 'lucide-react';

import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { UrlCell } from '@/components/data/url-cell';
import { EmptyState } from '@/components/ui/empty-state';
import { formatNumber } from '@/lib/utils';
import { metricColumns } from './metric-columns';
import type { PageRow } from './types';

export interface PagesTableProps {
  rows: readonly PageRow[];
  domain: string;
  windowLabel: string;
}

/**
 * Landing pages for the window, summed across every query that sent them impressions.
 *
 * The URL is the identity here — these rows come from Search Console, which reports the URL it
 * saw, not a row in our own page inventory, so a page that has never been crawled still appears.
 */
export function PagesTable({ rows, domain, windowLabel }: PagesTableProps): React.JSX.Element {
  const getRowId = useCallback((row: PageRow) => row.page, []);

  const columns = useMemo<Array<ColumnDef<PageRow>>>(
    () => [
      {
        id: 'page',
        header: 'Page',
        accessor: (row) => row.page,
        cell: (row) => (
          <div className="min-w-0 space-y-0.5">
            <UrlCell url={row.page} maxLength={52} />
            <p className="truncate text-2xs text-muted-foreground" title={row.topQuery}>
              {row.topQuery ? `Top query: ${row.topQuery}` : 'No query recorded'}
            </p>
          </div>
        ),
        sortable: true,
        width: 320,
        sticky: true,
      },
      {
        id: 'queryCount',
        header: 'Queries',
        headerLabel: 'Distinct queries',
        accessor: (row) => row.queryCount,
        cell: (row) => (
          <span className="tabular text-2xs text-muted-foreground">
            {formatNumber(row.queryCount)}
          </span>
        ),
        sortable: true,
        align: 'right',
        width: 80,
      },
      ...metricColumns<PageRow>({
        clicks: (row) => row.clicks,
        impressions: (row) => row.impressions,
        ctr: (row) => row.ctr,
        position: (row) => row.position,
      }),
    ],
    [],
  );

  return (
    <DataTable<PageRow>
      data={rows}
      columns={columns}
      getRowId={getRowId}
      caption={`Top landing pages for ${windowLabel}`}
      searchable
      searchPlaceholder="Filter pages…"
      searchKeys={['page']}
      defaultSort="clicks"
      defaultOrder="desc"
      pageSize={25}
      itemLabel="pages"
      defaultDensity="compact"
      stickyHeader
      maxHeight={520}
      exportFilename={`${domain}-top-pages`}
      emptyState={
        <EmptyState
          size="sm"
          icon={FileText}
          title="No landing pages in this window"
          description="Search Console reported no page rows for these dates. Widen the range, or check that the site's Search Console sync has run."
        />
      }
    />
  );
}
