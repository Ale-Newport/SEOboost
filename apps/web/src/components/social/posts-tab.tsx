'use client';

import { useCallback, useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock, CheckCircle2, ExternalLink, Hand, Megaphone, PenLine, Plus, RotateCcw, ShieldCheck, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Section, SectionDescription, SectionHeader, SectionTitle } from '@/components/ui/section';
import { toast } from '@/components/ui/toast';
import { apiPost } from '@/lib/api-client';
import { reportApiError, reportJobResult, type JobResponse } from '@/lib/job-feedback';
import { formatNumber } from '@/lib/utils';
import { PlatformBadge, PostStatusBadge } from './badges';
import { METRIC_LABEL, formatDateTime, relativeTime } from './format';
import type { PostStatusValue, SocialOverview, SocialPostRow } from './types';

/**
 * Everything the platform will publish, has published, or needs a human to post.
 *
 * Grouped by what the operator has to do next rather than by date: approve, post by hand, fix a
 * failure — then what is simply waiting for its slot, then the record of what went out.
 */

interface Group {
  id: string;
  title: string;
  description: string;
  statuses: PostStatusValue[];
}

const GROUPS: Group[] = [
  {
    id: 'approval',
    title: 'Awaiting approval',
    description: 'Drafted by the agents. Review, edit and decide in Approvals — replies in other communities always stop here.',
    statuses: ['AWAITING_APPROVAL', 'DRAFT'],
  },
  {
    id: 'manual',
    title: 'Post by hand',
    description: 'Approved, but the platform has no posting API or no account is connected. Post it yourself, then mark it as published.',
    statuses: ['MANUAL_PENDING'],
  },
  {
    id: 'failed',
    title: 'Failed or held back',
    description: 'A publish failed, or the guardrails refused it at publish time. Check the platform before retrying — a failed call may still have posted.',
    statuses: ['FAILED'],
  },
  {
    id: 'scheduled',
    title: 'Scheduled',
    description: 'Approved and waiting for their slot. Caps, cooldowns and community rules are checked again when each goes out.',
    statuses: ['SCHEDULED', 'APPROVED', 'PUBLISHING'],
  },
  {
    id: 'published',
    title: 'Published',
    description: 'What went out, with the engagement the platform reported back.',
    statuses: ['PUBLISHED'],
  },
  {
    id: 'closed',
    title: 'Rejected or cancelled',
    description: 'Kept for the record. Nothing here will be published.',
    statuses: ['REJECTED', 'CANCELLED'],
  },
];

export function PostsTab({
  data,
  onNewPost,
  onEdit,
}: {
  data: SocialOverview;
  onNewPost: () => void;
  onEdit: (post: SocialPostRow) => void;
}): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const [busy, setBusy] = useState<string | null>(null);
  const [marking, setMarking] = useState<SocialPostRow | null>(null);
  const [externalUrl, setExternalUrl] = useState('');
  const [cancelling, setCancelling] = useState<SocialPostRow | null>(null);

  const retry = useCallback(
    async (post: SocialPostRow) => {
      setBusy(`${post.id}:retry`);
      try {
        const result = await apiPost<JobResponse>(`/api/social/posts/${post.id}/retry`, {});
        if (reportJobResult(result, 'Queued again — guardrails are re-checked first')) router.refresh();
      } catch (error) {
        reportApiError(error, 'Could not retry the post.');
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  async function markPublished(): Promise<void> {
    if (!marking) return;
    setBusy(`${marking.id}:published`);
    try {
      await apiPost(`/api/social/posts/${marking.id}/published`, { externalUrl: externalUrl.trim() || null });
      toast.success('Marked as published');
      setMarking(null);
      setExternalUrl('');
      router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not mark the post as published.');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(): Promise<void> {
    if (!cancelling) return;
    try {
      await apiPost(`/api/social/posts/${cancelling.id}/cancel`, {});
      toast.success('Post cancelled');
      router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not cancel the post.');
    } finally {
      setCancelling(null);
    }
  }

  const groups = GROUPS.map((group) => ({ ...group, posts: data.posts.filter((post) => group.statuses.includes(post.status)) })).filter(
    (group) => group.posts.length > 0,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Posting only ever uses the official API of an account you connected yourself. Platforms without an API are
          prepared for you to post by hand — never automated through a browser.
        </p>
        <Button size="sm" onClick={onNewPost}>
          <Plus aria-hidden="true" />
          New post
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          bordered
          icon={Megaphone}
          title="No posts yet"
          description={
            data.accounts.some((account) => account.status === 'CONNECTED')
              ? 'Run "Plan today’s posts" to have the agent pick a page and draft a post for each connected account, or write one yourself.'
              : 'Connect an account under Accounts so the daily-post agent has somewhere to publish — or write a post for a hand-posted platform like Hacker News.'
          }
          action={
            <Button size="sm" variant="outline" onClick={onNewPost}>
              <Plus aria-hidden="true" />
              Write a post
            </Button>
          }
        />
      ) : (
        groups.map((group) => (
          <Section key={group.id}>
            <SectionHeader>
              <SectionTitle>
                {group.title} <span className="font-normal text-muted-foreground">({group.posts.length})</span>
              </SectionTitle>
              <SectionDescription>{group.description}</SectionDescription>
            </SectionHeader>
            <ul className="space-y-3">
              {group.posts.map((post) => {
                const editable = ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'SCHEDULED', 'FAILED', 'MANUAL_PENDING'].includes(post.status);
                const metrics = Object.entries(post.metrics).filter(
                  (entry): entry is [string, number] => typeof entry[1] === 'number',
                );
                return (
                  <li key={post.id}>
                    <Card>
                      <CardContent className="space-y-3 p-4">
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <PlatformBadge platform={post.platform} />
                          <Badge variant="outline" className="font-normal">
                            {post.kind === 'REPLY' ? 'Reply' : 'Post'}
                          </Badge>
                          <PostStatusBadge status={post.status} />
                          {post.accountHandle ? <span>{post.accountHandle}</span> : null}
                          {post.community ? <span>· {post.community}</span> : null}
                          {post.scheduledFor && post.status !== 'PUBLISHED' ? (
                            <span className="inline-flex items-center gap-1">
                              · <CalendarClock aria-hidden="true" className="size-3" /> {formatDateTime(post.scheduledFor)}
                            </span>
                          ) : null}
                          {post.publishedAt ? <span>· published {relativeTime(post.publishedAt)}</span> : null}
                          {post.generatedBy ? (
                            <span>· {post.generatedBy === 'operator' ? 'written by you' : `by ${post.generatedBy.replace(/Agent$/, '')}`}</span>
                          ) : null}
                        </div>

                        {post.conversation ? (
                          <p className="text-xs text-muted-foreground">
                            In reply to{' '}
                            <a href={post.conversation.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                              {post.conversation.title ?? post.conversation.url}
                            </a>
                          </p>
                        ) : null}

                        {post.title ? <p className="text-sm font-semibold text-foreground">{post.title}</p> : null}
                        <p className="whitespace-pre-line break-words text-sm leading-relaxed text-foreground">{post.body}</p>

                        {post.error ? (
                          <p className="rounded-md border border-destructive/30 bg-destructive/[0.07] p-2 text-xs text-destructive">{post.error}</p>
                        ) : null}

                        {metrics.length > 0 ? (
                          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                            {metrics.map(([key, value]) => (
                              <span key={key}>
                                <span className="font-semibold tabular-nums text-foreground">{formatNumber(value)}</span>{' '}
                                {METRIC_LABEL[key] ?? key}
                              </span>
                            ))}
                            {post.metrics.live === false ? <Badge variant="destructive">Removed on the platform</Badge> : null}
                            {post.metricsCheckedAt ? <span>· checked {relativeTime(post.metricsCheckedAt)}</span> : null}
                          </div>
                        ) : null}

                        <div className="flex flex-wrap items-center gap-2">
                          {post.status === 'AWAITING_APPROVAL' ? (
                            <Button asChild size="sm">
                              <Link href="/approvals">
                                <ShieldCheck aria-hidden="true" />
                                Review in Approvals
                              </Link>
                            </Button>
                          ) : null}
                          {post.manualPostUrl && post.status !== 'PUBLISHED' ? (
                            <Button asChild size="sm" variant={post.status === 'MANUAL_PENDING' ? 'default' : 'outline'}>
                              <a href={post.manualPostUrl} target="_blank" rel="noopener noreferrer">
                                <Hand aria-hidden="true" />
                                {post.kind === 'REPLY' ? 'Open the thread' : 'Open composer'}
                              </a>
                            </Button>
                          ) : null}
                          {post.status === 'MANUAL_PENDING' || post.status === 'FAILED' ? (
                            <CopyButton value={post.title ? `${post.title}\n\n${post.body}` : post.body} label="Copy text" showLabel size="sm" variant="outline" />
                          ) : null}
                          {post.status === 'MANUAL_PENDING' || post.status === 'FAILED' ? (
                            <Button size="sm" variant="outline" onClick={() => setMarking(post)}>
                              <CheckCircle2 aria-hidden="true" />
                              Mark as published
                            </Button>
                          ) : null}
                          {post.status === 'FAILED' || post.status === 'MANUAL_PENDING' ? (
                            <Button
                              size="sm"
                              variant="outline"
                              loading={busy === `${post.id}:retry`}
                              loadingText="Queueing"
                              onClick={() => void retry(post)}
                            >
                              <RotateCcw aria-hidden="true" />
                              {post.status === 'FAILED' ? 'Retry' : 'Try the API again'}
                            </Button>
                          ) : null}
                          {editable ? (
                            <Button size="sm" variant="ghost" onClick={() => onEdit(post)}>
                              <PenLine aria-hidden="true" />
                              Edit
                            </Button>
                          ) : null}
                          {editable ? (
                            <Button size="sm" variant="ghost" onClick={() => setCancelling(post)}>
                              <XCircle aria-hidden="true" />
                              Cancel
                            </Button>
                          ) : null}
                          {post.externalUrl ? (
                            <Button asChild size="sm" variant="link" className="ml-auto">
                              <a href={post.externalUrl} target="_blank" rel="noopener noreferrer">
                                View on {post.platform === 'HACKER_NEWS' ? 'HN' : 'platform'}
                                <ExternalLink aria-hidden="true" />
                              </a>
                            </Button>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          </Section>
        ))
      )}

      <Dialog
        open={marking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMarking(null);
            setExternalUrl('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark as published</DialogTitle>
            <DialogDescription>
              Paste the link to the live post so engagement can be followed and the history points at the real thing.
              The thread it answers is marked as replied.
            </DialogDescription>
          </DialogHeader>
          <FormField label="Link to the post" htmlFor={`${ids}-external`} description="Optional, but strongly recommended.">
            <Input
              id={`${ids}-external`}
              type="url"
              value={externalUrl}
              placeholder="https://"
              onChange={(event) => setExternalUrl(event.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMarking(null)}>
              Cancel
            </Button>
            <Button
              loading={busy === `${marking?.id ?? ''}:published`}
              loadingText="Saving"
              onClick={() => void markPublished()}
            >
              Mark as published
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
        destructive
        title="Cancel this post?"
        description="It will not be published, and any pending approval for it is closed. A reply's thread goes back to the shortlist."
        confirmLabel="Cancel post"
        cancelLabel="Keep it"
        onConfirm={cancel}
      />
    </div>
  );
}
