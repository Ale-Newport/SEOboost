import * as React from 'react';
import { type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Card } from './card';
import { Delta } from './delta';
import { Skeleton } from './skeleton';
import { TooltipInfo } from './tooltip-info';

export interface MetricCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: React.ReactNode;
  /** Pre-formatted for display — use `formatNumber`/`formatCompact`/`formatUsd` at the call site. */
  value: React.ReactNode;
  /** Explains how the metric is derived; rendered behind an “(i)”. */
  info?: React.ReactNode;
  icon?: LucideIcon;
  /**
   * Percentage change against the comparison period. `null` means the period
   * exists but has no data (shown as “—”); omit the prop entirely when there is
   * nothing to compare against.
   */
  delta?: number | null;
  /** Down is good for this metric (average position, load time, error rate). */
  invertDelta?: boolean;
  /** Names the comparison period, e.g. “vs previous 28 days”. */
  deltaLabel?: string;
  /** Trend visual, typically a `<Sparkline />`. */
  sparkline?: React.ReactNode;
  /** Secondary line under the value — a target, a share, a last-updated note. */
  footer?: React.ReactNode;
  loading?: boolean;
}

/**
 * The KPI tile used across every dashboard. Value, movement and trend live in
 * one fixed layout so a row of tiles aligns on the baseline of the big number
 * regardless of which optional slots each one uses.
 */
const MetricCard = React.forwardRef<HTMLDivElement, MetricCardProps>(function MetricCard(
  {
    label,
    value,
    info,
    icon: Icon,
    delta,
    invertDelta = false,
    deltaLabel,
    sparkline,
    footer,
    loading = false,
    className,
    ...props
  },
  ref,
) {
  if (loading) {
    return (
      <Card
        ref={ref}
        role="status"
        aria-busy="true"
        aria-live="polite"
        className={cn('p-4', className)}
        {...props}
      >
        <span className="sr-only">Loading metric</span>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-20" />
        <Skeleton className="mt-3 h-3 w-32" />
      </Card>
    );
  }

  return (
    <Card ref={ref} className={cn('flex flex-col p-4', className)} {...props}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          <span className="truncate text-xs font-medium text-muted-foreground">{label}</span>
          {info ? (
            <TooltipInfo
              content={info}
              label={typeof label === 'string' ? `About ${label}` : 'About this metric'}
            />
          ) : null}
        </div>
        {sparkline ? <div className="shrink-0">{sparkline}</div> : null}
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="tabular text-2xl font-semibold leading-none tracking-tight text-foreground">{value}</span>
        {delta !== undefined ? (
          <Delta value={delta} invertColors={invertDelta} comparisonLabel={deltaLabel} />
        ) : null}
        {delta !== undefined && deltaLabel ? (
          <span aria-hidden="true" className="text-2xs text-muted-foreground">
            {deltaLabel}
          </span>
        ) : null}
      </div>

      {footer ? <div className="mt-2 text-2xs leading-relaxed text-muted-foreground">{footer}</div> : null}
    </Card>
  );
});

export { MetricCard };
