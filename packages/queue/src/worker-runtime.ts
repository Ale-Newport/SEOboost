/**
 * The consumer side: everything `apps/worker` needs to run a job and keep its durable
 * JobRecord row honest.
 *
 * Two things matter here. First, the JobRecord row must always reflect reality — started,
 * progressing, finished, failed, how long it took, which attempt — because that row, not
 * Redis, is what the Jobs screen reads. Second, keeping it honest must be cheap: a 10 000-page
 * crawl reports progress constantly, so progress writes are throttled to roughly one per
 * second with a trailing flush, rather than one UPDATE per page.
 *
 * Retry policy is *not* configured here. Attempts and exponential backoff are attached to each
 * job at enqueue time from `QUEUE_POLICY`, because BullMQ reads them from the job's own options
 * rather than from the worker.
 */

import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { JobStatus, isUniqueViolation, json, prisma } from '@seo/db';
import {
  clamp,
  createLogger,
  env,
  errorMessage,
  type Logger,
} from '@seo/shared';
import { getRedisConnection } from './connection';
import { computeNextRun } from './cron';
import {
  JOB_QUEUE,
  QUEUE_POLICY,
  isJobName,
  type JobEnvelope,
  type JobName,
  type JobPayloads,
  type QueueName,
} from './types';

const log = createLogger('queue:worker');

/** Progress is written at most this often per job; the final value is always flushed. */
const PROGRESS_INTERVAL_MS = 1_000;

/** Cancellation is polled no more often than this — it is a Postgres read on a hot path. */
const CANCEL_POLL_INTERVAL_MS = 2_000;

/** JobRecord.error is a plain text column; keep stack-laden messages from bloating rows. */
const MAX_ERROR_LENGTH = 4_000;

// ─────────────────────────────────────────────────────────────
// Job context
// ─────────────────────────────────────────────────────────────

export interface JobContext {
  readonly jobRecordId: string;
  readonly log: Logger;
  /** Records progress (0-100) and an optional human message. Throttled; never throws. */
  updateProgress(percent: number, message?: string): Promise<void>;
  /** Stores the job's result payload on the JobRecord row. */
  setResult(result: unknown): Promise<void>;
  /** Writes any progress still held back by the throttle. Called for you on completion. */
  flushProgress(): Promise<void>;
  /**
   * True once the job was cancelled from the Jobs screen. Long-running processors should
   * check this between units of work and return early — BullMQ cannot interrupt them.
   */
  isCancelled(): Promise<boolean>;
}

export interface CreateJobContextOptions {
  /** Extra fields attached to every log line from this job. */
  bindings?: Record<string, unknown>;
  /** Mirrors progress into BullMQ so `queue.getJob()` shows it too. */
  mirror?: (percent: number, message?: string) => void;
}

/**
 * Builds the handle a processor uses to report on itself. Every method is best-effort: a
 * database hiccup while reporting progress must not fail an otherwise healthy job.
 */
export function createJobContext(
  jobRecordId: string,
  options: CreateJobContextOptions = {},
): JobContext {
  const contextLog = createLogger('job', { jobRecordId, ...options.bindings });

  let lastWriteAt = 0;
  let pending: { percent: number; message?: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let lastCancelCheckAt = 0;
  let cancelled = false;

  async function write(percent: number, message?: string): Promise<void> {
    options.mirror?.(percent, message);
    try {
      await prisma.jobRecord.update({
        where: { id: jobRecordId },
        data: { progress: percent, ...(message === undefined ? {} : { progressMessage: message }) },
      });
    } catch (err) {
      contextLog.warn('failed to persist job progress', { error: errorMessage(err) });
    }
  }

  async function flushProgress(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const next = pending;
    pending = null;
    if (!next) return;
    lastWriteAt = Date.now();
    await write(next.percent, next.message);
  }

  async function updateProgress(percent: number, message?: string): Promise<void> {
    const value = Math.round(clamp(percent, 0, 100));
    pending = { percent: value, message };

    const elapsed = Date.now() - lastWriteAt;
    if (elapsed >= PROGRESS_INTERVAL_MS || value >= 100) {
      await flushProgress();
      return;
    }

    // Schedule a trailing write so the last value in a burst is not lost. `unref` keeps this
    // timer from holding the worker process open during shutdown.
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flushProgress();
      }, PROGRESS_INTERVAL_MS - elapsed);
      timer.unref();
    }
  }

  async function setResult(result: unknown): Promise<void> {
    try {
      await prisma.jobRecord.update({
        where: { id: jobRecordId },
        data: { result: json(result) },
      });
    } catch (err) {
      contextLog.warn('failed to persist job result', { error: errorMessage(err) });
    }
  }

  async function isCancelled(): Promise<boolean> {
    if (cancelled) return true;
    const now = Date.now();
    if (now - lastCancelCheckAt < CANCEL_POLL_INTERVAL_MS) return false;
    lastCancelCheckAt = now;
    try {
      const row = await prisma.jobRecord.findUnique({
        where: { id: jobRecordId },
        select: { status: true },
      });
      cancelled = row?.status === JobStatus.CANCELLED;
    } catch (err) {
      contextLog.warn('failed to read cancellation flag', { error: errorMessage(err) });
    }
    return cancelled;
  }

  return { jobRecordId, log: contextLog, updateProgress, setResult, flushProgress, isCancelled };
}

// ─────────────────────────────────────────────────────────────
// JobRecord lifecycle
// ─────────────────────────────────────────────────────────────

/** JobRecord writes are advisory: losing one must never fail or retry an otherwise fine job. */
async function safeWrite(action: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.error(`failed to ${action}`, { error: errorMessage(err) });
  }
}

/**
 * Cancellation is sticky: once the Jobs screen writes CANCELLED, no lifecycle write may take
 * the row back out of that state. Without this a job that was cancelled while queued (and that
 * the broker refused to drop) would be flipped to RUNNING/COMPLETED by the very worker the
 * cancellation was meant to stop, and `ctx.isCancelled()` would never see the flag.
 */
function isRecordCancelled(status: JobStatus | undefined): boolean {
  return status === JobStatus.CANCELLED;
}

export async function markJobRunning(jobRecordId: string, attempt = 1): Promise<void> {
  await safeWrite('mark job running', async () => {
    const existing = await prisma.jobRecord.findUnique({
      where: { id: jobRecordId },
      select: { startedAt: true, status: true },
    });
    if (isRecordCancelled(existing?.status)) return;
    await prisma.jobRecord.update({
      where: { id: jobRecordId },
      data: {
        status: JobStatus.RUNNING,
        attempts: attempt,
        // Preserve the first attempt's start so durationMs covers the whole retry chain.
        startedAt: existing?.startedAt ?? new Date(),
        finishedAt: null,
        error: null,
        progressMessage: attempt > 1 ? `Retrying (attempt ${attempt})` : null,
      },
    });
  });
}

export async function markJobCompleted(jobRecordId: string, result?: unknown): Promise<void> {
  await safeWrite('mark job completed', async () => {
    const existing = await prisma.jobRecord.findUnique({
      where: { id: jobRecordId },
      select: { startedAt: true, status: true },
    });
    const finishedAt = new Date();
    const cancelled = isRecordCancelled(existing?.status);
    await prisma.jobRecord.update({
      where: { id: jobRecordId },
      data: {
        // A processor that noticed `ctx.isCancelled()` and returned early still finished; the
        // row keeps CANCELLED so the screen does not claim the work was completed.
        ...(cancelled ? {} : { status: JobStatus.COMPLETED, progress: 100, error: null }),
        finishedAt,
        durationMs: durationFrom(existing?.startedAt, finishedAt),
        ...(result === undefined ? {} : { result: json(result) }),
      },
    });
  });
}

export async function markJobFailed(
  jobRecordId: string,
  error: unknown,
  opts: { willRetry?: boolean; attempt?: number } = {},
): Promise<void> {
  const message = errorMessage(error).slice(0, MAX_ERROR_LENGTH);
  await safeWrite('mark job failed', async () => {
    const existing = await prisma.jobRecord.findUnique({
      where: { id: jobRecordId },
      select: { startedAt: true, status: true },
    });
    const finishedAt = new Date();
    const cancelled = isRecordCancelled(existing?.status);
    await prisma.jobRecord.update({
      where: { id: jobRecordId },
      data: {
        // A job BullMQ will retry goes back to QUEUED so the UI shows it as still in flight.
        // A cancelled row keeps its status but still records why the attempt ended.
        ...(cancelled ? {} : { status: opts.willRetry ? JobStatus.QUEUED : JobStatus.FAILED }),
        error: message,
        ...(opts.attempt === undefined ? {} : { attempts: opts.attempt }),
        ...(opts.willRetry && !cancelled
          ? { progressMessage: `Attempt failed, will retry: ${message.slice(0, 200)}` }
          : { finishedAt, durationMs: durationFrom(existing?.startedAt, finishedAt) }),
      },
    });
  });
}

export async function markJobCancelled(jobRecordId: string, reason?: string): Promise<void> {
  await safeWrite('mark job cancelled', async () => {
    const existing = await prisma.jobRecord.findUnique({
      where: { id: jobRecordId },
      select: { startedAt: true },
    });
    const finishedAt = new Date();
    await prisma.jobRecord.update({
      where: { id: jobRecordId },
      data: {
        status: JobStatus.CANCELLED,
        finishedAt,
        durationMs: durationFrom(existing?.startedAt, finishedAt),
        progressMessage: reason ?? 'Cancelled',
      },
    });
  });
}

function durationFrom(startedAt: Date | null | undefined, finishedAt: Date): number | null {
  if (!startedAt) return null;
  return Math.max(0, finishedAt.getTime() - startedAt.getTime());
}

/**
 * Keeps the ScheduledJob row in step with reality after a scheduled run, including the next
 * expected fire time so the Schedules screen does not have to parse cron itself.
 */
export async function stampScheduledJob(
  scheduledJobId: string,
  status: 'COMPLETED' | 'FAILED',
): Promise<void> {
  await safeWrite('stamp scheduled job', async () => {
    const row = await prisma.scheduledJob.findUnique({
      where: { id: scheduledJobId },
      select: { cron: true },
    });
    if (!row) return;
    const now = new Date();
    await prisma.scheduledJob.update({
      where: { id: scheduledJobId },
      data: { lastRunAt: now, lastStatus: status, nextRunAt: computeNextRun(row.cron, now) },
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Processors
// ─────────────────────────────────────────────────────────────

/**
 * The argument a processor receives. Because this is a union keyed on `jobName`, switching on
 * it narrows `payload` to the right shape — that is what makes the worker's dispatch table
 * type-safe end to end.
 */
export type JobHandlerArgs = {
  [K in JobName]: {
    jobName: K;
    payload: JobPayloads[K];
    websiteId: string | null;
    jobRecordId: string;
    ctx: JobContext;
    job: Job<JobEnvelope>;
  };
}[JobName];

export type QueueProcessor = (args: JobHandlerArgs) => Promise<unknown>;

/** A handler for one specific job name, with its payload already narrowed. */
export type JobHandler<K extends JobName> = (
  args: Extract<JobHandlerArgs, { jobName: K }>,
) => Promise<unknown>;

export type JobHandlerMap = { [K in JobName]?: JobHandler<K> };

/**
 * Turns a `{ 'crawl.site': handler }` map into a queue processor. An unmapped job name is a
 * deployment mistake, not a transient fault, so it fails permanently instead of retrying.
 */
export function createJobRouter(handlers: JobHandlerMap): QueueProcessor {
  return async (args: JobHandlerArgs): Promise<unknown> => {
    const handler = handlers[args.jobName];
    if (!handler) {
      throw new UnrecoverableError(`No handler registered for job "${args.jobName}"`);
    }
    // The map's value type is correlated with its key, but TypeScript cannot prove that the
    // looked-up handler matches this particular union member; the lookup above guarantees it.
    return (handler as JobHandler<JobName>)(args);
  };
}

// ─────────────────────────────────────────────────────────────
// Worker registration
// ─────────────────────────────────────────────────────────────

export interface RegisterWorkerOptions {
  /** Defaults to `env.workerConcurrency` scaled by the lane's `concurrencyFactor`. */
  concurrency?: number;
  lockDurationMs?: number;
  /** Caps throughput for lanes that hit vendor rate limits. */
  limiter?: { max: number; durationMs: number };
  autorun?: boolean;
  maxStalledCount?: number;
  /** Extra fields on every log line this worker emits. */
  bindings?: Record<string, unknown>;
}

/** Concurrency for a lane, honouring `WORKER_CONCURRENCY` and the lane's own weighting. */
export function concurrencyFor(queueName: QueueName): number {
  return Math.max(1, Math.round(env.workerConcurrency * QUEUE_POLICY[queueName].concurrencyFactor));
}

/**
 * Starts a BullMQ worker for one lane.
 *
 * Returns `null` when Redis is not configured — the worker process then simply has nothing to
 * do, which is the correct behaviour for an install running without a broker.
 */
export function registerWorker(
  queueName: QueueName,
  processor: QueueProcessor,
  opts: RegisterWorkerOptions = {},
): Worker<JobEnvelope, unknown, string> | null {
  const connection = getRedisConnection();
  if (!connection) {
    log.warn('worker not started: Redis is not configured', { queue: queueName });
    return null;
  }

  const policy = QUEUE_POLICY[queueName];
  const concurrency = opts.concurrency ?? concurrencyFor(queueName);
  const workerLog = createLogger('queue:worker', { queue: queueName, ...opts.bindings });

  const worker = new Worker<JobEnvelope, unknown, string>(
    queueName,
    async (job) => runJob(job, processor, workerLog),
    {
      connection,
      concurrency,
      lockDuration: opts.lockDurationMs ?? policy.lockDurationMs,
      autorun: opts.autorun ?? true,
      ...(opts.maxStalledCount === undefined ? {} : { maxStalledCount: opts.maxStalledCount }),
      ...(opts.limiter
        ? { limiter: { max: opts.limiter.max, duration: opts.limiter.durationMs } }
        : {}),
      removeOnComplete: { count: policy.keepCompleted },
      removeOnFail: { count: policy.keepFailed },
    },
  );

  worker.on('ready', () => workerLog.info('worker ready', { concurrency }));
  worker.on('active', (job) => workerLog.debug('job active', jobMeta(job)));
  worker.on('completed', (job) => workerLog.info('job completed', jobMeta(job)));
  worker.on('failed', (job, err) =>
    workerLog.error('job failed', { ...(job ? jobMeta(job) : {}), error: errorMessage(err) }),
  );
  worker.on('stalled', (jobId) => workerLog.warn('job stalled', { jobId }));
  worker.on('error', (err) => workerLog.error('worker error', { error: errorMessage(err) }));
  worker.on('closing', () => workerLog.info('worker closing'));
  worker.on('closed', () => workerLog.info('worker closed'));

  log.info('worker registered', { queue: queueName, concurrency });
  return worker;
}

function jobMeta(job: Job<JobEnvelope>): Record<string, unknown> {
  return {
    jobId: job.id,
    jobName: job.data?.jobName,
    websiteId: job.data?.websiteId,
    attempt: attemptNumber(job),
  };
}

function attemptNumber(job: Job<JobEnvelope>): number {
  return Math.max(job.attemptsStarted || 0, job.attemptsMade + 1);
}

/** Runs one job with full JobRecord bookkeeping around it. */
async function runJob(
  job: Job<JobEnvelope>,
  processor: QueueProcessor,
  workerLog: Logger,
): Promise<unknown> {
  const envelope = job.data;
  if (!envelope || typeof envelope.jobName !== 'string' || !isJobName(envelope.jobName)) {
    // Nothing about this job will improve on a retry.
    throw new UnrecoverableError(
      `Unknown job name "${String(envelope?.jobName)}" on queue "${job.queueName}"`,
    );
  }

  const jobName = envelope.jobName;
  const record = await ensureJobRecord(job, jobName);
  const jobRecordId = record.id;
  const attempt = attemptNumber(job);

  if (record.cancelled) {
    // Cancelled while it sat on the queue, and the broker would not give the job up (an
    // unreachable Redis, or a lock held at the moment of cancellation). Returning normally
    // takes it off the queue without touching the row, so the cancellation stands.
    workerLog.info('job was cancelled before it started; skipping', { jobName, jobRecordId });
    return { skipped: 'cancelled' };
  }

  const ctx = createJobContext(jobRecordId, {
    bindings: { jobName, websiteId: envelope.websiteId, attempt },
    mirror: (percent, message) => {
      // Best effort: BullMQ progress is a convenience mirror, the JobRecord row is the truth.
      void job.updateProgress({ percent, message: message ?? '' }).catch(() => undefined);
    },
  });

  await markJobRunning(jobRecordId, attempt);

  try {
    const result = await processor({
      jobName,
      payload: envelope.payload,
      websiteId: envelope.websiteId,
      jobRecordId,
      ctx,
      job,
    } as JobHandlerArgs);

    await ctx.flushProgress();
    await markJobCompleted(jobRecordId, result);
    if (envelope.scheduledJobId) await stampScheduledJob(envelope.scheduledJobId, 'COMPLETED');
    return result;
  } catch (err) {
    await ctx.flushProgress();
    const maxAttempts = job.opts.attempts ?? 1;
    const willRetry = !(err instanceof UnrecoverableError) && attempt < maxAttempts;

    await markJobFailed(jobRecordId, err, { willRetry, attempt });
    if (envelope.scheduledJobId && !willRetry) {
      await stampScheduledJob(envelope.scheduledJobId, 'FAILED');
    }
    workerLog.warn('job threw', {
      jobName,
      jobRecordId,
      attempt,
      willRetry,
      error: errorMessage(err),
    });
    throw err;
  }
}

/**
 * Resolves the durable row for a running job, creating it when necessary.
 *
 * Repeatable jobs arrive without a `jobRecordId` because BullMQ builds them from a template
 * stored long before this execution existed, so the row is created on first run here. Every
 * *retry* of that same execution re-enters this function with the same broker job id, so the
 * lookup by `jobId` — unique on JobRecord — is what stops attempt 2 from colliding with the row
 * attempt 1 wrote, and losing the whole run to a constraint violation.
 */
async function ensureJobRecord(
  job: Job<JobEnvelope>,
  jobName: JobName,
): Promise<{ id: string; cancelled: boolean }> {
  const envelope = job.data;

  if (envelope.jobRecordId) {
    const existing = await prisma.jobRecord.findUnique({
      where: { id: envelope.jobRecordId },
      select: { id: true, status: true },
    });
    if (existing) return { id: existing.id, cancelled: isRecordCancelled(existing.status) };
    log.warn('JobRecord referenced by the job is missing; recreating', {
      jobRecordId: envelope.jobRecordId,
      jobName,
    });
  }

  if (job.id) {
    const byJobId = await prisma.jobRecord.findUnique({
      where: { jobId: job.id },
      select: { id: true, status: true },
    });
    if (byJobId) return { id: byJobId.id, cancelled: isRecordCancelled(byJobId.status) };
  }

  const data = {
    websiteId: envelope.websiteId,
    queue: JOB_QUEUE[jobName],
    jobName,
    jobId: job.id ?? null,
    status: JobStatus.RUNNING,
    payload: json(envelope.payload),
    maxAttempts: job.opts.attempts ?? QUEUE_POLICY[JOB_QUEUE[jobName]].attempts,
  };

  try {
    const created = await prisma.jobRecord.create({ data });
    return { id: created.id, cancelled: false };
  } catch (err) {
    // Lost a race with a concurrent attempt of the same broker job; that row is the winner.
    if (job.id && isUniqueViolation(err)) {
      const winner = await prisma.jobRecord.findUnique({
        where: { jobId: job.id },
        select: { id: true, status: true },
      });
      if (winner) return { id: winner.id, cancelled: isRecordCancelled(winner.status) };
    }
    throw err;
  }
}
