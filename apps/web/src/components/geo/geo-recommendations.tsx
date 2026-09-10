'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, ListChecks, Sparkles, UserRoundCheck } from 'lucide-react';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { toast } from '@/components/ui/toast';
import { UrlCell } from '@/components/data/url-cell';
import { apiPost } from '@/lib/api-client';
import { reportApiError } from '@/lib/job-feedback';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { GeoRecommendationView } from '@/server/queries/geo';

const EFFORT_TONE = { LOW: 'success', MEDIUM: 'warning', HIGH: 'destructive' } as const;
const IMPACT_TONE = { HIGH: 'success', MEDIUM: 'info', LOW: 'muted' } as const;

/**
 * The audit's recommendations, each with the evidence behind it and a one-click promotion into
 * the action queue.
 *
 * Promotion creates a `PROPOSED` action — it does not change the site. Confidence is shown on
 * every card and never exceeds 0.6, which is the ceiling the GEO agent applies because GEO
 * outcomes cannot be attributed the way a ranking change can.
 */
export function GeoRecommendations({
  websiteId,
  auditId,
  recommendations,
}: {
  websiteId: string;
  auditId: string;
  recommendations: GeoRecommendationView[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  const promote = useCallback(
    async (recommendation: GeoRecommendationView) => {
      setPending(recommendation.id);
      try {
        await apiPost<{ action: { id: string; title: string } }>('/api/geo/actions', {
          websiteId,
          auditId,
          index: recommendation.index,
        });
        toast.success('Added to the action queue', {
          description: 'It is proposed, not applied — approve it from AI Actions when you are ready.',
        });
        router.refresh();
      } catch (error) {
        reportApiError(error, 'Could not create the action.');
      } finally {
        setPending(null);
      }
    },
    [websiteId, auditId, router],
  );

  if (recommendations.length === 0) {
    return (
      <EmptyState
        bordered
        icon={ListChecks}
        title="This audit produced no recommendations"
        description="The GEO agent writes recommendations alongside the score. Re-run the audit to generate them; with an AI provider configured they become page-specific rewrites instead of dimension-level guidance."
      />
    );
  }

  return (
    <ul className="space-y-3">
      {recommendations.map((recommendation) => (
        <li key={recommendation.id}>
          <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div className="min-w-0 space-y-1">
                <h3 className="text-sm font-semibold leading-snug text-foreground">{recommendation.action}</h3>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline">{recommendation.dimensionLabel}</Badge>
                  <Badge variant={IMPACT_TONE[recommendation.expectedImpact]}>
                    {recommendation.expectedImpact.toLowerCase()} impact
                  </Badge>
                  <Badge variant={EFFORT_TONE[recommendation.effort]}>
                    {recommendation.effort.toLowerCase()} effort
                  </Badge>
                  <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                    {formatPercent(recommendation.confidence * 100, 0)} confidence
                    <TooltipInfo
                      label="How confidence is set for GEO work"
                      content="Capped at 60% by design. Answer engines do not report why they cite a source, so no GEO change can be attributed the way a ranking change can. Recommendations needing input from the business are held at 45%."
                    />
                  </span>
                  {recommendation.affectedPages > 0 ? (
                    <span className="text-2xs text-muted-foreground">
                      · {formatNumber(recommendation.affectedPages)} audited page
                      {recommendation.affectedPages === 1 ? '' : 's'} flagged on this dimension
                    </span>
                  ) : null}
                </div>
              </div>

              {recommendation.actionId ? (
                <div className="flex shrink-0 items-center gap-2">
                  {recommendation.actionStatus ? <StatusBadge status={recommendation.actionStatus} /> : null}
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/actions?websiteId=${websiteId}`}>
                      View action
                      <ArrowUpRight aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  loading={pending === recommendation.id}
                  loadingText="Creating the action"
                  onClick={() => void promote(recommendation)}
                >
                  {pending === recommendation.id ? null : <Sparkles aria-hidden="true" />}
                  Create action
                </Button>
              )}
            </div>

            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              {recommendation.currentState ? (
                <div className="space-y-0.5">
                  <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Where it stands
                  </dt>
                  <dd className="text-sm leading-relaxed text-foreground">{recommendation.currentState}</dd>
                </div>
              ) : null}
              {recommendation.proposedChange ? (
                <div className="space-y-0.5">
                  <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    What to change
                  </dt>
                  <dd className="text-sm leading-relaxed text-foreground">{recommendation.proposedChange}</dd>
                </div>
              ) : null}
              {recommendation.rationale ? (
                <div className="space-y-0.5 sm:col-span-2">
                  <dt className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    Why it matters
                  </dt>
                  <dd className="text-sm leading-relaxed text-muted-foreground">{recommendation.rationale}</dd>
                </div>
              ) : null}
            </dl>

            {recommendation.requiresHumanInput ? (
              <p className="mt-3 flex items-start gap-2 rounded-md border border-warning/25 bg-warning/[0.07] p-2.5 text-xs leading-relaxed text-foreground">
                <UserRoundCheck aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
                <span>
                  Needs a decision or a fact from the business
                  {recommendation.humanInputNeeded ? `: ${recommendation.humanInputNeeded}` : '.'} Nothing here is
                  invented on your behalf — an unanswered question is left open rather than filled in.
                </span>
              </p>
            ) : null}

            {recommendation.targetUrl ? (
              <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="shrink-0">Example page</span>
                <UrlCell url={recommendation.targetUrl} maxLength={56} />
              </div>
            ) : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}
