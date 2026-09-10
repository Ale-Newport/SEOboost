/**
 * The shapes the Jobs screen passes from its server component to the client view.
 *
 * Everything is plain JSON — instants are ISO strings — so the boundary stays cheap and the
 * client can format dates in the reader's locale rather than the server's.
 */

export type JobStatusValue = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'DELAYED';

export const JOB_STATUS_VALUES: readonly JobStatusValue[] = [
  'RUNNING',
  'QUEUED',
  'DELAYED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

/** Statuses that mean the job is still in flight and the screen should keep polling. */
export const ACTIVE_JOB_STATUSES: readonly JobStatusValue[] = ['QUEUED', 'RUNNING', 'DELAYED'];

export interface JobRow {
  id: string;
  queue: string;
  jobName: string;
  /** The broker's job id; null when the job was recorded but never accepted by Redis. */
  jobId: string | null;
  status: JobStatusValue;
  progress: number;
  progressMessage: string | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  websiteId: string | null;
  websiteName: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** False for a job whose name is no longer in the catalogue — it cannot be re-enqueued. */
  retryable: boolean;
}

export interface QueueLane {
  queue: string;
  /** Live broker depth. Null for every field when Redis could not be read. */
  waiting: number | null;
  active: number | null;
  delayed: number | null;
  failed: number | null;
  paused: number | null;
  /** Workers currently attached to this lane, or null when the broker is unreachable. */
  workers: number | null;
  /** Durable Postgres counts — always available, even with the broker down. */
  recordedQueued: number;
  recordedRunning: number;
  recordedFailed: number;
}

export interface QueueHealthSummary {
  redisOk: boolean;
  redisConfigured: boolean;
  redisStatus: string;
  redisError: string | null;
  /** Distinct workers attached across every lane; null when the broker is unreachable. */
  workers: number | null;
  lanes: QueueLane[];
  /** When the longest-waiting queued job was created — evidence that nothing is draining. */
  oldestQueuedAt: string | null;
  /** The most recent moment any job actually started, i.e. the last sign of life from a worker. */
  lastWorkerActivityAt: string | null;
  databaseOk: boolean;
}

export interface JobStatusCount {
  status: JobStatusValue;
  count: number;
}

export interface JobStats {
  /** ISO instant marking the start of the counting window. */
  since: string;
  total: number;
  byStatus: JobStatusCount[];
}

export interface JobSiteOption {
  id: string;
  name: string;
}
