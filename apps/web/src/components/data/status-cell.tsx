'use client';

import { StatusBadge, humanizeStatus } from '@/components/ui/badge';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface StatusCellProps {
  /**
   * Any status enum in the schema (`CrawlStatus`, `ActionStatus`, `ApprovalStatus`,
   * `IntegrationStatus`, …). The tone mapping lives in `StatusBadge`, so a value it does not know
   * degrades to a neutral pill instead of breaking the screen.
   */
  status: string | null | undefined;
  /** Override the humanised enum text when the domain has a better word. */
  label?: string;
  /** Why the row is in this state — a failure reason, the last sync time. */
  detail?: string;
  className?: string;
}

export function StatusCell({ status, label, detail, className }: StatusCellProps): React.JSX.Element {
  if (!status) {
    return (
      <span className={cn('text-muted-foreground', className)} aria-label="No status">
        —
      </span>
    );
  }

  const badge = <StatusBadge status={status} label={label} className={className} />;

  if (!detail) return badge;

  return (
    <SimpleTooltip content={detail}>
      <span className="inline-flex">{badge}</span>
    </SimpleTooltip>
  );
}

export { humanizeStatus };
