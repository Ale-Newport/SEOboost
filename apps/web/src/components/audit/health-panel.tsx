import { ChevronDown } from 'lucide-react';
import type { ExplainableScore } from '@seo/shared';

import { Card } from '@/components/ui/card';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { formatNumber } from '@/lib/utils';
import type { HealthMethodology } from './types';

/** `0.15` → `15%`. Weights are published as percentages everywhere in the product. */
function weightPercent(weight: number): string {
  return `${Math.round(weight * 1000) / 10}%`;
}

/** Trims the trailing `.0` that `max(4, pages × 0.15)` produces for round site sizes. */
function formatDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export interface HealthPanelProps {
  score: ExplainableScore;
  methodology: HealthMethodology;
}

/**
 * The site health score and the whole of its derivation.
 *
 * Two things are on screen at once by design: `ScoreBreakdown` shows what the number is made of
 * (each category's 0-100 result, its published weight, the points it contributed and the engine's
 * own explanation), and the disclosure beside it states the method in words, with the site's real
 * constants substituted in. Nothing here re-derives the score — the factors come from
 * `calculateHealthScore` exactly as the engine returned them.
 */
export function HealthPanel({ score, methodology }: HealthPanelProps): React.JSX.Element {
  const {
    severityWeights,
    categoryWeights,
    pageHalfPoint,
    siteHalfPoint,
    pagesCrawled,
    liveIssuesScored,
    truncated,
    storedScore,
    storedScoreLabel,
  } = methodology;

  const storedDiffers =
    storedScore !== null && Math.abs(storedScore - score.score) >= 0.5 && !truncated;

  return (
    <Card className="grid gap-6 p-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:gap-8">
      <ScoreBreakdown
        score={score}
        title="Site health"
        sort="opportunity"
        ringSize="lg"
        aria-label="Site health score breakdown by category"
      />

      <div className="space-y-3">
        <details className="group rounded-lg border border-border bg-muted/30">
          <summary
            className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3.5 py-2.5 text-xs font-medium text-foreground hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
            aria-label="How the site health score is calculated"
          >
            How this is calculated
            <ChevronDown
              className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>

          <div className="space-y-4 border-t border-border px-3.5 py-3.5">
            <ol className="space-y-2.5 text-2xs leading-relaxed text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">1. Every open issue is priced.</span>{' '}
                A finding costs <span className="text-foreground">severity weight × rule weight</span>{' '}
                penalty points, charged to its category. Ignored and resolved issues cost nothing.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  2. Page-level penalties are scaled to site size.
                </span>{' '}
                They are divided by <span className="tabular text-foreground">{formatDecimal(pageHalfPoint)}</span>{' '}
                — that is <span className="tabular">max(4, pages × 0.15)</span> for the{' '}
                <span className="tabular">{formatNumber(pagesCrawled)}</span> pages crawled here. Ten
                missing titles matter more on a 20-page site than on a 20,000-page one.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  3. Site-wide penalties are not scaled.
                </span>{' '}
                A missing sitemap or absent robots.txt is divided by a fixed{' '}
                <span className="tabular text-foreground">{siteHalfPoint}</span>: it is exactly as bad
                on a large site as on a small one, so site size must not dilute it.
              </li>
              <li>
                <span className="font-medium text-foreground">4. The two ratios are combined.</span>{' '}
                Their sum <span className="tabular">r</span> runs through a saturating curve, giving a
                category score of <span className="tabular text-foreground">100 ÷ (1 + r)</span>. A ratio
                of 1 halves the category; nothing ever goes below 0 or above 100.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  5. Categories are combined by published weight.
                </span>{' '}
                The weights below are fixed, identical for every site, and sum to 100%.
              </li>
            </ol>

            <div className="space-y-1.5">
              <h4 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Severity weight
              </h4>
              <ul className="flex flex-wrap gap-1.5">
                {severityWeights.map((entry) => (
                  <li
                    key={entry.severity}
                    className="tabular rounded-md border border-border bg-card px-1.5 py-0.5 text-2xs text-muted-foreground"
                  >
                    <span className="font-medium text-foreground">{entry.severity}</span> ×{entry.weight}
                  </li>
                ))}
              </ul>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                Multiplied by the rule&rsquo;s own weight, published for every rule in the rule
                reference.
              </p>
            </div>

            <div className="space-y-1.5">
              <h4 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                Category weight
              </h4>
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
                {categoryWeights.map((entry) => (
                  <li
                    key={entry.category}
                    className="flex items-baseline justify-between gap-2 text-2xs text-muted-foreground"
                  >
                    <span className="truncate">{entry.label}</span>
                    <span className="tabular shrink-0 font-medium text-foreground">
                      {weightPercent(entry.weight)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </details>

        <dl className="space-y-1.5 rounded-lg border border-border bg-card px-3.5 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-2xs text-muted-foreground">Issues scored</dt>
            <dd className="tabular text-2xs font-medium text-foreground">
              {formatNumber(liveIssuesScored)} open
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-2xs text-muted-foreground">Pages crawled</dt>
            <dd className="tabular text-2xs font-medium text-foreground">{formatNumber(pagesCrawled)}</dd>
          </div>
          {storedScore === null ? null : (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-2xs text-muted-foreground">Last pipeline score</dt>
              <dd className="tabular text-2xs font-medium text-foreground">
                {formatDecimal(storedScore)}
                {storedScoreLabel ? (
                  <span className="ml-1 font-normal text-muted-foreground">· {storedScoreLabel}</span>
                ) : null}
              </dd>
            </div>
          )}
        </dl>

        <p className="text-2xs leading-relaxed text-muted-foreground">
          {truncated ? (
            <>
              This site has more open issues than one page of the breakdown can hold, so the
              categories above are computed from the first {formatNumber(liveIssuesScored)} of them and
              the real score is lower. The figure written by the analysis pipeline is the
              authoritative one.
            </>
          ) : storedDiffers ? (
            <>
              Recomputed from the issues currently open, using the same function the analysis
              pipeline runs — so it moves as soon as you ignore, resolve or reopen something, while
              the stored score only changes when the pipeline runs again.
            </>
          ) : (
            <>
              Recomputed from the issues currently open, using the same scoring function the
              analysis pipeline runs after every crawl.
            </>
          )}
        </p>
      </div>
    </Card>
  );
}
