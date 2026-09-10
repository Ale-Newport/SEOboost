'use client';

import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@/lib/utils';

export interface ProgressProps extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> {
  /** Tailwind class for the filled portion — lets callers colour by meaning. */
  indicatorClassName?: string;
}

/**
 * Determinate progress. `value` is null/undefined for indeterminate work, in
 * which case Radix leaves the bar unfilled and reports no value to AT — that is
 * the honest representation when total progress is genuinely unknown.
 */
const Progress = React.forwardRef<React.ComponentRef<typeof ProgressPrimitive.Root>, ProgressProps>(function Progress(
  { className, value, max = 100, indicatorClassName, ...props },
  ref,
) {
  const percent = value === null || value === undefined ? null : Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <ProgressPrimitive.Root
      ref={ref}
      value={value}
      max={max}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn('h-full w-full flex-1 rounded-full bg-primary transition-transform duration-500', indicatorClassName)}
        style={{ transform: `translateX(-${100 - (percent ?? 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});

export { Progress };
