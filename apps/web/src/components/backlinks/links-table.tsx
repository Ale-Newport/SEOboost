'use client';

import { useMemo } from 'react';
import { ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { FilterBar, BooleanFilter, EnumFilter, useFilterPills } from '@/components/data/filter-bar';
import { UrlCell } from '@/components/data/url-cell';
import { useTableParams } from '@/components/data/use-table-params';
import { formatNumber } from '@/lib/utils';
import type { BacklinkRowView } from '@/server/queries/backlinks';
import type { ReferringDomainSummary } from '@seo/integrations/backlinks/analysis';

/**
 * The stored link table.
 *
 * Filtering, sorting and paging all live in the URL and are executed by the server query, so the
 * screen behaves the same whether the rows arrived from a paid API or a CSV the operator dropped
 * in. Only the columns the query can actually sort on are marked sortable — offering a sort the
 * backend cannot honour is worse than not offering it.
 */

const FILTER_LABELS = {
  follow: { label: 'Link type', formatValue: (value: string) => (value === 'follow' ? 'Followed' : 'Nofollow') },
  status: { label: 'Status', formatValue: (value: string) => (value === 'lost' ? 'Lost' : 'Active') },
  suspicious: { label: 'Flagged', formatValue: () => 'Suspicious only' },
} as const;

function dateCell(value: Date | null): React.JSX.Element {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return (
    <time dateTime={value.toISOString()} className="tabular text-xs">
      {value.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
    </time>
  );
}

/** Columns shared by the main table and the new/lost movement tables. */
export function linkColumns(): Array<ColumnDef<BacklinkRowView>> {
  return [
    {
      id: 'referringDomain',
      header: 'Referring domain',
      accessor: (row) => row.referringDomain,
      cell: (row) => (
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{row.referringDomain}</span>
            {row.isSuspicious ? (
              <ShieldAlert aria-label="Flagged as suspicious" className="size-3.5 shrink-0 text-warning" />
            ) : null}
          </div>
          <UrlCell url={row.sourceUrl} maxLength={44} />
        </div>
      ),
      sortable: true,
      width: 300,
      sticky: true,
    },
    {
      id: 'anchorText',
      header: 'Anchor',
      accessor: (row) => row.anchorText,
      cell: (row) =>
        row.anchorText ? (
          <span className="line-clamp-2 text-xs text-foreground">{row.anchorText}</span>
        ) : (
          <span className="text-muted-foreground">No anchor text</span>
        ),
      sortable: true,
      width: 220,
    },
    {
      id: 'targetUrl',
      header: 'Target',
      accessor: (row) => row.targetUrl,
      cell: (row) => <UrlCell url={row.targetUrl} maxLength={40} />,
      width: 220,
    },
    {
      id: 'isFollow',
      header: 'Type',
      accessor: (row) => (row.isFollow ? 'follow' : 'nofollow'),
      cell: (row) => (
        <Badge variant={row.isFollow ? 'success' : 'muted'}>{row.isFollow ? 'Followed' : 'Nofollow'}</Badge>
      ),
      width: 110,
    },
    {
      id: 'domainAuthority',
      header: 'Authority',
      accessor: (row) => row.domainAuthority,
      cell: (row) =>
        row.domainAuthority === null ? (
          <span className="text-muted-foreground">Not reported</span>
        ) : (
          <span className="tabular">{row.domainAuthority}</span>
        ),
      sortable: true,
      align: 'right',
      width: 120,
    },
    {
      id: 'firstSeenAt',
      header: 'First seen',
      accessor: (row) => row.firstSeenAt,
      cell: (row) => dateCell(row.firstSeenAt),
      sortable: true,
      align: 'right',
      width: 130,
    },
    {
      id: 'lastSeenAt',
      header: 'Last seen',
      accessor: (row) => row.lastSeenAt,
      cell: (row) => dateCell(row.lastSeenAt),
      sortable: true,
      align: 'right',
      width: 130,
    },
    {
      id: 'status',
      header: 'Status',
      accessor: (row) => row.status,
      cell: (row) => (
        <div className="space-y-0.5">
          <Badge variant={row.status === 'lost' ? 'destructive' : 'success'}>
            {row.status === 'lost' ? 'Lost' : 'Active'}
          </Badge>
          {row.lostAt ? (
            <p className="text-2xs text-muted-foreground">
              {row.lostAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
            </p>
          ) : null}
        </div>
      ),
      sortable: true,
      width: 120,
    },
    {
      id: 'provider',
      header: 'Source',
      headerLabel: 'Data source',
      accessor: (row) => row.provider,
      cell: (row) => <Badge variant="outline">{row.provider}</Badge>,
      width: 110,
      defaultHidden: true,
    },
  ];
}

export function BacklinksTable({
  links,
}: {
  links: {
    rows: readonly BacklinkRowView[];
    total: number;
    page: number;
    pageSize: number;
    sort: string;
    order: 'asc' | 'desc';
  };
}): React.JSX.Element {
  const params = useTableParams({ defaultSort: 'firstSeenAt', defaultOrder: 'desc' });
  const pills = useFilterPills(FILTER_LABELS);
  const columns = useMemo(() => linkColumns(), []);

  return (
    <DataTable
      data={links.rows}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Backlinks stored for this website"
      searchable
      manualSearch
      search={params.searchInput}
      onSearchChange={params.setSearch}
      searchPlaceholder="Search domains, URLs and anchors…"
      sort={links.sort}
      order={links.order}
      onSortChange={(id, order) => params.setSort(id, order)}
      page={links.page}
      pageSize={links.pageSize}
      total={links.total}
      onPageChange={params.setPage}
      onPageSizeChange={params.setPageSize}
      itemLabel="links"
      filterPills={pills}
      onClearFilters={params.clearFilters}
      stickyHeader
      maxHeight={640}
      emptyTitle="No links match these filters"
      emptyDescription="Clear the filters, or import a fresh export — the table only ever shows links that are actually stored."
      toolbarActions={
        <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
          Authority as reported by the source
          <TooltipInfo
            label="Where the authority number comes from"
            content="Whatever metric the import carried — Ahrefs DR, Moz DA, a vendor's own score. Scales differ between vendors, so the figures are only comparable within one source. It is passed through untouched and never invented: a link whose source reported no figure shows “Not reported” rather than a zero."
          />
        </span>
      }
      toolbar={
        <FilterBar>
          <EnumFilter
            paramKey="follow"
            label="Type"
            allLabel="All links"
            options={[
              { value: 'follow', label: 'Followed' },
              { value: 'nofollow', label: 'Nofollow' },
            ]}
          />
          <EnumFilter
            paramKey="status"
            label="Status"
            allLabel="Any status"
            options={[
              { value: 'active', label: 'Active' },
              { value: 'lost', label: 'Lost' },
            ]}
          />
          <BooleanFilter paramKey="suspicious" label="Flagged only" icon={ShieldAlert} />
        </FilterBar>
      }
    />
  );
}

/**
 * The referring domains behind those links, strongest first. Sorted client-side because the
 * analysis already returns a bounded top-N rather than a pageable set.
 */
export function ReferringDomainsTable({
  domains,
}: {
  domains: readonly ReferringDomainSummary[];
}): React.JSX.Element {
  const columns = useMemo<Array<ColumnDef<ReferringDomainSummary>>>(
    () => [
      {
        id: 'domain',
        header: 'Domain',
        accessor: (row) => row.domain,
        cell: (row) => (
          <span className="flex items-center gap-1.5">
            <span className="truncate text-xs font-medium text-foreground">{row.domain}</span>
            {row.isSuspicious ? <Badge variant="warning">Flagged</Badge> : null}
          </span>
        ),
        sortable: true,
        width: 280,
        sticky: true,
      },
      {
        id: 'backlinks',
        header: 'Links',
        accessor: (row) => row.backlinks,
        cell: (row) => <span className="tabular">{formatNumber(row.backlinks)}</span>,
        sortable: true,
        align: 'right',
        width: 100,
      },
      {
        id: 'domainAuthority',
        header: 'Authority',
        accessor: (row) => row.domainAuthority,
        cell: (row) =>
          row.domainAuthority === null ? (
            <span className="text-muted-foreground">Not reported</span>
          ) : (
            <span className="tabular">{row.domainAuthority}</span>
          ),
        sortable: true,
        align: 'right',
        width: 120,
      },
      {
        id: 'followed',
        header: 'Followed',
        accessor: (row) => (row.followed ? 1 : 0),
        cell: (row) => (
          <Badge variant={row.followed ? 'success' : 'muted'}>{row.followed ? 'Yes' : 'Nofollow only'}</Badge>
        ),
        sortable: true,
        width: 140,
      },
      {
        id: 'firstSeenAt',
        header: 'First seen',
        accessor: (row) => row.firstSeenAt,
        cell: (row) => dateCell(row.firstSeenAt),
        sortable: true,
        align: 'right',
        width: 130,
      },
    ],
    [],
  );

  return (
    <DataTable
      data={domains}
      columns={columns}
      getRowId={(row) => row.domain}
      caption="Referring domains ranked by the number of links they send"
      searchable
      searchPlaceholder="Search domains…"
      defaultSort="backlinks"
      defaultOrder="desc"
      itemLabel="domains"
      exportFilename="referring-domains"
      stickyHeader
      maxHeight={480}
      emptyTitle="No referring domains stored"
      emptyDescription="Import a backlink export or connect a provider to populate the profile."
      toolbarActions={
        <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
          Authority as reported by the source
          <TooltipInfo
            label="Where the authority number comes from"
            content="Whatever metric the import carried — Ahrefs DR, Moz DA, a vendor's own score. It is passed through untouched and never invented: a domain with no reported figure shows “Not reported” rather than a zero."
          />
        </span>
      }
    />
  );
}
