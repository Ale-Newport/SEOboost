'use client';

import { useCallback, useMemo } from 'react';
import { Search } from 'lucide-react';

import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatNumber, shortenUrl } from '@/lib/utils';
import { metricColumns } from './metric-columns';
import type { QueryRow } from './types';

export interface QueriesTableProps {
  rows: readonly QueryRow[];
  /** Used for the export filename so a download names the site it came from. */
  domain: string;
  windowLabel: string;
}

/**
 * Top queries for the window, aggregated across every page that ranks for them.
 *
 * Sorting and paging are client-side: the server already returned the whole shortlist, so
 * re-querying to reorder fifty rows would be a round trip for nothing — and it keeps this table
 * from fighting the other three on the page over the same `sort` and `page` URL params.
 */
export function QueriesTable({ rows, domain, windowLabel }: QueriesTableProps): React.JSX.Element {
  const getRowId = useCallback((row: QueryRow) => row.query, []);

  const columns = useMemo<Array<ColumnDef<QueryRow>>>(
    () => [
      {
        id: 'query',
        header: 'Query',
        accessor: (row) => row.query,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground" title={row.query}>
              {row.query}
            </p>
            <p className="truncate text-2xs text-muted-foreground" title={row.page}>
              {row.page ? shortenUrl(row.page, 56) : 'No landing page recorded'}
            </p>
          </div>
        ),
        sortable: true,
        width: 300,
        sticky: true,
      },
      {
        id: 'pageCount',
        header: 'Pages',
        headerLabel: 'Ranking pages',
        accessor: (row) => row.pageCount,
        cell: (row) =>
          row.pageCount > 1 ? (
            <SimpleTooltip
              content={`${formatNumber(row.pageCount)} pages rank for this query. More than one is a cannibalisation signal worth checking.`}
            >
              <Badge variant="outline" className="tabular">
                {formatNumber(row.pageCount)}
              </Badge>
            </SimpleTooltip>
          ) : (
            <span className="tabular text-2xs text-muted-foreground">1</span>
          ),
        sortable: true,
        align: 'right',
        width: 72,
      },
      ...metricColumns<QueryRow>({
        clicks: (row) => row.clicks,
        impressions: (row) => row.impressions,
        ctr: (row) => row.ctr,
        position: (row) => row.position,
      }),
    ],
    [],
  );

  return (
    <DataTable<QueryRow>
      data={rows}
      columns={columns}
      getRowId={getRowId}
      caption={`Top search queries for ${windowLabel}`}
      searchable
      searchPlaceholder="Filter queries…"
      searchKeys={['query']}
      defaultSort="clicks"
      defaultOrder="desc"
      pageSize={25}
      itemLabel="queries"
      defaultDensity="compact"
      stickyHeader
      maxHeight={520}
      exportFilename={`${domain}-top-queries`}
      emptyState={
        <EmptyState
          size="sm"
          icon={Search}
          title="No queries in this window"
          description="Search Console reported no query rows for these dates. Widen the range, or check that the site's Search Console sync has run."
        />
      }
    />
  );
}
