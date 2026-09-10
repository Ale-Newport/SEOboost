'use client';

import * as React from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { Activity, Database, PlugZap, ServerCog } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { cn, formatNumber } from '@/lib/utils';
import type { QueueHealthSummary } from './types';

/** How long a job may sit QUEUED before the screen calls it out as stuck. */
const STUCK_QUEUE_MINUTES = 10;

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

function minutesSince(iso: string | null): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (Date.now() - date.getTime()) / 60_000;
}

/**
 * Broker and worker state.
 *
 * An unreachable Redis is the single most consequential thing this screen can report — every
 * job silently stops moving — so it is rendered as its own explanation of what will happen and
 * what to do, never as a generic "failed to load" error.
 */
export function QueueHealthPanel({ health }: { health: QueueHealthSummary }): React.JSX.Element {
  const stuckMinutes = minutesSince(health.oldestQueuedAt);
  const queueIsStuck = stuckMinutes !== null && stuckMinutes > STUCK_QUEUE_MINUTES;
  const noWorkers = health.redisOk && health.workers === 0;

  const totalWaiting = health.lanes.reduce((sum, lane) => sum + (lane.waiting ?? 0), 0);
  const totalActive = health.lanes.reduce((sum, lane) => sum + (lane.active ?? 0), 0);
  const totalFailed = health.lanes.reduce((sum, lane) => sum + (lane.failed ?? 0), 0);
  const recordedQueued = health.lanes.reduce((sum, lane) => sum + lane.recordedQueued, 0);

  return (
    <div className="space-y-4">
      {!health.redisConfigured ? (
        <Alert variant="warning" icon={PlugZap}>
          <AlertTitle>No queue broker is configured — nothing will run</AlertTitle>
          <AlertDescription>
            <p>
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">REDIS_URL</code> is not
              set, so every job you trigger is written to the database and then waits. Crawls, syncs,
              analyses, content generation and report generation will all stay <strong>queued</strong>{' '}
              until a broker is reachable and a worker process is connected.
            </p>
            <p className="mt-1.5">
              Set <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">REDIS_URL</code> in
              the environment, start the worker with{' '}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">npm run dev:worker</code>,
              then retry the queued jobs from the table below — none of them are lost.
            </p>
          </AlertDescription>
        </Alert>
      ) : !health.redisOk ? (
        <Alert variant="destructive" icon={PlugZap}>
          <AlertTitle>The queue broker is unreachable — jobs are queuing, not running</AlertTitle>
          <AlertDescription>
            <p>
              Redis is configured but the connection is <strong>{health.redisStatus}</strong>
              {health.redisError ? `: ${health.redisError}` : '.'} Jobs are still being recorded, so
              nothing is lost, but no worker can pick them up until the broker is back.
            </p>
            <p className="mt-1.5">
              Check that the Redis instance is running and reachable from this process, then reload.
              Queued jobs resume on their own; failed ones can be retried from the table.
            </p>
          </AlertDescription>
        </Alert>
      ) : noWorkers ? (
        <Alert variant="warning" icon={ServerCog}>
          <AlertTitle>Redis is healthy but no worker is attached</AlertTitle>
          <AlertDescription>
            The broker accepted {formatNumber(totalWaiting)} waiting job
            {totalWaiting === 1 ? '' : 's'}, but no worker process is consuming any lane. Start the
            worker (<code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">npm run dev:worker</code>{' '}
            in development, the <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs">worker</code>{' '}
            service in production) and these jobs will start immediately.
          </AlertDescription>
        </Alert>
      ) : queueIsStuck ? (
        <Alert variant="warning" icon={Activity}>
          <AlertTitle>Jobs have been waiting for more than {STUCK_QUEUE_MINUTES} minutes</AlertTitle>
          <AlertDescription>
            The oldest queued job was created {relative(health.oldestQueuedAt)} and has not started.
            The broker is reachable and {formatNumber(health.workers ?? 0)} worker
            {health.workers === 1 ? ' is' : 's are'} attached, so the lane is most likely saturated or
            a job is holding a lock. The last time any job started was {relative(health.lastWorkerActivityAt)}.
          </AlertDescription>
        </Alert>
      ) : null}

      {!health.databaseOk ? (
        <Alert variant="destructive" icon={Database}>
          <AlertTitle>The database is unreachable</AlertTitle>
          <AlertDescription>
            Job history is stored in Postgres. Until the connection is restored this screen cannot
            show reliable counts and no new job can be recorded.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <ServerCog className="size-4 text-muted-foreground" aria-hidden="true" />
            Queue health
          </CardTitle>
          <div className="col-start-2 row-start-1 flex items-center gap-2 justify-self-end">
            <Badge variant={health.redisOk ? 'success' : health.redisConfigured ? 'destructive' : 'muted'}>
              Redis: {health.redisConfigured ? health.redisStatus : 'not configured'}
            </Badge>
            <Badge variant={health.workers === null ? 'muted' : health.workers > 0 ? 'success' : 'warning'}>
              {health.workers === null
                ? 'Workers: unknown'
                : `${formatNumber(health.workers)} worker${health.workers === 1 ? '' : 's'}`}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryTile label="Waiting" value={health.redisOk ? totalWaiting : null} fallback={recordedQueued} fallbackLabel="recorded in the database" />
            <SummaryTile label="Active" value={health.redisOk ? totalActive : null} />
            <SummaryTile label="Failed in Redis" value={health.redisOk ? totalFailed : null} tone={totalFailed > 0 ? 'destructive' : undefined} />
            <SummaryTile label="Last job started" text={relative(health.lastWorkerActivityAt)} />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-xs">
              <caption className="sr-only">Per-queue depth and worker attachment</caption>
              <thead>
                <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 text-left font-medium">Lane</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Waiting</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Active</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Delayed</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Failed</th>
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">Workers</th>
                  <th scope="col" className="py-1.5 pl-2 text-right font-medium">Recorded (7d)</th>
                </tr>
              </thead>
              <tbody>
                {health.lanes.map((lane) => (
                  <tr key={lane.queue} className="border-b border-border/60 last:border-b-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium text-foreground">
                      {lane.queue}
                    </th>
                    <LaneCell value={lane.waiting} />
                    <LaneCell value={lane.active} highlight={(lane.active ?? 0) > 0} />
                    <LaneCell value={lane.delayed} />
                    <LaneCell value={lane.failed} destructive={(lane.failed ?? 0) > 0} />
                    <LaneCell value={lane.workers} muted={lane.workers === 0} />
                    <td className="tabular py-1.5 pl-2 text-right text-muted-foreground">
                      {formatNumber(lane.recordedQueued + lane.recordedRunning + lane.recordedFailed)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!health.redisOk ? (
            <StatList divided dense>
              <StatListItem
                label="Jobs recorded as queued"
                value={formatNumber(recordedQueued)}
                hint="Read from Postgres. These are the jobs a worker will pick up the moment a broker is reachable."
              />
              <StatListItem label="Oldest queued job" value={relative(health.oldestQueuedAt)} />
            </StatList>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  text,
  fallback,
  fallbackLabel,
  tone,
}: {
  label: string;
  value?: number | null;
  text?: string;
  fallback?: number;
  fallbackLabel?: string;
  tone?: 'destructive';
}): React.JSX.Element {
  const unavailable = value === null || value === undefined;

  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
      <p className="text-2xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          'tabular mt-0.5 text-lg font-semibold leading-none',
          tone === 'destructive' ? 'text-destructive' : 'text-foreground',
        )}
      >
        {text ?? (unavailable ? '—' : formatNumber(value))}
      </p>
      {unavailable && fallback !== undefined ? (
        <p className="mt-1 text-2xs text-muted-foreground">
          {formatNumber(fallback)} {fallbackLabel}
        </p>
      ) : null}
    </div>
  );
}

function LaneCell({
  value,
  highlight = false,
  destructive = false,
  muted = false,
}: {
  value: number | null;
  highlight?: boolean;
  destructive?: boolean;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <td
      className={cn(
        'tabular px-2 py-1.5 text-right',
        value === null && 'text-muted-foreground',
        highlight && 'font-medium text-foreground',
        destructive && 'font-medium text-destructive',
        muted && 'text-warning',
      )}
    >
      {value === null ? '—' : formatNumber(value)}
    </td>
  );
}
