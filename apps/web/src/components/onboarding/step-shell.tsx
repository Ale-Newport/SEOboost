'use client';

import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Chrome shared by every wizard step, so the eye lands in the same place each time: icon and
 * title top-left, actions bottom-right, "skip" always in the same spot as a quiet button —
 * never a link buried in body copy.
 */

export function StepHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground">
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold leading-tight tracking-tight">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function StepFooter({
  onBack,
  onSkip,
  skipLabel = 'Skip for now',
  children,
  className,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  skipLabel?: string;
  /** The step's primary action(s). */
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'mt-7 flex flex-wrap items-center gap-2 border-t border-border pt-5',
        className,
      )}
    >
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back
        </button>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {onSkip ? (
          <button
            type="button"
            onClick={onSkip}
            className="rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {skipLabel}
          </button>
        ) : null}
        {children}
      </div>
    </div>
  );
}
