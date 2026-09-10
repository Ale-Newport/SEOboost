'use client';

import { useState } from 'react';
import { ChevronRight, FileWarning } from 'lucide-react';
import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { ScoreRing } from '@/components/ui/score-ring';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { UrlCell } from '@/components/data/url-cell';
import { cn, formatNumber, formatPercent } from '@/lib/utils';
import type { GeoDimensionView } from '@/server/queries/geo';
import type { ExplainableScore } from '@seo/shared';

/**
 * The eleven weighted dimensions, twice over: once as the canonical `ScoreBreakdown` (so the
 * arithmetic behind the headline number is on screen), and once as a grid of cards that open a
 * per-dimension detail panel with the engine's evidence and the weakest pages.
 */
export function GeoDimensions({
  score,
  dimensions,
  websiteId,
}: {
  score: ExplainableScore;
  dimensions: GeoDimensionView[];
  websiteId: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const active = dimensions.find((dimension) => dimension.key === openKey) ?? null;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <Card className="p-5">
        <ScoreBreakdown
          score={score}
          title="GEO readiness"
          sort="opportunity"
          showRing={false}
        />
      </Card>

      <div className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold tracking-tight text-foreground">Dimension detail</h3>
          <p className="text-2xs text-muted-foreground">Biggest opportunity first</p>
        </div>

        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
          {[...dimensions]
            .sort((a, b) => b.missed - a.missed)
            .map((dimension) => (
              <li key={dimension.key}>
                <button
                  type="button"
                  onClick={() => setOpenKey(dimension.key)}
                  aria-haspopup="dialog"
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors',
                    'hover:border-primary/40 hover:bg-accent/40',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                  )}
                >
                  <ScoreRing value={dimension.score} size="sm" label={dimension.label} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-xs font-medium text-foreground">{dimension.label}</span>
                      <Badge variant="muted" className="shrink-0">
                        {Math.round(dimension.weight * 100)}%
                      </Badge>
                    </span>
                    <span className="mt-0.5 block text-2xs text-muted-foreground">
                      {dimension.contribution} of {Math.round(dimension.weight * 100)} pts
                      {dimension.pagesFlagged > 0
                        ? ` · ${formatNumber(dimension.pagesFlagged)} page${dimension.pagesFlagged === 1 ? '' : 's'} flagged`
                        : ' · no pages flagged'}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
        </ul>
      </div>

      <Sheet open={active !== null} onOpenChange={(open) => setOpenKey(open ? openKey : null)}>
        <SheetContent side="right" className="sm:max-w-lg">
          {active ? (
            <>
              <SheetHeader>
                <SheetTitle>{active.label}</SheetTitle>
                <SheetDescription>{active.meaning}</SheetDescription>
              </SheetHeader>

              <SheetBody className="space-y-5">
                <div className="flex items-center gap-4">
                  <ScoreRing value={active.score} size="lg" label="Dimension" />
                  <StatList dense divided className="min-w-0 flex-1">
                    <StatListItem
                      label="Weight"
                      value={`${Math.round(active.weight * 100)}% of the total`}
                      hint="How much this dimension can move the overall GEO score."
                    />
                    <StatListItem
                      label="Contributing"
                      value={`${active.contribution} pts`}
                      hint="Points this dimension currently adds to the 0-100 score."
                    />
                    <StatListItem label="Left on the table" value={`${active.missed} pts`} />
                    <StatListItem label="Pages scored" value={formatNumber(active.pagesScored)} />
                    <StatListItem
                      label="Pages flagged"
                      value={formatNumber(active.pagesFlagged)}
                      muted={active.pagesFlagged === 0}
                    />
                  </StatList>
                </div>

                <section className="space-y-1.5">
                  <h4 className="text-xs font-semibold text-foreground">What the audit measured</h4>
                  <p className="text-sm leading-relaxed text-muted-foreground">{active.explanation}</p>
                </section>

                {active.findings.length > 0 ? (
                  <section className="space-y-2">
                    <h4 className="text-xs font-semibold text-foreground">Findings</h4>
                    <ul className="space-y-2">
                      {active.findings.map((finding) => (
                        <li key={finding.id} className="rounded-md border border-border bg-muted/30 p-3">
                          <div className="mb-1.5 flex items-center gap-2">
                            <SeverityBadge severity={finding.badgeSeverity} />
                            {finding.affectedPages > 0 ? (
                              <span className="text-2xs text-muted-foreground">
                                {formatNumber(finding.affectedPages)} page
                                {finding.affectedPages === 1 ? '' : 's'} affected
                              </span>
                            ) : null}
                          </div>
                          <p className="text-sm leading-relaxed text-foreground">{finding.message}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <section className="space-y-2">
                  <h4 className="text-xs font-semibold text-foreground">
                    Weakest pages on this dimension
                  </h4>
                  {active.weakestPages.length === 0 ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                      <FileWarning aria-hidden="true" className="size-4" />
                      No per-page results were stored for this dimension.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {active.weakestPages.map((page) => (
                        <li key={page.pageId} className="space-y-1">
                          <div className="flex items-center justify-between gap-3">
                            <UrlCell
                              url={page.url}
                              label={page.title ?? undefined}
                              href={`/sites/${websiteId}/pages/${page.pageId}`}
                              maxLength={44}
                            />
                            <span className="tabular shrink-0 text-2xs text-muted-foreground">
                              {formatPercent(page.value * 100, 0)}
                            </span>
                          </div>
                          <ProgressBar
                            value={page.value * 100}
                            max={100}
                            tone={page.value >= 0.8 ? 'success' : page.value >= 0.5 ? 'warning' : 'destructive'}
                            size="sm"
                            showValue={false}
                            ariaLabel={`${active.label} on ${page.url}: ${Math.round(page.value * 100)} out of 100`}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </SheetBody>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
