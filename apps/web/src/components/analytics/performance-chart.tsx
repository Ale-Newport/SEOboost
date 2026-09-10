'use client';

import { useCallback, useMemo } from 'react';

import { TimeSeriesChart, type TimeSeriesRow, type TimeSeriesSeries } from '@/components/charts/time-series-chart';
import { useTableParams } from '@/components/data/use-table-params';
import { cn } from '@/lib/utils';
import { METRIC_OPTIONS, isMetricKey, type MetricKey, type PerformancePoint } from './types';

/** The URL param the toggle writes. Repeated once per selected metric. */
const METRIC_PARAM = 'metric';

const DEFAULT_METRICS: readonly MetricKey[] = ['clicks', 'impressions'];

const SERIES_CONFIG: Record<MetricKey, Omit<TimeSeriesSeries, 'key'>> = {
  clicks: { label: 'Clicks', type: 'area', axis: 'left', format: 'number', colorIndex: 0 },
  impressions: { label: 'Impressions', type: 'area', axis: 'left', format: 'number', colorIndex: 1 },
  ctr: { label: 'CTR', type: 'line', axis: 'right', format: 'percent', colorIndex: 2 },
  position: { label: 'Avg. position', type: 'line', axis: 'right', format: 'position', colorIndex: 3 },
};

export interface PerformanceChartProps {
  data: readonly PerformancePoint[];
  /** Rendered when the comparison period is enabled. */
  comparisonEnabled: boolean;
  comparisonLabel: string;
  windowLabel: string;
}

/**
 * The daily series, with the metrics on screen chosen in the URL.
 *
 * Axis assignment is not a preference, it is arithmetic: clicks and impressions are counts and
 * share the left axis, while CTR is a ratio and average position is inverted, so each of those
 * needs the right axis to itself. Selecting one of the two right-axis metrics therefore releases
 * the other rather than silently drawing it against an axis labelled for something else.
 */
export function PerformanceChart({
  data,
  comparisonEnabled,
  comparisonLabel,
  windowLabel,
}: PerformanceChartProps): React.JSX.Element {
  const { getParamList, setParams } = useTableParams();

  const selected = useMemo<MetricKey[]>(() => {
    const fromUrl = getParamList(METRIC_PARAM).filter(isMetricKey);
    return fromUrl.length > 0 ? fromUrl : [...DEFAULT_METRICS];
  }, [getParamList]);

  const toggle = useCallback(
    (key: MetricKey) => {
      const isOn = selected.includes(key);
      let next = isOn ? selected.filter((entry) => entry !== key) : [...selected, key];

      if (!isOn && SERIES_CONFIG[key].axis === 'right') {
        next = next.filter((entry) => entry === key || SERIES_CONFIG[entry].axis !== 'right');
      }
      // An empty chart is not a state worth reaching by clicking; the last metric stays on.
      if (next.length === 0) return;

      setParams({ [METRIC_PARAM]: next });
    },
    [selected, setParams],
  );

  const series = useMemo<TimeSeriesSeries[]>(
    () =>
      // Iterate the canonical order so the legend does not reshuffle as metrics are toggled.
      METRIC_OPTIONS.filter((option) => selected.includes(option.key)).map((option) => ({
        key: option.key,
        ...SERIES_CONFIG[option.key],
      })),
    [selected],
  );

  const rows = useMemo<TimeSeriesRow[]>(
    () =>
      data.map((point) => ({
        date: point.date,
        clicks: point.clicks,
        impressions: point.impressions,
        ctr: point.ctr,
        position: point.position,
      })),
    [data],
  );

  const comparisonRows = useMemo<TimeSeriesRow[] | undefined>(() => {
    if (!comparisonEnabled) return undefined;
    return data.map((point) => ({
      date: point.previousDate ?? point.date,
      clicks: point.previousClicks ?? 0,
      impressions: point.previousImpressions ?? 0,
      ctr: point.previousCtr ?? 0,
      position: point.previousPosition ?? null,
    }));
  }, [comparisonEnabled, data]);

  return (
    <TimeSeriesChart
      data={rows}
      series={series}
      {...(comparisonRows ? { comparison: comparisonRows } : {})}
      comparisonLabel={comparisonLabel}
      title="Search performance"
      description={`Daily totals for ${windowLabel}. Every point is an imported Search Console row — days with no row are drawn as gaps, not as zero.`}
      height={320}
      emptyMessage="No Search Console rows in this window."
      actions={
        <div
          role="group"
          aria-label="Metrics shown on the chart"
          className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-muted/40 p-0.5"
        >
          {METRIC_OPTIONS.map((option) => {
            const active = selected.includes(option.key);
            return (
              <button
                key={option.key}
                type="button"
                aria-pressed={active}
                title={option.hint}
                onClick={() => toggle(option.key)}
                className={cn(
                  'rounded px-2 py-1 text-2xs font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active
                    ? 'bg-card text-foreground shadow-xs'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      }
    />
  );
}
