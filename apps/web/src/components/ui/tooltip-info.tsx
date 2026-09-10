'use client';

import * as React from 'react';
import { Info } from 'lucide-react';

import { cn } from '@/lib/utils';
import { SimpleTooltip, type SimpleTooltipProps } from './tooltip';

export interface TooltipInfoProps extends Pick<SimpleTooltipProps, 'side' | 'align' | 'delayDuration'> {
  /** The explanation itself. Keep it to a sentence or two. */
  content: React.ReactNode;
  /** Accessible name for the trigger; name the thing being explained. */
  label?: string;
  size?: 'sm' | 'md';
  className?: string;
}

const SIZE_CLASS: Record<'sm' | 'md', string> = {
  sm: 'size-3.5 [&_svg]:size-3',
  md: 'size-4 [&_svg]:size-3.5',
};

/**
 * The “(i)” affordance that sits beside every score and derived metric in the
 * product — scores are only non-black-box if their definition is one hover away.
 *
 * It is a real `<button type="button">`, not a decorated `<span>`: Radix opens
 * the tooltip on focus as well as hover, so keyboard users reach the same copy,
 * and the button is reachable in the tab order to make that possible.
 */
const TooltipInfo = React.forwardRef<HTMLButtonElement, TooltipInfoProps>(function TooltipInfo(
  { content, label = 'More information', size = 'sm', side, align, delayDuration, className },
  ref,
) {
  return (
    <SimpleTooltip content={content} side={side} align={align} delayDuration={delayDuration}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground',
          'transition-colors hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          SIZE_CLASS[size],
          className,
        )}
      >
        <Info aria-hidden="true" />
      </button>
    </SimpleTooltip>
  );
});

export { TooltipInfo };
