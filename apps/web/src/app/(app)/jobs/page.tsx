import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { JobStatus, type Prisma, checkDatabaseConnection, prisma } from '@seo/db';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@seo/shared/constants';
import { isConfigured } from '@seo/shared';
import { QUEUE_NAMES, getQueue, getQueueHealth, isJobName } from '@seo/queue';

import { PageHeader } from '@/components/ui/page-header';
import { JobsView } from '@/components/jobs/jobs-view';
import type { JobRow, JobStats, JobStatusValue, QueueHealthSummary, QueueLane } from '@/components/jobs/types';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Jobs' };
export const dynamic = 'force-dynamic';

const STATS_WINDOW_DAYS = 7;

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function many(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((entry) => entry !== '');
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function isJobStatus(value: string): value is JobStatusValue {
  return (Object.values(JobStatus) as string[]).includes(value);
}

function orderByFor(sort: string | undefined, order: Prisma.SortOrder): Prisma.JobRecordOrderByWithRelationInput[] {
  const primary: Prisma.JobRecordOrderByWithRelationInput =
    sort === 'jobName'
      ? { jobName: order }
      : sort === 'status'
        ? { status: order }
        : sort === 'durationMs'
          ? { durationMs: order }
          : sort === 'finishedAt'
            ? { finishedAt: order }
            : { createdAt: order };
  return [primary, { createdAt: 'desc' }];
}

/**
 * Workers attached per lane, straight from the broker.
 *
 * Each lane is asked independently and a failure degrades that lane to `null` rather than
 * failing the page — "we could not read this" and "nobody is attached" are different answers
 * and the operator has to be able to tell them apart.
 */
async function readWorkerCounts(): Promise<Map<string, number | null>> {
  const entries = await Promise.all(
    QUEUE_NAMES.map(async (name): Promise<[string, number | null]> => {
      const queue = getQueue(name);
      if (!queue) return [name, null];
      try {
        const workers = await queue.getWorkers();
        return [name, workers.length];
      } catch {
        return [name, null];
      }
    }),
  );
  return new Map(entries);
}

export default async function JobsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const params = await searchParams;

  const websites = await prisma.website.findMany({
    where: { userId: user.id },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  const ownedIds = websites.map((site) => site.id);
  const siteNames = new Map(websites.map((site) => [site.id, site.name]));

  const requestedSites = many(params.site).filter((id) => ownedIds.includes(id));
  const scopedIds = requestedSites.length > 0 ? requestedSites : ownedIds;
  const statuses = many(params.status).filter(isJobStatus);
  const queues = many(params.queue).filter((queue) => (QUEUE_NAMES as readonly string[]).includes(queue));
  const search = one(params.search)?.trim() ?? '';

  // Ownership is an explicit id list. Installation-wide jobs (reports, maintenance) belong to no
  // site and are only included when the reader has not narrowed to specific sites.
  const ownership: Prisma.JobRecordWhereInput[] = [{ websiteId: { in: scopedIds } }];
  if (requestedSites.length === 0) ownership.push({ websiteId: null });

  const where: Prisma.JobRecordWhereInput = {
    OR: ownership,
    ...(statuses.length > 0 ? { status: { in: statuses as JobStatus[] } } : {}),
    ...(queues.length > 0 ? { queue: { in: queues } } : {}),
    ...(search
      ? {
          AND: [
            {
              OR: [
                { jobName: { contains: search, mode: 'insensitive' } },
                { jobId: { contains: search, mode: 'insensitive' } },
                { error: { contains: search, mode: 'insensitive' } },
              ],
            },
          ],
        }
      : {}),
  };

  const scopeWhere: Prisma.JobRecordWhereInput = {
    OR: [{ websiteId: { in: ownedIds } }, { websiteId: null }],
  };
  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000);

  const [
    records,
    total,
    historyTotal,
    statusGroups,
    laneGroups,
    oldestQueued,
    lastStarted,
    queueHealth,
    database,
    workerCounts,
  ] = await Promise.all([
    prisma.jobRecord.findMany({
      where,
      orderBy: orderByFor(one(params.sort), one(params.order) === 'asc' ? 'asc' : 'desc'),
      skip: (positiveInt(one(params.page), 1, Number.MAX_SAFE_INTEGER) - 1) *
        positiveInt(one(params.pageSize), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      take: positiveInt(one(params.pageSize), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      select: {
        id: true,
        queue: true,
        jobName: true,
        jobId: true,
        status: true,
        progress: true,
        progressMessage: true,
        error: true,
        attempts: true,
        maxAttempts: true,
        websiteId: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
      },
    }),
    prisma.jobRecord.count({ where }),
    prisma.jobRecord.count({ where: scopeWhere }),
    prisma.jobRecord.groupBy({
      by: ['status'],
      where: { ...scopeWhere, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.jobRecord.groupBy({
      by: ['queue', 'status'],
      where: { ...scopeWhere, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.jobRecord.findFirst({
      where: { ...scopeWhere, status: { in: [JobStatus.QUEUED, JobStatus.DELAYED] } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    prisma.jobRecord.findFirst({
      where: { ...scopeWhere, startedAt: { not: null } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    }),
    getQueueHealth(),
    checkDatabaseConnection(),
    readWorkerCounts(),
  ]);

  const page = positiveInt(one(params.page), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInt(one(params.pageSize), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const rows: JobRow[] = records.map((record) => ({
    id: record.id,
    queue: record.queue,
    jobName: record.jobName,
    jobId: record.jobId,
    status: record.status,
    progress: record.progress,
    progressMessage: record.progressMessage,
    error: record.error,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    websiteId: record.websiteId,
    websiteName: record.websiteId ? (siteNames.get(record.websiteId) ?? null) : null,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    durationMs: record.durationMs,
    // A job whose name has left the catalogue can never be re-enqueued; the API refuses it too.
    retryable: isJobName(record.jobName),
  }));

  const brokerLanes = new Map(queueHealth.queues.map((lane) => [lane.queue as string, lane]));
  const recorded = new Map<string, { queued: number; running: number; failed: number }>();
  for (const group of laneGroups) {
    const lane = recorded.get(group.queue) ?? { queued: 0, running: 0, failed: 0 };
    const count = group._count._all;
    if (group.status === JobStatus.QUEUED || group.status === JobStatus.DELAYED) lane.queued += count;
    if (group.status === JobStatus.RUNNING) lane.running += count;
    if (group.status === JobStatus.FAILED) lane.failed += count;
    recorded.set(group.queue, lane);
  }

  const lanes: QueueLane[] = QUEUE_NAMES.map((name) => {
    const broker = brokerLanes.get(name);
    const db = recorded.get(name) ?? { queued: 0, running: 0, failed: 0 };
    return {
      queue: name,
      waiting: broker?.waiting ?? null,
      active: broker?.active ?? null,
      delayed: broker?.delayed ?? null,
      failed: broker?.failed ?? null,
      paused: broker?.paused ?? null,
      workers: workerCounts.get(name) ?? null,
      recordedQueued: db.queued,
      recordedRunning: db.running,
      recordedFailed: db.failed,
    };
  });

  const knownWorkerCounts = lanes.map((lane) => lane.workers).filter((count): count is number => count !== null);
  const health: QueueHealthSummary = {
    redisOk: queueHealth.redis.ok,
    redisConfigured: isConfigured.redis(),
    redisStatus: queueHealth.redis.status,
    redisError: queueHealth.redis.error ?? null,
    // Highest per-lane count rather than a sum: one worker usually consumes several lanes, so
    // adding them up would report three workers where one is attached.
    workers: knownWorkerCounts.length > 0 ? Math.max(...knownWorkerCounts) : null,
    lanes,
    oldestQueuedAt: oldestQueued?.createdAt.toISOString() ?? null,
    lastWorkerActivityAt: lastStarted?.startedAt?.toISOString() ?? null,
    databaseOk: database.ok,
  };

  const byStatus = (Object.values(JobStatus) as JobStatusValue[]).map((status) => ({
    status,
    count: statusGroups.find((group) => group.status === status)?._count._all ?? 0,
  }));

  const stats: JobStats = {
    since: since.toISOString(),
    total: byStatus.reduce((sum, entry) => sum + entry.count, 0),
    byStatus,
  };

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Jobs"
        description="Every background job this installation has run, and the health of the queue that runs them."
      />

      <JobsView
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        health={health}
        stats={stats}
        sites={websites}
        queues={[...QUEUE_NAMES]}
        historyEmpty={historyTotal === 0}
      />
    </div>
  );
}
