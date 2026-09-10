import * as React from 'react';

import { cn } from '@/lib/utils';

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * `.skeleton` is defined in globals.css and carries the shimmer sweep, so every
 * loading placeholder in the app animates identically.
 */
function Skeleton({ className, ...props }: SkeletonProps): React.JSX.Element {
  return <div aria-hidden="true" className={cn('skeleton h-4 w-full', className)} {...props} />;
}

export interface SkeletonTextProps extends React.HTMLAttributes<HTMLDivElement> {
  lines?: number;
}

/** Paragraph placeholder; the last line is short so it reads as prose. */
function SkeletonText({ lines = 3, className, ...props }: SkeletonTextProps): React.JSX.Element {
  return (
    <div className={cn('space-y-2', className)} {...props}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn('h-3.5', index === lines - 1 && lines > 1 && 'w-3/5')} />
      ))}
    </div>
  );
}

export interface SkeletonCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Reserve space for a chart or metric block under the heading. */
  bodyHeight?: 'sm' | 'md' | 'lg';
  lines?: number;
}

const BODY_HEIGHT: Record<NonNullable<SkeletonCardProps['bodyHeight']>, string> = {
  sm: 'h-16',
  md: 'h-28',
  lg: 'h-48',
};

function SkeletonCard({ bodyHeight = 'md', lines = 0, className, ...props }: SkeletonCardProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('rounded-lg border border-border bg-card p-5 shadow-xs', className)}
      {...props}
    >
      <span className="sr-only">Loading</span>
      <Skeleton className="h-3.5 w-32" />
      <Skeleton className={cn('mt-4', BODY_HEIGHT[bodyHeight])} />
      {lines > 0 ? <SkeletonText lines={lines} className="mt-4" /> : null}
    </div>
  );
}

export interface SkeletonTableProps extends React.HTMLAttributes<HTMLDivElement> {
  rows?: number;
  columns?: number;
  /** Show a header row placeholder above the rows. */
  header?: boolean;
}

function SkeletonTable({
  rows = 6,
  columns = 4,
  header = true,
  className,
  ...props
}: SkeletonTableProps): React.JSX.Element {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}
      {...props}
    >
      <span className="sr-only">Loading table data</span>
      {header ? (
        <div
          className="grid gap-4 border-b border-border bg-muted/40 px-4 py-2.5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton key={index} className="h-3 w-20" />
          ))}
        </div>
      ) : null}
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="grid gap-4 border-b border-border/60 px-4 py-3 last:border-b-0"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              // First column reads as a label, the rest as values — less uniform, less fake.
              className={cn('h-3.5', columnIndex === 0 ? 'w-full' : 'w-2/3')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonText, SkeletonCard, SkeletonTable };
