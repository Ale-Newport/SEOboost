import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { cn, formatDelta } from '@/lib/utils';

const deltaVariants = cva('inline-flex items-center gap-1 whitespace-nowrap font-medium leading-none', {
  variants: {
    size: {
      sm: 'text-2xs [&_svg]:size-3',
      md: 'text-xs [&_svg]:size-3.5',
      lg: 'text-sm [&_svg]:size-4',
    },
    variant: {
      text: '',
      pill: 'rounded-md border px-1.5 py-0.5',
    },
  },
  defaultVariants: {
    size: 'md',
    variant: 'text',
  },
});

type DeltaDirection = 'up' | 'down' | 'flat';
type DeltaTone = 'positive' | 'negative' | 'neutral';

const TONE_TEXT: Record<DeltaTone, string> = {
  positive: 'text-success',
  negative: 'text-destructive',
  neutral: 'text-muted-foreground',
};

const TONE_PILL: Record<DeltaTone, string> = {
  positive: 'border-success/25 bg-success/10 text-success',
  negative: 'border-destructive/25 bg-destructive/10 text-destructive',
  neutral: 'border-border bg-muted/60 text-muted-foreground',
};

const DIRECTION_ICON = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: Minus,
} as const;

const DIRECTION_WORD: Record<DeltaDirection, string> = {
  up: 'Up',
  down: 'Down',
  flat: 'Unchanged',
};

export interface DeltaProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof deltaVariants> {
  /** Percentage change, already expressed in percentage points (12.4 → “+12.4%”). */
  value: number | null | undefined;
  /**
   * For metrics where falling is the win — average position, page weight,
   * response time. Colours flip; the arrow still points the way the number moved.
   */
  invertColors?: boolean;
  /**
   * Percentage points below which movement is treated as noise and styled
   * neutral. `0` disables the band; an exact zero change is always flat.
   */
  neutralThreshold?: number;
  decimals?: number;
  showIcon?: boolean;
  /** Completes the screen-reader sentence, e.g. “versus the previous 28 days”. */
  comparisonLabel?: string;
  /** Shown instead of a value when the comparison period has no data. */
  emptyLabel?: string;
}

/**
 * Direction-of-travel indicator for every KPI in the product.
 *
 * The arrow and the sign always describe the raw movement; only the colour is
 * inverted by `invertColors`. Flipping the arrow too would make “position
 * improved from 12 to 4” render as an up-arrow on a falling number, which reads
 * as a data bug to anyone comparing it with the value beside it.
 */
const Delta = React.forwardRef<HTMLSpanElement, DeltaProps>(function Delta(
  {
    value,
    invertColors = false,
    neutralThreshold = 0.1,
    decimals = 1,
    showIcon = true,
    comparisonLabel,
    emptyLabel = 'No comparison data',
    size,
    variant,
    className,
    ...props
  },
  ref,
) {
  // `Number.isFinite` rather than a NaN check: a division by a zero baseline can
  // reach the UI as ±Infinity, and “+Infinity%” is not a movement anyone can read.
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <span
        ref={ref}
        className={cn(deltaVariants({ size, variant }), TONE_TEXT.neutral, className)}
        {...props}
      >
        <span aria-hidden="true">—</span>
        <span className="sr-only">{emptyLabel}</span>
      </span>
    );
  }

  // An exact 0 is flat even when the neutral band is switched off — otherwise a
  // `neutralThreshold` of 0 renders “0.0%” with a red down-arrow.
  const band = Number.isFinite(neutralThreshold) ? Math.abs(neutralThreshold) : 0;
  const direction: DeltaDirection =
    value === 0 || Math.abs(value) < band ? 'flat' : value > 0 ? 'up' : 'down';
  const tone: DeltaTone =
    direction === 'flat' ? 'neutral' : (direction === 'up') !== invertColors ? 'positive' : 'negative';

  const Icon = DIRECTION_ICON[direction];
  const spoken = [
    DIRECTION_WORD[direction],
    direction === 'flat' ? null : `${Math.abs(value).toFixed(decimals)} percent`,
    comparisonLabel,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={ref}
      className={cn(
        deltaVariants({ size, variant }),
        variant === 'pill' ? TONE_PILL[tone] : TONE_TEXT[tone],
        className,
      )}
      {...props}
    >
      {showIcon ? <Icon aria-hidden="true" className="shrink-0" /> : null}
      <span aria-hidden="true" className="tabular">
        {formatDelta(value, decimals)}
      </span>
      <span className="sr-only">{spoken}</span>
    </span>
  );
});

export { Delta, deltaVariants };
