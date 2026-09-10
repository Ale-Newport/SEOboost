'use client';

import * as React from 'react';

import { cn, formatNumber } from '@/lib/utils';

export type ProgressTone = 'primary' | 'success' | 'warning' | 'destructive' | 'info' | 'muted';

const TONE_FILL: Record<ProgressTone, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  info: 'bg-info',
  muted: 'bg-muted-foreground/50',
};

const SIZE_TRACK: Record<'sm' | 'md', string> = {
  sm: 'h-1.5',
  md: 'h-2.5',
};

export interface ProgressBarSegment {
  /** Stable React key — usually the enum value or category id being counted. */
  key: string;
  label: string;
  value: number;
  tone?: ProgressTone;
}

export interface ProgressBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** Rendered above the track; also becomes the bar's accessible name. */
  label?: React.ReactNode;
  /** Filled amount. With `segments`, this stays the headline total shown beside the label. */
  value: number;
  max?: number;
  /**
   * Breaks the fill into stacked slices (issues by severity, pages by status).
   * Slices are drawn in order and are not re-normalised — if they do not add up
   * to `value` the remainder simply stays empty rather than being invented.
   */
  segments?: readonly ProgressBarSegment[];
  tone?: ProgressTone;
  size?: 'sm' | 'md';
  showValue?: boolean;
  /** Legend under the track; defaults to on whenever segments are supplied. */
  showLegend?: boolean;
  /** Overrides the “12 / 100” text beside the label. */
  formatValue?: (value: number, max: number) => string;
  /** Required when `label` is not a plain string, so the bar still has a name. */
  ariaLabel?: string;
}

function defaultFormatValue(value: number, max: number): string {
  return `${formatNumber(value)} / ${formatNumber(max)}`;
}

/** Percentage of the track a raw amount occupies, clamped so bad data cannot overflow the row. */
function widthPercent(amount: number, max: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (amount / max) * 100));
}

/**
 * Labelled horizontal bar for quotas, coverage and category breakdowns.
 *
 * Separate from `Progress` (Radix) on purpose: that one is a bare indicator for
 * in-flight work, this one is a labelled read-only statistic with an optional
 * stacked breakdown and legend.
 */
const ProgressBar = React.forwardRef<HTMLDivElement, ProgressBarProps>(function ProgressBar(
  {
    label,
    value,
    max = 100,
    segments,
    tone = 'primary',
    size = 'md',
    showValue = true,
    showLegend,
    formatValue = defaultFormatValue,
    ariaLabel,
    className,
    ...props
  },
  ref,
) {
  const labelId = React.useId();
  // A NaN reaching `aria-valuenow` renders the literal string "NaN" to assistive
  // tech, and a non-positive max makes every percentage meaningless — pin both
  // to something honest before they leave this component.
  const safeValue = Number.isFinite(value) ? value : 0;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const valueText = formatValue(safeValue, safeMax);
  const withLegend = showLegend ?? (segments !== undefined && segments.length > 0);
  const hasTextLabel = typeof label === 'string';

  return (
    <div ref={ref} className={cn('flex w-full flex-col gap-1.5', className)} {...props}>
      {label !== undefined || showValue ? (
        <div className="flex items-baseline justify-between gap-3">
          {label !== undefined ? (
            <span id={labelId} className="truncate text-xs font-medium text-foreground">
              {label}
            </span>
          ) : (
            <span />
          )}
          {showValue ? <span className="tabular shrink-0 text-xs text-muted-foreground">{valueText}</span> : null}
        </div>
      ) : null}

      <div
        role="progressbar"
        aria-valuenow={Math.round(safeValue)}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuetext={valueText}
        aria-label={ariaLabel ?? (hasTextLabel ? undefined : 'Progress')}
        aria-labelledby={ariaLabel === undefined && hasTextLabel ? labelId : undefined}
        className={cn('flex w-full overflow-hidden rounded-full bg-muted', SIZE_TRACK[size])}
      >
        {segments && segments.length > 0 ? (
          segments.map((segment) => (
            <div
              key={segment.key}
              // `shrink-0`: flex would otherwise scale every slice down when they
              // overflow the track, quietly re-normalising a breakdown that is
              // documented never to be re-normalised. Overflow is clipped instead.
              className={cn(
                'h-full shrink-0 transition-[width] duration-500 ease-out',
                TONE_FILL[segment.tone ?? tone],
              )}
              style={{ width: `${widthPercent(segment.value, safeMax)}%` }}
            />
          ))
        ) : (
          <div
            className={cn('h-full shrink-0 rounded-full transition-[width] duration-500 ease-out', TONE_FILL[tone])}
            style={{ width: `${widthPercent(safeValue, safeMax)}%` }}
          />
        )}
      </div>

      {withLegend && segments && segments.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {segments.map((segment) => (
            <li key={segment.key} className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn('size-1.5 shrink-0 rounded-full', TONE_FILL[segment.tone ?? tone])}
              />
              <span>{segment.label}</span>
              <span className="tabular font-medium text-foreground">{formatNumber(segment.value)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});

export { ProgressBar };
