'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronDown,
  ExternalLink,
  Eye,
  FileSearch,
  GitMerge,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition, shortenUrl } from '@/lib/utils';

import { opportunityTypeMeta } from './meta';
import { formatDate } from './text';
import type { OpportunityItem } from './types';

/**
 * One ranked opportunity.
 *
 * The card leads with the judgement, not the task: for every type that does *not* create a URL
 * the "already covered" strip sits directly under the title, because the decision to improve an
 * existing page instead of publishing a new one is the most valuable thing the discovery pass
 * produces — and the easiest thing for an operator to mistake for the system doing nothing.
 */

interface OpportunityCardProps {
  websiteId: string;
  opportunity: OpportunityItem;
}

export function OpportunityCard({ websiteId, opportunity }: OpportunityCardProps): React.JSX.Element {
  const router = useRouter();
  const meta = opportunityTypeMeta(opportunity.type);
  const Icon = meta.icon;

  const [showScore, setShowScore] = React.useState(false);
  const [acceptOpen, setAcceptOpen] = React.useState(false);
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [createBrief, setCreateBrief] = React.useState(true);

  const scorePanelId = `opportunity-score-${opportunity.id}`;
  const decided = opportunity.status === 'REJECTED' || opportunity.status === 'COMPLETED';

  const evidence = opportunity.evidence;
  const matchedUrl = opportunity.page?.url ?? opportunity.existingPageMatch ?? evidence.bestMatchUrl;
  const matchSimilarity = evidence.bestMatchSimilarity;

  const accept = async (): Promise<void> => {
    setPending(true);
    try {
      await apiPost(`/api/content/opportunities/${opportunity.id}/accept`, note ? { note } : {});
      if (createBrief) {
        await apiPost('/api/content/briefs', { opportunityId: opportunity.id });
        toast.success('Accepted and a brief was created', {
          description:
            'The brief is a skeleton: run the BRIEF pipeline stage on a draft to fill in the outline, questions and competitor analysis.',
        });
      } else {
        toast.success('Opportunity accepted', {
          description: 'Create a brief when you are ready to turn it into work.',
        });
      }
      setAcceptOpen(false);
      setNote('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not accept this opportunity');
    } finally {
      setPending(false);
    }
  };

  const reject = async (): Promise<void> => {
    setPending(true);
    try {
      await apiPost(
        `/api/content/opportunities/${opportunity.id}/reject`,
        reason.trim() ? { reason: reason.trim() } : {},
      );
      toast.success('Opportunity rejected', {
        description: reason.trim()
          ? 'The reason is stored on the opportunity so the next discovery pass does not re-propose it.'
          : 'Add a reason next time — it is what stops the pass re-proposing the same thing.',
      });
      setRejectOpen(false);
      setReason('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not reject this opportunity');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card className={cn('overflow-hidden', decided && 'opacity-75')}>
      <div className="flex flex-col gap-3 p-4">
        {/* Title row */}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={meta.tone}>
                <Icon className="size-3" aria-hidden="true" />
                {meta.label}
              </Badge>
              <StatusBadge status={opportunity.status} />
              {opportunity.briefCount > 0 && (
                <Badge variant="outline">
                  {opportunity.briefCount} brief{opportunity.briefCount === 1 ? '' : 's'}
                </Badge>
              )}
              {opportunity.cluster && <Badge variant="muted">{opportunity.cluster.name}</Badge>}
            </div>
            <h3 className="text-sm font-semibold leading-snug tracking-tight text-foreground">
              {opportunity.title}
            </h3>
            {opportunity.targetKeyword && (
              <p className="text-xs text-muted-foreground">
                Target keyword{' '}
                <span className="font-medium text-foreground">{opportunity.targetKeyword}</span>
                {opportunity.keyword?.searchVolume !== null && opportunity.keyword?.searchVolume !== undefined && (
                  <> · {formatCompact(opportunity.keyword.searchVolume)} searches/mo</>
                )}
                {opportunity.keyword?.intent && <> · {opportunity.keyword.intent.toLowerCase()} intent</>}
              </p>
            )}
          </div>

          {/* Priority */}
          <div className="shrink-0 text-right">
            <div className="flex items-center justify-end gap-1">
              <span className="tabular text-2xl font-semibold leading-none text-foreground">
                {Math.round(opportunity.priorityScore)}
              </span>
              <TooltipInfo
                label="How the priority score is built"
                content="Priority combines the modelled impact, the effort to deliver it and the confidence in the evidence. Open the breakdown for the exact weights."
              />
            </div>
            <p className="mt-1 text-2xs uppercase tracking-wide text-muted-foreground">Priority</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-6 px-1.5 text-2xs"
              aria-expanded={showScore}
              aria-controls={scorePanelId}
              onClick={() => setShowScore((open) => !open)}
            >
              <ChevronDown
                className={cn('size-3 transition-transform', showScore && 'rotate-180')}
                aria-hidden="true"
              />
              {showScore ? 'Hide' : 'Why this score'}
            </Button>
          </div>
        </div>

        {/* Score breakdown */}
        <div id={scorePanelId} hidden={!showScore}>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            {opportunity.priority ? (
              <ScoreBreakdown
                score={opportunity.priority}
                title="Priority"
                sort="opportunity"
                ringSize="md"
              />
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  This opportunity was recorded without a factor breakdown. These are the three inputs the
                  discovery pass stored:
                </p>
                <dl className="grid grid-cols-3 gap-3">
                  <RawScore label="Impact" value={opportunity.impactScore} />
                  <RawScore label="Effort" value={opportunity.effortScore} />
                  <RawScore label="Confidence" value={opportunity.confidenceScore} />
                </dl>
              </div>
            )}
          </div>
        </div>

        {/* The judgement */}
        {!meta.createsPage && matchedUrl ? (
          <div className="rounded-md border border-info/25 bg-info/[0.07] p-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-semibold text-foreground">
                  No new page — this is already covered
                </p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {evidence.pagesEvaluated === null
                    ? 'An existing page on this site already targets the query'
                    : `${formatNumber(evidence.pagesEvaluated)} existing pages were compared and one already targets the query`}
                  {matchSimilarity !== null && <> at {formatPercent(matchSimilarity, 0)} semantic match</>}. Publishing a
                  second URL would split the signal instead of adding reach.
                </p>
                <Link
                  href={`/sites/${websiteId}/pages?search=${encodeURIComponent(matchedUrl)}`}
                  className="inline-flex max-w-full items-center gap-1 truncate font-mono text-2xs font-medium text-primary hover:underline"
                >
                  {shortenUrl(matchedUrl, 60)}
                </Link>
              </div>
            </div>
          </div>
        ) : meta.createsPage ? (
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <div className="flex items-start gap-2">
              <FileSearch className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {evidence.pagesEvaluated === null
                  ? 'Existing pages were compared first'
                  : `${formatNumber(evidence.pagesEvaluated)} existing pages were compared first`}{' '}
                and none of them plausibly answers this query
                {matchSimilarity !== null && (
                  <> — the closest was only {formatPercent(matchSimilarity, 0)} semantic match</>
                )}
                , so a new page is warranted.
                {opportunity.suggestedUrl && (
                  <>
                    {' '}
                    Suggested URL{' '}
                    <span className="font-mono text-foreground">{opportunity.suggestedUrl}</span>.
                  </>
                )}
              </p>
            </div>
          </div>
        ) : null}

        {/* Reasoning */}
        <p className="text-sm leading-relaxed text-muted-foreground">{opportunity.reasoning}</p>

        {/* Evidence */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 sm:grid-cols-3 lg:grid-cols-5">
          <Evidence
            label="Impressions"
            value={evidence.impressions === null ? null : formatCompact(evidence.impressions)}
            hint="Search Console impressions for this query over the analysis window."
          />
          <Evidence
            label="Current position"
            value={evidence.currentPosition === null ? null : formatPosition(evidence.currentPosition)}
            hint="Average position for this query today. Lower is better."
          />
          <Evidence
            label="Cannibalisation"
            value={
              opportunity.cannibalizationChecked
                ? opportunity.cannibalizationRisk === null
                  ? 'Checked'
                  : formatPercent(opportunity.cannibalizationRisk, 0)
                : null
            }
            hint="How likely another URL on this site already competes for the query. Not checked means the pass had no Search Console data to check it against."
            tone={
              opportunity.cannibalizationRisk !== null && opportunity.cannibalizationRisk >= 0.6
                ? 'destructive'
                : undefined
            }
          />
          <Evidence
            label="Est. traffic gain"
            value={
              opportunity.estimatedTrafficGain === null
                ? null
                : `+${formatCompact(opportunity.estimatedTrafficGain)}/mo`
            }
            hint="Modelled additional clicks per month if the work lands the target position. An estimate, not a promise."
            icon={TrendingUp}
          />
          <Evidence
            label="Found"
            value={formatDate(opportunity.discoveredAt)}
            hint="When the discovery pass raised this opportunity."
          />
        </dl>

        {/* Competing URLs */}
        {evidence.cannibalizingUrls.length > 0 && (
          <div className="rounded-md border border-destructive/25 bg-destructive/[0.06] p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <GitMerge className="size-3.5 text-destructive" aria-hidden="true" />
              {evidence.cannibalizingUrls.length} URLs already compete for this query
            </p>
            <ul className="mt-1.5 space-y-0.5">
              {evidence.cannibalizingUrls.slice(0, 5).map((url) => (
                <li key={url} className="truncate font-mono text-2xs text-muted-foreground">
                  {shortenUrl(url, 70)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Candidates considered */}
        {evidence.candidates.length > 0 && (
          <details className="group rounded-md border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
              {evidence.candidates.length} existing pages were considered
            </summary>
            <ul className="space-y-2 border-t border-border px-3 py-2">
              {evidence.candidates.map((candidate) => (
                <li key={candidate.url} className="space-y-0.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <Link
                      href={`/sites/${websiteId}/pages?search=${encodeURIComponent(candidate.url)}`}
                      className="truncate font-mono text-2xs text-primary hover:underline"
                    >
                      {shortenUrl(candidate.url, 56)}
                    </Link>
                    {candidate.similarity !== null && (
                      <span className="tabular shrink-0 text-2xs text-muted-foreground">
                        {formatPercent(candidate.similarity, 0)} match
                      </span>
                    )}
                  </div>
                  {candidate.reason && (
                    <p className="text-2xs leading-relaxed text-muted-foreground">{candidate.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        {/* Rejection memory */}
        {evidence.rejectionReason && (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Rejected{evidence.rejectedAt ? ` ${formatDate(evidence.rejectedAt)}` : ''}:</span>{' '}
            {evidence.rejectionReason}
          </p>
        )}
        {evidence.acceptanceNote && (
          <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Note on accepting:</span> {evidence.acceptanceNote}
          </p>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button size="sm" disabled={decided} onClick={() => setAcceptOpen(true)}>
            <ThumbsUp aria-hidden="true" />
            Accept
          </Button>
          <Button size="sm" variant="outline" disabled={decided} onClick={() => setRejectOpen(true)}>
            <ThumbsDown aria-hidden="true" />
            Reject
          </Button>
          {matchedUrl && (
            <>
              <Button asChild size="sm" variant="ghost">
                <Link href={`/sites/${websiteId}/pages?search=${encodeURIComponent(matchedUrl)}`}>
                  <Eye aria-hidden="true" />
                  Open matched page
                </Link>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <a href={matchedUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink aria-hidden="true" />
                  <span className="sr-only">Open </span>Live
                </a>
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Accept */}
      <Dialog open={acceptOpen} onOpenChange={setAcceptOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Accept this opportunity</DialogTitle>
            <DialogDescription>{opportunity.title}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
              <div className="min-w-0 space-y-0.5">
                {/*
                  A Radix Switch renders a <button role="switch">, which `<label for>` does not
                  associate with in every browser — so the name and description are wired up by id.
                */}
                <span id={`brief-label-${opportunity.id}`} className="text-sm font-medium text-foreground">
                  Create a content brief now
                </span>
                <p id={`brief-hint-${opportunity.id}`} className="text-xs leading-relaxed text-muted-foreground">
                  The brief starts as a skeleton carrying only the facts this opportunity established.
                  The outline, questions and competitor analysis are produced later by the BRIEF pipeline
                  stage, which is where the model spend happens.
                </p>
              </div>
              <Switch
                checked={createBrief}
                onCheckedChange={setCreateBrief}
                aria-labelledby={`brief-label-${opportunity.id}`}
                aria-describedby={`brief-hint-${opportunity.id}`}
              />
            </div>

            <FormField
              label="Note (optional)"
              description="Stored alongside the evidence so the reasoning survives the handover."
            >
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                maxLength={1000}
                placeholder="Anything the writer should know…"
              />
            </FormField>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAcceptOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={() => void accept()} loading={pending} loadingText="Accepting">
              {createBrief ? 'Accept and create brief' : 'Accept'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this opportunity</DialogTitle>
            <DialogDescription>{opportunity.title}</DialogDescription>
          </DialogHeader>

          <FormField
            label="Why are you rejecting it?"
            description="The reason is written to the opportunity record. The next discovery pass reads it and stops re-proposing the same work."
          >
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              maxLength={1000}
              placeholder="e.g. off-strategy for this quarter; the query is served by our docs site"
            />
          </FormField>

          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => void reject()}
              loading={pending}
              loadingText="Rejecting"
            >
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function RawScore({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="tabular text-sm font-semibold text-foreground">{value.toFixed(2)}</dd>
    </div>
  );
}

function Evidence({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | null;
  hint: string;
  icon?: LucideIcon;
  tone?: 'destructive';
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-2xs uppercase tracking-wide text-muted-foreground">
        {label}
        <TooltipInfo label={`What "${label}" means`} content={hint} />
      </dt>
      <dd
        className={cn(
          'tabular flex items-center gap-1 text-sm font-medium',
          value === null ? 'text-muted-foreground' : 'text-foreground',
          tone === 'destructive' && 'text-destructive',
        )}
      >
        {Icon && value !== null ? <Icon className="size-3.5" aria-hidden /> : null}
        {value ?? 'Not measured'}
      </dd>
    </div>
  );
}
