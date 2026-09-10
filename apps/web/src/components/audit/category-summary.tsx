'use client';

import { Check } from 'lucide-react';

import { useTableParams } from '@/components/data/use-table-params';
import { cn, formatNumber } from '@/lib/utils';
import { SEVERITY_LABEL, type CategorySummary, type IssueSeverityName } from './types';

/**
 * Dot colour per severity, matching `SeverityCell` so the same severity never changes colour
 * between the summary and the table underneath it.
 */
const SEVERITY_DOT: Record<IssueSeverityName, string> = {
  CRITICAL: 'bg-destructive',
  HIGH: 'bg-destructive/60',
  MEDIUM: 'bg-warning',
  LOW: 'bg-info',
  INFO: 'bg-muted-foreground/50',
};

/** Bar colour for the category's own 0-100 score, on the shared 80/50 bands. */
function scoreTone(score: number): string {
  if (score >= 80) return 'bg-success';
  if (score >= 50) return 'bg-warning';
  return 'bg-destructive';
}

export interface CategorySummaryGridProps {
  summaries: readonly CategorySummary[];
}

/**
 * The section summary: one card per audit category, each a toggle for the table's `category`
 * filter. Clicking a card narrows the issue list below rather than navigating away, and the URL
 * carries the choice, so a filtered audit is a link you can send to whoever owns the fix.
 */
export function CategorySummaryGrid({ summaries }: CategorySummaryGridProps): React.JSX.Element {
  const { getParamList, toggleFilterValue } = useTableParams();
  const selected = getParamList('category');

  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {summaries.map((summary) => {
        const active = selected.includes(summary.category);
        const clean = summary.total === 0;

        return (
          <li key={summary.category}>
            <button
              type="button"
              aria-pressed={active}
              onClick={() => toggleFilterValue('category', summary.category)}
              className={cn(
                'group flex h-full w-full flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-colors',
                'hover:border-primary/40 hover:bg-accent/40',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                active ? 'border-primary/60 bg-primary/5' : 'border-border',
              )}
            >
              <span className="flex items-start justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-foreground">
                  {summary.label}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {active ? <Check className="size-3 text-primary" aria-hidden="true" /> : null}
                  <span
                    className={cn(
                      'tabular text-sm font-semibold leading-none',
                      clean ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {formatNumber(summary.total)}
                  </span>
                </span>
              </span>

              {clean ? (
                <span className="text-2xs text-muted-foreground">No open issues</span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {summary.bySeverity.map((entry) => (
                    <span
                      key={entry.severity}
                      className="inline-flex items-center gap-1 text-2xs text-muted-foreground"
                    >
                      <span
                        aria-hidden="true"
                        className={cn('size-1.5 shrink-0 rounded-full', SEVERITY_DOT[entry.severity])}
                      />
                      <span className="tabular">{formatNumber(entry.count)}</span>
                      <span>{SEVERITY_LABEL[entry.severity]}</span>
                    </span>
                  ))}
                </span>
              )}

              {summary.score === null || summary.weight === null ? (
                <span className="mt-auto text-2xs text-muted-foreground">Not weighted in health</span>
              ) : (
                <span
                  className="mt-auto block space-y-1"
                  role="img"
                  aria-label={`${summary.label} scores ${Math.round(summary.score)} out of 100 and carries ${Math.round(
                    summary.weight * 100,
                  )} percent of the site health score.`}
                >
                  <span className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground">
                    <span className="tabular">{Math.round(summary.score)}/100</span>
                    <span className="tabular">{Math.round(summary.weight * 100)}% weight</span>
                  </span>
                  <span className="block h-1 w-full overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn('block h-full rounded-full', scoreTone(summary.score))}
                      style={{ width: `${Math.max(0, Math.min(100, summary.score))}%` }}
                    />
                  </span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
