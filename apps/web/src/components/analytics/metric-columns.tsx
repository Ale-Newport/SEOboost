'use client';

import type { ColumnDef } from '@/components/data/data-table';
import { formatCompact, formatNumber, formatPercent, formatPosition } from '@/lib/utils';

/**
 * The four Search Console measures, rendered identically wherever they appear.
 *
 * Every table on this screen ends in the same clicks / impressions / CTR / position block, so it
 * is built once: a reader comparing the queries table with the pages table is comparing the same
 * columns in the same order, formatted the same way, and the CSV export inherits that too.
 */
export interface MetricAccessors<T> {
  clicks: (row: T) => number;
  impressions: (row: T) => number;
  /** 0-1. */
  ctr: (row: T) => number;
  position: (row: T) => number;
}

export function metricColumns<T>(get: MetricAccessors<T>): Array<ColumnDef<T>> {
  return [
    {
      id: 'clicks',
      header: 'Clicks',
      accessor: get.clicks,
      cell: (row) => <span className="tabular text-xs">{formatNumber(get.clicks(row))}</span>,
      sortable: true,
      align: 'right',
      width: 84,
    },
    {
      id: 'impressions',
      header: 'Impressions',
      accessor: get.impressions,
      cell: (row) => (
        <span className="tabular text-xs text-muted-foreground">
          {formatCompact(get.impressions(row))}
        </span>
      ),
      exportValue: (row) => get.impressions(row),
      sortable: true,
      align: 'right',
      width: 104,
    },
    {
      id: 'ctr',
      header: 'CTR',
      accessor: get.ctr,
      cell: (row) => <span className="tabular text-xs">{formatPercent(get.ctr(row), 2)}</span>,
      // A ratio, not a percentage string — a spreadsheet can then do arithmetic on the column.
      exportValue: (row) => get.ctr(row),
      sortable: true,
      align: 'right',
      width: 76,
    },
    {
      id: 'position',
      header: 'Position',
      headerLabel: 'Average position',
      accessor: get.position,
      cell: (row) => (
        <span className="tabular text-xs text-muted-foreground">
          {formatPosition(get.position(row))}
        </span>
      ),
      exportValue: (row) => get.position(row),
      sortable: true,
      align: 'right',
      width: 84,
    },
  ];
}
