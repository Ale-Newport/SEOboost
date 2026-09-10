'use client';

import { useCallback, useMemo } from 'react';
import { ArrowDown, ArrowUp, Download, Minus, Search, Split } from 'lucide-react';
import type { Paginated } from '@seo/shared';

import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { KeywordCell, type SearchIntentValue } from '@/components/data/keyword-cell';
import { ScoreCell } from '@/components/data/score-cell';
import { UrlCell } from '@/components/data/url-cell';
import { useFilterPills } from '@/components/data/filter-bar';
import { useTableParams, type SortOrder } from '@/components/data/use-table-params';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition, formatUsd } from '@/lib/utils';
import type { KeywordListItem } from '@/server/queries/keywords';
import { KEYWORD_FILTER_LABELS } from './keyword-filters';
import { bandForPosition } from './position-bands';

/**
 * The keyword list.
 *
 * Sorting, paging and searching all hand over to the server through URL params — a site can
 * carry six figures of keywords, and the sorted "top opportunities" view has to be computed
 * across all of them, not across whichever page happens to be mounted.
 */

/** Client param names → the query names `/api/websites/[id]/keywords` accepts, for the CSV export. */
const EXPORT_PARAM_MAP: Readonly<Record<string, string>> = {
  search: 'search',
  sort: 'sort',
  order: 'order',
  intent: 'intent',
  funnelStage: 'funnelStage',
  source: 'source',
  tracked: 'tracked',
  branded: 'branded',
  contentGap: 'contentGap',
  cannibalization: 'cannibalization',
};

const BAND_EXPORT_PARAMS: Readonly<Record<string, Record<string, string>>> = {
  top3: { positionMin: '1', positionMax: '3' },
  '4-10': { positionMin: '4', positionMax: '10' },
  '11-20': { positionMin: '11', positionMax: '20' },
  '21-50': { positionMin: '21', positionMax: '50' },
  '51plus': { positionMin: '51', positionMax: '100' },
  unranked: { unranked: 'true' },
};

/**
 * Build the server-side CSV URL for the *current* filter selection.
 *
 * The download deliberately goes through the API rather than the table's own exporter: the
 * exporter can only see the rows on screen, and "export my keywords" means all of them.
 */
function buildExportUrl(websiteId: string, params: URLSearchParams): string {
  const out = new URLSearchParams({ format: 'csv' });

  for (const [clientKey, apiKey] of Object.entries(EXPORT_PARAM_MAP)) {
    for (const value of params.getAll(clientKey)) {
      if (value !== '') out.append(apiKey, value);
    }
  }

  const clusterId = params.get('clusterId');
  if (clusterId === 'none') out.set('cluster', 'none');
  else if (clusterId) out.set('clusterId', clusterId);

  const band = params.get('band');
  const bandParams = band === null ? undefined : BAND_EXPORT_PARAMS[band];
  if (bandParams) {
    for (const [key, value] of Object.entries(bandParams)) out.set(key, value);
  }

  return `/api/websites/${websiteId}/keywords?${out.toString()}`;
}

function PositionChange({ change }: { change: number | null }): React.JSX.Element {
  if (change === null || change === 0 || !Number.isFinite(change)) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus className="size-3" aria-hidden="true" />
        <span className="sr-only">No change</span>
      </span>
    );
  }
  // A positive `positionChange` means the rank number fell, i.e. the keyword moved up.
  const improved = change > 0;
  const Icon = improved ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'tabular inline-flex items-center gap-0.5 text-xs font-medium',
        improved ? 'text-success' : 'text-destructive',
      )}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      {Math.abs(change).toFixed(1)}
      <span className="sr-only">{improved ? 'places up' : 'places down'}</span>
    </span>
  );
}

export interface KeywordTableProps {
  websiteId: string;
  result: Paginated<KeywordListItem>;
  hasAnyKeywords: boolean;
  /** The filter controls, rendered inside the toolbar beside the search box and the active pills. */
  filters: React.ReactNode;
  onImportRequested: () => void;
}

export function KeywordTable({
  websiteId,
  result,
  hasAnyKeywords,
  filters,
  onImportRequested,
}: KeywordTableProps): React.JSX.Element {
  const table = useTableParams({ defaultSort: 'opportunityScore', defaultOrder: 'desc' });
  const pills = useFilterPills(KEYWORD_FILTER_LABELS);
  const { setParams, setPage, setPageSize, setSort, setSearch, clearFilters, queryString } = table;

  const openKeyword = useCallback((row: KeywordListItem) => setParams({ id: row.id }), [setParams]);
  const handleSort = useCallback((id: string, order: SortOrder) => setSort(id, order), [setSort]);

  const exportUrl = useMemo(
    () => buildExportUrl(websiteId, new URLSearchParams(queryString)),
    [websiteId, queryString],
  );

  const columns = useMemo<ReadonlyArray<ColumnDef<KeywordListItem>>>(
    () => [
      {
        id: 'keyword',
        header: 'Keyword',
        headerLabel: 'Keyword',
        accessor: (row) => row.keyword,
        sortable: true,
        sticky: true,
        width: 300,
        cell: (row) => (
          <KeywordCell
            keyword={row.keyword}
            intent={row.intent as SearchIntentValue}
            cluster={row.clusterName}
            branded={row.isBranded}
          />
        ),
      },
      {
        id: 'currentPosition',
        header: 'Position',
        accessor: (row) => row.currentPosition,
        sortable: true,
        align: 'right',
        width: 96,
        exportValue: (row) => row.currentPosition,
        cell: (row) =>
          row.currentPosition === null ? (
            <SimpleTooltip content="No position recorded. Connect Search Console or a SERP provider to rank this keyword.">
              <span className="text-xs text-muted-foreground">Not ranking</span>
            </SimpleTooltip>
          ) : (
            <SimpleTooltip content={`${bandForPosition(row.currentPosition).label}${row.bestPosition === null ? '' : ` · best ${formatPosition(row.bestPosition)}`}`}>
              <span className="tabular text-sm font-medium text-foreground">
                {formatPosition(row.currentPosition)}
              </span>
            </SimpleTooltip>
          ),
      },
      {
        id: 'positionChange',
        header: 'Change',
        accessor: (row) => row.positionChange,
        sortable: true,
        align: 'right',
        width: 84,
        cell: (row) => <PositionChange change={row.positionChange} />,
      },
      {
        id: 'clicks28d',
        header: 'Clicks',
        accessor: (row) => row.clicks28d,
        sortable: true,
        align: 'right',
        width: 88,
        cell: (row) => <span className="tabular text-sm">{formatNumber(row.clicks28d)}</span>,
      },
      {
        id: 'impressions28d',
        header: 'Impressions',
        accessor: (row) => row.impressions28d,
        sortable: true,
        align: 'right',
        width: 108,
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
        width: 80,
        exportValue: (row) => (row.ctr28d === null ? null : Number((row.ctr28d * 100).toFixed(2))),
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">
            {row.ctr28d === null ? '—' : formatPercent(row.ctr28d, 2)}
          </span>
        ),
      },
      {
        id: 'searchVolume',
        header: 'Volume',
        accessor: (row) => row.searchVolume,
        sortable: true,
        align: 'right',
        width: 90,
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">
            {row.searchVolume === null ? '—' : formatCompact(row.searchVolume)}
          </span>
        ),
      },
      {
        id: 'difficulty',
        header: (
          <span className="inline-flex items-center gap-1">
            Difficulty
            <TooltipInfo content="Provider keyword difficulty, 0–100. Higher is harder. Blank when no SERP or keyword-data provider is configured — it is never estimated." />
          </span>
        ),
        headerLabel: 'Difficulty',
        accessor: (row) => row.difficulty,
        sortable: true,
        align: 'right',
        width: 96,
        cell: (row) => <ScoreCell value={row.difficulty} variant="pill" invert label="Difficulty" />,
      },
      {
        id: 'cpc',
        header: 'CPC',
        accessor: (row) => row.cpc,
        sortable: true,
        align: 'right',
        width: 84,
        defaultHidden: true,
        cell: (row) => (
          <span className="tabular text-sm text-muted-foreground">{row.cpc === null ? '—' : formatUsd(row.cpc)}</span>
        ),
      },
      {
        id: 'opportunityScore',
        header: (
          <span className="inline-flex items-center gap-1">
            Opportunity
            <TooltipInfo content="0–100, weighted from ranking headroom, measured demand, topical relevance, business value, competition, content gap, topical authority and AI-search potential. Open a keyword for the full factor-by-factor breakdown." />
          </span>
        ),
        headerLabel: 'Opportunity',
        accessor: (row) => row.opportunityScore,
        sortable: true,
        align: 'right',
        width: 140,
        cell: (row) =>
          row.opportunityScore === null ? (
            <SimpleTooltip content="Not scored yet — run the keyword analysis for this site.">
              <span className="text-xs text-muted-foreground">Not scored</span>
            </SimpleTooltip>
          ) : (
            <SimpleTooltip
              content={row.opportunityReason ?? 'Open this keyword for the factor-by-factor breakdown.'}
            >
              <span className="inline-flex">
                <ScoreCell value={row.opportunityScore} label="Opportunity score" />
              </span>
            </SimpleTooltip>
          ),
      },
      {
        id: 'rankingUrl',
        header: 'Ranking URL',
        accessor: (row) => row.rankingUrl ?? row.pageUrl,
        width: 240,
        cell: (row) => {
          const url = row.rankingUrl ?? row.pageUrl;
          return url === null ? (
            <span className="text-xs text-muted-foreground">No URL mapped</span>
          ) : (
            <UrlCell url={url} maxLength={40} />
          );
        },
      },
      {
        id: 'flags',
        header: 'Flags',
        accessor: (row) => [row.isContentGap ? 'content gap' : '', row.hasCannibalization ? 'cannibalised' : ''].filter(Boolean).join(', '),
        width: 150,
        cell: (row) => (
          <span className="flex flex-wrap items-center gap-1">
            {row.isContentGap ? (
              <SimpleTooltip content="No existing page targets this query well — a genuine content gap.">
                <Badge variant="warning">
                  <Search className="size-3" aria-hidden="true" />
                  Gap
                </Badge>
              </SimpleTooltip>
            ) : null}
            {row.hasCannibalization ? (
              <SimpleTooltip content="Several URLs compete for this query, splitting its relevance signals.">
                <Badge variant="destructive">
                  <Split className="size-3" aria-hidden="true" />
                  Cannibalised
                </Badge>
              </SimpleTooltip>
            ) : null}
            {!row.isContentGap && !row.hasCannibalization ? (
              <span className="text-xs text-muted-foreground">—</span>
            ) : null}
          </span>
        ),
      },
    ],
    [],
  );

  const emptyState = hasAnyKeywords ? (
    <EmptyState
      icon={Search}
      size="sm"
      title="No keywords match these filters"
      description="Every keyword on this site is filtered out by the current selection."
      action={
        <Button variant="outline" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      icon={Search}
      size="sm"
      title="No keywords yet"
      description="Keywords arrive from Search Console once the integration is connected and synced, from crawled page content, or from a list you import yourself."
      action={
        <Button size="sm" onClick={onImportRequested}>
          Import a keyword list
        </Button>
      }
    />
  );

  return (
    <DataTable<KeywordListItem>
      data={result.items}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Keywords for this website, with position, traffic and opportunity score"
      searchable
      manualSearch
      search={table.searchInput}
      onSearchChange={setSearch}
      searchPlaceholder="Search keywords…"
      sort={table.sort}
      order={table.order}
      onSortChange={handleSort}
      page={result.page}
      pageSize={result.pageSize}
      total={result.total}
      onPageChange={setPage}
      onPageSizeChange={setPageSize}
      itemLabel="keywords"
      onRowClick={openKeyword}
      filterPills={pills}
      onClearFilters={clearFilters}
      exportable={false}
      stickyHeader
      maxHeight="calc(100vh - 20rem)"
      emptyState={emptyState}
      toolbar={filters}
      toolbarActions={
        result.total === 0 ? (
          <Button variant="outline" size="sm" disabled>
            <Download aria-hidden="true" />
            Export CSV
          </Button>
        ) : (
          // A plain link, not the table's own exporter: the exporter can only see the rows on
          // screen, and this downloads every row the current filters select.
          <Button asChild variant="outline" size="sm">
            <a href={exportUrl} download>
              <Download aria-hidden="true" />
              Export CSV
            </a>
          </Button>
        )
      }
    />
  );
}
