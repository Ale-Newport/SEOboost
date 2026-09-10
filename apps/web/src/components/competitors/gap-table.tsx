'use client';

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sparkles, Target } from 'lucide-react';
import { toast } from 'sonner';

import type { KeywordGap } from '@seo/seo-engine';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { EnumFilter, FilterBar, type FilterLabelConfig, useFilterPills } from '@/components/data/filter-bar';
import { KeywordCell } from '@/components/data/keyword-cell';
import { useTableParams } from '@/components/data/use-table-params';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn, formatCompact, formatPosition } from '@/lib/utils';

/**
 * The keyword-gap table.
 *
 * Every row is an observation, not a projection: the competitor positions come from SERP rows the
 * analysis actually recorded, and `ourPosition` from this site's own keyword table. The gap score
 * is the engine's, rendered as-is with its inputs on screen so the ranking is auditable.
 */

const GAP_SCORE_EXPLANATION = (
  <>
    <p>The engine ranks gaps on four observed signals:</p>
    <ul className="mt-1 list-disc space-y-0.5 pl-4">
      <li>how many tracked competitors rank in the top 20 (30%)</li>
      <li>the best position any of them holds (25%)</li>
      <li>estimated monthly volume, when the provider returned one (25%)</li>
      <li>how close this site already is to the query (20%)</li>
    </ul>
    <p className="mt-1">
      Each row shows all four inputs, so a score can be checked against the evidence rather than
      taken on trust.
    </p>
  </>
);

const GAP_TYPE_LABEL: Record<KeywordGap['gapType'], string> = {
  missing: 'Not ranking',
  underperforming: 'Outranked',
};

const FILTER_LABELS: Readonly<Record<string, FilterLabelConfig>> = {
  gapType: {
    label: 'Gap',
    formatValue: (value: string) =>
      value === 'missing' || value === 'underperforming' ? GAP_TYPE_LABEL[value] : value,
  },
  competitor: { label: 'Competitor' },
};

export interface GapTableProps {
  websiteId: string;
  gaps: readonly KeywordGap[];
  counts: {
    gaps: number;
    missing: number;
    underperforming: number;
    observedCompetitorKeywords: number;
    ourKeywords: number;
  };
  competitorDomains: readonly string[];
}

export function GapTable({ websiteId, gaps, counts, competitorDomains }: GapTableProps): React.JSX.Element {
  const router = useRouter();
  const { search, searchInput, setSearch, getParam, clearFilters, hasActiveFilters } = useTableParams({
    defaultSort: 'gapScore',
    defaultOrder: 'desc',
  });
  const pills = useFilterPills(FILTER_LABELS);
  const [converting, setConverting] = useState<string | null>(null);
  const [converted, setConverted] = useState<readonly string[]>([]);

  const gapType = getParam('gapType');
  const competitor = getParam('competitor');

  const rows = useMemo(
    () =>
      gaps.filter((gap) => {
        if (gapType && gap.gapType !== gapType) return false;
        if (competitor && !gap.competitorDomains.includes(competitor)) return false;
        return true;
      }),
    [competitor, gapType, gaps],
  );

  const convert = useCallback(
    async (gap: KeywordGap) => {
      setConverting(gap.keyword);
      try {
        // Only the keyword travels: the route recomputes the gap, its score and its reasoning
        // from the stored observations, so the row can never be talked into existence.
        const result = await apiPost<{ created: boolean; message: string }>(
          `/api/websites/${websiteId}/competitors/opportunities`,
          { keyword: gap.keyword },
        );
        setConverted((current) => [...current, gap.keyword]);
        toast.success(result.message);
        router.refresh();
      } catch (cause) {
        toast.error(cause instanceof ApiError ? cause.message : 'Could not create the opportunity.');
      } finally {
        setConverting(null);
      }
    },
    [router, websiteId],
  );

  const columns = useMemo<Array<ColumnDef<KeywordGap>>>(
    () => [
      {
        id: 'keyword',
        header: 'Keyword',
        accessor: (row) => row.keyword,
        cell: (row) => <KeywordCell keyword={row.keyword} showIntent={false} />,
        sortable: true,
        sticky: true,
        width: 260,
      },
      {
        id: 'gapType',
        header: 'Gap',
        accessor: (row) => row.gapType,
        cell: (row) => (
          <Badge variant={row.gapType === 'missing' ? 'warning' : 'secondary'} className="text-2xs">
            {GAP_TYPE_LABEL[row.gapType]}
          </Badge>
        ),
        sortable: true,
        width: 110,
      },
      {
        id: 'competitors',
        header: 'Who ranks',
        accessor: (row) => row.competitorCount,
        exportValue: (row) => row.competitorDomains.join(' | '),
        cell: (row) => (
          <SimpleTooltip content={row.competitorDomains.join(', ')}>
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <span className="tabular text-xs font-medium">{row.competitorCount}</span>
              <span className="truncate text-2xs text-muted-foreground">
                {row.competitorDomains.slice(0, 2).join(', ')}
                {row.competitorDomains.length > 2 ? ` +${row.competitorDomains.length - 2}` : ''}
              </span>
            </span>
          </SimpleTooltip>
        ),
        sortable: true,
        width: 190,
      },
      {
        id: 'bestCompetitorPosition',
        header: 'Their best',
        accessor: (row) => row.bestCompetitorPosition,
        cell: (row) => <span className="tabular">{formatPosition(row.bestCompetitorPosition)}</span>,
        sortable: true,
        align: 'right',
        width: 96,
      },
      {
        id: 'ourPosition',
        header: 'Our position',
        accessor: (row) => row.ourPosition ?? Number.POSITIVE_INFINITY,
        exportValue: (row) => row.ourPosition,
        cell: (row) =>
          row.ourPosition === null ? (
            <span className="text-xs text-muted-foreground">Not ranking</span>
          ) : (
            <span className="tabular">{formatPosition(row.ourPosition)}</span>
          ),
        sortable: true,
        align: 'right',
        width: 112,
      },
      {
        id: 'estimatedVolume',
        header: 'Est. volume',
        accessor: (row) => row.estimatedVolume ?? -1,
        exportValue: (row) => row.estimatedVolume,
        cell: (row) =>
          row.estimatedVolume === null ? (
            <SimpleTooltip content="The SERP provider returned no volume for this query.">
              <span className="text-muted-foreground">—</span>
            </SimpleTooltip>
          ) : (
            <span className="tabular">{formatCompact(row.estimatedVolume)}</span>
          ),
        sortable: true,
        align: 'right',
        width: 104,
      },
      {
        id: 'gapScore',
        header: (
          <span className="inline-flex items-center gap-1">
            Gap score
            <TooltipInfo content={GAP_SCORE_EXPLANATION} label="How the gap score is calculated" />
          </span>
        ),
        headerLabel: 'Gap score',
        accessor: (row) => row.gapScore,
        cell: (row) => (
          <SimpleTooltip content={row.reason}>
            <span
              className={cn(
                'tabular font-semibold',
                row.gapScore >= 70 ? 'text-success' : row.gapScore >= 45 ? 'text-warning' : 'text-muted-foreground',
              )}
            >
              {Math.round(row.gapScore)}
            </span>
          </SimpleTooltip>
        ),
        sortable: true,
        align: 'right',
        width: 104,
      },
      {
        id: 'reason',
        header: 'Why it is a gap',
        accessor: (row) => row.reason,
        cell: (row) => <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{row.reason}</p>,
        width: 340,
      },
      {
        id: 'convert',
        header: 'Action',
        accessor: (row) => row.keyword,
        exportValue: () => null,
        cell: (row) =>
          converted.includes(row.keyword) ? (
            <Badge variant="success" className="text-2xs">
              Opportunity created
            </Badge>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-2xs"
              loading={converting === row.keyword}
              loadingText="Creating"
              onClick={() => void convert(row)}
            >
              <Sparkles aria-hidden="true" />
              Create opportunity
            </Button>
          ),
        width: 168,
      },
    ],
    [convert, converted, converting],
  );

  return (
    <DataTable<KeywordGap>
      data={rows}
      columns={columns}
      getRowId={(row) => row.keyword}
      caption="Keywords tracked competitors rank for that this site does not, ranked by gap score"
      searchable
      search={searchInput}
      onSearchChange={setSearch}
      searchPlaceholder="Search gap keywords…"
      searchKeys={['keyword', 'competitors']}
      defaultSort="gapScore"
      defaultOrder="desc"
      defaultDensity="compact"
      stickyHeader
      maxHeight={620}
      exportable
      exportFilename="keyword-gaps"
      filterPills={pills}
      {...(hasActiveFilters ? { onClearFilters: clearFilters } : {})}
      itemLabel="gaps"
      emptyTitle={search || gapType || competitor ? 'No gaps match these filters' : 'No gaps found'}
      emptyDescription={
        search || gapType || competitor
          ? 'Clear the filters to see the full gap list.'
          : `Compared ${counts.observedCompetitorKeywords.toLocaleString()} observed competitor rankings against ${counts.ourKeywords.toLocaleString()} of your keywords and found nothing this site is missing.`
      }
      toolbar={
        <FilterBar>
          <EnumFilter
            paramKey="gapType"
            label="Gap"
            allLabel={`All (${counts.gaps})`}
            options={[
              { value: 'missing', label: `Not ranking (${counts.missing})` },
              { value: 'underperforming', label: `Outranked (${counts.underperforming})` },
            ]}
          />
          {competitorDomains.length > 1 ? (
            <EnumFilter
              paramKey="competitor"
              label="Competitor"
              allLabel="Any competitor"
              options={competitorDomains.map((domain) => ({ value: domain, label: domain }))}
            />
          ) : null}
        </FilterBar>
      }
      toolbarActions={
        <span className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
          <Target aria-hidden="true" className="size-3.5" />
          {counts.gaps.toLocaleString()} gaps from {counts.observedCompetitorKeywords.toLocaleString()} observed
          rankings
        </span>
      }
    />
  );
}
