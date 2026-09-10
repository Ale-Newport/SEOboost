'use client';

import Link from 'next/link';
import { LineChart } from 'lucide-react';

import { ChartContainer } from '@/components/charts/chart-container';
import { TimeSeriesChart, type TimeSeriesRow } from '@/components/charts/time-series-chart';
import { Button } from '@/components/ui/button';
import type { PagePerformance } from '@/components/pages/types';

export interface PagePerformancePanelProps {
  websiteId: string;
  performance: PagePerformance;
}

/**
 * Daily search performance for this one URL.
 *
 * Impressions start hidden: on a shared linear axis they sit one to two orders of magnitude above
 * clicks and flatten the series that matters. Position gets its own reversed axis, because "up"
 * has to mean "better" for a metric where 1 beats 30.
 */
export function PagePerformancePanel({ websiteId, performance }: PagePerformancePanelProps): React.JSX.Element {
  const description =
    `${performance.days} days of Search Console data for this exact URL — ` +
    `${performance.range.from} to ${performance.range.to}. Reporting lags two to three days, so the window ends before today.`;

  if (!performance.hasData) {
    return (
      <ChartContainer
        title="Search performance"
        description={description}
        height={300}
        empty
        emptyIcon={<LineChart className="size-5" aria-hidden="true" />}
        emptyTitle="No search data for this URL"
        emptyMessage="Either Search Console is not connected for this site, or this page has had no impressions in the window."
        emptyAction={
          <Button asChild size="sm" variant="outline">
            <Link href={`/sites/${websiteId}/settings`}>Check the Search Console connection</Link>
          </Button>
        }
      >
        <span />
      </ChartContainer>
    );
  }

  const rows: TimeSeriesRow[] = performance.points.map((point) => ({
    date: point.date,
    clicks: point.clicks,
    impressions: point.impressions,
    position: point.position,
  }));

  return (
    <TimeSeriesChart
      data={rows}
      title="Search performance"
      description={description}
      height={300}
      series={[
        { key: 'clicks', label: 'Clicks', type: 'area', axis: 'left', format: 'number' },
        {
          key: 'impressions',
          label: 'Impressions',
          type: 'line',
          axis: 'left',
          format: 'compact',
          defaultHidden: true,
        },
        { key: 'position', label: 'Avg. position', type: 'line', axis: 'right', format: 'position' },
      ]}
    />
  );
}
