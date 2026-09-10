'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Loader2, Pin, PinOff, Split } from 'lucide-react';
import { toast } from 'sonner';

import { TimeSeriesChart } from '@/components/charts/time-series-chart';
import { useTableParams } from '@/components/data/use-table-params';
import { KeywordCell } from '@/components/data/keyword-cell';
import { ScoreCell } from '@/components/data/score-cell';
import { UrlCell } from '@/components/data/url-cell';
import { Alert } from '@/components/ui/alert';
import { Badge, humanizeStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { ApiError, apiPatch, apiPost } from '@/lib/api-client';
import { formatCompact, formatNumber, formatPercent, formatPosition, formatUsd } from '@/lib/utils';
import type { KeywordProfile } from './types';

/**
 * One keyword's full profile.
 *
 * The open keyword lives in the URL (`?id=`), so the panel is server-rendered, survives a
 * refresh and can be linked to — the same reason the list's filters live there.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

interface BriefResponse {
  brief: { id: string; title: string };
}

interface OpportunityResponse {
  opportunity: { id: string; title: string; status: string };
  created: boolean;
}

function historyNote(source: KeywordProfile['historySource']): string {
  switch (source) {
    case 'KEYWORD_METRIC':
      return 'Daily keyword metrics recorded by the rank sync.';
    case 'SEARCH_CONSOLE':
      return 'Derived from this query’s Search Console rows, impression-weighted per day.';
    default:
      return 'No history recorded yet.';
  }
}

export interface KeywordDetailSheetProps {
  websiteId: string;
  profile: KeywordProfile | null;
}

export function KeywordDetailSheet({ websiteId, profile }: KeywordDetailSheetProps): React.JSX.Element {
  const router = useRouter();
  const { setParams } = useTableParams();
  const [pendingTrack, setPendingTrack] = useState(false);
  const [pendingBrief, setPendingBrief] = useState(false);

  const close = useCallback(
    (open: boolean) => {
      if (!open) setParams({ id: null });
    },
    [setParams],
  );

  const toggleTracking = useCallback(async () => {
    if (!profile) return;
    setPendingTrack(true);
    try {
      await apiPatch(`/api/websites/${websiteId}/keywords/${profile.id}`, { isTracked: !profile.isTracked });
      toast.success(profile.isTracked ? 'Keyword untracked' : 'Keyword tracked', {
        description: profile.isTracked
          ? 'It stays in the list; the rank sync just stops prioritising it.'
          : 'The rank sync will prioritise this keyword from its next run.',
      });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not change tracking');
    } finally {
      setPendingTrack(false);
    }
  }, [profile, router, websiteId]);

  const createBrief = useCallback(async () => {
    if (!profile) return;
    setPendingBrief(true);
    try {
      // Two steps because briefs hang off opportunities: the first records *why* this keyword
      // deserves content, the second opens the brief the writer works from.
      const { opportunity } = await apiPost<OpportunityResponse>(
        `/api/websites/${websiteId}/keywords/${profile.id}/content-opportunity`,
        {},
      );
      const { brief } = await apiPost<BriefResponse>('/api/content/briefs', { opportunityId: opportunity.id });
      toast.success('Content brief created', {
        description: `"${brief.title}" is a skeleton. Run the BRIEF pipeline stage on a draft to fill in the outline, questions and competitor analysis.`,
      });
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not create the brief');
    } finally {
      setPendingBrief(false);
    }
  }, [profile, router, websiteId]);

  const rankingUrl = profile?.rankingUrl ?? profile?.pageUrl ?? null;

  return (
    <Sheet open={profile !== null} onOpenChange={close}>
      <SheetContent side="right" className="w-full sm:max-w-2xl" aria-label="Keyword details">
        {profile === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle className="break-words">{profile.keyword}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{humanizeStatus(profile.intent)}</Badge>
                <Badge variant="outline">{humanizeStatus(profile.funnelStage)}</Badge>
                <Badge variant="muted">{humanizeStatus(profile.source)}</Badge>
                <span className="text-2xs text-muted-foreground">{profile.locale}</span>
                {profile.isTracked ? <Badge variant="info">Tracked</Badge> : null}
                {profile.isBranded ? <Badge variant="outline">Brand</Badge> : null}
                {profile.isContentGap ? <Badge variant="warning">Content gap</Badge> : null}
                {profile.hasCannibalization ? (
                  <Badge variant="destructive">
                    <Split className="size-3" aria-hidden="true" />
                    Cannibalised
                  </Badge>
                ) : null}
              </SheetDescription>
            </SheetHeader>

            <SheetBody className="space-y-6 pb-2">
              <section aria-labelledby="keyword-metrics-heading">
                <h3 id="keyword-metrics-heading" className="mb-2 text-xs font-medium text-muted-foreground">
                  Last 28 days
                </h3>
                <StatList layout="row" divided dense>
                  <StatListItem
                    label="Position"
                    mono
                    value={profile.currentPosition === null ? 'Not ranking' : formatPosition(profile.currentPosition)}
                    hint={
                      profile.positionChange === null || profile.positionChange === 0
                        ? undefined
                        : `${profile.positionChange > 0 ? 'Up' : 'Down'} ${Math.abs(profile.positionChange).toFixed(1)} vs the previous period`
                    }
                  />
                  <StatListItem
                    label="Best ever"
                    mono
                    value={profile.bestPosition === null ? '—' : formatPosition(profile.bestPosition)}
                  />
                  <StatListItem label="Clicks" mono value={formatNumber(profile.clicks28d)} />
                  <StatListItem label="Impressions" mono value={formatCompact(profile.impressions28d)} />
                  <StatListItem
                    label="CTR"
                    mono
                    value={profile.ctr28d === null ? '—' : formatPercent(profile.ctr28d, 2)}
                  />
                  <StatListItem
                    label="Volume"
                    mono
                    value={profile.searchVolume === null ? '—' : formatCompact(profile.searchVolume)}
                    hint={profile.volumeSource ?? 'No provider supplied a volume for this keyword'}
                  />
                  <StatListItem
                    label="Difficulty"
                    value={<ScoreCell value={profile.difficulty} variant="pill" invert label="Difficulty" />}
                  />
                  <StatListItem label="CPC" mono value={profile.cpc === null ? '—' : formatUsd(profile.cpc)} />
                  <StatListItem label="First seen" value={DATE_FORMAT.format(profile.firstSeenAt)} muted />
                  <StatListItem label="Last seen" value={DATE_FORMAT.format(profile.lastSeenAt)} muted />
                </StatList>
              </section>

              <section aria-labelledby="keyword-history-heading">
                <h3 id="keyword-history-heading" className="sr-only">
                  Metric history
                </h3>
                <TimeSeriesChart
                  title="Last 90 days"
                  description={historyNote(profile.historySource)}
                  height={200}
                  data={profile.history}
                  series={[
                    { key: 'clicks', label: 'Clicks', type: 'area', axis: 'left', colorIndex: 0 },
                    {
                      key: 'impressions',
                      label: 'Impressions',
                      type: 'line',
                      axis: 'left',
                      colorIndex: 1,
                      format: 'compact',
                      defaultHidden: true,
                    },
                    { key: 'position', label: 'Position', type: 'line', axis: 'right', colorIndex: 4, format: 'position' },
                  ]}
                  emptyMessage="No day-by-day history for this keyword yet. It appears once Search Console has been synced, or once a SERP provider has recorded a rank."
                />
              </section>

              <section aria-labelledby="keyword-url-heading" className="space-y-2">
                <h3 id="keyword-url-heading" className="text-xs font-medium text-muted-foreground">
                  Ranking URL
                </h3>
                {rankingUrl === null ? (
                  <p className="text-sm text-muted-foreground">
                    No URL is mapped to this keyword. Search Console reports one once the query wins an
                    impression; until then, this is a candidate for new content.
                  </p>
                ) : (
                  <UrlCell url={rankingUrl} maxLength={80} />
                )}
              </section>

              <section aria-labelledby="keyword-opportunity-heading" className="space-y-2">
                <h3 id="keyword-opportunity-heading" className="text-xs font-medium text-muted-foreground">
                  Opportunity score
                </h3>
                {profile.opportunity === null ? (
                  <Alert variant="info" title="Not scored yet">
                    The keyword analysis has not scored this term. Run it for this site and the full
                    factor-by-factor breakdown appears here.
                  </Alert>
                ) : (
                  <ScoreBreakdown score={profile.opportunity} title="Opportunity" ringSize="md" />
                )}
              </section>

              <section aria-labelledby="keyword-cluster-heading" className="space-y-2">
                <h3 id="keyword-cluster-heading" className="text-xs font-medium text-muted-foreground">
                  Cluster
                </h3>
                {profile.cluster === null ? (
                  <p className="text-sm text-muted-foreground">
                    Not clustered yet. Clustering groups terms that share a search intent so one page can
                    answer all of them — run it from the Clusters tab.
                  </p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium text-foreground">{profile.cluster.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatNumber(profile.cluster.keywordCount)} keywords
                        {profile.cluster.avgPosition === null
                          ? ''
                          : ` · avg. position ${formatPosition(profile.cluster.avgPosition)}`}
                      </span>
                    </div>
                    {profile.siblings.length === 0 ? (
                      <p className="text-sm text-muted-foreground">This is the only keyword in the cluster.</p>
                    ) : (
                      <ul className="divide-y divide-border rounded-md border border-border">
                        {profile.siblings.map((sibling) => (
                          <li key={sibling.id} className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                            <KeywordCell keyword={sibling.keyword} showIntent={false} className="text-sm" />
                            <span className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
                              <span className="tabular">
                                {sibling.currentPosition === null ? '—' : formatPosition(sibling.currentPosition)}
                              </span>
                              <span className="tabular">{formatCompact(sibling.impressions28d)} impr.</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </section>

              {profile.brief === null ? null : (
                <EmptyState
                  size="sm"
                  bordered
                  icon={FileText}
                  title="A brief already exists for this keyword"
                  description={`"${profile.brief.title}" · ${humanizeStatus(profile.brief.status)}`}
                />
              )}
            </SheetBody>

            <SheetFooter>
              <Button
                variant="outline"
                onClick={() => void toggleTracking()}
                disabled={pendingTrack}
                aria-pressed={profile.isTracked}
              >
                {pendingTrack ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : profile.isTracked ? (
                  <PinOff aria-hidden="true" />
                ) : (
                  <Pin aria-hidden="true" />
                )}
                {profile.isTracked ? 'Untrack' : 'Track keyword'}
              </Button>
              <Button onClick={() => void createBrief()} disabled={pendingBrief || profile.brief !== null}>
                {pendingBrief ? <Loader2 className="animate-spin" aria-hidden="true" /> : <FileText aria-hidden="true" />}
                {profile.brief === null ? 'Create content brief' : 'Brief created'}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
