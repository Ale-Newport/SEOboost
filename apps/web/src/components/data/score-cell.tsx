'use client';

import { cn } from '@/lib/utils';

export type ScoreBand = 'good' | 'fair' | 'poor' | 'critical';

/**
 * Bands match the health-score language used across the product: 80+ is healthy, 60-79 needs
 * attention, 40-59 is a problem, below 40 is urgent. Keeping the thresholds here (rather than
 * per screen) means a score of 61 looks the same everywhere.
 */
export function scoreBand(value: number): ScoreBand {
  if (value >= 80) return 'good';
  if (value >= 60) return 'fair';
  if (value >= 40) return 'poor';
  return 'critical';
}

const BAND_TEXT: Record<ScoreBand, string> = {
  good: 'text-success',
  fair: 'text-info',
  poor: 'text-warning',
  critical: 'text-destructive',
};

const BAND_BAR: Record<ScoreBand, string> = {
  good: 'bg-success',
  fair: 'bg-info',
  poor: 'bg-warning',
  critical: 'bg-destructive',
};

const BAND_PILL: Record<ScoreBand, string> = {
  good: 'border-success/25 bg-success/10 text-success',
  fair: 'border-info/25 bg-info/10 text-info',
  poor: 'border-warning/25 bg-warning/10 text-warning',
  critical: 'border-destructive/25 bg-destructive/10 text-destructive',
};

const BAND_LABEL: Record<ScoreBand, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  critical: 'Critical',
};

export interface ScoreCellProps {
  /** 0-100. `null` renders an em dash — an absent score is never drawn as zero. */
  value: number | null | undefined;
  variant?: 'bar' | 'pill' | 'text';
  /** Higher is worse (difficulty, competition): flips the colour ramp, not the number. */
  invert?: boolean;
  /** Extra context for assistive tech, e.g. "Health score". */
  label?: string;
  className?: string;
}

export function ScoreCell({
  value,
  variant = 'bar',
  invert = false,
  label = 'Score',
  className,
}: ScoreCellProps): React.JSX.Element {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (
      <span className={cn('text-muted-foreground', className)} aria-label={`${label} unavailable`}>
        —
      </span>
    );
  }

  const clamped = Math.max(0, Math.min(100, value));
  const rounded = Math.round(clamped);
  const band = scoreBand(invert ? 100 - clamped : clamped);

  const meter = {
    role: 'meter' as const,
    'aria-valuenow': rounded,
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-label': `${label}: ${rounded} out of 100, ${BAND_LABEL[band]}`,
  };

  if (variant === 'pill') {
    return (
      <span
        {...meter}
        className={cn(
          'tabular inline-flex items-center rounded-md border px-1.5 py-0.5 text-2xs font-semibold leading-4',
          BAND_PILL[band],
          className,
        )}
      >
        {rounded}
      </span>
    );
  }

  if (variant === 'text') {
    return (
      <span {...meter} className={cn('tabular text-sm font-medium', BAND_TEXT[band], className)}>
        {rounded}
      </span>
    );
  }

  return (
    <div {...meter} className={cn('flex items-center justify-end gap-2', className)}>
      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('block h-full rounded-full transition-[width] duration-300', BAND_BAR[band])}
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className={cn('tabular w-7 text-right text-sm font-medium', BAND_TEXT[band])}>{rounded}</span>
    </div>
  );
}
