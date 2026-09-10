'use client';

import * as React from 'react';
import Link from 'next/link';
import { Globe, Layers, ShieldCheck, Sparkles, Target } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { ProgressBar } from '@/components/ui/progress-bar';
import { DataTableToolbar } from '@/components/data/data-table-toolbar';
import {
  EnumFilter,
  FacetFilter,
  FilterBar,
  humanizeFilterValue,
  useFilterPills,
} from '@/components/data/filter-bar';
import type { FacetOption } from '@/components/data/filter-bar';
import { Pagination } from '@/components/data/pagination';
import { useTableParams } from '@/components/data/use-table-params';
import { OpportunityCard } from '@/components/content/opportunity-card';
import { opportunityTypeMeta } from '@/components/content/meta';
import type { OpportunityItem } from '@/components/content/types';
import { formatCompact, formatNumber } from '@/lib/utils';

/**
 * The cross-site opportunity queue.
 *
 * Ranked by priority across every website, which means the top of this list is the next thing
 * worth doing anywhere in the portfolio. The screen leads with the reuse-over-create ratio
 * because that is the judgement the discovery pass exists to make: most queries are best served
 * by deepening a page that already exists, and a queue that mostly says "improve this" is the
 * system working, not the system idle.
 */

const PRIORITY_OPTIONS: FacetOption[] = [
  { value: '40', label: '40+' },
  { value: '55', label: '55+' },
  { value: '70', label: '70+' },
  { value: '85', label: '85+' },
];

export interface PortfolioOpportunity {
  websiteId: string;
  websiteName: string;
  websiteDomain: string;
  opportunity: OpportunityItem;
}

export interface OpportunityQueueProps {
  rows: PortfolioOpportunity[];
  total: number;
  page: number;
  pageSize: number;
  /** Portfolio-wide counts, unaffected by the filters. */
  openCount: number;
  totalProposed: number;
  reuseCount: number;
  siteOptions: FacetOption[];
  typeOptions: FacetOption[];
  statusOptions: FacetOption[];
  hasWebsites: boolean;
}

export function OpportunityQueue({
  rows,
  total,
  page,
  pageSize,
  openCount,
  totalProposed,
  reuseCount,
  siteOptions,
  typeOptions,
  statusOptions,
  hasWebsites,
}: OpportunityQueueProps): React.JSX.Element {
  const { searchInput, setSearch, setPage, setPageSize, hasActiveFilters, clearFilters } =
    useTableParams({ defaultPageSize: pageSize });

  const filterLabels = React.useMemo(
    () => ({
      site: {
        label: 'Website',
        formatValue: (value: string) =>
          siteOptions.find((option) => option.value === value)?.label ?? value,
      },
      type: { label: 'Type', formatValue: (value: string) => opportunityTypeMeta(value).label },
      status: { label: 'Status', formatValue: humanizeFilterValue },
      minPriority: { label: 'Min priority', formatValue: (value: string) => `${value}+` },
    }),
    [siteOptions],
  );
  const pills = useFilterPills(filterLabels);

  const createCount = Math.max(0, totalProposed - reuseCount);
  const reusePct = totalProposed === 0 ? null : Math.round((reuseCount / totalProposed) * 100);

  const estimatedGain = React.useMemo(
    () => rows.reduce((sum, row) => sum + (row.opportunity.estimatedTrafficGain ?? 0), 0),
    [rows],
  );

  const filtering = hasActiveFilters || searchInput.length > 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Open"
          value={formatNumber(openCount)}
          icon={Target}
          footer="Awaiting an accept or reject"
        />
        <MetricCard
          label="Total proposed"
          value={formatNumber(totalProposed)}
          icon={Layers}
          footer="Across every site and status"
        />
        <MetricCard
          label="Reuse over create"
          value={reusePct === null ? '—' : `${reusePct}%`}
          icon={ShieldCheck}
          info="The share of proposals that improve, refresh, consolidate or extend a page that already exists instead of publishing a new URL. Computed from the opportunity types across your whole portfolio."
          footer={`${formatNumber(reuseCount)} of ${formatNumber(totalProposed)} need no new page`}
        />
        <MetricCard
          label="Modelled gain"
          value={estimatedGain === 0 ? '—' : `+${formatCompact(estimatedGain)}`}
          icon={Sparkles}
          info="Sum of the estimated monthly clicks across the opportunities on this page of results. Modelled from impressions and expected CTR at the target position — an estimate, not a forecast."
          footer="Clicks/month on this page"
        />
      </div>

      {totalProposed > 0 ? (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight text-foreground">
              <ShieldCheck className="size-4 text-info" aria-hidden="true" />
              {formatNumber(reuseCount)} of {formatNumber(totalProposed)} proposals add no new URL
            </h2>
            <p className="tabular text-2xs text-muted-foreground">
              {formatNumber(createCount)} would publish a new page
            </p>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Every proposal is compared against the pages the site already has before it is raised.
            When an existing page already targets the query, the pass says so and proposes
            improving it — publishing a second URL would split the ranking signal rather than add
            reach. Each card below names the page it matched and the evidence behind that call.
          </p>
          <ProgressBar
            className="mt-3"
            value={totalProposed}
            max={totalProposed}
            showValue={false}
            segments={[
              {
                key: 'reuse',
                value: reuseCount,
                tone: 'info',
                label: `${formatNumber(reuseCount)} improve an existing page`,
              },
              {
                key: 'create',
                value: createCount,
                tone: 'primary',
                label: `${formatNumber(createCount)} create a new page`,
              },
            ]}
            ariaLabel="Proposals that reuse an existing page versus those that create a new one"
          />
        </div>
      ) : null}

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
            <FacetFilter paramKey="site" label="Website" options={siteOptions} icon={Globe} searchable />
            <FacetFilter paramKey="type" label="Type" options={typeOptions} searchable />
            <FacetFilter paramKey="status" label="Status" options={statusOptions} />
            <EnumFilter paramKey="minPriority" label="Priority" options={PRIORITY_OPTIONS} allLabel="Any" />
          </FilterBar>
        </DataTableToolbar>

        <div className="border-t border-border p-3">
          {rows.length === 0 ? (
            <EmptyState
              icon={hasWebsites ? Target : Globe}
              title={
                !hasWebsites
                  ? 'No websites yet'
                  : filtering
                    ? 'No opportunities match these filters'
                    : 'No content opportunities yet'
              }
              description={
                !hasWebsites
                  ? 'Add a website first. Opportunities are discovered per site, from its crawl and its Search Console data.'
                  : filtering
                    ? 'Clear the filters to see every proposal across your portfolio.'
                    : 'Opportunities come from the content strategy agent. It compares your Search Console queries and keyword clusters against the pages each site already has, so it needs a completed crawl and Search Console connected before it has anything to compare. Run it from a site to fill this queue.'
              }
              action={
                !hasWebsites ? (
                  <Button asChild size="sm">
                    <Link href="/sites/new">Add a website</Link>
                  </Button>
                ) : filtering ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <Link href="/sites">
                      <Sparkles aria-hidden="true" />
                      Pick a site to run discovery on
                    </Link>
                  </Button>
                )
              }
            />
          ) : (
            <ol className="space-y-4">
              {rows.map((row) => (
                <li key={row.opportunity.id} className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5 px-0.5">
                    <Link
                      href={`/sites/${row.websiteId}`}
                      className="inline-flex max-w-[18rem] items-center gap-1 truncate rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-2xs font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      <Globe className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="truncate">{row.websiteName}</span>
                    </Link>
                    <span className="truncate font-mono text-2xs text-muted-foreground">
                      {row.websiteDomain}
                    </span>
                    <Link
                      href={`/sites/${row.websiteId}/opportunities`}
                      className="ml-auto text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      All opportunities for this site
                    </Link>
                  </div>
                  <OpportunityCard websiteId={row.websiteId} opportunity={row.opportunity} />
                </li>
              ))}
            </ol>
          )}
        </div>

        {total > 0 ? (
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
        ) : null}
      </div>
    </div>
  );
}
