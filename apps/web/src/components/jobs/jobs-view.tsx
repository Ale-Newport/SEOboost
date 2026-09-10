'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatDistanceToNowStrict } from 'date-fns';
import { Activity, RefreshCw, RotateCw, X } from 'lucide-react';
import { toast } from 'sonner';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Progress } from '@/components/ui/progress';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { DataTable, type ColumnDef } from '@/components/data/data-table';
import { FacetFilter, FilterBar, useFilterPills } from '@/components/data/filter-bar';
import { useTableParams } from '@/components/data/use-table-params';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn, formatNumber } from '@/lib/utils';
import { JobDetailSheet } from './job-detail-sheet';
import { JobStatsPanel } from './job-stats-panel';
import { QueueHealthPanel } from './queue-health-panel';
import {
  ACTIVE_JOB_STATUSES,
  JOB_STATUS_VALUES,
  type JobRow,
  type JobSiteOption,
  type JobStats,
  type QueueHealthSummary,
} from './types';

/** Poll cadence while anything is in flight. Fast enough to feel live, slow enough to be free. */
const POLL_MS = 4_000;

const FILTER_LABELS = {
  status: { label: 'Status', formatValue: (value: string) => humanise(value) },
  queue: { label: 'Queue' },
  site: { label: 'Site' },
} as const;

function humanise(value: string): string {
  const lower = value.replace(/[_-]+/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function relative(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface JobsViewProps {
  rows: readonly JobRow[];
  total: number;
  page: number;
  pageSize: number;
  health: QueueHealthSummary;
  stats: JobStats;
  sites: readonly JobSiteOption[];
  queues: readonly string[];
  /** True when the install has never recorded a job, filters aside. */
  historyEmpty: boolean;
}

/**
 * The operations screen.
 *
 * The list is rendered by the server component above this one from Postgres, so it keeps
 * working with the broker down; this component adds the live behaviour — polling while
 * something is running, and the two mutations (cancel, retry).
 */
export function JobsView({
  rows,
  total,
  page,
  pageSize,
  health,
  stats,
  sites,
  queues,
  historyEmpty,
}: JobsViewProps): React.JSX.Element {
  const router = useRouter();
  const params = useTableParams({ defaultSort: 'createdAt', defaultOrder: 'desc' });
  const pills = useFilterPills(FILTER_LABELS);

  const [selected, setSelected] = React.useState<JobRow | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);

  const hasActive = rows.some((row) => ACTIVE_JOB_STATUSES.includes(row.status));

  // Keep the open sheet pointing at the freshest copy of its row as polls land.
  React.useEffect(() => {
    setSelected((current) => (current === null ? null : rows.find((row) => row.id === current.id) ?? current));
  }, [rows]);

  React.useEffect(() => {
    if (!hasActive) return;
    let disposed = false;

    const tick = (): void => {
      // A hidden tab has nobody watching; skip the round trip entirely.
      if (disposed || document.visibilityState !== 'visible') return;
      router.refresh();
    };

    const timer = window.setInterval(tick, POLL_MS);
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [hasActive, router]);

  const refreshNow = React.useCallback((): void => {
    setRefreshing(true);
    router.refresh();
    // Purely cosmetic: `router.refresh()` resolves when the server component re-renders, which
    // this component cannot await, so the spinner is time-boxed instead of left spinning.
    window.setTimeout(() => setRefreshing(false), 800);
  }, [router]);

  const cancelJob = React.useCallback(
    async (job: JobRow): Promise<void> => {
      setBusyId(job.id);
      try {
        const result = await apiPost<{ cancelled?: boolean; message?: string }>(
          `/api/jobs/${job.id}/cancel`,
          {},
        );
        toast.success(result.message ?? 'Job cancelled.');
        router.refresh();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not cancel that job.');
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const retryJob = React.useCallback(
    async (job: JobRow): Promise<void> => {
      setBusyId(job.id);
      try {
        const result = await apiPost<{ job?: { enqueued: boolean; message: string } }>(
          `/api/jobs/${job.id}/retry`,
          {},
        );
        if (result.job && result.job.enqueued === false) {
          toast.warning('Re-queued in the database only', { description: result.job.message });
        } else {
          toast.success('Job re-queued.', { description: 'The original failure stays in the history.' });
        }
        router.refresh();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'Could not retry that job.');
      } finally {
        setBusyId(null);
      }
    },
    [router],
  );

  const openDetail = React.useCallback((job: JobRow): void => {
    setSelected(job);
    setSheetOpen(true);
  }, []);

  const columns = React.useMemo<Array<ColumnDef<JobRow>>>(
    () => [
      {
        id: 'jobName',
        header: 'Job',
        accessor: (row) => row.jobName,
        sortable: true,
        sticky: true,
        width: 260,
        cell: (row) => (
          <div className="min-w-0">
            <p className="truncate font-mono text-2xs font-medium text-foreground">{row.jobName}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Badge variant="muted">{row.queue}</Badge>
              {row.jobId === null ? (
                <SimpleTooltip content="Recorded in the database but never accepted by the broker.">
                  <span className="text-warning">not queued</span>
                </SimpleTooltip>
              ) : null}
            </p>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessor: (row) => row.status,
        sortable: true,
        width: 110,
        cell: (row) => <StatusBadge status={row.status} />,
      },
      {
        id: 'site',
        header: 'Site',
        accessor: (row) => row.websiteName ?? '',
        width: 160,
        cell: (row) =>
          row.websiteId && row.websiteName ? (
            <Link
              href={`/sites/${row.websiteId}`}
              className="truncate text-xs text-foreground hover:underline"
              data-row-ignore
            >
              {row.websiteName}
            </Link>
          ) : (
            <span className="text-2xs text-muted-foreground">Installation-wide</span>
          ),
      },
      {
        id: 'progress',
        header: 'Progress',
        accessor: (row) => row.progress,
        width: 200,
        exportValue: (row) => row.progress,
        cell: (row) => {
          const active = ACTIVE_JOB_STATUSES.includes(row.status);
          if (!active && row.status === 'COMPLETED') {
            return <span className="text-2xs text-muted-foreground">Done</span>;
          }
          if (!active) {
            return (
              <span className="line-clamp-1 text-2xs text-muted-foreground" title={row.error ?? undefined}>
                {row.error ?? row.progressMessage ?? '—'}
              </span>
            );
          }
          return (
            <div className="min-w-0 space-y-1">
              <Progress value={row.progress} className="h-1.5" />
              <p className="truncate text-2xs text-muted-foreground">
                {row.progressMessage ?? (row.status === 'RUNNING' ? 'Running…' : 'Waiting for a worker…')}
              </p>
            </div>
          );
        },
      },
      {
        id: 'attempts',
        header: 'Tries',
        accessor: (row) => row.attempts,
        align: 'right',
        width: 80,
        cell: (row) => (
          <span
            className={cn(
              'tabular text-xs',
              row.attempts > 1 ? 'font-medium text-warning' : 'text-muted-foreground',
            )}
          >
            {formatNumber(row.attempts)}/{formatNumber(row.maxAttempts)}
          </span>
        ),
      },
      {
        id: 'durationMs',
        header: 'Duration',
        accessor: (row) => row.durationMs,
        sortable: true,
        align: 'right',
        width: 100,
        cell: (row) => <span className="tabular text-xs text-muted-foreground">{duration(row.durationMs)}</span>,
      },
      {
        id: 'createdAt',
        header: 'Created',
        accessor: (row) => row.createdAt,
        sortable: true,
        width: 130,
        cell: (row) => <span className="text-2xs text-muted-foreground">{relative(row.createdAt)}</span>,
      },
      {
        id: 'finishedAt',
        header: 'Finished',
        accessor: (row) => row.finishedAt,
        sortable: true,
        width: 130,
        defaultHidden: true,
        cell: (row) => <span className="text-2xs text-muted-foreground">{relative(row.finishedAt)}</span>,
      },
      {
        id: 'actions',
        header: '',
        headerLabel: 'Actions',
        accessor: () => '',
        width: 96,
        align: 'right',
        cell: (row) => {
          const active = ACTIVE_JOB_STATUSES.includes(row.status);
          const busy = busyId === row.id;
          if (active) {
            return (
              <SimpleTooltip content="Cancel — a running job stops at its next checkpoint.">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Cancel ${row.jobName}`}
                  disabled={busy}
                  onClick={() => void cancelJob(row)}
                >
                  <X aria-hidden="true" />
                </Button>
              </SimpleTooltip>
            );
          }
          if (!row.retryable) return <span className="text-2xs text-muted-foreground">—</span>;
          return (
            <SimpleTooltip content="Retry — creates a new run from the same payload.">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Retry ${row.jobName}`}
                disabled={busy}
                onClick={() => void retryJob(row)}
              >
                <RotateCw aria-hidden="true" />
              </Button>
            </SimpleTooltip>
          );
        },
      },
    ],
    [busyId, cancelJob, retryJob],
  );

  return (
    <div className="space-y-6">
      <QueueHealthPanel health={health} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)]">
        <JobStatsPanel stats={stats} />
      </div>

      {historyEmpty ? (
        <EmptyState
          bordered
          icon={Activity}
          title="No jobs have run yet"
          description="Everything this platform does in the background lands here: crawls, Search Console syncs, analyses, content generation and reports. Start a crawl from a site's overview and the job will appear within seconds."
          action={
            <Button asChild size="sm">
              <Link href="/sites">Go to your sites</Link>
            </Button>
          }
        />
      ) : (
        <DataTable<JobRow>
          data={rows}
          columns={columns}
          getRowId={(row) => row.id}
          caption="Background jobs, newest first"
          searchable
          manualSearch
          search={params.searchInput}
          onSearchChange={params.setSearch}
          searchPlaceholder="Search job name, broker id or error…"
          sort={params.sort}
          order={params.order}
          onSortChange={(id, order) => params.setSort(id, order)}
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={params.setPage}
          onPageSizeChange={params.setPageSize}
          itemLabel="job"
          onRowClick={openDetail}
          filterPills={pills}
          onClearFilters={params.clearFilters}
          stickyHeader
          maxHeight="70vh"
          toolbar={
            <FilterBar>
              <FacetFilter
                paramKey="status"
                label="Status"
                options={JOB_STATUS_VALUES.map((status) => ({ value: status, label: humanise(status) }))}
              />
              <FacetFilter
                paramKey="queue"
                label="Queue"
                options={queues.map((queue) => ({ value: queue, label: queue }))}
              />
              {sites.length > 1 ? (
                <FacetFilter
                  paramKey="site"
                  label="Site"
                  options={sites.map((site) => ({ value: site.id, label: site.name }))}
                  searchable
                />
              ) : null}
            </FilterBar>
          }
          toolbarActions={
            <div className="flex items-center gap-2">
              {hasActive ? (
                <span className="flex items-center gap-1.5 text-2xs text-muted-foreground" role="status">
                  <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-info" />
                  Live
                </span>
              ) : null}
              <Button variant="outline" size="sm" onClick={refreshNow} disabled={refreshing}>
                <RefreshCw className={cn(refreshing && 'animate-spin')} aria-hidden="true" />
                Refresh
              </Button>
            </div>
          }
          emptyState={
            <EmptyState
              size="sm"
              icon={Activity}
              title="No jobs match these filters"
              description="Widen the status, queue or site filter to see more of the history."
              action={
                <Button variant="outline" size="sm" onClick={params.clearFilters}>
                  Clear filters
                </Button>
              }
            />
          }
        />
      )}

      <JobDetailSheet
        job={selected}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onCancel={(job) => void cancelJob(job)}
        onRetry={(job) => void retryJob(job)}
        busyJobId={busyId}
      />
    </div>
  );
}
