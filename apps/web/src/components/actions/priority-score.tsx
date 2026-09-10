'use client';

import { ChevronDown } from 'lucide-react';
import type { ExplainableScore } from '@seo/shared';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { cn } from '@/lib/utils';

export interface PriorityScoreProps {
  score: ExplainableScore;
  /** Heading inside the popover, e.g. “Why this priority”. */
  title?: string;
  /** Caption under the number in the trigger. */
  caption?: string;
  size?: 'sm' | 'md';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

const NUMBER_CLASS: Record<'sm' | 'md', string> = {
  sm: 'text-sm',
  md: 'text-lg',
};

/**
 * A priority number that opens its own breakdown.
 *
 * Scores in this product are never allowed to be bare numbers, and a queue of fifty rows cannot
 * afford fifty expanded breakdowns — so the number itself is the disclosure control, and the
 * factors, weights and points render in a popover that opens on click or keyboard focus.
 */
export function PriorityScore({
  score,
  title = 'Why this priority',
  caption = 'priority',
  size = 'sm',
  align = 'end',
  className,
}: PriorityScoreProps): React.JSX.Element {
  const value = Number.isFinite(score.score) ? Math.round(score.score) : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-row-ignore
          aria-label={
            value === null
              ? 'Priority not scored — show how priority is calculated'
              : `Priority ${value} out of 100 — show the breakdown`
          }
          className={cn(
            'group/score inline-flex flex-col items-end rounded-md px-1.5 py-0.5 text-right transition-colors',
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
            className,
          )}
        >
          <span className="flex items-center gap-1">
            <span className={cn('tabular font-semibold leading-none text-foreground', NUMBER_CLASS[size])}>
              {value ?? '—'}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-3 text-muted-foreground transition-transform group-data-[state=open]/score:rotate-180"
            />
          </span>
          {caption ? <span className="text-2xs leading-tight text-muted-foreground">{caption}</span> : null}
        </button>
      </PopoverTrigger>

      <PopoverContent align={align} className="w-[22rem] max-w-[calc(100vw-2rem)] p-4">
        <ScoreBreakdown score={score} title={title} ringSize="md" compact />
      </PopoverContent>
    </Popover>
  );
}
