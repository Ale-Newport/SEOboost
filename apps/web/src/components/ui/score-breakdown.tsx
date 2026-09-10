import * as React from 'react';
import type { ExplainableScore, ScoreFactor } from '@seo/shared';

import { cn } from '@/lib/utils';
import { DEFAULT_SCORE_THRESHOLDS, ScoreRing, scoreGrade, type ScoreGrade, type ScoreThresholds } from './score-ring';
import { TooltipInfo } from './tooltip-info';

const GRADE_FILL: Record<ScoreGrade, string> = {
  good: 'bg-success',
  fair: 'bg-warning',
  poor: 'bg-destructive',
};

export type ScoreBreakdownSort = 'contribution' | 'opportunity';

/**
 * Engine numbers are taken as given, but a factor whose weight or contribution
 * arrives as NaN (an upstream division by an empty sample) must not become
 * `width: NaN%` or an aria-label reading “NaN percent” — it degrades to zero,
 * which renders as an empty bar rather than a wrong one.
 */
function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Points this factor can contribute at full marks: `weight` expressed on the 0-100 scale. */
function maxPoints(factor: ScoreFactor): number {
  return finite(factor.weight) * 100;
}

/** Points the factor is currently leaving on the table. */
function missedPoints(factor: ScoreFactor): number {
  return maxPoints(factor) - finite(factor.contribution);
}

/** One decimal only when it carries information — “15 pts”, never “15.0 pts”. */
function formatPoints(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export interface ScoreBreakdownProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  score: ExplainableScore;
  /** Names the score, e.g. “Technical health”. Rendered as a heading beside the ring. */
  title?: React.ReactNode;
  /**
   * `contribution` answers “what is holding this score up”, `opportunity`
   * answers “where do I get the most points back”.
   */
  sort?: ScoreBreakdownSort;
  showRing?: boolean;
  ringSize?: 'sm' | 'md' | 'lg';
  /** Move each factor's explanation behind an “(i)” — for side panels and popovers. */
  compact?: boolean;
  thresholds?: ScoreThresholds;
}

/**
 * Renders an `ExplainableScore` as a headline plus one labelled bar per factor.
 *
 * This is the component that keeps scores out of black-box territory, so every
 * number that went into the total is on screen: the factor's own 0-100 result
 * as the bar, its weight, the points it actually contributed out of the points
 * it could have, and the engine's own explanation string. Nothing here is
 * recomputed from the score — `contribution` and `weight` are taken as given so
 * the UI can never drift from the engine that produced them.
 */
const ScoreBreakdown = React.forwardRef<HTMLDivElement, ScoreBreakdownProps>(function ScoreBreakdown(
  {
    score,
    title,
    sort = 'contribution',
    showRing = true,
    ringSize = 'lg',
    compact = false,
    thresholds = DEFAULT_SCORE_THRESHOLDS,
    className,
    ...props
  },
  ref,
) {
  // Copied before sorting: the caller's array belongs to the engine result and
  // must not be reordered underneath it.
  const factors = [...score.factors].sort((a, b) =>
    sort === 'opportunity'
      ? missedPoints(b) - missedPoints(a)
      : finite(b.contribution) - finite(a.contribution),
  );

  // Left undefined when the total is not a real number, so the ring falls back
  // to its own “not available” name instead of announcing “NaN out of 100”.
  const ringLabel =
    typeof title === 'string' && Number.isFinite(score.score)
      ? `${title}: ${Math.round(score.score)} out of 100`
      : undefined;

  return (
    <div ref={ref} className={cn('flex flex-col gap-4', className)} {...props}>
      <div className="flex items-start gap-4">
        {showRing ? (
          <ScoreRing value={score.score} size={ringSize} thresholds={thresholds} ariaLabel={ringLabel} />
        ) : null}
        <div className="min-w-0 space-y-1">
          {title ? (
            <h3 className="text-sm font-semibold leading-tight tracking-tight text-foreground">{title}</h3>
          ) : null}
          <p className="text-sm leading-relaxed text-muted-foreground">{score.summary}</p>
          {factors.length > 0 ? (
            <p className="text-2xs text-muted-foreground">
              {factors.length} weighted {factors.length === 1 ? 'factor' : 'factors'}
              {sort === 'opportunity' ? ' · biggest opportunity first' : ' · largest contribution first'}
            </p>
          ) : null}
        </div>
      </div>

      {factors.length === 0 ? (
        <p className="text-xs text-muted-foreground">No factor breakdown was recorded for this score.</p>
      ) : (
        <ol className="space-y-3">
          {factors.map((factor) => {
            const available = maxPoints(factor);
            const contribution = finite(factor.contribution);
            const percent = Math.min(100, Math.max(0, finite(factor.value) * 100));
            const grade = scoreGrade(percent, thresholds);
            const weighted = available > 0;

            return (
              <li key={factor.key} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs font-medium text-foreground">{factor.label}</span>
                    {compact ? <TooltipInfo content={factor.explanation} label={`Why: ${factor.label}`} /> : null}
                  </div>
                  <span className="tabular shrink-0 text-2xs text-muted-foreground">
                    {weighted ? (
                      <>
                        <span className="font-medium text-foreground">{formatPoints(contribution)}</span>
                        {` / ${formatPoints(available)} pts`}
                      </>
                    ) : (
                      'Not weighted'
                    )}
                  </span>
                </div>

                <div
                  role="img"
                  aria-label={
                    weighted
                      ? `${factor.label}: ${formatPoints(contribution)} of ${formatPoints(available)} points, ${Math.round(percent)} percent`
                      : `${factor.label}: not weighted, ${Math.round(percent)} percent`
                  }
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-500 ease-out',
                      weighted ? GRADE_FILL[grade] : 'bg-muted-foreground/40',
                    )}
                    style={{ width: `${percent}%` }}
                  />
                </div>

                <div className="flex items-start justify-between gap-3">
                  {compact ? (
                    <span />
                  ) : (
                    <p className="min-w-0 text-2xs leading-relaxed text-muted-foreground">{factor.explanation}</p>
                  )}
                  <span className="tabular shrink-0 text-2xs text-muted-foreground">
                    {Math.round(finite(factor.weight) * 100)}% weight
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
});

export { ScoreBreakdown };
