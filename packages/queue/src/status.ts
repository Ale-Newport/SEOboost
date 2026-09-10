/**
 * Read models for the Jobs screen, plus the two mutations it offers (cancel and retry).
 *
 * Everything the screen lists comes from Postgres, never from Redis. That is what makes the
 * screen work during a broker outage, and it is why `JobRecord` — not the BullMQ job — is the
 * thing this module cancels, retries and prunes. Redis is consulted only where it adds
 * something Postgres cannot know: live queue depth, and actually pulling a job off the queue.
 *
 * Nothing here throws because Redis is missing. `getQueueHealth()` reports the outage as data,
 * and `cancelJob()` still cancels — the durable row is the signal the worker polls.
 */

import {
  type JobRecord,
  JobStatus,
  type Prisma,
  json,
  prisma,
  buildPaginated,
  paginate,
  readJson,
} from '@seo/db';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  NotFoundError,
  type Paginated,
  ValidationError,
  clamp,
  createLogger,
  errorMessage,
  withTimeout,
} from '@seo/shared';
import { checkRedisConnection, redisStatus } from './connection';
import { type EnqueueResult, enqueue, getQueue } from './queue';
import { markJobCancelled } from './worker-runtime';
import {
  QUEUE_NAMES,
  type AnyJobPayload,
  type QueueName,
  isJobName,
  isQueueName,
  queueForJob,
} from './types';

const log = createLogger('queue:status');

/** Bounds every Redis round-trip so an unreachable broker degrades instead of hanging. */
const BROKER_TIMEOUT_MS = 5_000;

/** Statuses that mean the job is done and will not move again on its own. */
const TERMINAL_STATUSES: JobStatus[] = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
];

/** Retention floor for `cleanupOldJobs`: recent history is what makes a failure debuggable. */
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 30;

/** Rows deleted per statement, so a first cleanup on a large table stays interruptible. */
const CLEANUP_BATCH = 1_000;
const CLEANUP_MAX_BATCHES = 500;

const STATS_WINDOW_DAYS = 7;

// ─────────────────────────────────────────────────────────────
// listJobs
// ─────────────────────────────────────────────────────────────

export interface ListJobsOptions {
  /** Omit for every job; pass `null` for the portfolio-wide jobs that belong to no site. */
  websiteId?: string | null;
  status?: JobStatus | JobStatus[];
  queue?: QueueName;
  page?: number;
  pageSize?: number;
  /** Matches job name, broker job id, or error text. */
  search?: string;
}

function buildWhere(opts: ListJobsOptions): Prisma.JobRecordWhereInput {
  const statuses = opts.status === undefined ? [] : [opts.status].flat();
  const search = opts.search?.trim();

  return {
    ...(opts.websiteId === undefined ? {} : { websiteId: opts.websiteId }),
    ...(statuses.length > 0 ? { status: { in: statuses } } : {}),
    ...(opts.queue ? { queue: opts.queue } : {}),
    ...(search
      ? {
          OR: [
            { jobName: { contains: search, mode: 'insensitive' } },
            { jobId: { contains: search, mode: 'insensitive' } },
            { error: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

/** One page of job history, newest first. */
export async function listJobs(opts: ListJobsOptions = {}): Promise<Paginated<JobRecord>> {
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.floor(clamp(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE));
  const where = buildWhere(opts);

  const [items, total] = await Promise.all([
    prisma.jobRecord.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...paginate(page, pageSize),
    }),
    prisma.jobRecord.count({ where }),
  ]);

  return buildPaginated(items, total, page, pageSize);
}

/** One job row, or `null`. Callers that need a 404 raise it themselves. */
export async function getJob(id: string): Promise<JobRecord | null> {
  return prisma.jobRecord.findUnique({ where: { id } });
}

// ─────────────────────────────────────────────────────────────
// getJobStats
// ─────────────────────────────────────────────────────────────

export interface JobQueueStats {
  queue: string;
  total: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
}

export interface JobStats {
  /** Start of the window these counts cover. */
  since: Date;
  total: number;
  byStatus: Record<JobStatus, number>;
  byQueue: JobQueueStats[];
}

function emptyStatusCounts(): Record<JobStatus, number> {
  const counts = {} as Record<JobStatus, number>;
  for (const status of Object.values(JobStatus)) counts[status] = 0;
  return counts;
}

/**
 * Status and per-lane counts over the last seven days.
 *
 * One `groupBy` covers both breakdowns: grouping by `(queue, status)` and folding it twice is a
 * single round-trip, where two separate aggregates would be two — and could disagree if a job
 * changed status between them.
 */
export async function getJobStats(websiteId?: string | null): Promise<JobStats> {
  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1_000);

  const groups = await prisma.jobRecord.groupBy({
    by: ['queue', 'status'],
    where: {
      createdAt: { gte: since },
      ...(websiteId === undefined ? {} : { websiteId }),
    },
    _count: { _all: true },
  });

  const byStatus = emptyStatusCounts();
  const laneCounts = new Map<string, JobQueueStats>();
  let total = 0;

  for (const group of groups) {
    const count = group._count._all;
    total += count;
    byStatus[group.status] += count;

    const lane = laneCounts.get(group.queue) ?? {
      queue: group.queue,
      total: 0,
      running: 0,
      queued: 0,
      completed: 0,
      failed: 0,
    };
    lane.total += count;
    if (group.status === JobStatus.RUNNING) lane.running += count;
    if (group.status === JobStatus.QUEUED || group.status === JobStatus.DELAYED) {
      lane.queued += count;
    }
    if (group.status === JobStatus.COMPLETED) lane.completed += count;
    if (group.status === JobStatus.FAILED) lane.failed += count;
    laneCounts.set(group.queue, lane);
  }

  // Known lanes first and always present, so the UI's row order does not jump around as
  // activity moves between them; unrecognised lanes (a renamed job) are appended, not dropped.
  const byQueue: JobQueueStats[] = QUEUE_NAMES.map(
    (name) =>
      laneCounts.get(name) ?? {
        queue: name,
        total: 0,
        running: 0,
        queued: 0,
        completed: 0,
        failed: 0,
      },
  );
  for (const [name, stats] of laneCounts) {
    if (!isQueueName(name)) byQueue.push(stats);
  }

  return { since, total, byStatus, byQueue };
}

// ─────────────────────────────────────────────────────────────
// Broker helpers
// ─────────────────────────────────────────────────────────────

/** The lane a row belongs to: the catalogue wins over the stored column, which can be stale. */
function laneOf(row: Pick<JobRecord, 'queue' | 'jobName'>): QueueName | null {
  if (isJobName(row.jobName)) return queueForJob(row.jobName);
  return isQueueName(row.queue) ? row.queue : null;
}

/**
 * Pulls a job off the broker. An *active* job holds a BullMQ lock and cannot be removed —
 * that is not an error here: the worker notices the CANCELLED row on its next
 * `ctx.isCancelled()` poll and stops on its own.
 */
async function removeFromBroker(queueName: QueueName, jobId: string): Promise<boolean> {
  const queueInstance = getQueue(queueName);
  if (!queueInstance) return false;

  try {
    const job = await withTimeout(queueInstance.getJob(jobId), BROKER_TIMEOUT_MS, 'get job');
    if (!job) return false;
    await withTimeout(job.remove(), BROKER_TIMEOUT_MS, 'remove job');
    return true;
  } catch (err) {
    log.warn('could not remove job from the broker', {
      queue: queueName,
      jobId,
      error: errorMessage(err),
    });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// cancelJob
// ─────────────────────────────────────────────────────────────

export interface CancelJobResult {
  jobRecordId: string;
  cancelled: boolean;
  /** True when the job was still on the queue and was taken off it. */
  removedFromQueue: boolean;
  status: JobStatus;
  message: string;
}

/**
 * Cancels a job: off the broker when it is reachable, then CANCELLED in the database.
 *
 * The database write happens regardless. It is both the record the UI reads and the flag a
 * running processor polls, so a cancellation still takes effect with Redis down.
 */
export async function cancelJob(jobRecordId: string): Promise<CancelJobResult> {
  const row = await prisma.jobRecord.findUnique({ where: { id: jobRecordId } });
  if (!row) throw new NotFoundError('Job');

  if (TERMINAL_STATUSES.includes(row.status)) {
    return {
      jobRecordId,
      cancelled: false,
      removedFromQueue: false,
      status: row.status,
      message: `Job already finished with status ${row.status}`,
    };
  }

  const lane = laneOf(row);

  // The durable flag is written *before* the broker is touched. It is what a running processor
  // polls and what a worker checks before it starts a job, so doing it first closes the window
  // in which a queued job could be picked up with no cancellation on record.
  await markJobCancelled(jobRecordId, 'Cancelled; a running attempt stops at its next checkpoint');

  const removedFromQueue =
    lane !== null && row.jobId !== null ? await removeFromBroker(lane, row.jobId) : false;

  if (removedFromQueue) {
    try {
      await prisma.jobRecord.update({
        where: { id: jobRecordId },
        data: { progressMessage: 'Cancelled and removed from the queue' },
      });
    } catch (err) {
      // Cosmetic only — the cancellation itself is already durable.
      log.warn('failed to refine cancellation message', { jobRecordId, error: errorMessage(err) });
    }
  }

  log.info('job cancelled', { jobRecordId, queue: lane, removedFromQueue });
  return {
    jobRecordId,
    cancelled: true,
    removedFromQueue,
    status: JobStatus.CANCELLED,
    message: removedFromQueue
      ? 'Removed from the queue.'
      : 'Marked cancelled. A job already running will stop at its next checkpoint.',
  };
}

// ─────────────────────────────────────────────────────────────
// retryJob
// ─────────────────────────────────────────────────────────────

export interface RetryJobResult {
  sourceJobRecordId: string;
  /** The durable row for the new run, or `null` if it could not be created. */
  newJobRecordId: string | null;
  enqueue: EnqueueResult;
}

/**
 * Re-runs a job from its stored name and payload.
 *
 * A fresh `JobRecord` is created rather than resetting the old one, so the failure stays
 * visible in the history. The two are linked through the old row's `result` JSON — merged, not
 * replaced, so a partial result from the failed attempt is not lost.
 */
export async function retryJob(jobRecordId: string): Promise<RetryJobResult> {
  const row = await prisma.jobRecord.findUnique({ where: { id: jobRecordId } });
  if (!row) throw new NotFoundError('Job');

  if (!isJobName(row.jobName)) {
    throw new ValidationError(
      `Job "${row.jobName}" is not in the job catalogue and cannot be retried`,
    );
  }

  if (row.status === JobStatus.RUNNING || row.status === JobStatus.QUEUED) {
    throw new ValidationError(`Job is still ${row.status}; cancel it before retrying`);
  }

  // The payload column is free-form JSON, so its shape cannot be proven at runtime; the
  // processor validates it exactly as it did on the original run.
  const payload = readJson<Record<string, unknown>>(row.payload, {}) as AnyJobPayload;

  const result = await enqueue(row.jobName, payload, {
    websiteId: row.websiteId,
    trigger: 'manual',
  });

  const newJobRecordId =
    result.enqueued && result.kind === 'job'
      ? result.jobRecordId
      : !result.enqueued && 'jobRecordId' in result
        ? result.jobRecordId
        : null;

  if (newJobRecordId) {
    const previous = readJson<Record<string, unknown>>(row.result, {});
    await prisma.jobRecord.update({
      where: { id: jobRecordId },
      data: {
        result: json({ ...previous, retriedAsJobRecordId: newJobRecordId }),
        progressMessage: `Retried as job ${newJobRecordId}`,
      },
    });
  }

  log.info('job retried', { jobRecordId, newJobRecordId, enqueued: result.enqueued });
  return { sourceJobRecordId: jobRecordId, newJobRecordId, enqueue: result };
}

// ─────────────────────────────────────────────────────────────
// getQueueHealth
// ─────────────────────────────────────────────────────────────

export interface QueueCounts {
  queue: QueueName;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
}

export interface QueueHealth {
  redis: { ok: boolean; error?: string; status: string };
  queues: QueueCounts[];
}

function countsFrom(queueName: QueueName, raw: Record<string, number>): QueueCounts {
  return {
    queue: queueName,
    waiting: raw.waiting ?? 0,
    active: raw.active ?? 0,
    delayed: raw.delayed ?? 0,
    completed: raw.completed ?? 0,
    failed: raw.failed ?? 0,
    paused: raw.paused ?? 0,
  };
}

/**
 * Live broker state for the health screen: a real PING plus per-lane depth.
 *
 * With Redis down this returns `{ redis: { ok: false, … }, queues: [] }` rather than throwing —
 * "no broker" is a state the operator needs shown, not an error page.
 */
export async function getQueueHealth(): Promise<QueueHealth> {
  const redis = await checkRedisConnection();
  const status = redisStatus();

  if (!redis.ok) {
    return { redis: { ok: false, ...(redis.error ? { error: redis.error } : {}), status }, queues: [] };
  }

  const queues: QueueCounts[] = [];
  for (const queueName of QUEUE_NAMES) {
    const queueInstance = getQueue(queueName);
    if (!queueInstance) continue;
    try {
      const raw = await withTimeout(
        queueInstance.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed', 'paused'),
        BROKER_TIMEOUT_MS,
        `counts for ${queueName}`,
      );
      queues.push(countsFrom(queueName, raw));
    } catch (err) {
      // One unreadable lane must not blank out the whole screen; report it as zeroes and log.
      log.warn('failed to read queue counts', { queue: queueName, error: errorMessage(err) });
      queues.push(countsFrom(queueName, {}));
    }
  }

  return { redis: { ok: true, status }, queues };
}

// ─────────────────────────────────────────────────────────────
// cleanupOldJobs
// ─────────────────────────────────────────────────────────────

export interface CleanupOldJobsResult {
  /** Rows created before this instant were eligible. */
  cutoff: Date;
  retentionDays: number;
  deletedRecords: number;
  /** Finished jobs dropped from Redis; 0 when the broker is unreachable. */
  removedFromBroker: number;
}

/**
 * Prunes finished job history from Postgres, and the matching finished jobs from Redis.
 *
 * Only terminal rows are eligible — a QUEUED or RUNNING row is live work no matter how old its
 * `createdAt` is, and deleting it would strand a running job with nowhere to report. The
 * retention window is clamped to a floor so a bad payload cannot wipe the history entirely.
 */
export async function cleanupOldJobs(olderThanDays?: number): Promise<CleanupOldJobsResult> {
  const retentionDays = Math.floor(
    clamp(olderThanDays ?? DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS),
  );
  const retentionMs = retentionDays * 24 * 60 * 60 * 1_000;
  const cutoff = new Date(Date.now() - retentionMs);

  const where: Prisma.JobRecordWhereInput = {
    status: { in: TERMINAL_STATUSES },
    createdAt: { lt: cutoff },
  };

  let deletedRecords = 0;
  for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
    const rows = await prisma.jobRecord.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: CLEANUP_BATCH,
    });
    if (rows.length === 0) break;

    const removed = await prisma.jobRecord.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    deletedRecords += removed.count;
    if (rows.length < CLEANUP_BATCH) break;
  }

  let removedFromBroker = 0;
  for (const queueName of QUEUE_NAMES) {
    const queueInstance = getQueue(queueName);
    if (!queueInstance) continue;
    for (const type of ['completed', 'failed'] as const) {
      // `clean` removes at most `limit` entries per call, so a single call would leave most of
      // a long-neglected lane behind. Loop until a short batch says the lane is drained, under
      // the same batch bound the Postgres pass uses.
      for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
        let cleaned: string[];
        try {
          cleaned = await withTimeout(
            queueInstance.clean(retentionMs, CLEANUP_BATCH, type),
            BROKER_TIMEOUT_MS,
            `clean ${type} on ${queueName}`,
          );
        } catch (err) {
          log.warn('failed to clean broker history', {
            queue: queueName,
            type,
            error: errorMessage(err),
          });
          break;
        }
        removedFromBroker += cleaned.length;
        if (cleaned.length < CLEANUP_BATCH) break;
      }
    }
  }

  log.info('job history cleaned', { retentionDays, deletedRecords, removedFromBroker });
  return { cutoff, retentionDays, deletedRecords, removedFromBroker };
}
