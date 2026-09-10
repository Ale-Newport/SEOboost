'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Braces, CircleAlert, CircleCheck, ExternalLink, FileCode2, Rocket, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, humanizeStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { EnumFilter, FacetFilter } from '@/components/data/filter-bar';
import { StatusCell } from '@/components/data/status-cell';
import { UrlCell } from '@/components/data/url-cell';
import { useTableParams } from '@/components/data/use-table-params';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import { formatNumber, formatPercent } from '@/lib/utils';
import { DeclinedPanel } from './declined-panel';
import { ValidationBadge } from './json-ld-block';
import { SchemaItemSheet } from './schema-item-sheet';
import { ValidateJsonLdTool } from './validate-json-ld-tool';
import {
  DEPLOYMENT_STATUS_VALUES,
  VALIDATION_STATUS_VALUES,
  countErrors,
  toIssues,
  type GenerateResponse,
  type SchemaDeclinedResponse,
  type SchemaListResponse,
  type StructuredDataItemDto,
} from './types';

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });

const COVERAGE_EXPLANATION =
  'Distinct pages carrying at least one structured data block, over the count of active indexable pages ' +
  'from the last crawl. Site-wide blocks that are not attached to a page (Organization, WebSite) count ' +
  'towards neither side.';

export interface StructuredDataViewProps {
  websiteId: string;
  websiteName: string;
  siteUrl: string;
  hasCrawl: boolean;
  /** A connected adapter can inject the tag into the live page. */
  canDeploy: boolean;
  adapterLabel: string | null;
}

export function StructuredDataView({
  websiteId,
  websiteName,
  siteUrl,
  hasCrawl,
  canDeploy,
  adapterLabel,
}: StructuredDataViewProps): React.JSX.Element {
  const { page, pageSize, setPage, setPageSize, getParam, getParamList, hasActiveFilters, clearFilters } =
    useTableParams({ defaultPageSize: 25 });

  const schemaType = getParam('schemaType');
  const validationKey = getParamList('validationStatus').join(',');
  const deploymentKey = getParamList('deploymentStatus').join(',');

  const [data, setData] = useState<SchemaListResponse | null>(null);
  const [declined, setDeclined] = useState<SchemaDeclinedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [declinedLoading, setDeclinedLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [openItem, setOpenItem] = useState<StructuredDataItemDto | null>(null);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const query = new URLSearchParams({ websiteId, page: String(page), pageSize: String(pageSize) });
    if (schemaType) query.set('schemaType', schemaType);
    for (const value of validationKey.length > 0 ? validationKey.split(',') : []) {
      query.append('validationStatus', value);
    }
    for (const value of deploymentKey.length > 0 ? deploymentKey.split(',') : []) {
      query.append('deploymentStatus', value);
    }

    apiGet<SchemaListResponse>(`/api/schema?${query.toString()}`)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : 'The structured data could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [websiteId, page, pageSize, schemaType, validationKey, deploymentKey, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    setDeclinedLoading(true);

    apiGet<SchemaDeclinedResponse>(`/api/schema/declined?websiteId=${encodeURIComponent(websiteId)}`)
      .then((response) => {
        if (!cancelled) setDeclined(response);
      })
      .catch(() => {
        // A failed side query must not blank the table; the panel simply does not render.
        if (!cancelled) setDeclined(null);
      })
      .finally(() => {
        if (!cancelled) setDeclinedLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [websiteId, reloadToken]);

  const generate = useCallback(async (): Promise<void> => {
    setGenerating(true);
    try {
      const result = await apiPost<GenerateResponse>('/api/schema/generate', { websiteId });
      if (result.status === 'skipped') {
        toast.warning(result.reason ?? 'Generation did not run.', { description: result.fix });
        return;
      }
      if (result.job && result.job.enqueued === false) {
        toast.warning('Recorded, but no worker picked it up', { description: result.job.message });
      } else {
        toast.success('Schema generation queued', {
          description: `Reading ${formatNumber(result.pagesInScope ?? 0)} crawled pages. Only markup the page actually supports is written.`,
        });
      }
      refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : 'Generation could not be started.');
    } finally {
      setGenerating(false);
    }
  }, [websiteId, refresh]);

  const summary = data?.summary ?? null;
  const valid = summary?.byValidation.VALID ?? 0;
  const invalid = summary?.byValidation.INVALID ?? 0;
  const unvalidated = summary?.byValidation.UNVALIDATED ?? 0;
  const coverage =
    summary && summary.indexablePages > 0 ? summary.pagesWithSchema / summary.indexablePages : null;

  const typeOptions = useMemo(
    () =>
      Object.entries(summary?.byType ?? {})
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, label: value, count })),
    [summary],
  );

  const columns = useMemo<Array<ColumnDef<StructuredDataItemDto>>>(
    () => [
      {
        id: 'page',
        header: 'Page',
        width: 300,
        sticky: true,
        accessor: (row) => row.page?.url ?? '',
        cell: (row) =>
          row.page ? (
            <UrlCell url={row.page.url} label={row.page.title ?? undefined} maxLength={46} />
          ) : (
            <SimpleTooltip content="Organization, WebSite and similar blocks describe the site, not one page.">
              <span className="text-muted-foreground">Site-wide</span>
            </SimpleTooltip>
          ),
        exportValue: (row) => row.page?.url ?? 'site-wide',
      },
      {
        id: 'schemaType',
        header: 'Schema type',
        width: 150,
        accessor: (row) => row.schemaType,
        cell: (row) => (
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Braces className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {row.schemaType}
          </span>
        ),
      },
      {
        id: 'validationStatus',
        header: 'Validation',
        width: 260,
        accessor: (row) => row.validationStatus,
        cell: (row) => {
          const issues = toIssues(row.validationErrors);
          const errors = countErrors(issues);
          const first = issues.find((issue) => issue.severity === 'error') ?? issues[0];
          return (
            <div className="min-w-0 space-y-0.5">
              <ValidationBadge status={row.validationStatus} errorCount={errors} />
              {first ? (
                <p className="truncate text-2xs text-muted-foreground" title={`${first.path}: ${first.message}`}>
                  <span className="font-mono">{first.path}</span> — {first.message}
                </p>
              ) : null}
            </div>
          );
        },
        exportValue: (row) =>
          toIssues(row.validationErrors)
            .map((issue) => `${issue.severity}: ${issue.path} ${issue.message}`)
            .join(' | ') || row.validationStatus,
      },
      {
        id: 'deploymentStatus',
        header: 'Deployment',
        width: 130,
        accessor: (row) => row.deploymentStatus,
        cell: (row) => (
          <StatusCell
            status={row.deploymentStatus}
            detail={
              row.deployedAt
                ? `Last deployed ${DATE.format(new Date(row.deployedAt))}`
                : 'This block is not on the live page yet.'
            }
          />
        ),
      },
      {
        id: 'source',
        header: 'Source',
        width: 110,
        accessor: (row) => row.source,
        cell: (row) => <Badge variant="muted">{humanizeStatus(row.source)}</Badge>,
      },
      {
        id: 'updatedAt',
        header: 'Updated',
        width: 110,
        align: 'right',
        accessor: (row) => row.updatedAt,
        cell: (row) => <span className="tabular text-muted-foreground">{DATE.format(new Date(row.updatedAt))}</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Structured data"
        description={
          <>
            JSON-LD blocks, their validation errors and what is live on{' '}
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              {websiteName}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <ValidateJsonLdTool />
            <Button
              size="sm"
              onClick={() => void generate()}
              loading={generating}
              loadingText="Queueing"
              disabled={!hasCrawl}
            >
              <Sparkles className="size-3.5" aria-hidden="true" />
              Generate markup
            </Button>
          </div>
        }
      />

      {hasCrawl ? null : (
        <Alert variant="warning">
          <AlertTitle>This site has not been crawled yet</AlertTitle>
          <AlertDescription>
            Markup is generated from what is visibly on each page, so generation needs crawled page content.{' '}
            <Link href={`/sites/${websiteId}`}>Start a crawl from the site overview</Link>, then generate.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="Markup blocks"
          value={data ? formatNumber(data.total) : '—'}
          loading={loading && data === null}
          icon={FileCode2}
          info="Every JSON-LD block stored for this site, matching the filters below."
          footer={
            summary && Object.keys(summary.byType).length > 0
              ? `${formatNumber(Object.keys(summary.byType).length)} distinct schema types`
              : 'No types generated yet'
          }
        />
        <MetricCard
          label="Valid"
          value={summary ? formatNumber(valid) : '—'}
          loading={loading && data === null}
          icon={CircleCheck}
          info="Blocks whose last validation found no errors. Warnings still count as valid — they mean eligible but incomplete."
          footer={
            unvalidated > 0 ? `${formatNumber(unvalidated)} never validated` : 'Every block has been checked'
          }
        />
        <MetricCard
          label="With errors"
          value={summary ? formatNumber(invalid) : '—'}
          loading={loading && data === null}
          icon={CircleAlert}
          info="Blocks with at least one error. Search engines withhold rich results for these; deployment is blocked until they are fixed."
          footer={invalid > 0 ? 'Filter by “Invalid” to work through them' : 'Nothing is blocking rich results'}
        />
        <MetricCard
          label="Page coverage"
          value={coverage === null ? '—' : formatPercent(coverage, 0)}
          loading={loading && data === null}
          icon={Rocket}
          info={COVERAGE_EXPLANATION}
          footer={
            summary
              ? summary.indexablePages > 0
                ? `${formatNumber(summary.pagesWithSchema)} of ${formatNumber(summary.indexablePages)} indexable pages`
                : 'No indexable pages recorded — run a crawl'
              : undefined
          }
        />
      </div>

      {error === null ? null : <ErrorState message={error} onRetry={refresh} retryLabel="Try again" bordered />}

      <DeclinedPanel data={declined} loading={declinedLoading} />

      <DataTable
        data={data?.items ?? []}
        columns={columns}
        getRowId={(row) => row.id}
        loading={loading}
        caption="Structured data blocks with their validation and deployment status, most recently updated first"
        page={page}
        pageSize={pageSize}
        total={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        itemLabel="blocks"
        onRowClick={setOpenItem}
        exportable
        exportFilename={`structured-data-${websiteId}`}
        onClearFilters={hasActiveFilters ? clearFilters : undefined}
        toolbar={
          <>
            {/* Single-valued: the endpoint takes one `schemaType`, so a facet would 400. */}
            <EnumFilter paramKey="schemaType" label="Type" options={typeOptions} allLabel="All types" />
            <FacetFilter
              paramKey="validationStatus"
              label="Validation"
              options={VALIDATION_STATUS_VALUES.map((value) => ({
                value,
                label: humanizeStatus(value),
                ...(summary?.byValidation[value] === undefined ? {} : { count: summary.byValidation[value] }),
              }))}
            />
            <FacetFilter
              paramKey="deploymentStatus"
              label="Deployment"
              options={DEPLOYMENT_STATUS_VALUES.map((value) => ({ value, label: humanizeStatus(value) }))}
            />
          </>
        }
        emptyTitle={hasActiveFilters ? 'No blocks match these filters' : 'No structured data yet'}
        emptyDescription={
          hasActiveFilters
            ? 'Clear the filters to see every block stored for this site.'
            : hasCrawl
              ? 'Run “Generate markup” to derive JSON-LD from the crawled page content. The generator only marks up what is visibly on the page, so some pages will produce nothing — and it will tell you why.'
              : 'Crawl the site first: markup is derived from crawled page content, never invented.'
        }
      />

      <SchemaItemSheet
        item={openItem}
        websiteId={websiteId}
        open={openItem !== null}
        onOpenChange={(next) => {
          if (!next) setOpenItem(null);
        }}
        onChanged={refresh}
        canDeploy={canDeploy}
        adapterLabel={adapterLabel}
      />
    </div>
  );
}
