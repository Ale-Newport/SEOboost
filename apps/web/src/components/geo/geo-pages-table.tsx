'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { ScoreCell } from '@/components/data/score-cell';
import { UrlCell } from '@/components/data/url-cell';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { GeoPageRow } from '@/server/queries/geo';

/** `BLOG_INDEX` → `Blog index`. The enum is an implementation detail, not a label. */
function pageTypeLabel(value: string): string {
  const words = value.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Per-page GEO scores, sortable by score so the worst pages surface first — which is the order
 * the underlying query already returns them in.
 */
export function GeoPagesTable({
  websiteId,
  pages,
  pageAuditCount,
}: {
  websiteId: string;
  pages: GeoPageRow[];
  pageAuditCount: number;
}) {
  const columns = useMemo<Array<ColumnDef<GeoPageRow>>>(
    () => [
      {
        id: 'url',
        header: 'Page',
        accessor: (row) => row.title ?? row.url,
        cell: (row) => (
          <UrlCell
            url={row.url}
            label={row.title ?? undefined}
            href={`/sites/${websiteId}/pages/${row.pageId}`}
            maxLength={56}
          />
        ),
        sortable: true,
        width: 340,
        sticky: true,
      },
      {
        id: 'score',
        header: 'GEO score',
        accessor: (row) => row.score,
        cell: (row) => <ScoreCell value={row.score} label="GEO score" />,
        sortable: true,
        align: 'right',
        width: 140,
      },
      {
        id: 'worst',
        header: 'Weakest dimension',
        headerLabel: 'Weakest dimension',
        accessor: (row) => row.worstDimension?.label ?? '',
        cell: (row) =>
          row.worstDimension ? (
            <span className="flex items-center gap-1.5">
              <Badge variant="outline">{row.worstDimension.label}</Badge>
              <span className="tabular text-2xs text-muted-foreground">
                {formatPercent(row.worstDimension.value * 100, 0)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        sortable: true,
        width: 220,
      },
      {
        id: 'findings',
        header: 'Findings',
        accessor: (row) => row.findingCount,
        cell: (row) =>
          row.findingCount === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <span className="tabular">{formatNumber(row.findingCount)}</span>
          ),
        sortable: true,
        align: 'right',
        width: 100,
      },
      {
        id: 'pageType',
        header: 'Type',
        accessor: (row) => row.pageType,
        cell: (row) => <Badge variant="muted">{pageTypeLabel(row.pageType)}</Badge>,
        sortable: true,
        width: 130,
      },
      {
        id: 'wordCount',
        header: 'Words',
        accessor: (row) => row.wordCount,
        sortable: true,
        align: 'right',
        width: 100,
      },
    ],
    [websiteId],
  );

  return (
    <DataTable
      data={pages}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Per-page GEO scores from the most recent audit"
      searchable
      searchPlaceholder="Search pages…"
      defaultSort="score"
      defaultOrder="asc"
      itemLabel="pages"
      exportFilename="geo-page-scores"
      emptyTitle="No pages were scored"
      emptyDescription="The audit only scores indexable pages with more than 100 words of content. Crawl the site so more pages are stored, or lengthen the thin ones, then re-run the GEO audit."
      stickyHeader
      maxHeight={640}
      toolbarActions={
        pageAuditCount > pages.length ? (
          <span className="text-2xs text-muted-foreground">
            Showing the {formatNumber(pages.length)} lowest-scoring of {formatNumber(pageAuditCount)} audited pages
          </span>
        ) : null
      }
    />
  );
}
