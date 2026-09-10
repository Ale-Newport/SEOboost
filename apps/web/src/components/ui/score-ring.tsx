import * as React from 'react';

import { cn } from '@/lib/utils';

export type ScoreGrade = 'good' | 'fair' | 'poor';

export interface ScoreThresholds {
  /** At or above this, the score is healthy. */
  good: number;
  /** At or above this, the score needs attention; below it, it is failing. */
  fair: number;
}

/**
 * Bands shared by every 0-100 gauge in the product (health, page SEO, GEO,
 * content quality) so the same number never changes colour between screens.
 */
export const DEFAULT_SCORE_THRESHOLDS: ScoreThresholds = { good: 80, fair: 50 };

export function scoreGrade(value: number, thresholds: ScoreThresholds = DEFAULT_SCORE_THRESHOLDS): ScoreGrade {
  if (value >= thresholds.good) return 'good';
  if (value >= thresholds.fair) return 'fair';
  return 'poor';
}

/** Stroke + text colour per grade, sourced from the semantic tokens in both themes. */
export const SCORE_GRADE_STROKE: Record<ScoreGrade, string> = {
  good: 'stroke-success',
  fair: 'stroke-warning',
  poor: 'stroke-destructive',
};

export const SCORE_GRADE_TEXT: Record<ScoreGrade, string> = {
  good: 'text-success',
  fair: 'text-warning',
  poor: 'text-destructive',
};

type ScoreRingSize = 'sm' | 'md' | 'lg';

interface SizeSpec {
  box: string;
  /** In viewBox units, so the ring stays proportional at every rendered size. */
  strokeWidth: number;
  value: string;
  label: string;
}

// Thinner stroke as the ring grows: a heavy ring at 96px reads as a donut chart
// rather than a gauge.
const SIZE_SPEC: Record<ScoreRingSize, SizeSpec> = {
  sm: { box: 'size-10', strokeWidth: 12, value: 'text-xs font-semibold', label: 'sr-only' },
  md: { box: 'size-16', strokeWidth: 10, value: 'text-lg font-semibold', label: 'text-[0.625rem]' },
  lg: { box: 'size-24', strokeWidth: 8, value: 'text-3xl font-semibold', label: 'text-2xs' },
};

export interface ScoreRingProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 0-100. `null` renders an empty ring — a score that has not been computed yet. */
  value: number | null | undefined;
  size?: ScoreRingSize;
  /** Caption under the number, e.g. “Health”. Also used in the accessible name. */
  label?: string;
  /** Overrides the whole accessible name when the caption is not enough context. */
  ariaLabel?: string;
  thresholds?: ScoreThresholds;
  /** Hide the centre number when the value is already stated next to the ring. */
  showValue?: boolean;
}

/**
 * Circular 0-100 gauge. Hand-rolled SVG (no chart library) because it renders in
 * table rows and headers where a ResponsiveContainer per instance would be
 * wasteful, and because the arc has to line up exactly with the centre label.
 */
const ScoreRing = React.forwardRef<HTMLDivElement, ScoreRingProps>(function ScoreRing(
  { value, size = 'md', label, ariaLabel, thresholds = DEFAULT_SCORE_THRESHOLDS, showValue = true, className, ...props },
  ref,
) {
  const spec = SIZE_SPEC[size];
  // Finite, not just non-NaN: clamping ±Infinity would silently render a
  // confident 100 (or 0) for a score that was never computed.
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const clamped = hasValue ? Math.min(100, Math.max(0, value)) : 0;
  const rounded = Math.round(clamped);
  const grade = scoreGrade(clamped, thresholds);

  const radius = 50 - spec.strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  const accessibleName =
    ariaLabel ?? (hasValue ? `${label ?? 'Score'}: ${rounded} out of 100` : `${label ?? 'Score'}: not available`);

  return (
    <div
      ref={ref}
      role="img"
      aria-label={accessibleName}
      className={cn('relative inline-grid shrink-0 place-items-center', spec.box, className)}
      {...props}
    >
      <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true" focusable="false">
        <circle
          cx="50"
          cy="50"
          r={radius}
          fill="none"
          strokeWidth={spec.strokeWidth}
          className="stroke-muted"
        />
        {hasValue ? (
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            strokeWidth={spec.strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            className={cn('transition-[stroke-dashoffset] duration-700 ease-out', SCORE_GRADE_STROKE[grade])}
          />
        ) : null}
      </svg>

      {showValue ? (
        <div aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
          <span className={cn('tabular leading-none', spec.value, hasValue ? SCORE_GRADE_TEXT[grade] : 'text-muted-foreground')}>
            {hasValue ? rounded : '—'}
          </span>
          {label ? (
            <span className={cn('max-w-full truncate uppercase tracking-wide text-muted-foreground', spec.label)}>
              {label}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export { ScoreRing };
