'use client';

import { SeverityBadge, type Severity } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export type { Severity };

/**
 * Dot colour per severity. The label is always rendered next to it — colour alone would fail
 * anyone with a red/green deficiency, and this table is read all day.
 */
const DOT_CLASS: Record<Severity, string> = {
  CRITICAL: 'bg-destructive',
  HIGH: 'bg-destructive/60',
  MEDIUM: 'bg-warning',
  LOW: 'bg-info',
  INFO: 'bg-muted-foreground/50',
};

const LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical',
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info',
};

export interface SeverityCellProps {
  severity: Severity | null | undefined;
  /** `badge` borrows the filled pill from the design system; `dot` is quieter for long lists. */
  variant?: 'dot' | 'badge';
  /** Trailing count, e.g. "High · 12" when a row aggregates issues. */
  count?: number;
  className?: string;
}

export function SeverityCell({
  severity,
  variant = 'dot',
  count,
  className,
}: SeverityCellProps): React.JSX.Element {
  if (!severity) {
    return (
      <span className={cn('text-muted-foreground', className)} aria-label="No severity">
        —
      </span>
    );
  }

  if (variant === 'badge') {
    return <SeverityBadge severity={severity} className={className} />;
  }

  // A severity the schema gained since this build still has to render something readable, so the
  // lookups fall back rather than producing an unlabelled, uncoloured dot.
  const dot = DOT_CLASS[severity] ?? 'bg-muted-foreground/50';
  const text = LABEL[severity] ?? String(severity);

  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', className)}>
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', dot)} />
      <span className={cn(severity === 'CRITICAL' && 'font-medium text-foreground')}>{text}</span>
      {count === undefined ? null : <span className="tabular text-xs text-muted-foreground">· {count}</span>}
    </span>
  );
}
