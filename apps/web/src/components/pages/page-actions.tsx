'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Link2, MoreHorizontal, RefreshCw, ScanLine, Type } from 'lucide-react';
import { toast } from 'sonner';
import { SEO_THRESHOLDS } from '@seo/shared';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition } from '@/lib/utils';
import type { MetaReview, PageQueryInsight } from '@/components/pages/types';
import type { PageProfile } from '@/server/queries/pages';

/**
 * The work this screen can start.
 *
 * Each button maps onto a real endpoint and says exactly what that endpoint does — the audit
 * re-runs against the *existing* crawl rather than re-fetching the URL, and the link analysis is
 * a site-wide pass ordered to reach this page first. Claiming either was page-scoped fetching
 * would make the result look broken when it is working correctly.
 */

type Opportunity = PageProfile['recommendations']['opportunities'][number];

export interface PageActionsProps {
  websiteId: string;
  pageId: string;
  meta: MetaReview;
  queries: PageQueryInsight[];
  opportunities: Opportunity[];
}

interface JobSummary {
  enqueued: boolean;
  message: string;
}

interface ActionResponse {
  message?: string;
  jobs?: JobSummary[];
  status?: string;
  reason?: string;
  fix?: string;
}

interface BriefResponse {
  brief: { id: string; title: string };
}

/** An opportunity nobody has closed out — the only kind a brief should be opened from. */
const OPEN_STATUSES = new Set(['IDENTIFIED', 'ACCEPTED', 'IN_PROGRESS']);

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}

/** Reports the enqueue honestly: a written row that no broker accepted is not a started job. */
function reportJobs(response: ActionResponse, title: string, description: string): void {
  if (response.status === 'skipped') {
    toast.warning('Nothing to run', { description: response.reason ?? description });
    return;
  }
  const jobs = response.jobs ?? [];
  if (jobs.length > 0 && jobs.every((job) => !job.enqueued)) {
    toast.warning('Queued, but no worker picked it up', {
      description: jobs[0]?.message ?? 'Start the worker (npm run dev:worker) or check REDIS_URL.',
    });
    return;
  }
  toast.success(title, { description: response.message ?? description });
}

export function PageActions({
  websiteId,
  pageId,
  meta,
  queries,
  opportunities,
}: PageActionsProps): React.JSX.Element {
  const router = useRouter();
  const { confirm, confirmDialog } = useConfirm();

  const [pending, setPending] = useState<'analyse' | 'links' | 'brief' | 'crawl' | null>(null);
  const [titleOpen, setTitleOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(meta.title.value ?? '');

  const briefTarget = useMemo(
    () => opportunities.find((row) => OPEN_STATUSES.has(row.status)) ?? null,
    [opportunities],
  );

  const underperforming = useMemo(() => queries.filter((row) => row.underperforms), [queries]);

  const run = useCallback(
    async (
      key: 'analyse' | 'links',
      action: 'analyse' | 'suggest-links',
      title: string,
      description: string,
    ) => {
      setPending(key);
      try {
        const response = await apiPost<ActionResponse>(
          `/api/websites/${websiteId}/pages/${pageId}/actions`,
          { action },
        );
        reportJobs(response, title, description);
        router.refresh();
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setPending(null);
      }
    },
    [pageId, router, websiteId],
  );

  const recrawlSite = useCallback(async () => {
    const ok = await confirm({
      title: 'Re-crawl the whole site?',
      description:
        'Fetching fresh HTML for one URL is not possible on its own — the link graph every other screen reads is built from a single crawl snapshot, so the crawl covers the site. It runs in the background and this page updates when it finishes.',
      confirmLabel: 'Start the crawl',
    });
    if (!ok) return;

    setPending('crawl');
    try {
      const response = await apiPost<{ message?: string; enqueued?: boolean }>(
        `/api/websites/${websiteId}/crawl`,
        {},
      );
      if (response.enqueued === false) {
        toast.warning('Crawl recorded, but no worker picked it up', {
          description: 'Start the worker (npm run dev:worker) or check REDIS_URL.',
        });
      } else {
        toast.success('Crawl started', {
          description: response.message ?? 'Fresh HTML, headings and links for every page on this site.',
        });
      }
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(null);
    }
  }, [confirm, router, websiteId]);

  const generateBrief = useCallback(async () => {
    if (!briefTarget) return;
    setPending('brief');
    try {
      const response = await apiPost<BriefResponse>('/api/content/briefs', {
        opportunityId: briefTarget.id,
      });
      toast.success('Brief created', {
        description: `“${response.brief.title}” is in the content pipeline. The outline and questions are filled in by the BRIEF stage.`,
      });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(null);
    }
  }, [briefTarget, router]);

  const titleLength = draftTitle.trim().length;
  const titleTone =
    titleLength === 0
      ? 'text-destructive'
      : titleLength < SEO_THRESHOLDS.title.min || titleLength > SEO_THRESHOLDS.title.max
        ? 'text-warning'
        : 'text-success';

  return (
    <>
      <Button
        size="sm"
        onClick={() =>
          void run(
            'analyse',
            'analyse',
            'Re-analysing this page',
            'The audit and the page scores are re-running against the latest crawl.',
          )
        }
        loading={pending === 'analyse'}
        loadingText="Queueing the re-analysis"
      >
        <ScanLine aria-hidden="true" />
        Re-analyse
      </Button>

      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setDraftTitle(meta.title.value ?? '');
          setTitleOpen(true);
        }}
      >
        <Type aria-hidden="true" />
        Optimise title
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="More actions for this page">
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel>This page</DropdownMenuLabel>

          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void run(
                'links',
                'suggest-links',
                'Looking for internal links',
                'The link agent reads every crawled page to find sentences an anchor could live in, starting with the pages that need links most.',
              );
            }}
            disabled={pending !== null}
          >
            <Link2 aria-hidden="true" />
            <span className="flex flex-col gap-0.5">
              <span>Suggest internal links</span>
              <span className="text-2xs text-muted-foreground">Finds pages that should link here</span>
            </span>
          </DropdownMenuItem>

          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void generateBrief();
            }}
            disabled={pending !== null || briefTarget === null}
          >
            <FileText aria-hidden="true" />
            <span className="flex flex-col gap-0.5">
              <span>Generate a content brief</span>
              <span className="text-2xs text-muted-foreground">
                {briefTarget === null
                  ? 'Needs a content opportunity — run the content strategy agent'
                  : `From “${briefTarget.title}”`}
              </span>
            </span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuLabel>This site</DropdownMenuLabel>

          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              void recrawlSite();
            }}
            disabled={pending !== null}
          >
            <RefreshCw aria-hidden="true" />
            <span className="flex flex-col gap-0.5">
              <span>Re-crawl the site</span>
              <span className="text-2xs text-muted-foreground">
                The only way to re-fetch this page&rsquo;s HTML
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={titleOpen} onOpenChange={setTitleOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Optimise the title</DialogTitle>
            <DialogDescription>
              Draft it against this page&rsquo;s own Search Console record. Nothing is written to your site
              from here — copy the result into your CMS, then re-crawl so the change is picked up.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="page-title-draft">Title tag</Label>
                <span className={cn('tabular text-xs font-medium', titleTone)}>
                  {titleLength} / {SEO_THRESHOLDS.title.min}–{SEO_THRESHOLDS.title.max} characters
                </span>
              </div>
              <Textarea
                id="page-title-draft"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                rows={2}
                placeholder="No title tag on this page yet"
                aria-describedby="page-title-help"
              />
              <p id="page-title-help" className="text-2xs leading-relaxed text-muted-foreground">
                Search results truncate past {SEO_THRESHOLDS.title.hardMax} characters. Below{' '}
                {SEO_THRESHOLDS.title.min} the slot is wasted.
              </p>
            </div>

            <section className="space-y-1.5">
              <h4 className="text-xs font-semibold text-foreground">
                Queries this URL earns impressions for that the title does not contain
              </h4>
              {meta.missingFromTitle.length === 0 ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Every query with impressions in the last 28 days already appears in the title — or Search
                  Console has recorded no queries for this URL yet.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {meta.missingFromTitle.map((row) => (
                    <li key={row.query} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <span className="min-w-0 flex-1 text-xs text-foreground">{row.query}</span>
                      <span className="tabular text-2xs text-muted-foreground">
                        {formatCompact(row.impressions)} impressions
                      </span>
                      <span className="tabular text-2xs text-muted-foreground">
                        position {formatPosition(row.position)}
                      </span>
                      <CopyButton value={row.query} label={`Copy the query ${row.query}`} className="-my-1" />
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {underperforming.length > 0 ? (
              <section className="space-y-1.5">
                <h4 className="flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground">
                  Under-earning their position
                  <Badge variant="warning">{formatNumber(underperforming.length)}</Badge>
                </h4>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {underperforming.slice(0, 5).map((row) => (
                    <li key={row.query} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <span className="min-w-0 flex-1 text-xs text-foreground">{row.query}</span>
                      <span className="tabular text-2xs text-muted-foreground">
                        {formatPercent(row.ctr, 2)} vs {formatPercent(row.expectedCtr, 2)} expected
                      </span>
                      <span className="tabular text-2xs font-medium text-warning">
                        +{formatNumber(row.potentialClicks)} clicks if closed
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  A rank that earns less than the CTR curve predicts is a snippet problem, not a ranking one —
                  which is exactly what a title rewrite fixes.
                </p>
              </section>
            ) : null}
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setTitleOpen(false)}>
              Close
            </Button>
            <CopyButton
              value={draftTitle.trim()}
              label="Copy title"
              copiedLabel="Copied"
              showLabel
              variant="default"
              size="sm"
              disabled={draftTitle.trim() === ''}
            />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {confirmDialog}
    </>
  );
}
