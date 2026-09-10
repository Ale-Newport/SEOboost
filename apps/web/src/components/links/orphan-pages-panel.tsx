'use client';

import { useMemo, useState } from 'react';
import { Compass, Sparkles } from 'lucide-react';

import { Badge, humanizeStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { ScoreCell } from '@/components/data/score-cell';
import { UrlCell } from '@/components/data/url-cell';
import { formatNumber } from '@/lib/utils';
import type { OrphanPage } from './types';

interface OrphanPagesPanelProps {
  orphans: { items: OrphanPage[]; total: number } | null;
  loading: boolean;
  hasCrawl: boolean;
  /** Queues the internal link analysis; the caller owns the request and its toasts. */
  onFindLinks: () => Promise<void>;
  analysisRunning: boolean;
}

export function OrphanPagesPanel({
  orphans,
  loading,
  hasCrawl,
  onFindLinks,
  analysisRunning,
}: OrphanPagesPanelProps): React.JSX.Element {
  const [confirmFor, setConfirmFor] = useState<OrphanPage | null>(null);

  const items = orphans?.items ?? [];
  const capped = orphans !== null && orphans.total > items.length;

  const columns = useMemo<Array<ColumnDef<OrphanPage>>>(
    () => [
      {
        id: 'url',
        header: 'Page',
        width: 340,
        sortable: true,
        accessor: (row) => row.url,
        cell: (row) => (
          <div className="min-w-0">
            <UrlCell url={row.url} label={row.title ?? undefined} maxLength={52} />
            {row.title ? <p className="truncate font-mono text-2xs text-muted-foreground">{row.url}</p> : null}
          </div>
        ),
        exportValue: (row) => row.url,
      },
      {
        id: 'pageType',
        header: 'Type',
        width: 110,
        sortable: true,
        accessor: (row) => row.pageType,
        cell: (row) => <Badge variant="muted">{humanizeStatus(row.pageType)}</Badge>,
      },
      {
        id: 'indexable',
        header: 'Indexable',
        width: 100,
        sortable: true,
        accessor: (row) => row.isIndexable,
        cell: (row) =>
          row.isIndexable ? (
            <Badge variant="outline">Indexable</Badge>
          ) : (
            <SimpleTooltip content="Not indexable, so an orphan here costs nothing in search.">
              <Badge variant="muted">No</Badge>
            </SimpleTooltip>
          ),
      },
      {
        id: 'depth',
        header: 'Depth',
        align: 'right',
        width: 80,
        sortable: true,
        accessor: (row) => row.depth,
      },
      {
        id: 'wordCount',
        header: 'Words',
        align: 'right',
        width: 90,
        sortable: true,
        accessor: (row) => row.wordCount,
      },
      {
        id: 'impressions28d',
        header: 'Impressions',
        align: 'right',
        width: 110,
        sortable: true,
        accessor: (row) => row.impressions28d,
      },
      {
        id: 'clicks28d',
        header: 'Clicks',
        align: 'right',
        width: 90,
        sortable: true,
        accessor: (row) => row.clicks28d,
      },
      {
        id: 'seoScore',
        header: 'SEO score',
        align: 'right',
        width: 130,
        sortable: true,
        accessor: (row) => row.seoScore,
        cell: (row) => <ScoreCell value={row.seoScore} label="Page SEO score" />,
      },
      {
        id: 'find',
        header: <span className="sr-only">Find links</span>,
        headerLabel: 'Find links',
        align: 'right',
        width: 130,
        accessor: () => '',
        exportValue: () => null,
        cell: (row) => (
          <Button
            size="sm"
            variant="outline"
            data-row-ignore
            disabled={analysisRunning}
            onClick={(event) => {
              event.stopPropagation();
              setConfirmFor(row);
            }}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            Find links
          </Button>
        ),
      },
    ],
    [analysisRunning],
  );

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Pages with zero inbound internal links. Search engines reach them only through the sitemap, and
        they receive no internal authority at all. Non-indexable orphans are listed too, marked as such —
        those are usually fine to leave alone.
        {capped ? (
          <>
            {' '}
            Showing the first {formatNumber(items.length)} of {formatNumber(orphans?.total ?? 0)}, ordered by
            impressions.
          </>
        ) : null}
      </p>

      <DataTable
        data={items}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        caption="Indexable pages with no inbound internal links."
        searchable
        searchPlaceholder="Search these orphan pages…"
        searchKeys={['url']}
        defaultSort="impressions28d"
        defaultOrder="desc"
        itemLabel="orphan pages"
        exportFilename="orphan-pages"
        emptyState={
          <EmptyState
            size="sm"
            icon={Compass}
            title={hasCrawl ? 'No orphan pages' : 'No crawl yet'}
            description={
              hasCrawl
                ? 'Every active page on this site has at least one inbound internal link. Re-check after the next crawl — new pages usually arrive orphaned.'
                : 'Orphan detection compares the page inventory against the crawled link graph. Run a crawl to populate both.'
            }
          />
        }
      />

      <ConfirmDialog
        open={confirmFor !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmFor(null);
        }}
        title="Find internal links for this page"
        description={
          <>
            The link suggester works over the whole site in one pass — a suggestion is a pair, so it needs
            every candidate source page’s text to find a sentence the anchor can genuinely live in. It orders
            its work by how starved of inbound links each target is, so{' '}
            <span className="font-medium text-foreground">{confirmFor?.url}</span> is at the front of the
            queue. Results appear on the Suggestions tab when the run finishes.
          </>
        }
        confirmLabel="Run link analysis"
        onConfirm={async () => {
          await onFindLinks();
          setConfirmFor(null);
        }}
      />
    </div>
  );
}
