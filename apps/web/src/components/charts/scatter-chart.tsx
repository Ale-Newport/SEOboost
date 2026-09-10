'use client';

import { useCallback, useMemo } from 'react';
import {
  CartesianGrid,
  Cell,
  ReferenceArea,
  ResponsiveContainer,
  Scatter,
  ScatterChart as RechartsScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { ChartContainer, seriesColor, useChartColors, withAlpha } from './chart-container';
import { ChartTooltip, formatChartValue, type ChartValueFormat } from './chart-tooltip';
import { formatCompact } from '@/lib/utils';

/**
 * Mirrors `SEO_THRESHOLDS.strikingDistance` / `ctrOpportunity.minImpressions` from @seo/shared.
 * Duplicated deliberately: @seo/shared pulls in node-only modules (crypto, logger) and must not
 * be imported into a client bundle. Keep in sync if the shared thresholds change.
 */
export const STRIKING_DISTANCE = { minPosition: 8, maxPosition: 20, minImpressions: 100 } as const;

export interface ScatterPoint {
  id?: string;
  label: string;
  x: number;
  y: number;
  /** Optional third dimension mapped to bubble area. */
  z?: number;
  color?: string;
  /** Extra fields surfaced in the tooltip footer. */
  meta?: string;
}

export interface ScatterQuadrant {
  x1?: number;
  x2?: number;
  y1?: number;
  y2?: number;
  label?: string;
  /** Resolved CSS colour; defaults to the success token. */
  color?: string;
}

export interface ScatterChartProps {
  data: readonly ScatterPoint[];
  xLabel: string;
  yLabel: string;
  xFormat?: ChartValueFormat;
  yFormat?: ChartValueFormat;
  /** Average position reads best inverted — rank 1 at the top. */
  yReversed?: boolean;
  /** Shade an opportunity region. Pass `strikingDistanceQuadrant()` for the common case. */
  quadrant?: ScatterQuadrant;
  /** Colour points that fall inside the quadrant differently. */
  highlightQuadrant?: boolean;
  zLabel?: string;
  zRange?: [number, number];
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  height?: number;
  loading?: boolean;
  emptyMessage?: string;
  onPointClick?: (point: ScatterPoint) => void;
  bare?: boolean;
  className?: string;
}

/**
 * The "striking distance" opportunity region: ranking just off page one with enough impressions
 * to be worth the work. Pass the result as `quadrant` to `ScatterChart`.
 */
export function strikingDistanceQuadrant(
  minImpressions: number = STRIKING_DISTANCE.minImpressions,
  label = 'Striking distance',
): ScatterQuadrant {
  return {
    x1: minImpressions,
    y1: STRIKING_DISTANCE.minPosition,
    y2: STRIKING_DISTANCE.maxPosition,
    label,
  };
}

function inQuadrant(point: ScatterPoint, q: ScatterQuadrant | undefined): boolean {
  if (!q) return false;
  if (q.x1 !== undefined && point.x < q.x1) return false;
  if (q.x2 !== undefined && point.x > q.x2) return false;
  if (q.y1 !== undefined && point.y < q.y1) return false;
  if (q.y2 !== undefined && point.y > q.y2) return false;
  return true;
}

export function ScatterChart({
  data,
  xLabel,
  yLabel,
  xFormat = 'compact',
  yFormat = 'position',
  yReversed = true,
  quadrant,
  highlightQuadrant = true,
  zLabel,
  zRange = [30, 320],
  title,
  description,
  actions,
  height = 320,
  loading = false,
  emptyMessage = 'No points to plot for this period.',
  onPointClick,
  bare = false,
  className,
}: ScatterChartProps) {
  const colors = useChartColors();

  const quadrantColor = quadrant?.color ?? colors.success;
  const baseColor = seriesColor(colors, 0);

  const rows = useMemo(
    () =>
      data.map((p, i) => {
        const highlighted = highlightQuadrant && inQuadrant(p, quadrant);
        return {
          ...p,
          id: p.id ?? `${p.label}-${i}`,
          z: p.z ?? 1,
          __highlighted: highlighted,
          __fill: p.color ?? (highlighted ? quadrantColor : baseColor),
        };
      }),
    [data, quadrant, highlightQuadrant, quadrantColor, baseColor],
  );

  const highlightedCount = rows.filter((r) => r.__highlighted).length;

  const handleClick = useCallback(
    (payload: unknown) => {
      if (!onPointClick) return;
      if (payload && typeof payload === 'object' && 'label' in payload && 'x' in payload && 'y' in payload) {
        const row = payload as ScatterPoint;
        onPointClick({ id: row.id, label: row.label, x: row.x, y: row.y, z: row.z, meta: row.meta });
      }
    },
    [onPointClick],
  );

  const ariaLabel = useMemo(() => {
    if (rows.length === 0) return 'Scatter chart with no data';
    const quadrantNote =
      quadrant && highlightQuadrant
        ? ` ${highlightedCount} of them fall inside the ${quadrant.label ?? 'highlighted'} region.`
        : '';
    return `Scatter chart of ${yLabel.toLowerCase()} against ${xLabel.toLowerCase()}, ${rows.length} points.${quadrantNote}`;
  }, [rows.length, xLabel, yLabel, quadrant, highlightQuadrant, highlightedCount]);

  const axisTick = useCallback(
    (fmt: ChartValueFormat) => (v: number) =>
      fmt === 'percent' ? formatChartValue(v, 'percent') : fmt === 'position' ? v.toFixed(0) : formatCompact(v),
    [],
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
      footer={
        quadrant && highlightQuadrant && rows.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: quadrantColor }}
            />
            {highlightedCount} in {quadrant.label ?? 'the highlighted region'}
          </span>
        ) : undefined
      }
    >
      <div role="img" aria-label={ariaLabel} className="h-full w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsScatterChart margin={{ top: 12, right: 16, bottom: 18, left: 0 }}>
            <CartesianGrid stroke={colors.border} strokeDasharray="3 3" />

            {quadrant ? (
              <ReferenceArea
                x1={quadrant.x1}
                x2={quadrant.x2}
                y1={quadrant.y1}
                y2={quadrant.y2}
                fill={quadrantColor}
                fillOpacity={0.09}
                stroke={withAlpha(quadrantColor, 0.35)}
                strokeDasharray="3 3"
                ifOverflow="extendDomain"
                label={
                  quadrant.label
                    ? {
                        value: quadrant.label,
                        position: 'insideTopLeft',
                        fill: colors.mutedForeground,
                        fontSize: 11,
                      }
                    : undefined
                }
              />
            ) : null}

            <XAxis
              type="number"
              dataKey="x"
              name={xLabel}
              tickFormatter={axisTick(xFormat)}
              tick={{ fill: colors.mutedForeground, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: colors.border }}
              label={{
                value: xLabel,
                position: 'insideBottom',
                offset: -12,
                fill: colors.mutedForeground,
                fontSize: 11,
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name={yLabel}
              reversed={yReversed}
              tickFormatter={axisTick(yFormat)}
              tick={{ fill: colors.mutedForeground, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={48}
              label={{
                value: yLabel,
                angle: -90,
                position: 'insideLeft',
                fill: colors.mutedForeground,
                fontSize: 11,
              }}
            />
            <ZAxis type="number" dataKey="z" range={zRange} name={zLabel ?? 'Weight'} />

            <Tooltip
              cursor={{ strokeDasharray: '3 3', stroke: colors.border }}
              content={
                <ChartTooltip
                  header={(entries) => {
                    const point = entries[0]?.payload;
                    return typeof point?.label === 'string' ? point.label : null;
                  }}
                  nameFormatter={(name) => (name === 'x' ? xLabel : name === 'y' ? yLabel : name)}
                  valueFormatter={(value, entry) =>
                    formatChartValue(value, entry.dataKey === 'y' ? yFormat : xFormat)
                  }
                  footer={(entries) => {
                    const point = entries[0]?.payload;
                    return typeof point?.meta === 'string' ? point.meta : null;
                  }}
                />
              }
            />

            <Scatter
              data={rows}
              name={yLabel}
              isAnimationActive={false}
              onClick={handleClick}
              cursor={onPointClick ? 'pointer' : undefined}
            >
              {rows.map((row) => (
                <Cell
                  key={row.id}
                  fill={row.__fill}
                  fillOpacity={row.__highlighted ? 0.85 : 0.55}
                  stroke={row.__fill}
                  strokeOpacity={0.9}
                />
              ))}
            </Scatter>
          </RechartsScatterChart>
        </ResponsiveContainer>
      </div>
    </ChartContainer>
  );
}
