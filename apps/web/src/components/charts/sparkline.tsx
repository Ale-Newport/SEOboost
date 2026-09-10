'use client';

import { useMemo } from 'react';
import { cn, formatCompact } from '@/lib/utils';

export interface SparklineProps {
  /** Chronological values; `null` marks a gap and breaks the line rather than interpolating. */
  values: ReadonlyArray<number | null | undefined>;
  width?: number;
  height?: number;
  strokeWidth?: number;
  /** Soft fill under the line. */
  area?: boolean;
  /** Green when rising, red when falling. Off by default so it does not shout in dense tables. */
  trendColored?: boolean;
  /** Lower is better (average position, load time) — flips the trend colouring. */
  invertTrend?: boolean;
  /** Explicit CSS colour; overrides `trendColored`. */
  color?: string;
  showLastDot?: boolean;
  ariaLabel?: string;
  className?: string;
}

interface Point {
  x: number;
  y: number;
}

/**
 * Tiny axis-free trend line for table cells and metric tiles.
 *
 * Hand-rolled SVG rather than recharts: a list screen renders hundreds of these at once and a
 * ResponsiveContainer per cell would cost a ResizeObserver and a render pass each.
 */
export function Sparkline({
  values,
  width = 88,
  height = 24,
  strokeWidth = 1.5,
  area = false,
  trendColored = false,
  invertTrend = false,
  color,
  showLastDot = true,
  ariaLabel,
  className,
}: SparklineProps) {
  const pad = strokeWidth + 1;

  const { segments, last, lastValue, firstValue, count } = useMemo(() => {
    const finite = values.map((v) =>
      typeof v === 'number' && Number.isFinite(v) ? v : null,
    );
    const present = finite.filter((v): v is number => v !== null);
    if (present.length === 0) {
      return { segments: [] as Point[][], last: null, lastValue: null, firstValue: null, count: 0 };
    }

    const min = Math.min(...present);
    const max = Math.max(...present);
    const span = max - min || 1;
    const stepX = finite.length > 1 ? (width - pad * 2) / (finite.length - 1) : 0;
    const usableY = height - pad * 2;

    const segs: Point[][] = [];
    let current: Point[] = [];
    for (let i = 0; i < finite.length; i++) {
      const v = finite[i];
      if (v === null || v === undefined) {
        if (current.length > 0) segs.push(current);
        current = [];
        continue;
      }
      current.push({
        x: pad + stepX * i,
        // Flat series sit on the middle line instead of hugging the floor.
        y: pad + (span === 1 && max === min ? usableY / 2 : usableY - ((v - min) / span) * usableY),
      });
    }
    if (current.length > 0) segs.push(current);

    const flat = segs.flat();
    return {
      segments: segs,
      last: flat[flat.length - 1] ?? null,
      firstValue: present[0] ?? null,
      lastValue: present[present.length - 1] ?? null,
      count: present.length,
    };
  }, [values, width, height, pad]);

  const direction: 'up' | 'down' | 'flat' =
    firstValue === null || lastValue === null || firstValue === lastValue
      ? 'flat'
      : lastValue > firstValue
        ? 'up'
        : 'down';

  const good = invertTrend ? direction === 'down' : direction === 'up';
  const bad = invertTrend ? direction === 'up' : direction === 'down';

  const strokeColor =
    color ??
    (trendColored
      ? good
        ? 'hsl(var(--success))'
        : bad
          ? 'hsl(var(--destructive))'
          : 'hsl(var(--muted-foreground))'
      : 'hsl(var(--chart-1))');

  const label =
    ariaLabel ??
    (count === 0
      ? 'No trend data'
      : `Trend ${direction}, from ${formatCompact(firstValue)} to ${formatCompact(lastValue)} over ${count} points`);

  if (count < 2) {
    // A single point (or none) is not a trend — draw a neutral baseline so the row keeps its height.
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        className={cn('overflow-visible text-muted-foreground/40', className)}
      >
        <line
          x1={pad}
          y1={height / 2}
          x2={width - pad}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeDasharray="2 3"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const toPath = (pts: Point[]): string =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      className={cn('overflow-visible', className)}
      style={{ color: strokeColor }}
    >
      {area
        ? segments.map((seg, i) =>
            seg.length > 1 ? (
              <path
                key={`a-${i}`}
                d={`${toPath(seg)} L${(seg[seg.length - 1]?.x ?? 0).toFixed(2)} ${height - pad} L${(seg[0]?.x ?? 0).toFixed(2)} ${height - pad} Z`}
                fill="currentColor"
                fillOpacity={0.12}
                stroke="none"
              />
            ) : null,
          )
        : null}

      {segments.map((seg, i) => (
        <path
          key={`l-${i}`}
          d={toPath(seg)}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {showLastDot && last ? (
        <circle cx={last.x} cy={last.y} r={strokeWidth + 0.5} fill="currentColor" />
      ) : null}
    </svg>
  );
}
