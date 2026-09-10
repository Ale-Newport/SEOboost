'use client';

import { useMemo, useState } from 'react';
import { TimeSeriesChart } from '@/components/charts/time-series-chart';
import { ChartContainer } from '@/components/charts/chart-container';
import { Button } from '@/components/ui/button';
import type { TimeSeriesPoint } from '@seo/shared';
import { cn } from '@/lib/utils';

const RANGES = [
  { label: '28d', days: 28 },
  { label: '90d', days: 90 },
] as const;

const METRICS = [
  { key: 'clicks', label: 'Clicks', format: 'number' as const },
  { key: 'impressions', label: 'Impressions', format: 'compact' as const },
  { key: 'ctr', label: 'CTR', format: 'percent' as const },
  { key: 'position', label: 'Avg. position', format: 'position' as const },
];

/**
 * Portfolio performance over time.
 * The comparison overlay is built from the `previous*` keys the analytics query attaches, so the
 * chart receives two aligned series rather than re-querying when the metric toggle changes.
 */
export function PortfolioChart({ series, hasData }: { series: TimeSeriesPoint[]; hasData: boolean }) {
  const [days, setDays] = useState<number>(90);
  const [metric, setMetric] = useState<string>('clicks');

  const activeMetric = METRICS.find((m) => m.key === metric) ?? METRICS[0]!;
  const visible = useMemo(() => series.slice(-days), [series, days]);

  const comparison = useMemo(() => {
    const capitalised = `previous${activeMetric.key.charAt(0).toUpperCase()}${activeMetric.key.slice(1)}`;
    if (!visible.some((point) => point[capitalised] !== undefined)) return undefined;
    return visible.map((point) => ({
      date: String(point.previousDate ?? point.date),
      [activeMetric.key]: (point[capitalised] as number | null) ?? null,
    }));
  }, [visible, activeMetric.key]);

  return (
    <ChartContainer
      title="Portfolio organic performance"
      description={hasData ? 'Search Console data across every connected property' : undefined}
      empty={!hasData || visible.length === 0}
      emptyTitle="No search data yet"
      emptyMessage="Connect a Search Console property in a site's Settings → Integrations, then run a sync to populate this chart."
      height={300}
      actions={
        <div className="flex items-center gap-1">
          <div className="mr-2 hidden rounded-md border border-border p-0.5 sm:flex" role="group" aria-label="Metric">
            {METRICS.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => setMetric(m.key)}
                className={cn(
                  'rounded px-2 py-1 text-xs font-medium transition-colors',
                  metric === m.key ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={metric === m.key}
              >
                {m.label}
              </button>
            ))}
          </div>
          {RANGES.map((range) => (
            <Button
              key={range.label}
              variant={days === range.days ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setDays(range.days)}
              aria-pressed={days === range.days}
            >
              {range.label}
            </Button>
          ))}
        </div>
      }
    >
      <TimeSeriesChart
        bare
        data={visible}
        comparison={comparison}
        comparisonLabel="Previous period"
        series={[
          {
            key: activeMetric.key,
            label: activeMetric.label,
            format: activeMetric.format,
            type: activeMetric.key === 'position' ? 'line' : 'area',
            axis: activeMetric.key === 'position' ? 'right' : 'left',
          },
        ]}
        height={280}
      />
    </ChartContainer>
  );
}
