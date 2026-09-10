'use client';

import * as React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { z } from 'zod';

import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ErrorState } from '@/components/ui/error-state';
import { Progress } from '@/components/ui/progress';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SkeletonText } from '@/components/ui/skeleton';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { ApiError, apiGet } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';
import type { JobRow } from './types';

const detailSchema = z.object({
  id: z.string(),
  payload: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.string().nullish(),
  lane: z.string().nullish(),
  retryable: z.boolean().optional(),
  website: z.object({ id: z.string(), name: z.string(), domain: z.string() }).nullish(),
});

type JobDetail = z.infer<typeof detailSchema>;

function pretty(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isEmptyPayload(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function timestamp(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : format(date, 'd MMM yyyy, HH:mm:ss');
}

/** `humanDuration` lives behind the shared barrel, which is server-only; this is its client twin. */
function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function CodeBlock({ title, value }: { title: string; value: string }): React.JSX.Element {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        <CopyButton value={value} label={`Copy ${title.toLowerCase()}`} className="size-7" />
      </div>
      <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed text-muted-foreground">
        <code>{value}</code>
      </pre>
    </section>
  );
}

export interface JobDetailSheetProps {
  job: JobRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancel: (job: JobRow) => void;
  onRetry: (job: JobRow) => void;
  busyJobId: string | null;
}

/**
 * The full record for one job: what it was asked to do, what it produced, and how it failed.
 *
 * The payload, result and error stack are fetched on open rather than shipped with every table
 * row — a page of fifty jobs would otherwise carry fifty JSON blobs the reader never looks at.
 */
export function JobDetailSheet({
  job,
  open,
  onOpenChange,
  onCancel,
  onRetry,
  busyJobId,
}: JobDetailSheetProps): React.JSX.Element {
  const [detail, setDetail] = React.useState<JobDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const jobId = job?.id ?? null;

  const load = React.useCallback(async (id: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const payload = await apiGet<unknown>(`/api/jobs/${id}`);
      const parsed = detailSchema.safeParse(payload);
      if (!parsed.success) {
        setError('The job record came back in an unexpected shape.');
        setDetail(null);
        return;
      }
      setDetail(parsed.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this job.');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open || jobId === null) {
      setDetail(null);
      return;
    }
    void load(jobId);
  }, [open, jobId, load]);

  const isActive = job !== null && (job.status === 'RUNNING' || job.status === 'QUEUED' || job.status === 'DELAYED');
  const busy = job !== null && busyJobId === job.id;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl">
        {job === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm">{job.jobName}</span>
                <StatusBadge status={job.status} />
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="muted">{job.queue}</Badge>
                {job.websiteId && job.websiteName ? (
                  <Link href={`/sites/${job.websiteId}`} className="text-xs text-primary hover:underline">
                    {job.websiteName}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">Installation-wide job</span>
                )}
              </SheetDescription>
            </SheetHeader>

            <SheetBody className="space-y-5 py-1">
              {isActive ? (
                <div className="space-y-1.5">
                  <Progress value={job.progress} />
                  <p className="text-2xs text-muted-foreground">
                    {job.progressMessage ?? (job.status === 'RUNNING' ? 'Running…' : 'Waiting for a worker…')}
                    {job.progress > 0 ? ` · ${job.progress}%` : ''}
                  </p>
                </div>
              ) : null}

              <StatList divided dense>
                <StatListItem label="Job record" value={job.id} mono copyValue={job.id} />
                <StatListItem
                  label="Broker job id"
                  value={job.jobId ?? 'Never accepted by the broker'}
                  mono={job.jobId !== null}
                  muted={job.jobId === null}
                  {...(job.jobId ? { copyValue: job.jobId } : {})}
                  hint="Empty when the job was recorded in the database but Redis was unavailable to accept it."
                />
                <StatListItem
                  label="Attempts"
                  value={`${formatNumber(job.attempts)} of ${formatNumber(job.maxAttempts)}`}
                />
                <StatListItem label="Created" value={timestamp(job.createdAt)} />
                <StatListItem label="Started" value={timestamp(job.startedAt)} muted={job.startedAt === null} />
                <StatListItem label="Finished" value={timestamp(job.finishedAt)} muted={job.finishedAt === null} />
                <StatListItem label="Duration" value={duration(job.durationMs)} muted={job.durationMs === null} />
              </StatList>

              {loading ? (
                <SkeletonText lines={6} />
              ) : error ? (
                <ErrorState
                  bordered
                  message={error}
                  onRetry={() => void load(job.id)}
                  retryLabel="Try again"
                />
              ) : detail ? (
                <>
                  {job.error || detail.error ? (
                    <section className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold text-destructive">Error</h3>
                        <CopyButton value={detail.error ?? job.error ?? ''} label="Copy the error" className="size-7" />
                      </div>
                      <pre className="max-h-64 overflow-auto rounded-md border border-destructive/30 bg-destructive/[0.07] p-2.5 text-2xs leading-relaxed text-destructive">
                        <code>{detail.error ?? job.error}</code>
                      </pre>
                    </section>
                  ) : null}

                  {isEmptyPayload(detail.payload) ? (
                    <p className="text-xs text-muted-foreground">This job carried no payload.</p>
                  ) : (
                    <CodeBlock title="Payload" value={pretty(detail.payload)} />
                  )}

                  {isEmptyPayload(detail.result) ? (
                    <p className="text-xs text-muted-foreground">
                      {job.status === 'COMPLETED'
                        ? 'The job completed without writing a result payload.'
                        : 'No result yet.'}
                    </p>
                  ) : (
                    <CodeBlock title="Result" value={pretty(detail.result)} />
                  )}
                </>
              ) : null}
            </SheetBody>

            <SheetFooter>
              {isActive ? (
                <Button variant="outline" onClick={() => onCancel(job)} loading={busy} loadingText="Cancelling">
                  Cancel job
                </Button>
              ) : null}
              {!isActive && job.retryable ? (
                <Button onClick={() => onRetry(job)} loading={busy} loadingText="Re-queueing">
                  Retry job
                </Button>
              ) : null}
              {!isActive && !job.retryable ? (
                <p className="text-2xs text-muted-foreground">
                  This job&rsquo;s name is not in the current job catalogue, so it cannot be re-queued.
                </p>
              ) : null}
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
