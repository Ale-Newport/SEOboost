'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileText, Layers, ShieldCheck, Sparkles, Target } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { DataTableToolbar } from '@/components/data/data-table-toolbar';
import {
  EnumFilter,
  FacetFilter,
  FilterBar,
  humanizeFilterValue,
  useFilterPills,
} from '@/components/data/filter-bar';
import { Pagination } from '@/components/data/pagination';
import { useTableParams } from '@/components/data/use-table-params';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatCompact, formatNumber } from '@/lib/utils';

import { OPPORTUNITY_TYPE_META, opportunityTypeMeta } from './meta';
import { OpportunityCard } from './opportunity-card';
import type { OpportunityFacetCount, OpportunityItem } from './types';
import { OPPORTUNITY_STATUSES } from './types';

interface OpportunitiesViewProps {
  website: { id: string; name: string; domain: string };
  items: OpportunityItem[];
  total: number;
  page: number;
  pageSize: number;
  typeFacets: OpportunityFacetCount[];
  statusFacets: OpportunityFacetCount[];
  openCount: number;
}

const FILTER_LABELS = {
  type: { label: 'Type', formatValue: (value: string) => opportunityTypeMeta(value).label },
  status: { label: 'Status', formatValue: humanizeFilterValue },
  minPriority: { label: 'Min priority', formatValue: (value: string) => `${value}+` },
} as const;

const PRIORITY_OPTIONS = [
  { value: '40', label: '40+' },
  { value: '55', label: '55+' },
  { value: '70', label: '70+' },
  { value: '85', label: '85+' },
];

export function OpportunitiesView({
  website,
  items,
  total,
  page,
  pageSize,
  typeFacets,
  statusFacets,
  openCount,
}: OpportunitiesViewProps): React.JSX.Element {
  const router = useRouter();
  const { search, searchInput, setSearch, setPage, setPageSize, hasActiveFilters, clearFilters } =
    useTableParams({ defaultPageSize: pageSize });
  const pills = useFilterPills(FILTER_LABELS);
  const [running, setRunning] = React.useState(false);

  const typeCounts = React.useMemo(
    () => new Map(typeFacets.map((facet) => [facet.value, facet.count])),
    [typeFacets],
  );
  const statusCounts = React.useMemo(
    () => new Map(statusFacets.map((facet) => [facet.value, facet.count])),
    [statusFacets],
  );

  const totalOnSite = React.useMemo(
    () => typeFacets.reduce((sum, facet) => sum + facet.count, 0),
    [typeFacets],
  );

  /**
   * How many of the proposals do *not* add a URL. This is the headline the screen exists to
   * make: a discovery pass whose answer is mostly "improve what you have" is working correctly.
   */
  const reuseCount = React.useMemo(
    () =>
      typeFacets.reduce(
        (sum, facet) => (opportunityTypeMeta(facet.value).createsPage ? sum : sum + facet.count),
        0,
      ),
    [typeFacets],
  );

  const estimatedGain = React.useMemo(
    () =>
      items.reduce((sum, item) => sum + (item.estimatedTrafficGain ?? 0), 0),
    [items],
  );

  // The facet queries cover every row on this website, so a type that is missing from them
  // genuinely has zero opportunities — showing `0` here is a measurement, not a placeholder.
  const typeOptions = React.useMemo(
    () =>
      Object.entries(OPPORTUNITY_TYPE_META)
        .map(([value, meta]) => ({
          value,
          label: meta.label,
          icon: meta.icon,
          count: typeCounts.get(value) ?? 0,
        }))
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    [typeCounts],
  );

  const statusOptions = React.useMemo(
    () =>
      OPPORTUNITY_STATUSES.map((value) => ({
        value,
        label: humanizeFilterValue(value),
        count: statusCounts.get(value) ?? 0,
      })),
    [statusCounts],
  );

  const runDiscovery = async (): Promise<void> => {
    setRunning(true);
    try {
      const result = await apiPost<{ enqueued?: boolean; reason?: string }>(
        '/api/agents/content-strategy/run',
        { websiteId: website.id },
      );
      if (result.enqueued === false) {
        toast.warning('Queued, but no worker picked it up', {
          description: result.reason ?? 'Start the worker (npm run dev:worker) or check REDIS_URL.',
        });
      } else {
        toast.success('Content strategy agent is running', {
          description:
            'It compares every keyword against the pages you already have before proposing anything. Refresh in a moment.',
        });
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the agent');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Content opportunities"
        description={`Ranked by priority for ${website.name}. Every proposal was checked against the pages this site already has.`}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/sites/${website.id}/content`}>
                <FileText aria-hidden="true" />
                Content pipeline
              </Link>
            </Button>
            <Button size="sm" onClick={() => void runDiscovery()} loading={running} loadingText="Starting">
              <Sparkles aria-hidden="true" />
              Find opportunities
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Open"
          value={formatNumber(openCount)}
          icon={Target}
          footer="Awaiting a decision"
        />
        <MetricCard
          label="Total proposed"
          value={formatNumber(totalOnSite)}
          icon={Layers}
          footer="Across every status"
        />
        <MetricCard
          label="Reuse over create"
          value={totalOnSite === 0 ? '—' : `${Math.round((reuseCount / totalOnSite) * 100)}%`}
          icon={ShieldCheck}
          info="The share of proposals that improve, refresh, consolidate or extend an existing page instead of publishing a new URL. A high number means the site is being deepened rather than inflated."
          footer={`${formatNumber(reuseCount)} of ${formatNumber(totalOnSite)} need no new page`}
        />
        <MetricCard
          label="Modelled gain"
          value={estimatedGain === 0 ? '—' : `+${formatCompact(estimatedGain)}`}
          icon={Sparkles}
          info="Sum of the estimated monthly clicks across the opportunities on this page. Modelled from impressions and expected CTR at the target position — an estimate, not a forecast."
          footer="Clicks/month on this page of results"
        />
      </div>

      <div className="rounded-lg border border-border bg-card">
        <DataTableToolbar
          search={searchInput}
          onSearchChange={setSearch}
          searchPlaceholder="Search title, keyword or reasoning…"
          resultCount={total}
          filters={pills}
          onClearFilters={clearFilters}
        >
          <FilterBar>
            <FacetFilter paramKey="type" label="Type" options={typeOptions} searchable />
            <FacetFilter paramKey="status" label="Status" options={statusOptions} />
            <EnumFilter
              paramKey="minPriority"
              label="Priority"
              options={PRIORITY_OPTIONS}
              allLabel="Any"
            />
          </FilterBar>
        </DataTableToolbar>

        <div className="border-t border-border p-3">
          {items.length === 0 ? (
            <EmptyState
              icon={Target}
              title={
                search || hasActiveFilters
                  ? 'No opportunities match these filters'
                  : 'No content opportunities yet'
              }
              description={
                search || hasActiveFilters
                  ? 'Clear the filters to see everything this site has proposed.'
                  : 'Opportunities come from the content strategy agent, which compares your Search Console queries and keyword clusters against the pages you already have. It needs a completed crawl and Search Console connected to have anything to compare.'
              }
              action={
                search || hasActiveFilters ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => void runDiscovery()} loading={running} loadingText="Starting">
                    <Sparkles aria-hidden="true" />
                    Run the content strategy agent
                  </Button>
                )
              }
              secondaryAction={
                search || hasActiveFilters ? null : (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/sites/${website.id}/settings`}>Check integrations</Link>
                  </Button>
                )
              }
            />
          ) : (
            <ol className="space-y-3">
              {items.map((opportunity) => (
                <li key={opportunity.id}>
                  <OpportunityCard websiteId={website.id} opportunity={opportunity} />
                </li>
              ))}
            </ol>
          )}
        </div>

        {total > 0 && (
          <div className="border-t border-border px-3 py-2">
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              itemLabel="opportunities"
            />
          </div>
        )}
      </div>
    </div>
  );
}
