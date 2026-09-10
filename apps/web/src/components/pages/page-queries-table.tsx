'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';

import {
  DataTable,
  KeywordCell,
  type ColumnDef,
} from '@/components/data';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition } from '@/lib/utils';
import type { PageQueryInsight } from '@/components/pages/types';

export interface PageQueriesTableProps {
  websiteId: string;
  queries: PageQueryInsight[];
  hasSearchData: boolean;
}

const CTR_GAP_INFO =
  'The click-through rate a result at this position typically earns, from the shared CTR curve. ' +
  'Sitting well below it usually means the title and description do not match the intent behind the query — ' +
  'it is not a ranking signal, it is a snippet problem.';

/**
 * Every query this URL is known to rank for, with the expected-CTR comparison.
 *
 * The gap column is the point of the table: position and clicks alone cannot tell you whether a
 * page is under-earning its rank, and the difference is the one number that turns "we rank
 * fourth" into a concrete rewrite.
 */
export function PageQueriesTable({
  websiteId,
  queries,
  hasSearchData,
}: PageQueriesTableProps): React.JSX.Element {
  const columns = useMemo<Array<ColumnDef<PageQueryInsight>>>(
    () => [
      {
        id: 'query',
        header: 'Query',
        accessor: (row) => row.query,
        sortable: true,
        sticky: true,
        width: 260,
        cell: (row) => <KeywordCell keyword={row.query} showIntent={false} />,
      },
      {
        id: 'position',
        header: 'Position',
        accessor: (row) => row.position,
        sortable: true,
        align: 'right',
        width: 96,
        cell: (row) => <span className="tabular text-sm">{formatPosition(row.position)}</span>,
      },
      {
        id: 'clicks',
        header: 'Clicks',
        accessor: (row) => row.clicks,
        sortable: true,
        align: 'right',
        width: 88,
        cell: (row) => <span className="tabular text-sm">{formatNumber(row.clicks)}</span>,
      },
      {
        id: 'impressions',
        header: 'Impressions',
        accessor: (row) => row.impressions,
        sortable: true,
        align: 'right',
        width: 112,
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">{formatCompact(row.impressions)}</span>
        ),
      },
      {
        id: 'ctr',
        header: 'CTR',
        accessor: (row) => row.ctr,
        sortable: true,
        align: 'right',
        width: 88,
        exportValue: (row) => row.ctr,
        cell: (row) => <span className="tabular text-sm">{formatPercent(row.ctr, 2)}</span>,
      },
      {
        id: 'expectedCtr',
        header: (
          <span className="inline-flex items-center gap-1">
            Expected
            <TooltipInfo content={CTR_GAP_INFO} label="What expected CTR means" />
          </span>
        ),
        headerLabel: 'Expected CTR',
        accessor: (row) => row.expectedCtr,
        sortable: true,
        align: 'right',
        width: 110,
        exportValue: (row) => row.expectedCtr,
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">{formatPercent(row.expectedCtr, 2)}</span>
        ),
      },
      {
        id: 'ctrGap',
        header: 'Gap',
        headerLabel: 'CTR gap',
        accessor: (row) => row.ctrGap,
        sortable: true,
        align: 'right',
        width: 132,
        exportValue: (row) => row.ctrGap,
        cell: (row) => {
          const label = `${row.ctrGap > 0 ? '+' : ''}${(row.ctrGap * 100).toFixed(2)}%`;
          if (!row.underperforms) {
            return (
              <span className={cn('tabular text-sm', row.ctrGap >= 0 ? 'text-success' : 'text-muted-foreground')}>
                {label}
              </span>
            );
          }
          return (
            <SimpleTooltip
              content={`At the expected rate this query would add about ${formatNumber(row.potentialClicks)} clicks over the same window.`}
            >
              <span className="tabular inline-flex items-center gap-1.5 text-sm font-medium text-warning">
                {label}
                <span className="text-2xs font-normal text-muted-foreground">
                  +{formatNumber(row.potentialClicks)} clicks
                </span>
              </span>
            </SimpleTooltip>
          );
        },
      },
    ],
    [],
  );

  const underperforming = queries.filter((row) => row.underperforms).length;

  return (
    <section className="rounded-lg border border-border bg-card shadow-xs">
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 pb-3 pt-4">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-semibold tracking-tight">Queries</h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {queries.length === 0
              ? 'Search Console query rows attributed to this URL.'
              : `${formatNumber(queries.length)} quer${queries.length === 1 ? 'y' : 'ies'} attributed to this URL` +
                (underperforming > 0
                  ? `, ${underperforming} earning less than the CTR curve predicts.`
                  : ', all earning at or above the CTR curve.')}
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/sites/${websiteId}/keywords`}>All keywords</Link>
        </Button>
      </header>

      <DataTable<PageQueryInsight>
        data={queries}
        columns={columns}
        getRowId={(row) => row.query}
        caption="Search queries this page ranks for, with the expected click-through rate for each position"
        defaultSort="impressions"
        defaultOrder="desc"
        hideToolbar
        stickyHeader
        maxHeight={420}
        exportable={false}
        className="border-0 shadow-none"
        emptyState={
          <EmptyState
            size="sm"
            icon={Search}
            title={hasSearchData ? 'No query rows for this URL' : 'No Search Console data yet'}
            description={
              hasSearchData
                ? 'This URL has impressions in the daily totals but no query-level rows yet. Query data is imported separately and can lag the daily sync.'
                : 'Connect Search Console and run a sync: query-level performance has no other source.'
            }
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={`/sites/${websiteId}/settings`}>Integrations</Link>
              </Button>
            }
          />
        }
      />
    </section>
  );
}
