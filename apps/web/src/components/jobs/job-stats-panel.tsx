'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { BarChart3 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ProgressBar, type ProgressBarSegment, type ProgressTone } from '@/components/ui/progress-bar';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { JobStats, JobStatusValue } from './types';

const STATUS_TONE: Record<JobStatusValue, ProgressTone> = {
  COMPLETED: 'success',
  RUNNING: 'info',
  QUEUED: 'primary',
  DELAYED: 'warning',
  FAILED: 'destructive',
  CANCELLED: 'muted',
};

const STATUS_LABEL: Record<JobStatusValue, string> = {
  COMPLETED: 'Completed',
  RUNNING: 'Running',
  QUEUED: 'Queued',
  DELAYED: 'Delayed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
};

/**
 * Seven-day outcome mix.
 *
 * A single stacked bar rather than a chart library: the only question it answers is "what
 * fraction of recent work failed", and that reads faster from one bar with a legend than from
 * a set of axes.
 */
export function JobStatsPanel({ stats }: { stats: JobStats }): React.JSX.Element {
  const since = new Date(stats.since);
  const sinceLabel = Number.isNaN(since.getTime()) ? 'the last 7 days' : `since ${format(since, 'd MMM')}`;

  const segments: ProgressBarSegment[] = stats.byStatus
    .filter((entry) => entry.count > 0)
    .map((entry) => ({
      key: entry.status,
      label: STATUS_LABEL[entry.status],
      value: entry.count,
      tone: STATUS_TONE[entry.status],
    }));

  const failed = stats.byStatus.find((entry) => entry.status === 'FAILED')?.count ?? 0;
  const failureRate = stats.total > 0 ? failed / stats.total : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="size-4 text-muted-foreground" aria-hidden="true" />
          Last 7 days
        </CardTitle>
        <p className="col-start-1 text-xs text-muted-foreground">
          {formatNumber(stats.total)} job{stats.total === 1 ? '' : 's'} recorded {sinceLabel}
          {stats.total > 0 ? ` · ${formatPercent(failureRate, 1)} failed` : ''}
        </p>
      </CardHeader>
      <CardContent>
        {stats.total === 0 ? (
          <EmptyState
            size="sm"
            icon={BarChart3}
            title="No jobs in the last 7 days"
            description="Job history appears here once something runs — start a crawl, sync Search Console, or run an agent from a site's screens."
          />
        ) : (
          <ProgressBar
            label="Outcome mix"
            value={stats.total}
            max={stats.total}
            segments={segments}
            showLegend
            formatValue={(value) => `${formatNumber(value)} total`}
          />
        )}
      </CardContent>
    </Card>
  );
}
