'use client';

import { useMemo } from 'react';

import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { UrlCell } from '@/components/data/url-cell';
import { useTableParams } from '@/components/data/use-table-params';
import { formatNumber } from '@/lib/utils';
import type { DiscrepancyGroup, DiscrepancyRow } from '@/server/queries/indexation';

/**
 * The reconciliation itself: one row per page that sits in a bucket where the three sources
 * disagree — our crawl, the sitemap, and Search Console.
 *
 * The selected bucket lives in the URL so a specific discrepancy list can be linked to, and the
 * bucket's own description is shown above the table: two of the five buckets are informational
 * rather than defects, and a table that does not say which is which invites busywork.
 */

const ALL = 'all';

/** Short labels for the segmented control; the full label carries the meaning below it. */
const SHORT_LABELS: Record<string, string> = {
  IN_SITEMAP_NOT_CRAWLED: 'Sitemap, not crawled',
  CRAWLED_NOT_IN_SITEMAP: 'Crawled, not in sitemap',
  INDEXABLE_NO_SEARCH_DATA: 'No impressions',
  NOINDEX: 'Excluded',
  CANONICALISED_AWAY: 'Canonicalised away',
};

export function DiscrepancyTable({
  websiteId,
  groups,
  rows,
}: {
  websiteId: string;
  groups: readonly DiscrepancyGroup[];
  rows: readonly DiscrepancyRow[];
}): React.JSX.Element {
  const { getParam, setFilter } = useTableParams();
  const selected = getParam('kind') ?? ALL;
  const activeGroup = groups.find((group) => group.kind === selected) ?? null;

  const visible = useMemo(
    () => (selected === ALL ? rows : rows.filter((row) => row.kind === selected)),
    [rows, selected],
  );

  const columns = useMemo<Array<ColumnDef<DiscrepancyRow>>>(
    () => [
      {
        id: 'url',
        header: 'Page',
        accessor: (row) => row.title ?? row.path,
        cell: (row) => (
          <UrlCell
            url={row.url}
            label={row.title ?? undefined}
            href={`/sites/${websiteId}/pages/${row.pageId}`}
            maxLength={56}
          />
        ),
        sortable: true,
        width: 320,
        sticky: true,
      },
      {
        id: 'kind',
        header: 'Bucket',
        accessor: (row) => row.kind,
        cell: (row) => <Badge variant="outline">{SHORT_LABELS[row.kind] ?? row.kind}</Badge>,
        sortable: true,
        width: 190,
      },
      {
        id: 'detail',
        header: 'Why it is here',
        accessor: (row) => row.detail,
        cell: (row) => <span className="line-clamp-2 text-xs text-muted-foreground">{row.detail}</span>,
        width: 300,
      },
      {
        id: 'statusCode',
        header: 'Status',
        accessor: (row) => row.statusCode,
        cell: (row) =>
          row.statusCode === null ? (
            <span className="text-muted-foreground">Not fetched</span>
          ) : (
            <Badge variant={row.statusCode < 300 ? 'success' : row.statusCode < 400 ? 'warning' : 'destructive'}>
              {row.statusCode}
            </Badge>
          ),
        sortable: true,
        align: 'right',
        width: 110,
      },
      {
        id: 'isIndexable',
        header: 'Indexable',
        accessor: (row) => (row.isIndexable ? 1 : 0),
        cell: (row) =>
          row.isIndexable ? (
            <Badge variant="success">Yes</Badge>
          ) : (
            <span className="text-xs text-muted-foreground" title={row.indexabilityReason ?? undefined}>
              {row.indexabilityReason ?? 'No'}
            </span>
          ),
        exportValue: (row) => (row.isIndexable ? 'indexable' : (row.indexabilityReason ?? 'not indexable')),
        sortable: true,
        width: 170,
      },
      {
        id: 'inSitemap',
        header: 'In sitemap',
        accessor: (row) => (row.inSitemap ? 1 : 0),
        cell: (row) => (
          <Badge variant={row.inSitemap ? 'muted' : 'warning'}>{row.inSitemap ? 'Listed' : 'Absent'}</Badge>
        ),
        sortable: true,
        width: 120,
      },
      {
        id: 'impressions28d',
        header: 'Impressions',
        headerLabel: 'Impressions (28d)',
        accessor: (row) => row.impressions28d,
        cell: (row) => <span className="tabular">{formatNumber(row.impressions28d)}</span>,
        sortable: true,
        align: 'right',
        width: 120,
      },
      {
        id: 'clicks28d',
        header: 'Clicks',
        headerLabel: 'Clicks (28d)',
        accessor: (row) => row.clicks28d,
        cell: (row) => <span className="tabular">{formatNumber(row.clicks28d)}</span>,
        sortable: true,
        align: 'right',
        width: 100,
      },
      {
        id: 'canonicalUrl',
        header: 'Canonical',
        accessor: (row) => row.canonicalUrl,
        cell: (row) =>
          row.canonicalUrl ? (
            <UrlCell url={row.canonicalUrl} maxLength={40} />
          ) : (
            <span className="text-muted-foreground">Self</span>
          ),
        width: 220,
        defaultHidden: true,
      },
      {
        id: 'lastCrawledAt',
        header: 'Last crawled',
        accessor: (row) => row.lastCrawledAt,
        cell: (row) =>
          row.lastCrawledAt === null ? (
            <span className="text-muted-foreground">Never</span>
          ) : (
            <time dateTime={row.lastCrawledAt.toISOString()} className="tabular text-xs">
              {row.lastCrawledAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </time>
          ),
        sortable: true,
        align: 'right',
        width: 130,
        defaultHidden: true,
      },
    ],
    [websiteId],
  );

  return (
    <div className="space-y-3">
      <Tabs value={selected} onValueChange={(next) => setFilter('kind', next === ALL ? null : next)}>
        <TabsList variant="line" className="flex-wrap">
          <TabsTrigger value={ALL}>
            All
            <Badge variant="muted">{formatNumber(rows.length)}</Badge>
          </TabsTrigger>
          {groups.map((group) => (
            <TabsTrigger key={group.kind} value={group.kind}>
              {SHORT_LABELS[group.kind] ?? group.label}
              <Badge variant={group.tone === 'warning' && group.count > 0 ? 'warning' : 'muted'}>
                {formatNumber(group.count)}
              </Badge>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <p className="text-xs leading-relaxed text-muted-foreground">
        {activeGroup
          ? activeGroup.description
          : 'Every page where the crawl, the sitemap and Search Console disagree. Two of these buckets are informational rather than defects — select one to read what it means before acting on it.'}
      </p>

      <DataTable
        data={visible}
        columns={columns}
        getRowId={(row) => row.id}
        caption="Pages where the crawl, the sitemap and Search Console disagree"
        searchable
        searchPlaceholder="Search URLs and titles…"
        searchKeys={['url', 'detail']}
        defaultSort="impressions28d"
        defaultOrder="desc"
        itemLabel="pages"
        exportFilename="indexation-discrepancies"
        stickyHeader
        maxHeight={640}
        emptyTitle={activeGroup ? 'Nothing in this bucket' : 'No discrepancies found'}
        emptyDescription={
          activeGroup
            ? 'The crawl, the sitemap and Search Console agree on every page for this check.'
            : 'The three sources agree across every page scanned. Re-crawl after publishing to confirm it holds.'
        }
      />
    </div>
  );
}
