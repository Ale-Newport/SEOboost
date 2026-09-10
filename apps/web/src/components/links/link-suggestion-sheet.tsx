'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, Check, ExternalLink, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ProgressBar } from '@/components/ui/progress-bar';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber, shortenUrl } from '@/lib/utils';
import { splitOnAnchor } from './graph-utils';
import type { LinkSuggestion } from './types';

export const RELEVANCE_EXPLANATION =
  'How closely the two pages are about the same thing, from the embedding (or lexical) similarity of ' +
  'their text. Below roughly 28 the suggester will not propose a link at all.';

export const IMPACT_EXPLANATION =
  'How much this target stands to gain, from how starved of inbound internal links it is today. An ' +
  'orphan gains far more from its first link than a hub gains from its ninth.';

interface LinkSuggestionSheetProps {
  suggestion: LinkSuggestion | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful approve/reject so the list can refetch. */
  onDecided: () => void;
  /** A CMS adapter that can write the link is connected. */
  canApply: boolean;
  adapterLabel: string | null;
}

export function LinkSuggestionSheet({
  suggestion,
  open,
  onOpenChange,
  onDecided,
  canApply,
  adapterLabel,
}: LinkSuggestionSheetProps): React.JSX.Element {
  const [anchor, setAnchor] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<'approve' | 'reject' | null>(null);

  // Each suggestion opens with its own anchor, never the previous row's edit.
  useEffect(() => {
    setAnchor(suggestion?.anchorText ?? '');
    setReason('');
    setPending(null);
  }, [suggestion]);

  const decided = suggestion !== null && suggestion.status !== 'PENDING';
  const applied = suggestion?.status === 'APPLIED';

  async function decide(kind: 'approve' | 'reject'): Promise<void> {
    if (!suggestion) return;
    setPending(kind);
    try {
      if (kind === 'approve') {
        const trimmed = anchor.trim();
        await apiPost(
          `/api/links/${suggestion.id}/approve`,
          trimmed.length > 0 && trimmed !== suggestion.anchorText ? { anchorText: trimmed } : {},
        );
        toast.success('Suggestion approved', {
          description: canApply
            ? `Use “Apply approved” to write it through ${adapterLabel ?? 'the connected CMS'}.`
            : 'No CMS is connected, so it is recorded for manual placement.',
        });
      } else {
        const trimmed = reason.trim();
        await apiPost(
          `/api/links/${suggestion.id}/reject`,
          trimmed.length > 0 ? { reason: trimmed } : {},
        );
        toast.success('Suggestion rejected', {
          description: 'The suggester reads rejections back, so this pair will not be proposed again.',
        });
      }
      onDecided();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The decision could not be saved.');
    } finally {
      setPending(null);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        {suggestion === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle>Internal link suggestion</SheetTitle>
              <SheetDescription>
                Link <span className="font-medium text-foreground">{shortenUrl(suggestion.sourcePage.url, 34)}</span>{' '}
                to <span className="font-medium text-foreground">{shortenUrl(suggestion.targetPage.url, 34)}</span>.
              </SheetDescription>
            </SheetHeader>

            <SheetBody className="space-y-5 py-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={suggestion.status} />
                {suggestion.targetPage.isOrphan ? (
                  <Badge variant="destructive">Target is an orphan</Badge>
                ) : null}
              </div>

              <PagePair suggestion={suggestion} />

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Where it goes
                </h3>
                {suggestion.contextSnippet ? (
                  <blockquote className="rounded-md border border-border bg-muted/40 p-3 text-sm leading-relaxed text-foreground">
                    {splitOnAnchor(suggestion.contextSnippet, suggestion.anchorText).map((part, index) =>
                      part.match ? (
                        <mark
                          key={index}
                          className="rounded-sm bg-primary/15 px-0.5 font-medium text-foreground underline decoration-primary decoration-2 underline-offset-2"
                        >
                          {part.text}
                        </mark>
                      ) : (
                        <span key={index}>{part.text}</span>
                      ),
                    )}
                  </blockquote>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No placement sentence was captured for this suggestion, so the anchor has to be placed by
                    hand after reading the source page.
                  </p>
                )}
                {suggestion.placementHint ? (
                  <p className="text-xs text-muted-foreground">{suggestion.placementHint}</p>
                ) : null}
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Why this pair
                </h3>
                <p className="text-sm leading-relaxed text-foreground">{suggestion.reason}</p>
              </section>

              <section className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scores</h3>
                <ProgressBar
                  label={
                    <span className="inline-flex items-center gap-1">
                      Relevance
                      <TooltipInfo content={RELEVANCE_EXPLANATION} label="How relevance is calculated" />
                    </span>
                  }
                  value={Math.round(suggestion.relevanceScore * 100)}
                  max={100}
                  tone="info"
                  showValue
                  formatValue={(value) => `${value} / 100`}
                  ariaLabel={`Relevance ${Math.round(suggestion.relevanceScore * 100)} out of 100`}
                />
                <ProgressBar
                  label={
                    <span className="inline-flex items-center gap-1">
                      Impact
                      <TooltipInfo content={IMPACT_EXPLANATION} label="How impact is calculated" />
                    </span>
                  }
                  value={Math.round(suggestion.impactScore * 100)}
                  max={100}
                  tone="primary"
                  showValue
                  formatValue={(value) => `${value} / 100`}
                  ariaLabel={`Impact ${Math.round(suggestion.impactScore * 100)} out of 100`}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  The target has {formatNumber(suggestion.targetPage.internalLinksIn)} inbound internal link
                  {suggestion.targetPage.internalLinksIn === 1 ? '' : 's'} today and{' '}
                  {formatNumber(suggestion.targetPage.clicks28d)} click
                  {suggestion.targetPage.clicks28d === 1 ? '' : 's'} in the last 28 days.
                </p>
              </section>

              {suggestion.rejectedReason ? (
                <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  Rejected: {suggestion.rejectedReason}
                </p>
              ) : null}

              {applied ? null : (
                <section className="space-y-3">
                  <FormField
                    label="Anchor text"
                    description="Edit before approving if the phrasing does not read naturally in the sentence above."
                  >
                    <Input
                      value={anchor}
                      onChange={(event) => setAnchor(event.target.value)}
                      maxLength={300}
                      placeholder={suggestion.anchorText}
                    />
                  </FormField>
                  <FormField
                    label="Rejection reason"
                    description="Optional. Stored on the row and fed back to the suggester."
                  >
                    <Textarea
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={2}
                      maxLength={500}
                      placeholder="e.g. the target page is being consolidated"
                    />
                  </FormField>
                </section>
              )}
            </SheetBody>

            <SheetFooter>
              {applied ? (
                <p className="text-sm text-muted-foreground">
                  This link has already been applied and can no longer be changed here.
                </p>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => void decide('reject')}
                    loading={pending === 'reject'}
                    loadingText="Rejecting"
                    disabled={pending !== null}
                  >
                    <X className="size-4" aria-hidden="true" />
                    Reject
                  </Button>
                  <Button
                    onClick={() => void decide('approve')}
                    loading={pending === 'approve'}
                    loadingText="Approving"
                    disabled={pending !== null}
                  >
                    <Check className="size-4" aria-hidden="true" />
                    {decided ? 'Re-approve' : 'Approve'}
                  </Button>
                </>
              )}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function PagePair({ suggestion }: { suggestion: LinkSuggestion }): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <PageLine
        role="From"
        url={suggestion.sourcePage.url}
        title={suggestion.sourcePage.title}
        detail={`${formatNumber(suggestion.sourcePage.internalLinksOut)} outbound internal links`}
      />
      <div className="flex items-center gap-2 pl-1 text-muted-foreground">
        <ArrowDown className="size-3.5" aria-hidden="true" />
        <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {suggestion.anchorText}
        </code>
      </div>
      <PageLine
        role="To"
        url={suggestion.targetPage.url}
        title={suggestion.targetPage.title}
        detail={`${formatNumber(suggestion.targetPage.internalLinksIn)} inbound internal links`}
      />
    </div>
  );
}

function PageLine({
  role,
  url,
  title,
  detail,
}: {
  role: string;
  url: string;
  title: string | null;
  detail: string;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{role}</p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex max-w-full items-center gap-1 truncate text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
      >
        <span className="truncate">{title ?? shortenUrl(url, 46)}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
      </a>
      <p className="truncate font-mono text-2xs text-muted-foreground">{url}</p>
      <p className="text-2xs text-muted-foreground">{detail}</p>
    </div>
  );
}
