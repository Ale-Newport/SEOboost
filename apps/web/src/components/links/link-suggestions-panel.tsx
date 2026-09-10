'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Link2, Loader2, Play, Rocket, X } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { FacetFilter } from '@/components/data/filter-bar';
import { ScoreCell } from '@/components/data/score-cell';
import { StatusCell } from '@/components/data/status-cell';
import { UrlCell } from '@/components/data/url-cell';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn, formatNumber, shortenUrl } from '@/lib/utils';
import {
  IMPACT_EXPLANATION,
  LinkSuggestionSheet,
  RELEVANCE_EXPLANATION,
} from './link-suggestion-sheet';
import type { EnqueueSummaryDto, LinkSuggestion, LinksResponse, SkippedDto } from './types';

const STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'APPLIED', label: 'Applied' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'FAILED', label: 'Failed' },
] as const;

/** Bounded fan-out: a bulk decision on 200 rows must not open 200 sockets at once. */
const BULK_CONCURRENCY = 6;

interface ApplyResponse extends SkippedDto {
  queued?: number;
  suggestionIds?: string[];
  skippedSuggestions?: Array<{ id: string; reason: string }>;
  job?: EnqueueSummaryDto;
}

interface LinkSuggestionsPanelProps {
  websiteId: string;
  suggestions: LinksResponse['suggestions'] | null;
  loading: boolean;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRefresh: () => void;
  /** A connected adapter can write the link into the page; otherwise approval is a record only. */
  canApply: boolean;
  adapterLabel: string | null;
  hasCrawl: boolean;
  onRunAnalysis: () => void;
  analysisRunning: boolean;
}

export function LinkSuggestionsPanel({
  websiteId,
  suggestions,
  loading,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  onRefresh,
  canApply,
  adapterLabel,
  hasCrawl,
  onRunAnalysis,
  analysisRunning,
}: LinkSuggestionsPanelProps): React.JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [openRow, setOpenRow] = useState<LinkSuggestion | null>(null);
  const [bulkPending, setBulkPending] = useState<'approve' | 'reject' | null>(null);
  const [applying, setApplying] = useState(false);

  const items = suggestions?.items ?? [];
  const approvedCount = suggestions?.byStatus.APPROVED ?? 0;

  const decide = useCallback(
    async (id: string, kind: 'approve' | 'reject'): Promise<void> => {
      await apiPost(`/api/links/${id}/${kind}`, {});
    },
    [],
  );

  const decideOne = useCallback(
    async (row: LinkSuggestion, kind: 'approve' | 'reject'): Promise<void> => {
      try {
        await decide(row.id, kind);
        toast.success(kind === 'approve' ? 'Suggestion approved' : 'Suggestion rejected');
        onRefresh();
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'The decision could not be saved.');
      }
    },
    [decide, onRefresh],
  );

  const decideMany = useCallback(
    async (ids: readonly string[], kind: 'approve' | 'reject'): Promise<void> => {
      setBulkPending(kind);
      let ok = 0;
      const failures: string[] = [];
      try {
        for (let index = 0; index < ids.length; index += BULK_CONCURRENCY) {
          const batch = ids.slice(index, index + BULK_CONCURRENCY);
          const settled = await Promise.allSettled(batch.map((id) => decide(id, kind)));
          for (const outcome of settled) {
            if (outcome.status === 'fulfilled') ok++;
            else failures.push(outcome.reason instanceof ApiError ? outcome.reason.message : 'Request failed');
          }
        }
        const verb = kind === 'approve' ? 'approved' : 'rejected';
        if (failures.length === 0) {
          toast.success(`${formatNumber(ok)} suggestion${ok === 1 ? '' : 's'} ${verb}`);
        } else {
          toast.warning(`${formatNumber(ok)} ${verb}, ${formatNumber(failures.length)} failed`, {
            description: failures[0],
          });
        }
        setSelectedIds([]);
        onRefresh();
      } finally {
        setBulkPending(null);
      }
    },
    [decide, onRefresh],
  );

  const applyApproved = useCallback(async (): Promise<void> => {
    setApplying(true);
    try {
      const result = await apiPost<ApplyResponse>('/api/links/apply', { websiteId });
      if (result.status === 'skipped') {
        toast.warning(result.reason ?? 'Nothing was applied.', { description: result.fix });
        return;
      }
      const queued = result.queued ?? 0;
      if (result.job && result.job.enqueued === false) {
        toast.warning(`${formatNumber(queued)} link${queued === 1 ? '' : 's'} recorded but not queued`, {
          description: result.job.message,
        });
      } else {
        toast.success(`Applying ${formatNumber(queued)} approved link${queued === 1 ? '' : 's'}`, {
          description: `Writing through ${adapterLabel ?? 'the connected CMS'}. Follow the job on the Jobs screen.`,
        });
      }
      const skippedRows = result.skippedSuggestions ?? [];
      if (skippedRows.length > 0) {
        toast.info(`${formatNumber(skippedRows.length)} suggestion(s) were not applied`, {
          description: skippedRows[0]?.reason,
        });
      }
      onRefresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The links could not be applied.');
    } finally {
      setApplying(false);
    }
  }, [websiteId, adapterLabel, onRefresh]);

  const columns = useMemo<Array<ColumnDef<LinkSuggestion>>>(
    () => [
      {
        id: 'source',
        header: 'Source page',
        width: 260,
        accessor: (row) => row.sourcePage.url,
        cell: (row) => (
          <UrlCell
            url={row.sourcePage.url}
            label={row.sourcePage.title ?? shortenUrl(row.sourcePage.url, 40)}
            maxLength={40}
          />
        ),
        exportValue: (row) => row.sourcePage.url,
      },
      {
        id: 'target',
        header: 'Target page',
        width: 260,
        accessor: (row) => row.targetPage.url,
        cell: (row) => (
          <div className="flex min-w-0 items-center gap-1.5">
            <UrlCell
              url={row.targetPage.url}
              label={row.targetPage.title ?? shortenUrl(row.targetPage.url, 34)}
              maxLength={34}
            />
            {row.targetPage.isOrphan ? (
              <SimpleTooltip content="No internal links point at this page yet.">
                <Badge variant="destructive" className="shrink-0">
                  Orphan
                </Badge>
              </SimpleTooltip>
            ) : null}
          </div>
        ),
        exportValue: (row) => row.targetPage.url,
      },
      {
        id: 'anchor',
        header: 'Anchor',
        width: 180,
        accessor: (row) => row.anchorText,
        cell: (row) => (
          <code className="block truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            {row.anchorText}
          </code>
        ),
      },
      {
        id: 'placement',
        header: 'Placement sentence',
        width: 320,
        accessor: (row) => row.contextSnippet ?? '',
        cell: (row) =>
          row.contextSnippet ? (
            <SimpleTooltip content={row.contextSnippet}>
              <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                {row.contextSnippet}
              </span>
            </SimpleTooltip>
          ) : (
            <span className="text-xs text-muted-foreground">Place by hand — no sentence captured</span>
          ),
      },
      {
        id: 'reason',
        header: 'Reason',
        width: 260,
        defaultHidden: true,
        accessor: (row) => row.reason,
        cell: (row) => <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{row.reason}</span>,
      },
      {
        id: 'relevance',
        header: (
          <span className="inline-flex items-center gap-1">
            Relevance
            <TooltipInfo content={RELEVANCE_EXPLANATION} label="How relevance is calculated" />
          </span>
        ),
        headerLabel: 'Relevance',
        align: 'right',
        width: 110,
        accessor: (row) => row.relevanceScore,
        cell: (row) => (
          <ScoreCell value={Math.round(row.relevanceScore * 100)} variant="pill" label="Relevance" />
        ),
        exportValue: (row) => Math.round(row.relevanceScore * 100),
      },
      {
        id: 'impact',
        header: (
          <span className="inline-flex items-center gap-1">
            Impact
            <TooltipInfo content={IMPACT_EXPLANATION} label="How impact is calculated" />
          </span>
        ),
        headerLabel: 'Impact',
        align: 'right',
        width: 110,
        accessor: (row) => row.impactScore,
        cell: (row) => <ScoreCell value={Math.round(row.impactScore * 100)} variant="pill" label="Impact" />,
        exportValue: (row) => Math.round(row.impactScore * 100),
      },
      {
        id: 'status',
        header: 'Status',
        width: 120,
        accessor: (row) => row.status,
        cell: (row) => <StatusCell status={row.status} detail={row.rejectedReason ?? undefined} />,
      },
      {
        id: 'decide',
        header: <span className="sr-only">Decision</span>,
        headerLabel: 'Decision',
        align: 'right',
        width: 84,
        accessor: () => '',
        exportValue: () => null,
        cell: (row) =>
          row.status === 'APPLIED' ? (
            <span className="text-2xs text-muted-foreground">Applied</span>
          ) : (
            <span className="flex items-center justify-end gap-1">
              <SimpleTooltip content="Approve">
                <Button
                  size="icon"
                  variant="ghost"
                  data-row-ignore
                  aria-label={`Approve link to ${row.targetPage.url}`}
                  className="size-7 text-muted-foreground hover:text-success"
                  onClick={(event) => {
                    event.stopPropagation();
                    void decideOne(row, 'approve');
                  }}
                >
                  <Check className="size-3.5" aria-hidden="true" />
                </Button>
              </SimpleTooltip>
              <SimpleTooltip content="Reject">
                <Button
                  size="icon"
                  variant="ghost"
                  data-row-ignore
                  aria-label={`Reject link to ${row.targetPage.url}`}
                  className="size-7 text-muted-foreground hover:text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    void decideOne(row, 'reject');
                  }}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </Button>
              </SimpleTooltip>
            </span>
          ),
      },
    ],
    [decideOne],
  );

  return (
    <div className="space-y-4">
      <ApplyModeNotice canApply={canApply} adapterLabel={adapterLabel} websiteId={websiteId} />

      <DataTable
        data={items}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        caption="Suggested internal links, ordered by impact then relevance."
        selectable
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        bulkActions={(_rows, ids) => (
          <>
            <Button
              size="sm"
              variant="outline"
              loading={bulkPending === 'approve'}
              loadingText="Approving"
              disabled={bulkPending !== null}
              onClick={() => void decideMany(ids, 'approve')}
            >
              <Check className="size-3.5" aria-hidden="true" />
              Approve {formatNumber(ids.length)}
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={bulkPending === 'reject'}
              loadingText="Rejecting"
              disabled={bulkPending !== null}
              onClick={() => void decideMany(ids, 'reject')}
            >
              <X className="size-3.5" aria-hidden="true" />
              Reject {formatNumber(ids.length)}
            </Button>
          </>
        )}
        page={page}
        pageSize={pageSize}
        total={suggestions?.total ?? 0}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
        itemLabel="suggestions"
        onRowClick={setOpenRow}
        toolbar={
          <FacetFilter
            paramKey="status"
            label="Status"
            options={STATUS_OPTIONS.map((option) => ({
              ...option,
              count: suggestions?.byStatus[option.value],
            }))}
          />
        }
        toolbarActions={
          <SimpleTooltip
            content={
              canApply
                ? `Queues one batch through ${adapterLabel}. Only approved suggestions are written.`
                : 'Connect a CMS adapter to write approved links automatically.'
            }
          >
            <span className="inline-flex">
              <Button
                size="sm"
                loading={applying}
                loadingText="Queueing"
                disabled={approvedCount === 0 || !canApply}
                onClick={() => void applyApproved()}
              >
                <Rocket className="size-3.5" aria-hidden="true" />
                Apply approved ({formatNumber(approvedCount)})
              </Button>
            </span>
          </SimpleTooltip>
        }
        exportFilename="internal-link-suggestions"
        emptyState={
          <EmptyState
            size="sm"
            icon={Link2}
            title={hasCrawl ? 'No link suggestions in this view' : 'No crawl yet, so no link graph'}
            description={
              hasCrawl
                ? 'Either the filters exclude everything, or the internal link analysis has not run since the last crawl. It only proposes a link when the two pages are genuinely related and the anchor already appears in the source page’s prose.'
                : 'Internal link suggestions are built from crawled page text and the link graph. Run a crawl first, then run the link analysis.'
            }
            action={
              <Button size="sm" onClick={onRunAnalysis} disabled={!hasCrawl || analysisRunning}>
                {analysisRunning ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Play className="size-3.5" aria-hidden="true" />
                )}
                Run link analysis
              </Button>
            }
          />
        }
      />

      <LinkSuggestionSheet
        suggestion={openRow}
        open={openRow !== null}
        onOpenChange={(next) => {
          if (!next) setOpenRow(null);
        }}
        onDecided={onRefresh}
        canApply={canApply}
        adapterLabel={adapterLabel}
      />
    </div>
  );
}

/**
 * The distinction that decides what "approve" means here: with an adapter the links are written
 * to the live site, without one they are only recorded. Saying nothing would let an operator
 * approve fifty links and assume the site had changed.
 */
function ApplyModeNotice({
  canApply,
  adapterLabel,
  websiteId,
}: {
  canApply: boolean;
  adapterLabel: string | null;
  websiteId: string;
}): React.JSX.Element {
  if (canApply) {
    return (
      <p className={cn('flex items-center gap-2 text-xs text-muted-foreground')}>
        <Rocket className="size-3.5 shrink-0" aria-hidden="true" />
        Approved links are written to the live site through <strong className="font-medium text-foreground">
          {adapterLabel}
        </strong>{' '}
        when you press “Apply approved”. Approving on its own changes nothing.
      </p>
    );
  }

  return (
    <Alert variant="warning">
      <AlertTitle>No CMS is connected — approved links are prepared, not applied</AlertTitle>
      <AlertDescription>
        Approving records the decision, the final anchor text and the exact sentence to place it in, so the
        work can be done by hand or exported. Writing links automatically needs a CMS adapter (WordPress,
        Shopify, Webflow, a git repository or a webhook).{' '}
        <Link href={`/sites/${websiteId}/settings`}>Connect one in site settings</Link>.
      </AlertDescription>
    </Alert>
  );
}
