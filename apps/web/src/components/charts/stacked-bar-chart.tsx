'use client';

import { useCallback, useMemo } from 'react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer, ChartLegend, seriesColor, useChartColors } from './chart-container';
import { ChartTooltip, formatChartValue, type ChartValueFormat } from './chart-tooltip';
import { formatCompact, formatPercent } from '@/lib/utils';

const VALUE_LABEL_MAX_BARS = 12;
const STACK_ID = 'stack';

export interface StackedBarSeries {
  key: string;
  label: string;
  color?: string;
  colorIndex?: number;
}

export interface StackedBarRow {
  [key: string]: string | number | null | undefined;
}

export interface StackedBarChartProps {
  data: readonly StackedBarRow[];
  series: readonly StackedBarSeries[];
  /** Field holding the category name on each row. */
  categoryKey?: string;
  layout?: 'columns' | 'bars';
  /** `expand` normalises every stack to 100% — use for composition-over-time. */
  stackOffset?: 'none' | 'expand';
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  loading?: boolean;
  format?: ChartValueFormat;
  /** Stack totals at the end of each bar; defaults to on for a small number of bars. */
  showValueLabels?: boolean;
  showLegend?: boolean;
  emptyMessage?: string;
  bare?: boolean;
  className?: string;
  categoryWidth?: number;
  onCategoryClick?: (category: string) => void;
}

export function StackedBarChart({
  data,
  series,
  categoryKey = 'label',
  layout = 'columns',
  stackOffset = 'none',
  title,
  description,
  actions,
  height = 280,
  loading = false,
  format = 'number',
  showValueLabels,
  showLegend = true,
  emptyMessage = 'Nothing to break down yet.',
  bare = false,
  className,
  categoryWidth = 150,
  onCategoryClick,
}: StackedBarChartProps) {
  const colors = useChartColors();
  const horizontal = layout === 'bars';
  const expand = stackOffset === 'expand';

  const resolved = useMemo(
    () => series.map((s, i) => ({ ...s, color: s.color ?? seriesColor(colors, s.colorIndex ?? i) })),
    [series, colors],
  );

  /** Stack totals are needed both for the end-of-bar label and for the tooltip's Total row. */
  const rows = useMemo(
    () =>
      data.map((row) => {
        const total = series.reduce<number>((acc, s) => {
          const v = row[s.key];
          return typeof v === 'number' && Number.isFinite(v) ? acc + v : acc;
        }, 0);
        return { ...row, __total: total };
      }),
    [data, series],
  );

  const labelsOn = (showValueLabels ?? rows.length <= VALUE_LABEL_MAX_BARS) && !expand;
  const lastKey = resolved[resolved.length - 1]?.key;

  const labelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of resolved) map.set(s.key, s.label);
    return map;
  }, [resolved]);

  const handleClick = useCallback(
    (payload: unknown) => {
      if (!onCategoryClick) return;
      if (payload && typeof payload === 'object' && categoryKey in payload) {
        const value = (payload as Record<string, unknown>)[categoryKey];
        if (typeof value === 'string') onCategoryClick(value);
      }
    },
    [onCategoryClick, categoryKey],
  );

  const ariaLabel = useMemo(() => {
    if (rows.length === 0) return 'Stacked bar chart with no data';
    const totals = resolved.map((s) => {
      const total = rows.reduce<number>((acc, r) => {
        const v = (r as unknown as Record<string, unknown>)[s.key];
        return typeof v === 'number' ? acc + v : acc;
      }, 0);
      return `${s.label} ${formatChartValue(total, format)}`;
    });
    return `Stacked bar chart across ${rows.length} categories. Totals: ${totals.join(', ')}.`;
  }, [rows, resolved, format]);

  const numericTick = useCallback(
    (v: number) => (expand ? formatPercent(v, 0) : format === 'percent' ? formatPercent(v) : formatCompact(v)),
    [expand, format],
  );

  const isEmpty = rows.length === 0 || rows.every((r) => r.__total === 0);

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
        showLegend && !isEmpty ? (
          <ChartLegend items={resolved.map((s) => ({ id: s.key, label: s.label, color: s.color }))} />
        ) : undefined
      }
    >
      <div role="img" aria-label={ariaLabel} className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart
            data={rows}
            layout={horizontal ? 'vertical' : 'horizontal'}
            stackOffset={expand ? 'expand' : 'none'}
            margin={{
              top: labelsOn && !horizontal ? 18 : 8,
              right: labelsOn && horizontal ? 52 : 12,
              bottom: 0,
              left: 0,
            }}
            barCategoryGap={horizontal ? '18%' : '22%'}
          >
            <CartesianGrid
              stroke={colors.border}
              strokeDasharray="3 3"
              horizontal={!horizontal}
              vertical={horizontal}
            />

            {horizontal ? (
              <>
                <XAxis
                  type="number"
                  tickFormatter={numericTick}
                  tick={{ fill: colors.mutedForeground, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey={categoryKey}
                  width={categoryWidth}
                  tick={{ fill: colors.mutedForeground, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                />
              </>
            ) : (
              <>
                <XAxis
                  type="category"
                  dataKey={categoryKey}
                  tick={{ fill: colors.mutedForeground, fontSize: 11 }}
                  axisLine={{ stroke: colors.border }}
                  tickLine={false}
                  interval={rows.length > 16 ? 'preserveStartEnd' : 0}
                />
                <YAxis
                  type="number"
                  tickFormatter={numericTick}
                  tick={{ fill: colors.mutedForeground, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={52}
                />
              </>
            )}

            <Tooltip
              cursor={{ fill: colors.muted, fillOpacity: 0.5 }}
              content={
                <ChartTooltip
                  format={expand ? 'number' : format}
                  nameFormatter={(name) => labelByKey.get(name) ?? name}
                  showTotal={!expand}
                  hideEmpty
                />
              }
            />

            {resolved.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.key}
                stackId={STACK_ID}
                fill={s.color}
                isAnimationActive={false}
                onClick={handleClick}
                cursor={onCategoryClick ? 'pointer' : undefined}
                radius={
                  s.key === lastKey ? (horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]) : undefined
                }
              >
                {labelsOn && s.key === lastKey ? (
                  <LabelList
                    dataKey="__total"
                    position={horizontal ? 'right' : 'top'}
                    fill={colors.mutedForeground}
                    fontSize={11}
                    formatter={(value: number) => formatChartValue(value, format)}
                  />
                ) : null}
              </Bar>
            ))}
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
}
