import { ExternalLink, Swords } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { RemoveCompetitorButton } from '@/components/competitors/competitor-actions';
import type { CompetitorRow } from '@/components/competitors/queries';
import { cn, colorIndex, formatCompact, formatNumber, formatPercent, formatPosition, initials } from '@/lib/utils';

/** Static list so Tailwind keeps every monogram colour in the build. */
const MONOGRAM_TONES = [
  'bg-chart-1/12 text-chart-1',
  'bg-chart-2/12 text-chart-2',
  'bg-chart-3/12 text-chart-3',
  'bg-chart-4/12 text-chart-4',
  'bg-chart-5/12 text-chart-5',
  'bg-chart-6/12 text-chart-6',
] as const;

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

export function CompetitorCard({
  websiteId,
  competitor,
}: {
  websiteId: string;
  competitor: CompetitorRow;
}): React.JSX.Element {
  const analysed = competitor.lastAnalysedAt !== null;
  const live = competitor.live;
  const decided = live ? live.wins + live.losses : 0;
  const tone = MONOGRAM_TONES[colorIndex(competitor.domain, MONOGRAM_TONES.length)] ?? MONOGRAM_TONES[0];

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold',
            tone,
          )}
        >
          {initials(competitor.name ?? competitor.domain)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {competitor.name ?? competitor.domain}
            </h3>
            <a
              href={`https://${competitor.domain}`}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={`Open ${competitor.domain} in a new tab`}
            >
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
          </div>
          <p className="truncate font-mono text-2xs text-muted-foreground">{competitor.domain}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Badge variant={competitor.isManual ? 'outline' : 'secondary'} className="text-2xs">
            {competitor.isManual ? 'Manual' : 'Detected'}
          </Badge>
          <RemoveCompetitorButton
            websiteId={websiteId}
            competitorId={competitor.id}
            domain={competitor.domain}
          />
        </div>
      </div>

      {!analysed ? (
        <p className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          Not analysed yet. Run the competitor analysis to collect this domain&rsquo;s rankings — every
          number below stays empty until it has.
        </p>
      ) : null}

      <StatList dense divided className="text-sm">
        <StatListItem
          label="Shared keywords"
          value={<span className="tabular">{analysed ? formatNumber(competitor.sharedKeywords) : '—'}</span>}
          muted={!analysed}
          hint="Queries where both this site and the competitor were observed ranking."
        />
        <StatListItem
          label="Gap keywords"
          value={<span className="tabular">{analysed ? formatNumber(competitor.gapKeywords) : '—'}</span>}
          muted={!analysed}
          hint="Queries they rank for and this site does not."
        />
        <StatListItem
          label="SERP overlap"
          value={<span className="tabular">{analysed ? formatPercent(competitor.serpOverlapPct / 100, 1) : '—'}</span>}
          muted={!analysed}
          hint="Share of this site's tracked keywords the competitor also ranks for. Higher means you are fighting over the same queries."
        />
        <StatListItem
          label="Their avg. position"
          value={<span className="tabular">{formatPosition(competitor.avgPosition)}</span>}
          muted={competitor.avgPosition === null}
          hint="Mean position across every ranking observed for this competitor. Lower is better."
        />
        <StatListItem
          label="Observed rankings"
          value={<span className="tabular">{formatCompact(competitor.observedKeywords)}</span>}
          muted={competitor.observedKeywords === 0}
          hint="Rows the analysis has actually recorded — the evidence behind the numbers above."
        />
      </StatList>

      {live && decided > 0 ? (
        <div className="space-y-1.5">
          <ProgressBar
            label={
              <span className="inline-flex items-center gap-1">
                <Swords aria-hidden="true" className="size-3.5 text-muted-foreground" />
                Head to head
                <TooltipInfo
                  content="Across the keywords you both rank for: how often this site sits above the competitor (wins) and how often it sits below (losses). Computed live from the observed rankings."
                  label="How head to head is measured"
                />
              </span>
            }
            ariaLabel={`Head to head against ${competitor.domain}`}
            value={decided}
            max={decided}
            segments={[
              { key: 'wins', label: `${live.wins} we win`, value: live.wins, tone: 'success' },
              { key: 'losses', label: `${live.losses} we lose`, value: live.losses, tone: 'destructive' },
            ]}
            size="sm"
            showValue={false}
          />
        </div>
      ) : null}

      {competitor.topicalStrengths.length > 0 ? (
        <div className="space-y-1">
          <p className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            Topical strengths
            <TooltipInfo
              content="Terms that recur across the queries where this competitor outranks us — where their content is consistently stronger."
              label="How topical strengths are derived"
            />
          </p>
          <div className="flex flex-wrap gap-1">
            {competitor.topicalStrengths.slice(0, 8).map((term) => (
              <Badge key={term} variant="outline" className="text-2xs font-normal">
                {term}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}

      {competitor.notes ? (
        <p className="border-t border-border pt-2 text-xs leading-relaxed text-muted-foreground">
          {competitor.notes}
        </p>
      ) : null}

      <p className="mt-auto text-2xs text-muted-foreground">
        {analysed && competitor.lastAnalysedAt
          ? `Last analysed ${DATE.format(competitor.lastAnalysedAt)}`
          : `Added ${DATE.format(competitor.createdAt)}`}
      </p>
    </Card>
  );
}
