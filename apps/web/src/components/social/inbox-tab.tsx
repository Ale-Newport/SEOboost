'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { ExternalLink, Inbox, MessageSquareReply, PenLine, RotateCcw, Sparkles, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { apiPost } from '@/lib/api-client';
import { reportApiError, reportJobResult, type JobResponse } from '@/lib/job-feedback';
import { cn, formatNumber } from '@/lib/utils';
import { ConversationStatusBadge, PlatformBadge, PolicyBadge, PostStatusBadge } from './badges';
import { APPROACH_LABEL, INTENT_LABEL, formatDateTime, relativeTime } from './format';
import {
  CONVERSATION_FILTERS,
  type ConversationFilter,
  type SocialConversationRow,
  type SocialOverview,
} from './types';

/**
 * The listening inbox: threads where the problem this site solves is being discussed, ranked by
 * the deterministic relevance score, with the model's triage (when there is one) beside it.
 *
 * Nothing here posts. "Draft reply" asks the reply agent for a draft that goes to Approvals;
 * "Write reply" opens the composer for the operator's own words. Both are subject to the same
 * guardrails at publish time.
 */

const FILTER_LABEL: Record<ConversationFilter, string> = {
  open: 'Open',
  replied: 'Replied',
  dismissed: 'Dismissed',
  expired: 'Expired',
  all: 'All',
};

function scoreTone(score: number): string {
  if (score >= 70) return 'text-success';
  if (score >= 45) return 'text-warning';
  return 'text-muted-foreground';
}

export function InboxTab({
  data,
  onWriteReply,
}: {
  data: SocialOverview;
  onWriteReply: (conversation: SocialConversationRow) => void;
}): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const [busy, setBusy] = useState<string | null>(null);
  const { conversations, conversationFilter, conversationFilterCounts, website, aiConfigured, topics } = data;

  const setFilter = useCallback(
    (filter: ConversationFilter) => {
      const params = new URLSearchParams({ tab: 'inbox' });
      if (filter !== 'open') params.set('filter', filter);
      router.push(`${pathname}?${params.toString()}`);
    },
    [pathname, router],
  );

  const act = useCallback(
    async (conversation: SocialConversationRow, op: 'dismiss' | 'restore' | 'draft') => {
      setBusy(`${conversation.id}:${op}`);
      try {
        if (op === 'draft') {
          const result = await apiPost<JobResponse>(`/api/social/conversations/${conversation.id}/draft`, {});
          if (reportJobResult(result, 'Drafting a reply — it will appear in Approvals')) router.refresh();
        } else {
          await apiPost(`/api/social/conversations/${conversation.id}/${op}`, {});
          router.refresh();
        }
      } catch (error) {
        reportApiError(error, 'That did not work. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filter conversations">
        {CONVERSATION_FILTERS.map((filter) => (
          <Button
            key={filter}
            size="sm"
            variant={filter === conversationFilter ? 'default' : 'outline'}
            aria-pressed={filter === conversationFilter}
            onClick={() => setFilter(filter)}
          >
            {FILTER_LABEL[filter]}
            <span className="tabular-nums opacity-70">{formatNumber(conversationFilterCounts[filter])}</span>
          </Button>
        ))}
      </div>

      {conversations.length === 0 ? (
        <EmptyState
          bordered
          icon={Inbox}
          title={
            topics.length === 0
              ? 'Nothing to listen for yet'
              : conversationFilter === 'open'
                ? 'No open conversations'
                : `No ${FILTER_LABEL[conversationFilter].toLowerCase()} conversations`
          }
          description={
            topics.length === 0
              ? 'Add a listening topic — a phrase your audience uses for the problem you solve — under Topics, or let "Suggest strategy" propose a set. Then run listening.'
              : conversationFilter === 'open'
                ? 'Run listening to search your topics now. Threads below the relevance threshold are dropped as noise, so an empty inbox can be the honest result.'
                : 'Try another filter.'
          }
          action={
            topics.length === 0 ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`${pathname}?tab=topics`}>Go to Topics</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-3">
          {conversations.map((conversation) => {
            const closed = ['REPLIED', 'DISMISSED', 'EXPIRED'].includes(conversation.status);
            const triage = conversation.triage;
            return (
              <li key={conversation.id}>
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <PlatformBadge platform={conversation.platform} />
                          {conversation.community ? <span className="font-medium text-foreground">{conversation.community}</span> : null}
                          {conversation.communityPolicy ? (
                            <PolicyBadge policy={conversation.communityPolicy} summary={conversation.communityRulesSummary} />
                          ) : null}
                          <ConversationStatusBadge status={conversation.status} />
                          <SimpleTooltip content={`Posted ${formatDateTime(conversation.publishedAt)}`}>
                            <span className="cursor-default">{relativeTime(conversation.publishedAt ?? conversation.discoveredAt)}</span>
                          </SimpleTooltip>
                          {conversation.commentCount !== null ? <span>· {formatNumber(conversation.commentCount)} comments</span> : null}
                          {conversation.score !== null ? <span>· score {formatNumber(conversation.score)}</span> : null}
                          {conversation.isLocked ? <Badge variant="muted">Locked</Badge> : null}
                        </div>
                        <a
                          href={conversation.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="group inline-flex items-start gap-1 text-sm font-semibold text-foreground hover:underline"
                        >
                          <span className="break-words">{conversation.title ?? conversation.body?.slice(0, 120) ?? conversation.url}</span>
                          <ExternalLink aria-hidden="true" className="mt-0.5 size-3 shrink-0 opacity-60 group-hover:opacity-100" />
                        </a>
                        {conversation.body && conversation.title ? (
                          <p className="line-clamp-3 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{conversation.body}</p>
                        ) : null}
                      </div>

                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="flex shrink-0 flex-col items-center rounded-md border border-border px-3 py-1.5 hover:bg-accent"
                            aria-label={`Relevance ${Math.round(conversation.relevanceScore)} out of 100 — show why`}
                          >
                            <span className={cn('text-lg font-semibold tabular-nums leading-none', scoreTone(conversation.relevanceScore))}>
                              {Math.round(conversation.relevanceScore)}
                            </span>
                            <span className="text-2xs text-muted-foreground">relevance</span>
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-[22rem] max-w-[calc(100vw-2rem)]">
                          {conversation.relevanceFactors.length ? (
                            <ScoreBreakdown
                              compact
                              ringSize="sm"
                              title="Relevance"
                              score={{
                                score: conversation.relevanceScore,
                                factors: conversation.relevanceFactors,
                                summary: conversation.relevanceSummary ?? '',
                              }}
                            />
                          ) : (
                            <p className="text-sm text-muted-foreground">No factor breakdown was stored for this thread.</p>
                          )}
                        </PopoverContent>
                      </Popover>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <Badge variant="secondary" className="font-normal">
                        {INTENT_LABEL[conversation.intent] ?? conversation.intent}
                      </Badge>
                      {conversation.topicName ? <span className="text-muted-foreground">Topic: {conversation.topicName}</span> : null}
                      {conversation.post ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          Our post: <PostStatusBadge status={conversation.post.status} />
                          {conversation.post.externalUrl ? (
                            <a href={conversation.post.externalUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              view
                            </a>
                          ) : null}
                        </span>
                      ) : null}
                    </div>

                    {triage && (triage.approach || triage.reason || triage.draftSkipReason) ? (
                      <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
                        {triage.approach ? (
                          <p className="font-medium text-foreground">
                            {APPROACH_LABEL[triage.approach] ?? triage.approach}
                            {triage.fit !== null ? <span className="font-normal text-muted-foreground"> · fit {Math.round(triage.fit * 100)}%</span> : null}
                          </p>
                        ) : null}
                        {triage.reason ? <p className="text-muted-foreground">{triage.reason}</p> : null}
                        {triage.angle ? <p className="mt-1 text-foreground">Angle: {triage.angle}</p> : null}
                        {triage.draftSkipReason ? (
                          <p className="mt-1 text-warning">Not drafted: {triage.draftSkipReason}</p>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                      {!closed ? (
                        <>
                          <SimpleTooltip
                            content={
                              aiConfigured
                                ? 'The reply agent drafts a disclosed, helpful answer within the guardrails. It lands in Approvals — nothing is posted.'
                                : 'No AI provider is configured. Write the reply yourself instead.'
                            }
                          >
                            <span className="inline-flex">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!aiConfigured || conversation.isLocked}
                                loading={busy === `${conversation.id}:draft`}
                                loadingText="Queueing"
                                onClick={() => void act(conversation, 'draft')}
                              >
                                <Sparkles aria-hidden="true" />
                                Draft reply
                              </Button>
                            </span>
                          </SimpleTooltip>
                          <Button size="sm" variant="outline" disabled={conversation.isLocked} onClick={() => onWriteReply(conversation)}>
                            <PenLine aria-hidden="true" />
                            Write reply
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={busy === `${conversation.id}:dismiss`}
                            loadingText="Dismissing"
                            onClick={() => void act(conversation, 'dismiss')}
                          >
                            <X aria-hidden="true" />
                            Dismiss
                          </Button>
                        </>
                      ) : conversation.status !== 'REPLIED' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === `${conversation.id}:restore`}
                          loadingText="Restoring"
                          onClick={() => void act(conversation, 'restore')}
                        >
                          <RotateCcw aria-hidden="true" />
                          Restore
                        </Button>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <MessageSquareReply aria-hidden="true" className="size-3.5" />
                          Answered
                        </span>
                      )}
                      <span className="ml-auto text-2xs text-muted-foreground">via {conversation.backend}</span>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {conversations.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          Relevance is computed without a model: topic fit, what the author asks for, freshness, engagement and the
          community&rsquo;s rules for {website.domain}. Triage, when shown, is the model&rsquo;s read of the same thread.
        </p>
      ) : null}
    </div>
  );
}
