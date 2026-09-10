'use client';

import { ArrowDown, ArrowUp, Minus } from 'lucide-react';

import { Sparkline } from '@/components/charts/sparkline';
import { cn } from '@/lib/utils';

export interface TrendCellProps {
  /** Chronological series. `null` marks a gap; the sparkline breaks the line instead of guessing. */
  values: ReadonlyArray<number | null | undefined>;
  /**
   * Percentage change to display. Omit and it is derived from the first and last present values —
   * a real computation over real points, never a stand-in when the series is empty.
   */
  deltaPct?: number | null;
  /** Lower is better (average position, response time): flips the colouring, not the arrow. */
  invert?: boolean;
  showSparkline?: boolean;
  showDelta?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

/** First and last non-null values, which is what a period-over-period delta compares. */
function endpoints(values: ReadonlyArray<number | null | undefined>): { first: number | null; last: number | null } {
  let first: number | null = null;
  let last: number | null = null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (first === null) first = value;
    last = value;
  }
  return { first, last };
}

export function TrendCell({
  values,
  deltaPct,
  invert = false,
  showSparkline = true,
  showDelta = true,
  width = 72,
  height = 20,
  className,
}: TrendCellProps): React.JSX.Element {
  const { first, last } = endpoints(values);

  // Only derive a delta when both ends exist and the baseline is non-zero — a change from zero is
  // not a percentage, and reporting one would be an invention. A supplied delta is trusted but
  // still has to be a real number: NaN/Infinity comes out of `(a - b) / 0` upstream and must show
  // as "no data", not as "NaN%".
  const supplied = typeof deltaPct === 'number' && Number.isFinite(deltaPct) ? deltaPct : null;
  const derived =
    deltaPct !== undefined
      ? supplied
      : first !== null && last !== null && first !== 0
        ? ((last - first) / Math.abs(first)) * 100
        : null;

  const direction = derived === null || derived === 0 ? 'flat' : derived > 0 ? 'up' : 'down';
  const good = invert ? direction === 'down' : direction === 'up';
  const bad = invert ? direction === 'up' : direction === 'down';

  const Icon = direction === 'up' ? ArrowUp : direction === 'down' ? ArrowDown : Minus;

  return (
    <div className={cn('flex items-center justify-end gap-2', className)}>
      {showSparkline ? (
        <Sparkline values={values} width={width} height={height} invertTrend={invert} trendColored />
      ) : null}

      {showDelta ? (
        derived === null ? (
          <span className="tabular w-14 text-right text-xs text-muted-foreground">—</span>
        ) : (
          <span
            className={cn(
              'tabular inline-flex w-14 items-center justify-end gap-0.5 text-xs font-medium',
              good && 'text-success',
              bad && 'text-destructive',
              !good && !bad && 'text-muted-foreground',
            )}
          >
            <Icon className="size-3 shrink-0" aria-hidden="true" />
            {/* The arrow already carries the sign; repeating it reads as noise. */}
            {Math.abs(derived).toFixed(1)}%
          </span>
        )
      ) : null}
    </div>
  );
}
