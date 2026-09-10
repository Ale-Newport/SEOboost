'use client';

import { useCallback, useMemo } from 'react';
import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartContainer, seriesColor, useChartColors } from './chart-container';
import { ChartTooltip, formatChartValue, type ChartValueFormat } from './chart-tooltip';
import { colorIndex as hashColorIndex, formatCompact } from '@/lib/utils';

/** Above this many bars, per-bar value labels collide — the tooltip carries the numbers instead. */
const VALUE_LABEL_MAX_BARS = 12;

export interface BarDatum {
  /** Stable identity for click handlers and React keys; falls back to `label`. */
  id?: string;
  label: string;
  value: number;
  color?: string;
  colorIndex?: number;
}

export interface BarChartProps {
  data: readonly BarDatum[];
  /** `columns` draws vertical bars (default); `bars` draws horizontal ones, better for long labels. */
  layout?: 'columns' | 'bars';
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  loading?: boolean;
  format?: ChartValueFormat;
  /** Defaults to on when there are few enough bars to label without collisions. */
  showValueLabels?: boolean;
  /** Derive each bar's colour from its label hash instead of a single accent. */
  colorByLabel?: boolean;
  /** Single accent colour used when `colorByLabel` is off and the datum has no colour. */
  colorIndex?: number;
  onBarClick?: (datum: BarDatum) => void;
  categoryLabel?: string;
  valueLabel?: string;
  emptyMessage?: string;
  bare?: boolean;
  className?: string;
  /** Width reserved for category labels in `bars` layout. */
  categoryWidth?: number;
}

export function BarChart({
  data,
  layout = 'columns',
  title,
  description,
  actions,
  height = 280,
  loading = false,
  format = 'number',
  showValueLabels,
  colorByLabel = false,
  colorIndex = 0,
  onBarClick,
  categoryLabel = 'Category',
  valueLabel = 'Value',
  emptyMessage = 'Nothing to compare yet.',
  bare = false,
  className,
  categoryWidth = 150,
}: BarChartProps) {
  const colors = useChartColors();
  const horizontal = layout === 'bars';

  const rows = useMemo(
    () =>
      data.map((d, i) => ({
        ...d,
        id: d.id ?? d.label,
        fill: d.color ?? seriesColor(colors, colorByLabel ? hashColorIndex(d.label) : (d.colorIndex ?? colorIndex)),
        __index: i,
      })),
    [data, colors, colorByLabel, colorIndex],
  );

  const labelsOn = showValueLabels ?? rows.length <= VALUE_LABEL_MAX_BARS;

  const handleClick = useCallback(
    (payload: unknown) => {
      if (!onBarClick) return;
      // recharts hands back the row object it rendered; narrow before using it.
      if (payload && typeof payload === 'object' && 'label' in payload && 'value' in payload) {
        const row = payload as BarDatum;
        onBarClick({ id: row.id, label: row.label, value: row.value });
      }
    },
    [onBarClick],
  );

  const ariaLabel = useMemo(() => {
    if (rows.length === 0) return 'Bar chart with no data';
    const top = [...rows].sort((a, b) => b.value - a.value).slice(0, 5);
    return `Bar chart of ${valueLabel.toLowerCase()} by ${categoryLabel.toLowerCase()}, ${rows.length} categories. Highest: ${top
      .map((r) => `${r.label} ${formatChartValue(r.value, format)}`)
      .join(', ')}.`;
  }, [rows, valueLabel, categoryLabel, format]);

  const tickFormat = useCallback(
    (v: number) => (format === 'percent' ? formatChartValue(v, 'percent') : formatCompact(v)),
    [format],
  );

  return (
    <ChartContainer
      title={title}
      description={description}
      actions={actions}
      height={height}
      loading={loading}
      empty={rows.length === 0}
      emptyMessage={emptyMessage}
      bare={bare}
      className={className}
    >
      <div role="img" aria-label={ariaLabel} className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart
            data={rows}
            layout={horizontal ? 'vertical' : 'horizontal'}
            margin={{
              top: labelsOn && !horizontal ? 18 : 8,
              right: labelsOn && horizontal ? 48 : 12,
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
                  tickFormatter={tickFormat}
                  tick={{ fill: colors.mutedForeground, fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="label"
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
                  dataKey="label"
                  tick={{ fill: colors.mutedForeground, fontSize: 11 }}
                  axisLine={{ stroke: colors.border }}
                  tickLine={false}
                  interval={rows.length > 16 ? 'preserveStartEnd' : 0}
                />
                <YAxis
                  type="number"
                  tickFormatter={tickFormat}
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
                  format={format}
                  nameFormatter={() => valueLabel}
                />
              }
            />

            <Bar
              dataKey="value"
              name={valueLabel}
              radius={horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}
              isAnimationActive={false}
              onClick={handleClick}
              cursor={onBarClick ? 'pointer' : undefined}
            >
              {rows.map((row) => (
                <Cell key={row.id} fill={row.fill} />
              ))}
              {labelsOn ? (
                <LabelList
                  dataKey="value"
                  position={horizontal ? 'right' : 'top'}
                  fill={colors.mutedForeground}
                  fontSize={11}
                  formatter={(value: number) => formatChartValue(value, format)}
                />
              ) : null}
            </Bar>
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
}
