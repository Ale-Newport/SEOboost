/**
 * The producer side of the job system.
 *
 * The invariant that everything else depends on: **a JobRecord row is written before anything
 * touches Redis.** The Jobs screen is therefore backed by Postgres and works identically with
 * or without a broker; Redis only decides whether a worker will ever pick the row up. When
 * Redis is missing we say so explicitly and return `enqueued: false` — we never run the job
 * inline and never report success for work that will not happen.
 */

import { Queue, type JobsOptions } from 'bullmq';
import { JobStatus, isUniqueViolation, json, prisma } from '@seo/db';
import { createLogger, errorMessage, withTimeout } from '@seo/shared';
import { randomToken } from '@seo/shared/crypto';
import { getRedisConnection, isRedisReady } from './connection';
import { isValidCron } from './cron';
import {
  JOB_QUEUE,
  QUEUE_POLICY,
  type JobEnvelope,
  type JobName,
  type JobPayloads,
  type JobTrigger,
  type QueueName,
  websiteIdOfPayload,
} from './types';

const log = createLogger('queue');

/**
 * How long we wait for `queue.add` before deciding Redis is effectively down. ioredis buffers
 * commands while reconnecting, so without a bound this call would hang for the whole outage.
 */
const ADD_TIMEOUT_MS = 5_000;

const NO_WORKER_MESSAGE =
  'Queued in the database only: REDIS_URL is not configured or Redis is unreachable, so no ' +
  'worker is connected. The job will not run until a broker is available and it is retried.';

/**
 * A push that fails for any *other* reason must not be reported as "Redis is unreachable" — that
 * sends the operator to check a healthy Redis while the real cause sits in the log.
 */
const pushFailedMessage = (error: string): string =>
  `Queued in the database only: the broker rejected the job (${error}). Redis may well be healthy — ` +
  'check the worker logs. Retry the job once the cause is fixed.';

const queues = new Map<QueueName, Queue<JobEnvelope>>();

// ─────────────────────────────────────────────────────────────
// Queue instances
// ─────────────────────────────────────────────────────────────

/**
 * Lazily creates the BullMQ Queue for a lane, or returns `null` when Redis is unavailable.
 * Instances are cached because each one holds a connection-bound script cache.
 */
export function getQueue(name: QueueName): Queue<JobEnvelope> | null {
  const existing = queues.get(name);
  if (existing) return existing;

  const connection = getRedisConnection();
  if (!connection) return null;

  const policy = QUEUE_POLICY[name];
  const queue = new Queue<JobEnvelope>(name, {
    connection,
    defaultJobOptions: {
      attempts: policy.attempts,
      backoff: { type: 'exponential', delay: policy.backoffMs },
      removeOnComplete: { count: policy.keepCompleted },
      removeOnFail: { count: policy.keepFailed },
    },
  });

  // A Queue that loses Redis emits `error`; unhandled, that would take the process down.
  queue.on('error', (err: Error) => {
    log.warn('queue error', { queue: name, error: errorMessage(err) });
  });

  queues.set(name, queue);
  return queue;
}

/** Every queue instance created so far in this process. */
export function activeQueues(): Queue<JobEnvelope>[] {
  return [...queues.values()];
}

/** Closes every cached queue. Call on shutdown, before `closeRedisConnection()`. */
export async function closeQueues(): Promise<void> {
  const instances = [...queues.values()];
  queues.clear();
  await Promise.all(
    instances.map(async (queue) => {
      try {
        await queue.close();
      } catch (err) {
        log.warn('failed to close queue', { queue: queue.name, error: errorMessage(err) });
      }
    }),
  );
}

// ─────────────────────────────────────────────────────────────
// enqueue
// ─────────────────────────────────────────────────────────────

export interface RepeatSpec {
  /** Cron expression. Mutually exclusive with `everyMs`. */
  pattern?: string;
  everyMs?: number;
  /** IANA zone the pattern is expressed in. Defaults to UTC. */
  timeZone?: string;
  limit?: number;
  immediately?: boolean;
}

export interface EnqueueOptions {
  /** Milliseconds before the job becomes eligible for a worker. */
  delayMs?: number;
  /** 1 (soonest) … 2 097 151. Omit for the default FIFO behaviour. */
  priority?: number;
  /**
   * Collapses repeated enqueues of the same logical work. The key becomes the BullMQ job id,
   * so a second enqueue while the first is still queued or running is rejected as a duplicate
   * rather than doubling the work.
   */
  dedupeKey?: string;
  /** Overrides the lane's default attempt count. */
  attempts?: number;
  /** Overrides the lane's exponential backoff base delay. */
  backoffMs?: number;
  /** Registers a repeatable schedule instead of a one-shot job. */
  repeat?: RepeatSpec;
  /** Overrides the websiteId derived from the payload (portfolio-wide jobs pass `null`). */
  websiteId?: string | null;
  trigger?: JobTrigger;
  /** Set by the scheduler so the worker can stamp `ScheduledJob.lastRunAt`. */
  scheduledJobId?: string;
}

export type EnqueueResult =
  | { enqueued: true; kind: 'job'; jobRecordId: string; jobId: string; queue: QueueName }
  | { enqueued: true; kind: 'repeatable'; schedulerId: string; queue: QueueName }
  | {
      enqueued: false;
      reason: 'redis-unavailable';
      jobRecordId: string | null;
      queue: QueueName;
    }
  | { enqueued: false; reason: 'duplicate'; jobRecordId: string; queue: QueueName }
  | { enqueued: false; reason: 'invalid-schedule'; error: string; queue: QueueName };

/** Terminal statuses — a JobRecord in one of these can be reused by a same-key enqueue. */
const TERMINAL_STATUSES: JobStatus[] = [
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
];

/**
 * Deterministic BullMQ job id.
 *
 * BullMQ rejects custom ids containing `:` — it uses the colon as its own key separator, so an id
 * like `crawl.site:abc` fails the `add` outright. Every other character we generate (job names use
 * dots, cuids are alphanumeric) is fine, so the separator is `--` and anything unexpected in a
 * caller-supplied dedupe key is sanitised rather than trusted.
 */
export function buildJobId(jobName: JobName, dedupeKey?: string): string {
  const suffix = (dedupeKey ?? randomToken(12)).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${jobName}--${suffix}`;
}

/**
 * Queues a job.
 *
 * Order of operations is deliberate: durable row first, broker second. If the broker push
 * fails the row survives with an explanation, so nothing is silently lost and `retryJob()`
 * can pick it up later.
 */
export async function enqueue<K extends JobName>(
  jobName: K,
  payload: JobPayloads[K],
  opts: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const queueName = JOB_QUEUE[jobName];
  const policy = QUEUE_POLICY[queueName];
  const websiteId =
    opts.websiteId !== undefined ? opts.websiteId : websiteIdOfPayload(payload);
  const trigger: JobTrigger = opts.trigger ?? 'manual';

  if (opts.repeat) {
    return upsertRepeatable(jobName, payload, opts.repeat, { ...opts, websiteId, trigger });
  }

  const jobId = buildJobId(jobName, opts.dedupeKey);
  const attempts = opts.attempts ?? policy.attempts;

  // ── 1. durable row ────────────────────────────────────────
  const queueInstance = getQueue(queueName);
  const redisAvailable = queueInstance !== null;

  let jobRecordId: string;
  try {
    const record = await upsertJobRecord({
      jobId,
      jobName,
      queueName,
      websiteId,
      payload,
      attempts,
      dedupe: Boolean(opts.dedupeKey),
      progressMessage: redisAvailable ? null : NO_WORKER_MESSAGE,
      status: redisAvailable && opts.delayMs ? JobStatus.DELAYED : JobStatus.QUEUED,
    });
    if (record.duplicate) {
      log.debug('enqueue skipped, duplicate in flight', { jobName, jobId });
      return { enqueued: false, reason: 'duplicate', jobRecordId: record.id, queue: queueName };
    }
    jobRecordId = record.id;
  } catch (err) {
    // A JobRecord we cannot write is a real failure — the caller must not believe the job
    // was accepted.
    log.error('failed to write JobRecord', { jobName, error: errorMessage(err) });
    throw err;
  }

  if (!queueInstance) {
    log.warn('enqueued without a broker', { jobName, jobRecordId, queue: queueName });
    return { enqueued: false, reason: 'redis-unavailable', jobRecordId, queue: queueName };
  }

  // ── 2. broker push ────────────────────────────────────────
  const envelope: JobEnvelope<K> = {
    jobName,
    payload,
    websiteId,
    jobRecordId,
    scheduledJobId: opts.scheduledJobId,
    trigger,
    enqueuedAt: new Date().toISOString(),
  };

  const jobOptions: JobsOptions = {
    jobId,
    attempts,
    backoff: { type: 'exponential', delay: opts.backoffMs ?? policy.backoffMs },
    removeOnComplete: { count: policy.keepCompleted },
    removeOnFail: { count: policy.keepFailed },
    ...(opts.delayMs ? { delay: opts.delayMs } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
  };

  try {
    await withTimeout(
      queueInstance.add(jobName, envelope as JobEnvelope, jobOptions),
      ADD_TIMEOUT_MS,
      `enqueue ${jobName}`,
    );
  } catch (err) {
    // The command may still be sitting in ioredis' offline buffer and land later. Because the
    // job id is deterministic for this record, a late landing is deduplicated by BullMQ rather
    // than producing a second run.
    const reason = errorMessage(err);
    log.warn('broker push failed; job remains queued in the database', {
      jobName,
      jobRecordId,
      jobId,
      error: reason,
    });
    await safeUpdateJobRecord(jobRecordId, {
      status: JobStatus.QUEUED,
      progressMessage: isRedisReady() ? pushFailedMessage(reason) : NO_WORKER_MESSAGE,
    });
    return { enqueued: false, reason: 'redis-unavailable', jobRecordId, queue: queueName };
  }

  log.info('job enqueued', { jobName, queue: queueName, jobRecordId, websiteId });
  return { enqueued: true, kind: 'job', jobRecordId, jobId, queue: queueName };
}

// ─────────────────────────────────────────────────────────────
// Repeatable jobs
// ─────────────────────────────────────────────────────────────

/** Prefix for every scheduler this package owns, so `syncSchedules` never touches foreign keys. */
export const SCHEDULER_PREFIX = 'seo';

/** Stable, reconstructible id for a repeatable registration. */
export function schedulerIdFor(jobName: JobName, websiteId: string | null): string {
  return `${SCHEDULER_PREFIX}:${websiteId ?? 'global'}:${jobName}`;
}

/** Everything wrong with a repeat spec that can be known without a broker; `null` when it is fine. */
function validateRepeat(repeat: RepeatSpec): string | null {
  if (!repeat.pattern && !repeat.everyMs) {
    return 'A repeat spec needs either a cron pattern or everyMs';
  }
  if (repeat.pattern && repeat.everyMs) {
    return 'A repeat spec takes either a cron pattern or everyMs, not both';
  }
  if (repeat.pattern && !isValidCron(repeat.pattern)) {
    return `"${repeat.pattern}" is not a valid cron expression`;
  }
  if (repeat.everyMs !== undefined && (!Number.isFinite(repeat.everyMs) || repeat.everyMs <= 0)) {
    return 'everyMs must be a positive number of milliseconds';
  }
  if (repeat.limit !== undefined && (!Number.isInteger(repeat.limit) || repeat.limit < 1)) {
    return 'limit must be a positive integer';
  }
  return null;
}

/**
 * Registers (or updates) a repeatable job. Repeatables produce no JobRecord row here — the
 * row is created by the worker on each actual execution, so the Jobs screen shows runs rather
 * than registrations.
 */
export async function upsertRepeatable<K extends JobName>(
  jobName: K,
  payload: JobPayloads[K],
  repeat: RepeatSpec,
  opts: {
    websiteId?: string | null;
    trigger?: JobTrigger;
    scheduledJobId?: string;
    schedulerId?: string;
    attempts?: number;
    backoffMs?: number;
  } = {},
): Promise<EnqueueResult> {
  const queueName = JOB_QUEUE[jobName];
  const policy = QUEUE_POLICY[queueName];
  const websiteId =
    opts.websiteId !== undefined ? opts.websiteId : websiteIdOfPayload(payload);

  // Validate before touching Redis: BullMQ rejects a contradictory or unparseable spec by
  // throwing, which the catch below would report as `redis-unavailable` — a misleading reason
  // that sends the operator looking at the broker instead of at their expression.
  const invalid = validateRepeat(repeat);
  if (invalid) {
    return { enqueued: false, reason: 'invalid-schedule', error: invalid, queue: queueName };
  }

  const queueInstance = getQueue(queueName);
  if (!queueInstance) {
    return { enqueued: false, reason: 'redis-unavailable', jobRecordId: null, queue: queueName };
  }

  const schedulerId = opts.schedulerId ?? schedulerIdFor(jobName, websiteId);
  const envelope: JobEnvelope<K> = {
    jobName,
    payload,
    websiteId,
    scheduledJobId: opts.scheduledJobId,
    trigger: opts.trigger ?? 'schedule',
    enqueuedAt: new Date().toISOString(),
  };

  try {
    await withTimeout(
      queueInstance.upsertJobScheduler(
        schedulerId,
        {
          ...(repeat.pattern ? { pattern: repeat.pattern } : {}),
          ...(repeat.everyMs ? { every: repeat.everyMs } : {}),
          ...(repeat.timeZone ? { tz: repeat.timeZone } : {}),
          ...(repeat.limit ? { limit: repeat.limit } : {}),
          ...(repeat.immediately ? { immediately: repeat.immediately } : {}),
        },
        {
          name: jobName,
          data: envelope as JobEnvelope,
          opts: {
            attempts: opts.attempts ?? policy.attempts,
            backoff: { type: 'exponential', delay: opts.backoffMs ?? policy.backoffMs },
            removeOnComplete: { count: policy.keepCompleted },
            removeOnFail: { count: policy.keepFailed },
          },
        },
      ),
      ADD_TIMEOUT_MS,
      `upsert schedule ${schedulerId}`,
    );
  } catch (err) {
    log.warn('failed to register repeatable job', {
      jobName,
      schedulerId,
      error: errorMessage(err),
    });
    return { enqueued: false, reason: 'redis-unavailable', jobRecordId: null, queue: queueName };
  }

  return { enqueued: true, kind: 'repeatable', schedulerId, queue: queueName };
}

/** Removes a repeatable registration. Returns false when Redis is down or it did not exist. */
export async function removeRepeatable(
  queueName: QueueName,
  schedulerId: string,
): Promise<boolean> {
  const queueInstance = getQueue(queueName);
  if (!queueInstance) return false;
  try {
    return await withTimeout(
      queueInstance.removeJobScheduler(schedulerId),
      ADD_TIMEOUT_MS,
      `remove schedule ${schedulerId}`,
    );
  } catch (err) {
    log.warn('failed to remove repeatable job', { schedulerId, error: errorMessage(err) });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// JobRecord helpers
// ─────────────────────────────────────────────────────────────

interface UpsertJobRecordArgs {
  jobId: string;
  jobName: JobName;
  queueName: QueueName;
  websiteId: string | null;
  payload: unknown;
  attempts: number;
  dedupe: boolean;
  progressMessage: string | null;
  status: JobStatus;
}

/**
 * Writes the durable row. With a dedupe key the row is keyed by job id: an in-flight row wins
 * (the enqueue is a no-op), a finished row is reset and reused so "run it again" works without
 * leaking a new id every time.
 */
async function upsertJobRecord(
  args: UpsertJobRecordArgs,
): Promise<{ id: string; duplicate: boolean }> {
  const base = {
    websiteId: args.websiteId,
    queue: args.queueName,
    jobName: args.jobName,
    jobId: args.jobId,
    status: args.status,
    payload: json(args.payload),
    maxAttempts: args.attempts,
    progressMessage: args.progressMessage,
  };

  if (!args.dedupe) {
    const created = await prisma.jobRecord.create({ data: base });
    return { id: created.id, duplicate: false };
  }

  const existing = await prisma.jobRecord.findUnique({
    where: { jobId: args.jobId },
    select: { id: true, status: true },
  });

  if (existing && !TERMINAL_STATUSES.includes(existing.status)) {
    return { id: existing.id, duplicate: true };
  }

  if (existing) {
    // The previous run finished; clear the old job out of Redis so BullMQ accepts the id
    // again, then reset the row in place.
    const queueInstance = getQueue(args.queueName);
    if (queueInstance) {
      try {
        await withTimeout(queueInstance.remove(args.jobId), ADD_TIMEOUT_MS, 'remove finished job');
      } catch {
        // Nothing to remove, or the broker is unreachable — the add below reports either way.
      }
    }
    const reset = await prisma.jobRecord.update({
      where: { id: existing.id },
      data: {
        ...base,
        progress: 0,
        attempts: 0,
        result: json({}),
        error: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      },
    });
    return { id: reset.id, duplicate: false };
  }

  try {
    const created = await prisma.jobRecord.create({ data: base });
    return { id: created.id, duplicate: false };
  } catch (err) {
    // Lost a race with a concurrent enqueue of the same key; that other row is the winner.
    if (isUniqueViolation(err)) {
      const winner = await prisma.jobRecord.findUnique({
        where: { jobId: args.jobId },
        select: { id: true },
      });
      if (winner) return { id: winner.id, duplicate: true };
    }
    throw err;
  }
}

/** Best-effort JobRecord patch: a Postgres blip must not turn into a failed enqueue. */
async function safeUpdateJobRecord(
  jobRecordId: string,
  data: { status?: JobStatus; progressMessage?: string | null },
): Promise<void> {
  try {
    await prisma.jobRecord.update({ where: { id: jobRecordId }, data });
  } catch (err) {
    log.warn('failed to update JobRecord', { jobRecordId, error: errorMessage(err) });
  }
}
