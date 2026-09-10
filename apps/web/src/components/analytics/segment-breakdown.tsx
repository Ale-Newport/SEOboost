'use client';

import { useCallback, useMemo } from 'react';
import { Globe, MonitorSmartphone } from 'lucide-react';

import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { formatPercent } from '@/lib/utils';
import { metricColumns } from './metric-columns';
import type { SegmentRow } from './types';

interface SegmentTableProps {
  rows: readonly SegmentRow[];
  dimensionLabel: string;
  caption: string;
  exportFilename: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyIcon: typeof Globe;
  maxHeight: number;
}

function SegmentTable({
  rows,
  dimensionLabel,
  caption,
  exportFilename,
  emptyTitle,
  emptyDescription,
  emptyIcon,
  maxHeight,
}: SegmentTableProps): React.JSX.Element {
  const getRowId = useCallback((row: SegmentRow) => row.value, []);

  const columns = useMemo<Array<ColumnDef<SegmentRow>>>(
    () => [
      {
        id: 'segment',
        header: dimensionLabel,
        accessor: (row) => row.label,
        cell: (row) => (
          <div className="min-w-0 space-y-1">
            <p className="truncate text-xs font-medium text-foreground">{row.label}</p>
            {/* The share bar is decorative — the number beside it carries the same information. */}
            <div className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.min(100, Math.max(0, row.share * 100))}%` }}
              />
            </div>
          </div>
        ),
        sortable: true,
        width: 160,
      },
      {
        id: 'share',
        header: 'Share',
        headerLabel: 'Share of clicks',
        accessor: (row) => row.share,
        cell: (row) => (
          <span className="tabular text-xs text-muted-foreground">
            {formatPercent(row.share, 1)}
          </span>
        ),
        exportValue: (row) => row.share,
        sortable: true,
        align: 'right',
        width: 76,
      },
      ...metricColumns<SegmentRow>({
        clicks: (row) => row.clicks,
        impressions: (row) => row.impressions,
        ctr: (row) => row.ctr,
        position: (row) => row.position,
      }),
    ],
    [dimensionLabel],
  );

  return (
    <DataTable<SegmentRow>
      data={rows}
      columns={columns}
      getRowId={getRowId}
      caption={caption}
      searchable={false}
      defaultSort="clicks"
      defaultOrder="desc"
      pageSize={10}
      itemLabel={dimensionLabel.toLowerCase()}
      defaultDensity="compact"
      stickyHeader
      maxHeight={maxHeight}
      exportFilename={exportFilename}
      emptyState={
        <EmptyState
          size="sm"
          icon={emptyIcon}
          title={emptyTitle}
          description={emptyDescription}
        />
      }
    />
  );
}

export interface SegmentBreakdownProps {
  countries: readonly SegmentRow[];
  devices: readonly SegmentRow[];
  domain: string;
  windowLabel: string;
}

/**
 * Where the traffic came from, by country and by device.
 *
 * These are separate Search Console exports rather than a cross-tabulation: a country row and a
 * device row each total the whole site, so the two tables should agree with the summary cards but
 * cannot be multiplied together.
 */
export function SegmentBreakdown({
  countries,
  devices,
  domain,
  windowLabel,
}: SegmentBreakdownProps): React.JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SegmentTable
        rows={countries}
        dimensionLabel="Country"
        caption={`Clicks by country for ${windowLabel}`}
        exportFilename={`${domain}-clicks-by-country`}
        emptyIcon={Globe}
        emptyTitle="No country breakdown imported"
        emptyDescription="The Search Console sync stores country rows separately from the site totals. Run a sync for this window to populate it."
        maxHeight={420}
      />
      <SegmentTable
        rows={devices}
        dimensionLabel="Device"
        caption={`Clicks by device for ${windowLabel}`}
        exportFilename={`${domain}-clicks-by-device`}
        emptyIcon={MonitorSmartphone}
        emptyTitle="No device breakdown imported"
        emptyDescription="The Search Console sync stores device rows separately from the site totals. Run a sync for this window to populate it."
        maxHeight={420}
      />
    </div>
  );
}
