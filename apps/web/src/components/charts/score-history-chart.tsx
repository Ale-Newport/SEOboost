'use client';

import { useCallback, useId, useMemo } from 'react';
import { format, parseISO } from 'date-fns';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer, ChartLegend, seriesColor, useChartColors, withAlpha } from './chart-container';
import { ChartTooltip } from './chart-tooltip';

export interface ScoreHistoryPoint {
  date: string;
  [key: string]: string | number | null | undefined;
}

export interface ScoreSeries {
  key: string;
  label: string;
  color?: string;
  colorIndex?: number;
  type?: 'line' | 'area';
}

export interface ScoreBand {
  id: string;
  label: string;
  from: number;
  to: number;
  /** Resolved CSS colour. Omit to use the default poor/fair/good ramp. */
  color?: string;
}

/** Default 0-100 grading bands, shaded behind the line so a score is readable without a legend. */
const DEFAULT_BANDS: readonly ScoreBand[] = [
  { id: 'poor', label: 'Poor', from: 0, to: 50 },
  { id: 'fair', label: 'Fair', from: 50, to: 75 },
  { id: 'good', label: 'Good', from: 75, to: 100 },
];

export interface ScoreHistoryChartProps {
  data: readonly ScoreHistoryPoint[];
  /** Defaults to a single `score` series. */
  series?: readonly ScoreSeries[];
  bands?: readonly ScoreBand[];
  showBands?: boolean;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  loading?: boolean;
  emptyMessage?: string;
  dateFormat?: string;
  showLegend?: boolean;
  bare?: boolean;
  className?: string;
}

export function ScoreHistoryChart({
  data,
  series,
  bands,
  showBands = true,
  title,
  description,
  actions,
  height = 260,
  loading = false,
  emptyMessage = 'No score history yet — it fills in after the first crawl.',
  dateFormat = 'd MMM',
  showLegend,
  bare = false,
  className,
}: ScoreHistoryChartProps) {
  const colors = useChartColors();
  const gradientId = useId().replace(/:/g, '');

  const resolvedSeries = useMemo<Required<Omit<ScoreSeries, 'colorIndex'>>[]>(() => {
    const input = series && series.length > 0 ? series : [{ key: 'score', label: 'Score' }];
    return input.map((s, i) => ({
      key: s.key,
      label: s.label,
      type: s.type ?? (input.length === 1 ? 'area' : 'line'),
      color: s.color ?? seriesColor(colors, s.colorIndex ?? i),
    }));
  }, [series, colors]);

  const resolvedBands = useMemo<Required<ScoreBand>[]>(() => {
    const palette: Record<string, string> = {
      poor: colors.destructive,
      fair: colors.warning,
      good: colors.success,
    };
    const source = bands ?? DEFAULT_BANDS;
    return source.map((b) => ({
      id: b.id,
      label: b.label,
      from: b.from,
      to: b.to,
      color: b.color ?? palette[b.id] ?? colors.mutedForeground,
    }));
  }, [bands, colors]);

  // recharts mutates nothing but its `data` prop is typed mutable, so hand it a copy.
  const rows = useMemo(() => [...data], [data]);

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

  const isEmpty =
    data.length === 0 ||
    resolvedSeries.every((s) => data.every((row) => typeof row[s.key] !== 'number'));

  const ariaLabel = useMemo(() => {
    if (isEmpty) return 'Score history chart with no data';
    const parts = resolvedSeries.map((s) => {
      const values = data
        .map((r) => r[s.key])
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      const firstValue = values[0];
      const latest = values[values.length - 1];
      if (firstValue === undefined || latest === undefined) return `${s.label}: no data`;
      return `${s.label} moved from ${Math.round(firstValue)} to ${Math.round(latest)} out of 100`;
    });
    return `Score history over ${data.length} points. ${parts.join('. ')}.`;
  }, [data, resolvedSeries, isEmpty]);

  const legendVisible = showLegend ?? resolvedSeries.length > 1;

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
      footer={
        !isEmpty ? (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            {legendVisible ? (
              <ChartLegend
                items={resolvedSeries.map((s) => ({ id: s.key, label: s.label, color: s.color }))}
              />
            ) : (
              <span />
            )}
            {showBands ? (
              <ul className="flex items-center gap-3">
                {resolvedBands.map((b) => (
                  <li key={b.id} className="flex items-center gap-1.5 text-2xs">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-sm"
                      style={{ backgroundColor: withAlpha(b.color, 0.35) }}
                    />
                    <span>
                      {b.label} <span className="tabular">{b.from}–{b.to}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div role="img" aria-label={ariaLabel} className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <defs>
              {resolvedSeries
                .filter((s) => s.type === 'area')
                .map((s) => (
                  <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.3} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                  </linearGradient>
                ))}
            </defs>

            {showBands
              ? resolvedBands.map((b) => (
                  <ReferenceArea
                    key={b.id}
                    y1={b.from}
                    y2={b.to}
                    fill={b.color}
                    fillOpacity={0.07}
                    stroke="none"
                    ifOverflow="extendDomain"
                  />
                ))
              : null}

            <CartesianGrid stroke={colors.border} strokeDasharray="3 3" vertical={false} />

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
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tick={{ fill: colors.mutedForeground, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={34}
            />

            <Tooltip
              cursor={{ stroke: colors.border, strokeWidth: 1 }}
              content={
                <ChartTooltip
                  format="raw"
                  labelFormatter={(label) => tickFormat(String(label))}
                  valueFormatter={(value) =>
                    typeof value === 'number' ? `${Math.round(value)} / 100` : '—'
                  }
                  hideEmpty
                />
              }
            />

            {resolvedSeries.map((s) =>
              s.type === 'area' ? (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  fill={`url(#${gradientId}-${s.key})`}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ),
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
}
