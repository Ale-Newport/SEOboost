'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Area,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartLegend,
  seriesColor,
  useChartColors,
  withAlpha,
  type ChartLegendItem,
} from './chart-container';
import { ChartTooltip, formatChartValue, type ChartValueFormat } from './chart-tooltip';
import { formatCompact } from '@/lib/utils';

/** Suffix used for the comparison-period copy of a series inside the merged row. */
const PREV_SUFFIX = '__prev';
const PREV_DATE_KEY = '__prevDate';
/** Above this many points the x-axis becomes brushable — otherwise ticks turn into mush. */
const BRUSH_THRESHOLD = 90;

export interface TimeSeriesRow {
  /** ISO date (yyyy-MM-dd) or any string date-fns can parse. */
  date: string;
  [metric: string]: string | number | null | undefined;
}

export interface TimeSeriesSeries {
  /** Key into the row objects. */
  key: string;
  label: string;
  /** Explicit colour; otherwise `colorIndex` (or position) picks from --chart-1..6. */
  color?: string;
  colorIndex?: number;
  type?: 'line' | 'area';
  axis?: 'left' | 'right';
  format?: ChartValueFormat;
  strokeWidth?: number;
  /** Start hidden; the legend can re-enable it. */
  defaultHidden?: boolean;
}

export interface TimeSeriesChartProps {
  data: readonly TimeSeriesRow[];
  series: readonly TimeSeriesSeries[];
  /**
   * Same-shape rows for the previous period, in chronological order. They are zipped onto the
   * current rows by index (not by date) so the two periods line up on a single x-axis, and are
   * drawn as dashed overlays.
   */
  comparison?: readonly TimeSeriesRow[];
  comparisonLabel?: string;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  loading?: boolean;
  /** Reverse the right axis — average position is "better" when smaller. Auto-on for `position`. */
  rightAxisReversed?: boolean;
  showLegend?: boolean;
  showGrid?: boolean;
  /** Force the brush on/off; defaults to on above 90 points. */
  brush?: boolean;
  emptyMessage?: string;
  bare?: boolean;
  className?: string;
  dateFormat?: string;
}

interface MergedRow {
  date: string;
  [key: string]: string | number | null | undefined;
}

function axisTickFormatter(value: number, fmt: ChartValueFormat): string {
  if (fmt === 'percent') return formatChartValue(value, 'percent');
  if (fmt === 'position') return value.toFixed(0);
  return formatCompact(value);
}

/**
 * Multi-series time chart with an optional dashed comparison-period overlay and independent
 * left/right axes (e.g. clicks left, average position right and inverted).
 */
export function TimeSeriesChart({
  data,
  series,
  comparison,
  comparisonLabel = 'Previous period',
  title,
  description,
  actions,
  height = 300,
  loading = false,
  rightAxisReversed,
  showLegend = true,
  showGrid = true,
  brush,
  emptyMessage = 'No metrics for this period yet.',
  bare = false,
  className,
  dateFormat = 'd MMM',
}: TimeSeriesChartProps) {
  const colors = useChartColors();
  const gradientId = useId().replace(/:/g, '');
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(series.filter((s) => s.defaultHidden).map((s) => s.key)),
  );

  const toggle = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const resolved = useMemo(
    () =>
      series.map((s, i) => ({
        ...s,
        axis: s.axis ?? 'left',
        type: s.type ?? 'line',
        format: s.format ?? 'number',
        color: s.color ?? seriesColor(colors, s.colorIndex ?? i),
      })),
    [series, colors],
  );

  /** Zip the comparison period onto the current rows by index so both share one x-axis. */
  const merged = useMemo<MergedRow[]>(() => {
    if (!comparison || comparison.length === 0) return data.map((row) => ({ ...row }));
    return data.map((row, i) => {
      const prev = comparison[i];
      const out: MergedRow = { ...row };
      if (prev) {
        out[PREV_DATE_KEY] = prev.date;
        for (const s of series) out[`${s.key}${PREV_SUFFIX}`] = prev[s.key] ?? null;
      }
      return out;
    });
  }, [data, comparison, series]);

  const hasComparison = Boolean(comparison && comparison.length > 0);
  const visible = resolved.filter((s) => !hidden.has(s.key));
  const hasRight = visible.some((s) => s.axis === 'right');
  const rightSeries = resolved.filter((s) => s.axis === 'right');
  const reverseRight = rightAxisReversed ?? rightSeries.some((s) => s.format === 'position');
  const leftFormat: ChartValueFormat = visible.find((s) => s.axis === 'left')?.format ?? 'number';
  const rightFormat: ChartValueFormat = rightSeries[0]?.format ?? 'number';

  const formatByKey = useMemo(() => {
    const map = new Map<string, ChartValueFormat>();
    for (const s of resolved) {
      map.set(s.key, s.format);
      map.set(`${s.key}${PREV_SUFFIX}`, s.format);
    }
    return map;
  }, [resolved]);

  const labelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of resolved) {
      map.set(s.key, s.label);
      map.set(`${s.key}${PREV_SUFFIX}`, `${s.label} · ${comparisonLabel.toLowerCase()}`);
    }
    return map;
  }, [resolved, comparisonLabel]);

  const tickFormat = useCallback(
    (value: string): string => {
      try {
        return format(parseISO(value), dateFormat);
      } catch {
        return value;
      }
    },
    [dateFormat],
  );

  const showBrush = brush ?? merged.length > BRUSH_THRESHOLD;
  const brushStart = showBrush ? Math.max(0, merged.length - BRUSH_THRESHOLD) : 0;

  const legendItems = useMemo<ChartLegendItem[]>(() => {
    const items: ChartLegendItem[] = resolved.map((s) => ({
      id: s.key,
      label: s.label,
      color: s.color,
      hidden: hidden.has(s.key),
    }));
    if (hasComparison) {
      items.push({ id: PREV_SUFFIX, label: comparisonLabel, color: colors.mutedForeground, dashed: true });
    }
    return items;
  }, [resolved, hidden, hasComparison, comparisonLabel, colors.mutedForeground]);

  const ariaLabel = useMemo(() => {
    if (merged.length === 0) return 'Time series chart with no data';
    const first = merged[0]?.date ?? '';
    const last = merged[merged.length - 1]?.date ?? '';
    const parts = resolved.map((s) => {
      const values = merged
        .map((r) => r[s.key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (values.length === 0) return `${s.label}: no data`;
      const latest = values[values.length - 1] ?? 0;
      const firstValue = values[0] ?? 0;
      const direction = latest > firstValue ? 'up' : latest < firstValue ? 'down' : 'flat';
      return `${s.label} ${direction} from ${formatChartValue(firstValue, s.format)} to ${formatChartValue(latest, s.format)}`;
    });
    return `Time series from ${first} to ${last}. ${parts.join('. ')}.`;
  }, [merged, resolved]);

  const isEmpty =
    merged.length === 0 ||
    resolved.every((s) => merged.every((row) => typeof row[s.key] !== 'number'));

  return (
    <ChartContainer
      title={title}
      description={description}
      actions={actions}
      height={height}
      loading={loading}
      empty={isEmpty}
      emptyMessage={emptyMessage}
      bare={bare}
      className={className}
      footer={showLegend && !isEmpty ? <ChartLegend items={legendItems} onToggle={toggle} /> : undefined}
    >
      <div role="img" aria-label={ariaLabel} className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={merged} margin={{ top: 8, right: hasRight ? 4 : 12, bottom: 0, left: 0 }}>
            <defs>
              {resolved
                .filter((s) => s.type === 'area')
                .map((s) => (
                  <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
            </defs>

            {showGrid ? (
              <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />
            ) : null}

            <XAxis
              dataKey="date"
              tickFormatter={tickFormat}
              tick={{ fill: colors.mutedForeground, fontSize: 11 }}
              stroke={colors.border}
              tickLine={false}
              axisLine={{ stroke: colors.border }}
              minTickGap={24}
            />

            <YAxis
              yAxisId="left"
              tick={{ fill: colors.mutedForeground, fontSize: 11 }}
              tickFormatter={(v: number) => axisTickFormatter(v, leftFormat)}
              stroke={colors.border}
              tickLine={false}
              axisLine={false}
              width={52}
            />

            {hasRight ? (
              <YAxis
                yAxisId="right"
                orientation="right"
                reversed={reverseRight}
                tick={{ fill: colors.mutedForeground, fontSize: 11 }}
                tickFormatter={(v: number) => axisTickFormatter(v, rightFormat)}
                stroke={colors.border}
                tickLine={false}
                axisLine={false}
                width={44}
              />
            ) : null}

            <Tooltip
              cursor={{ stroke: colors.border, strokeWidth: 1 }}
              content={
                <ChartTooltip
                  labelFormatter={(label) => tickFormat(String(label))}
                  nameFormatter={(name) => labelByKey.get(name) ?? name}
                  valueFormatter={(value, entry) =>
                    formatChartValue(value, formatByKey.get(String(entry.dataKey ?? '')) ?? 'number')
                  }
                  hideEmpty
                  footer={
                    hasComparison
                      ? (rows) => {
                          const prevDate = rows[0]?.payload?.[PREV_DATE_KEY];
                          return typeof prevDate === 'string'
                            ? `${comparisonLabel}: ${tickFormat(prevDate)}`
                            : null;
                        }
                      : undefined
                  }
                />
              }
            />

            {resolved.map((s) => {
              if (hidden.has(s.key)) return null;
              const axisId = s.axis === 'right' ? 'right' : 'left';
              if (s.type === 'area') {
                return (
                  <Area
                    key={s.key}
                    yAxisId={axisId}
                    type="monotone"
                    dataKey={s.key}
                    name={s.key}
                    stroke={s.color}
                    strokeWidth={s.strokeWidth ?? 2}
                    fill={`url(#${gradientId}-${s.key})`}
                    dot={false}
                    activeDot={{ r: 3, strokeWidth: 0 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                );
              }
              return (
                <Line
                  key={s.key}
                  yAxisId={axisId}
                  type="monotone"
                  dataKey={s.key}
                  name={s.key}
                  stroke={s.color}
                  strokeWidth={s.strokeWidth ?? 2}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })}

            {hasComparison
              ? resolved.map((s) => {
                  if (hidden.has(s.key)) return null;
                  return (
                    <Line
                      key={`${s.key}${PREV_SUFFIX}`}
                      yAxisId={s.axis === 'right' ? 'right' : 'left'}
                      type="monotone"
                      dataKey={`${s.key}${PREV_SUFFIX}`}
                      name={`${s.key}${PREV_SUFFIX}`}
                      stroke={withAlpha(s.color, 0.55)}
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={false}
                      activeDot={false}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  );
                })
              : null}

            {showBrush ? (
              <Brush
                dataKey="date"
                height={22}
                travellerWidth={8}
                startIndex={brushStart}
                stroke={colors.border}
                fill={withAlpha(colors.muted, 0.6)}
                tickFormatter={tickFormat}
              />
            ) : null}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
}
