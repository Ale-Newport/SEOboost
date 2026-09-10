'use client';

import { useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Download, FileText, Filter, Link2, ScanLine } from 'lucide-react';
import type { Paginated } from '@seo/shared';
import type { PageType } from '@seo/db';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  BooleanFilter,
  DataTable,
  EnumFilter,
  FacetFilter,
  FilterBar,
  NumberRangeFilter,
  ScoreCell,
  TrendCell,
  UrlCell,
  humanizeFilterValue,
  useFilterPills,
  useTableParams,
  type ColumnDef,
  type FilterLabelConfig,
} from '@/components/data';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition, shortenUrl } from '@/lib/utils';
import type { PageListItem } from '@/server/queries/pages';

interface PageFacets {
  pageType: Array<{ value: PageType; count: number }>;
  statusCode: Array<{ value: number; count: number }>;
  indexable: { yes: number; no: number };
  orphan: number;
  total: number;
}

export interface PagesListViewProps {
  websiteId: string;
  result: Paginated<PageListItem>;
  facets: PageFacets;
  thinContentWords: number;
}

/** `ARTICLE` → `Article`; the enum is not written for humans. */
function humanizeType(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const FILTER_LABELS: Readonly<Record<string, FilterLabelConfig>> = {
  pageType: { label: 'Type', formatValue: humanizeType },
  statusCode: { label: 'Status' },
  indexable: { label: 'Indexable', formatValue: (value) => (value === 'true' ? 'Yes' : 'No') },
  inSitemap: { label: 'In sitemap', formatValue: (value) => (value === 'true' ? 'Yes' : 'No') },
  hasIssues: { label: 'Issues', formatValue: (value) => (value === 'true' ? 'Has open issues' : 'No open issues') },
  orphan: { label: 'Orphan', formatValue: () => 'Orphans only' },
  words: { label: 'Words', formatValue: humanizeFilterValue },
};

const YES_NO_ALL = 'All';

/**
 * The page inventory table.
 *
 * Every filter, the sort and the page number live in the URL through `useTableParams`, so the
 * server component beside this one reads exactly the same state and a filtered view is a link
 * someone can paste into a ticket. Nothing is filtered or sorted client-side: at 50k rows the
 * database is the only honest place to do it.
 */
export function PagesListView({
  websiteId,
  result,
  facets,
  thinContentWords,
}: PagesListViewProps): React.JSX.Element {
  const table = useTableParams({ defaultPageSize: 50, defaultSort: null, defaultOrder: 'desc' });
  const { setPage, setPageSize, setSearch, toggleSort, clearFilters, queryString } = table;
  const pills = useFilterPills(FILTER_LABELS);

  const handleSort = useCallback((id: string) => toggleSort(id), [toggleSort]);

  /**
   * The export goes through the API rather than the rows on screen: `format=csv` re-runs the
   * same filters server-side and writes every match (up to its own cap), not just this page.
   */
  const exportHref = useMemo(() => {
    const params = new URLSearchParams(queryString);
    params.delete('page');
    params.delete('pageSize');
    params.set('format', 'csv');
    return `/api/websites/${websiteId}/pages?${params.toString()}`;
  }, [queryString, websiteId]);

  const columns = useMemo<Array<ColumnDef<PageListItem>>>(
    () => [
      {
        id: 'url',
        header: 'URL',
        headerLabel: 'URL',
        accessor: (row) => row.path,
        sortable: true,
        sticky: true,
        width: 340,
        cell: (row) => (
          <div className="min-w-0">
            <UrlCell
              url={row.url}
              label={shortenUrl(row.path === '' ? '/' : row.path, 46)}
              href={`/sites/${websiteId}/pages/${row.id}`}
            />
            <p className="truncate text-2xs text-muted-foreground" title={row.title ?? undefined}>
              {row.title ?? 'No title tag'}
            </p>
          </div>
        ),
      },
      {
        id: 'title',
        header: 'Title',
        accessor: (row) => row.title,
        sortable: true,
        defaultHidden: true,
        width: 260,
        cell: (row) =>
          row.title === null ? (
            <span className="text-muted-foreground">Missing</span>
          ) : (
            <span className="block truncate" title={row.title}>
              {row.title}
            </span>
          ),
      },
      {
        id: 'pageType',
        header: 'Type',
        accessor: (row) => row.pageType,
        sortable: true,
        width: 120,
        cell: (row) => (
          <Badge variant="outline" className="font-normal">
            {humanizeType(row.pageType)}
          </Badge>
        ),
      },
      {
        id: 'isIndexable',
        header: 'Indexable',
        headerLabel: 'Indexable',
        accessor: (row) => row.isIndexable,
        align: 'center',
        width: 110,
        exportValue: (row) => (row.isIndexable ? 'yes' : 'no'),
        cell: (row) =>
          row.isIndexable ? (
            <Badge variant="success">Yes</Badge>
          ) : (
            <SimpleTooltip content={row.indexabilityReason ?? 'The last crawl did not record a reason.'}>
              <span className="inline-flex">
                <Badge variant="muted">No</Badge>
              </span>
            </SimpleTooltip>
          ),
      },
      {
        id: 'statusCode',
        header: 'Status',
        accessor: (row) => row.statusCode,
        sortable: true,
        align: 'center',
        width: 90,
        defaultHidden: true,
        cell: (row) =>
          row.statusCode === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <span
              className={cn(
                'tabular text-sm',
                row.statusCode >= 500
                  ? 'font-medium text-destructive'
                  : row.statusCode >= 400
                    ? 'font-medium text-warning'
                    : row.statusCode >= 300
                      ? 'text-info'
                      : 'text-muted-foreground',
              )}
            >
              {row.statusCode}
            </span>
          ),
      },
      {
        id: 'wordCount',
        header: 'Words',
        accessor: (row) => row.wordCount,
        sortable: true,
        align: 'right',
        width: 100,
        cell: (row) => (
          <span
            className={cn('tabular text-sm', row.wordCount < thinContentWords && 'font-medium text-warning')}
            title={row.wordCount < thinContentWords ? `Below the ${thinContentWords}-word thin-content threshold` : undefined}
          >
            {formatNumber(row.wordCount)}
          </span>
        ),
      },
      {
        id: 'depth',
        header: 'Depth',
        accessor: (row) => row.depth,
        sortable: true,
        align: 'right',
        width: 84,
        cell: (row) => <span className="tabular text-sm text-muted-foreground">{row.depth}</span>,
      },
      {
        id: 'internalLinksIn',
        header: 'Links in',
        accessor: (row) => row.internalLinksIn,
        sortable: true,
        align: 'right',
        width: 96,
        cell: (row) => (
          <span className={cn('tabular text-sm', row.isOrphan && 'font-medium text-warning')}>
            {row.isOrphan ? (
              <SimpleTooltip content="Orphan: no internal link points at this page.">
                <span className="inline-flex items-center gap-1">
                  <Link2 className="size-3" aria-hidden="true" />0
                </span>
              </SimpleTooltip>
            ) : (
              formatNumber(row.internalLinksIn)
            )}
          </span>
        ),
      },
      {
        id: 'internalLinksOut',
        header: 'Links out',
        accessor: (row) => row.internalLinksOut,
        sortable: true,
        align: 'right',
        width: 100,
        defaultHidden: true,
        cell: (row) => <span className="tabular text-sm text-muted-foreground">{formatNumber(row.internalLinksOut)}</span>,
      },
      {
        id: 'clicks28d',
        header: 'Clicks',
        accessor: (row) => row.clicks28d,
        sortable: true,
        align: 'right',
        width: 96,
        cell: (row) => <span className="tabular text-sm">{formatNumber(row.clicks28d)}</span>,
      },
      {
        id: 'impressions28d',
        header: 'Impressions',
        accessor: (row) => row.impressions28d,
        sortable: true,
        align: 'right',
        width: 116,
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">{formatCompact(row.impressions28d)}</span>
        ),
      },
      {
        id: 'ctr28d',
        header: 'CTR',
        accessor: (row) => row.ctr28d,
        sortable: true,
        align: 'right',
        width: 90,
        defaultHidden: true,
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">{formatPercent(row.ctr28d, 2)}</span>
        ),
      },
      {
        id: 'position28d',
        header: 'Position',
        accessor: (row) => row.position28d,
        sortable: true,
        align: 'right',
        width: 96,
        cell: (row) => <span className="tabular text-sm">{formatPosition(row.position28d)}</span>,
      },
      {
        id: 'clicksTrendPct',
        header: 'Trend',
        headerLabel: 'Clicks trend (%)',
        accessor: (row) => row.clicksTrendPct,
        sortable: true,
        align: 'right',
        width: 104,
        exportValue: (row) => row.clicksTrendPct,
        // No sparkline: the list model holds a period-over-period percentage, not a daily
        // series, and drawing a shape from one number would be an invention.
        cell: (row) => <TrendCell values={[]} deltaPct={row.clicksTrendPct} showSparkline={false} />,
      },
      {
        id: 'seoScore',
        header: 'SEO',
        headerLabel: 'SEO score',
        accessor: (row) => row.seoScore,
        sortable: true,
        align: 'right',
        width: 110,
        cell: (row) => <ScoreCell value={row.seoScore} variant="bar" label="SEO score" />,
      },
      {
        id: 'geoScore',
        header: 'GEO',
        headerLabel: 'GEO score',
        accessor: (row) => row.geoScore,
        sortable: true,
        align: 'center',
        width: 84,
        cell: (row) => <ScoreCell value={row.geoScore} variant="pill" label="GEO score" />,
      },
      {
        id: 'opportunityScore',
        header: 'Opportunity',
        headerLabel: 'Opportunity score',
        accessor: (row) => row.opportunityScore,
        sortable: true,
        align: 'right',
        width: 120,
        cell: (row) => <ScoreCell value={row.opportunityScore} variant="bar" label="Opportunity score" />,
      },
      {
        id: 'openIssues',
        header: 'Issues',
        accessor: (row) => row.openIssues,
        align: 'right',
        width: 90,
        cell: (row) =>
          row.openIssues === 0 ? (
            <span className="text-sm text-muted-foreground">—</span>
          ) : (
            <span
              className={cn(
                'tabular text-sm',
                row.criticalIssues > 0 ? 'font-medium text-destructive' : 'text-foreground',
              )}
              title={row.criticalIssues > 0 ? `${row.criticalIssues} critical` : undefined}
            >
              {formatNumber(row.openIssues)}
            </span>
          ),
      },
    ],
    [websiteId, thinContentWords],
  );

  const noMatches = result.items.length === 0;

  return (
    <DataTable<PageListItem>
      data={result.items}
      columns={columns}
      getRowId={(row) => row.id}
      caption={`Pages on this website, ${formatNumber(result.total)} matching the current filters`}
      searchable
      search={table.searchInput}
      onSearchChange={setSearch}
      searchPlaceholder="Search URL, title or H1…"
      manualSearch
      sort={table.sort}
      order={table.order}
      onSortChange={handleSort}
      page={result.page}
      pageSize={result.pageSize}
      total={result.total}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
      itemLabel="pages"
      rowHref={(row) => `/sites/${websiteId}/pages/${row.id}`}
      filterPills={pills}
      onClearFilters={clearFilters}
      exportable={false}
      stickyHeader
      maxHeight="calc(100vh - 22rem)"
      toolbarActions={
        <Button asChild variant="outline" size="sm">
          <a href={exportHref} download>
            <Download aria-hidden="true" />
            Export CSV
          </a>
        </Button>
      }
      toolbar={
        <FilterBar>
          <FacetFilter
            paramKey="pageType"
            label="Type"
            icon={FileText}
            options={facets.pageType.map((entry) => ({
              value: entry.value,
              label: humanizeType(entry.value),
              count: entry.count,
            }))}
          />
          <EnumFilter
            paramKey="indexable"
            label="Indexable"
            allLabel={YES_NO_ALL}
            options={[
              { value: 'true', label: 'Yes', count: facets.indexable.yes },
              { value: 'false', label: 'No', count: facets.indexable.no },
            ]}
          />
          <EnumFilter
            paramKey="hasIssues"
            label="Issues"
            allLabel={YES_NO_ALL}
            options={[
              { value: 'true', label: 'Has open issues' },
              { value: 'false', label: 'None open' },
            ]}
          />
          <EnumFilter
            paramKey="inSitemap"
            label="Sitemap"
            allLabel={YES_NO_ALL}
            options={[
              { value: 'true', label: 'In sitemap' },
              { value: 'false', label: 'Missing' },
            ]}
          />
          {facets.statusCode.length > 1 ? (
            <FacetFilter
              paramKey="statusCode"
              label="Status"
              icon={ScanLine}
              options={facets.statusCode.map((entry) => ({
                value: String(entry.value),
                label: String(entry.value),
                count: entry.count,
              }))}
            />
          ) : null}
          <NumberRangeFilter paramKey="words" label="Words" min={0} step={50} />
          <BooleanFilter paramKey="orphan" label="Orphans only" icon={Link2} />
        </FilterBar>
      }
      emptyState={
        noMatches ? (
          <EmptyState
            size="sm"
            icon={Filter}
            title="No pages match these filters"
            description={
              `The crawl found ${formatNumber(facets.total)} page${facets.total === 1 ? '' : 's'} on this site. ` +
              'Widen or clear the filters to see them.'
            }
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
            secondaryAction={
              <Button asChild variant="ghost" size="sm">
                <Link href={`/sites/${websiteId}`}>Site overview</Link>
              </Button>
            }
          />
        ) : undefined
      }
    />
  );
}
