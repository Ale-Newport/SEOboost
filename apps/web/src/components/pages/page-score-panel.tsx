'use client';

import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import type { ExplainableScore } from '@seo/shared';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { ScoreRing } from '@/components/ui/score-ring';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { cn } from '@/lib/utils';

export interface PageScorePanelProps {
  websiteId: string;
  seo: ExplainableScore | null;
  storedSeoScore: number | null;
  geo: ExplainableScore | null;
  storedGeoScore: number | null;
  geoAuditedAt: Date | null;
  opportunity: ExplainableScore | null;
  lastAnalysedAt: Date | null;
}

interface ScoreSlotProps {
  label: string;
  score: ExplainableScore | null;
  fallbackValue: number | null;
  title: string;
  /** Shown instead of the breakdown when the factors were never recorded. */
  unavailable: React.ReactNode;
  sort?: 'contribution' | 'opportunity';
}

/**
 * One ring plus its disclosure.
 *
 * A score is only allowed on screen with its factors attached, so the ring is a button: pressing
 * it opens the weighted breakdown that produced the number. When the factors genuinely cannot be
 * derived, the ring still refuses to stand alone — it carries an explanation of what is missing
 * and what to run to get it.
 */
function ScoreSlot({ label, score, fallbackValue, title, unavailable, sort }: ScoreSlotProps): React.JSX.Element {
  const value = score?.score ?? fallbackValue;

  if (!score) {
    return (
      <div className="flex flex-col items-center gap-1.5 text-center">
        <ScoreRing value={value} size="md" ariaLabel={`${label}: ${value === null ? 'not available' : `${Math.round(value)} out of 100`}`} />
        <span className="flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
          <TooltipInfo content={unavailable} label={`Why the ${label} score has no breakdown`} />
        </span>
      </div>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'group flex flex-col items-center gap-1.5 rounded-md p-1 text-center transition-colors',
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
          aria-label={`${title}: ${Math.round(score.score)} out of 100. Show the factor breakdown.`}
        >
          <ScoreRing value={score.score} size="md" showValue />
          <span className="inline-flex items-center gap-0.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground group-hover:text-foreground">
            {label}
            <ChevronDown className="size-3" aria-hidden="true" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-[22rem] max-w-[calc(100vw-2rem)] p-4">
        <ScoreBreakdown score={score} title={title} ringSize="md" sort={sort ?? 'opportunity'} compact />
      </PopoverContent>
    </Popover>
  );
}

/** The three numbers this screen is judged on, each one openable into the factors behind it. */
export function PageScorePanel({
  websiteId,
  seo,
  storedSeoScore,
  geo,
  storedGeoScore,
  geoAuditedAt,
  opportunity,
  lastAnalysedAt,
}: PageScorePanelProps): React.JSX.Element {
  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle>Scores</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-between gap-4">
        <div className="flex items-start justify-around gap-2">
          <ScoreSlot
            label="SEO"
            title="Page SEO score"
            score={seo}
            fallbackValue={storedSeoScore}
            unavailable={
              <>
                The breakdown is computed from the crawled document — title, headings, images, body text. This
                page has no crawl record yet, so only the stored number is available. Run a crawl to get the
                factors back.
              </>
            }
          />
          <ScoreSlot
            label="GEO"
            title="Generative-engine readiness"
            score={geo}
            fallbackValue={storedGeoScore}
            unavailable={
              <>
                No GEO audit has scored this page yet. Run the GEO agent from the site&rsquo;s AI search section
                to measure entity clarity, fact density, structure and the other dimensions.
              </>
            }
          />
          <ScoreSlot
            label="Opportunity"
            title="Opportunity score"
            score={opportunity}
            fallbackValue={null}
            sort="contribution"
            unavailable={<>Opportunity is derived from search performance; there is none recorded for this URL.</>}
          />
        </div>

        <p className="text-2xs leading-relaxed text-muted-foreground">
          {lastAnalysedAt
            ? `Scored ${lastAnalysedAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. `
            : 'This page has not been scored yet. '}
          {geoAuditedAt
            ? `GEO audited ${geoAuditedAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}. `
            : ''}
          <Link href={`/sites/${websiteId}/geo`} className="font-medium text-primary hover:underline">
            GEO readiness
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
