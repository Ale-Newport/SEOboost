/**
 * The typed job catalogue.
 *
 * Everything that can be queued in this product is declared here exactly once, so that
 * `enqueue()` on the web side and the worker's dispatcher share one source of truth: adding a
 * job name without a payload type or a queue assignment is a compile error.
 *
 * This module intentionally has no runtime imports — it is loaded by the web app, the worker
 * and the unit tests alike, and must stay free of Prisma/Redis side effects.
 */

import type { ContentStage, EmbeddingOwner, EntityType } from '@seo/db';

// ─────────────────────────────────────────────────────────────
// Queues
// ─────────────────────────────────────────────────────────────

/**
 * Queues are split by *resource contention*, not by feature area: each one is a lane with its
 * own concurrency and retry budget. A slow site crawl must never block a cheap score
 * recomputation, and an LLM rate limit must never stall a CMS publish.
 *
 * - `crawl`       outbound HTTP against the customer's own site (bandwidth + politeness bound)
 * - `analysis`    deterministic CPU/Postgres work over already-fetched data
 * - `sync`        third-party data APIs (GSC, GA4, Bing, SERP) with vendor rate limits
 * - `ai`          LLM / embedding calls, bound by token budgets and provider limits
 * - `content`     the long-running content pipeline, including the CMS publish step
 * - `actions`     mutations to live customer properties — deliberately low concurrency
 * - `maintenance` housekeeping: reports, digests, retention
 */
export const QUEUE_NAMES = [
  'crawl',
  'analysis',
  'sync',
  'ai',
  'content',
  'actions',
  'maintenance',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export function isQueueName(value: string): value is QueueName {
  return (QUEUE_NAMES as readonly string[]).includes(value);
}

// ─────────────────────────────────────────────────────────────
// Shared payload vocabulary
// ─────────────────────────────────────────────────────────────

/** Where a job came from. Mirrored onto Crawl.trigger / AgentRun.trigger by the processors. */
export type JobTrigger = 'manual' | 'schedule' | 'agent' | 'api' | 'chain' | 'system';

export type SerpDevice = 'desktop' | 'mobile';

/** How `keywords.cluster` should group keywords when several strategies are available. */
export type ClusterMethod = 'embedding' | 'serp' | 'lexical';

export type KeywordDiscoverySource = 'gsc' | 'serp' | 'competitors' | 'site' | 'seeds';

export type ReportType = 'weekly' | 'monthly' | 'quarterly' | 'portfolio' | 'custom';

export type DigestFrequency = 'daily' | 'weekly';

/** Retention targets for `maintenance.cleanup`. */
export type CleanupTarget =
  | 'job-records'
  | 'crawl-pages'
  | 'page-snapshots'
  | 'serp-snapshots'
  | 'ai-usage'
  | 'notifications'
  | 'agent-runs'
  | 'orphan-embeddings';

/** ISO-8601 calendar day, `YYYY-MM-DD`. Payloads carry strings so they survive JSON round-trips. */
export type DateKey = string;

// ─────────────────────────────────────────────────────────────
// Payloads
// ─────────────────────────────────────────────────────────────

/**
 * Payload for every job name. Optional fields mean "let the processor fall back to
 * WebsiteSettings / sensible defaults" — never "the processor will invent a value".
 */
export interface JobPayloads {
  // ── Crawling ────────────────────────────────────────────────
  'crawl.site': {
    websiteId: string;
    /** Pre-created Crawl row; when absent the processor creates one. */
    crawlId?: string;
    trigger?: JobTrigger;
    /** Overrides WebsiteSettings.crawlMaxPages for this run only. */
    maxPages?: number;
    maxDepth?: number;
    renderJs?: boolean;
    /** Extra entry points on top of the homepage and sitemap URLs. */
    startUrls?: string[];
  };
  'crawl.cancel': {
    websiteId: string;
    crawlId: string;
    reason?: string;
  };

  // ── Analysis & scoring ──────────────────────────────────────
  'analysis.technical-audit': {
    websiteId: string;
    /** Audit the pages captured by this crawl; omit to audit the latest completed crawl. */
    crawlId?: string;
    pageIds?: string[];
  };
  'analysis.page-scores': {
    websiteId: string;
    pageIds?: string[];
    /** Recompute even when the page's content hash is unchanged. */
    force?: boolean;
  };
  'analysis.site-scores': {
    websiteId: string;
    /** Also write a ScoreSnapshot row for the score-history charts. */
    snapshot?: boolean;
  };
  'analysis.full': {
    websiteId: string;
    crawlId?: string;
    trigger?: JobTrigger;
  };

  // ── Search data sync ────────────────────────────────────────
  'gsc.sync': {
    websiteId: string;
    /** Rolling window ending at the freshest available day. Ignored when from/to are given. */
    days?: number;
    from?: DateKey;
    to?: DateKey;
  };
  'gsc.backfill': {
    websiteId: string;
    /** How far back to reach; Search Console retains ~16 months. */
    months?: number;
    from?: DateKey;
    to?: DateKey;
  };
  'bing.sync': {
    websiteId: string;
    days?: number;
  };
  'ga4.sync': {
    websiteId: string;
    days?: number;
    from?: DateKey;
    to?: DateKey;
  };

  // ── Keywords ────────────────────────────────────────────────
  'keywords.discover': {
    websiteId: string;
    sources?: KeywordDiscoverySource[];
    /** Free-text seeds supplied by the operator. */
    seeds?: string[];
    limit?: number;
  };
  'keywords.enrich': {
    websiteId: string;
    keywordIds?: string[];
    /** Re-enrich keywords whose metrics are older than this; omit to enrich only missing ones. */
    refreshOlderThanDays?: number;
    limit?: number;
  };
  'keywords.cluster': {
    websiteId: string;
    keywordIds?: string[];
    method?: ClusterMethod;
    minClusterSize?: number;
  };

  // ── SERP & competitors ──────────────────────────────────────
  'serp.fetch': {
    websiteId: string;
    keywordIds?: string[];
    locale?: string;
    device?: SerpDevice;
    limit?: number;
  };
  'competitors.analyse': {
    websiteId: string;
    competitorIds?: string[];
    /** Derive new competitors from SERP overlap before analysing. */
    discover?: boolean;
  };

  // ── Internal linking ────────────────────────────────────────
  'links.analyse-internal': {
    websiteId: string;
    pageIds?: string[];
    maxSuggestionsPerPage?: number;
  };
  'links.apply-suggestion': {
    websiteId: string;
    suggestionIds: string[];
    /** User who approved the change; recorded on the ChangeLog entry. */
    actorUserId?: string;
    dryRun?: boolean;
  };

  // ── Content pipeline ────────────────────────────────────────
  'content.pipeline-stage': {
    websiteId: string;
    draftId: string;
    stage: ContentStage;
    /** Re-run a stage that already completed. */
    force?: boolean;
  };
  'content.detect-decay': {
    websiteId: string;
    lookbackDays?: number;
    minImpressions?: number;
  };
  'content.publish': {
    websiteId: string;
    draftId: string;
    /** SeoAction that authorised the publish, when it came through the approval flow. */
    actionId?: string;
    dryRun?: boolean;
  };

  // ── GEO / entities ──────────────────────────────────────────
  'geo.audit': {
    websiteId: string;
    pageIds?: string[];
    /** Audit every indexable page rather than the usual representative sample. */
    full?: boolean;
  };
  'entities.extract': {
    websiteId: string;
    pageIds?: string[];
    types?: EntityType[];
  };

  // ── AI visibility ───────────────────────────────────────────
  'aivis.discover-prompts': {
    websiteId: string;
    locale?: string;
    limit?: number;
  };
  'aivis.run-prompts': {
    websiteId: string;
    promptIds?: string[];
    /** Provider keys (e.g. 'openai'); omit to run every configured provider. */
    providers?: string[];
    locale?: string;
  };

  // ── Agents ──────────────────────────────────────────────────
  'agents.run': {
    websiteId: string;
    /** Registry key of the agent, e.g. 'technical-seo'. */
    agent: string;
    trigger?: JobTrigger;
    input?: Record<string, unknown>;
    /** Pre-created AgentRun row so the UI can follow along from the moment of enqueue. */
    agentRunId?: string;
  };
  'agents.manager-plan': {
    websiteId: string;
    horizonDays?: number;
    trigger?: JobTrigger;
  };

  // ── Actions ─────────────────────────────────────────────────
  'actions.execute': {
    websiteId: string;
    actionId: string;
    approvalId?: string;
    dryRun?: boolean;
  };
  'actions.measure': {
    websiteId: string;
    /** Measure one action; omit to sweep every executed action that is due. */
    actionId?: string;
    minDaysSinceExecution?: number;
  };

  // ── Reporting & notifications ───────────────────────────────
  'reports.generate': {
    /** Null/absent for a portfolio-wide report spanning every site the user owns. */
    websiteId?: string;
    type: ReportType;
    periodStart?: DateKey;
    periodEnd?: DateKey;
    /** Recipient for the resulting notification. */
    userId?: string;
  };
  'notifications.digest': {
    frequency: DigestFrequency;
    websiteId?: string;
    userId?: string;
  };

  // ── Maintenance ─────────────────────────────────────────────
  'embeddings.backfill': {
    websiteId: string;
    ownerTypes?: EmbeddingOwner[];
    limit?: number;
  };
  'maintenance.cleanup': {
    /** Rows older than this are eligible for deletion; the processor clamps to a safe floor. */
    olderThanDays?: number;
    targets?: CleanupTarget[];
  };
}

export type JobName = keyof JobPayloads;

export type JobPayload<K extends JobName = JobName> = JobPayloads[K];

/** Union of every payload shape — use `JobDispatch` when you need name/payload correlation. */
export type AnyJobPayload = JobPayloads[JobName];

// ─────────────────────────────────────────────────────────────
// Job → queue mapping
// ─────────────────────────────────────────────────────────────

/**
 * Every job's lane. Keyed by `JobName` so a new job cannot be added without choosing one.
 *
 * Two assignments are worth explaining:
 * - `content.publish` stays on `content` rather than `actions` because it shares the CMS
 *   adapter and its rate limits with the rest of the pipeline it terminates.
 * - `competitors.analyse` sits on `sync` because its cost is dominated by SERP-provider
 *   calls, and that is where the rate limit that matters lives.
 */
export const JOB_QUEUE: { readonly [K in JobName]: QueueName } = {
  'crawl.site': 'crawl',
  'crawl.cancel': 'crawl',

  'analysis.technical-audit': 'analysis',
  'analysis.page-scores': 'analysis',
  'analysis.site-scores': 'analysis',
  'analysis.full': 'analysis',

  'gsc.sync': 'sync',
  'gsc.backfill': 'sync',
  'bing.sync': 'sync',
  'ga4.sync': 'sync',

  'keywords.discover': 'sync',
  'keywords.enrich': 'sync',
  'keywords.cluster': 'ai',

  'serp.fetch': 'sync',
  'competitors.analyse': 'sync',

  'links.analyse-internal': 'analysis',
  'links.apply-suggestion': 'actions',

  'content.pipeline-stage': 'content',
  'content.detect-decay': 'analysis',
  'content.publish': 'content',

  'geo.audit': 'analysis',
  'entities.extract': 'ai',

  'aivis.discover-prompts': 'ai',
  'aivis.run-prompts': 'ai',

  'agents.run': 'ai',
  'agents.manager-plan': 'ai',

  'actions.execute': 'actions',
  'actions.measure': 'actions',

  'reports.generate': 'maintenance',
  'notifications.digest': 'maintenance',

  'embeddings.backfill': 'ai',
  'maintenance.cleanup': 'maintenance',
};

/** Every declared job name, derived from the queue map so the two can never drift. */
export const JOB_NAMES = Object.keys(JOB_QUEUE) as JobName[];

export function isJobName(value: string): value is JobName {
  return Object.prototype.hasOwnProperty.call(JOB_QUEUE, value);
}

/** The lane a job runs on. Throws only for names that are not in the catalogue. */
export function queueForJob(jobName: JobName): QueueName {
  return JOB_QUEUE[jobName];
}

/** Job names that run on a given lane — used by the worker to build its dispatch tables. */
export function jobsForQueue(queue: QueueName): JobName[] {
  return JOB_NAMES.filter((name) => JOB_QUEUE[name] === queue);
}

// ─────────────────────────────────────────────────────────────
// Retry / concurrency policy
// ─────────────────────────────────────────────────────────────

export interface QueuePolicy {
  /** Total attempts including the first. */
  attempts: number;
  /** Base delay for BullMQ's exponential backoff (delay × 2^(attempt-1)). */
  backoffMs: number;
  /** Multiplier applied to `env.workerConcurrency` when a worker does not override it. */
  concurrencyFactor: number;
  /** How long a single attempt may hold its lock before it is considered stalled. */
  lockDurationMs: number;
  /** Completed jobs kept in Redis; the durable JobRecord row is the real history. */
  keepCompleted: number;
  keepFailed: number;
}

/**
 * Per-lane retry policy. External-API lanes retry more and back off harder because their
 * failures are usually transient rate limits; `actions` retries barely at all because a
 * half-applied mutation to a live site is worse than a visible failure.
 */
export const QUEUE_POLICY: { readonly [K in QueueName]: QueuePolicy } = {
  crawl: {
    attempts: 2,
    backoffMs: 30_000,
    concurrencyFactor: 0.5,
    lockDurationMs: 300_000,
    keepCompleted: 50,
    keepFailed: 200,
  },
  analysis: {
    attempts: 3,
    backoffMs: 5_000,
    concurrencyFactor: 1,
    lockDurationMs: 120_000,
    keepCompleted: 100,
    keepFailed: 200,
  },
  sync: {
    attempts: 5,
    backoffMs: 15_000,
    concurrencyFactor: 1,
    lockDurationMs: 180_000,
    keepCompleted: 100,
    keepFailed: 200,
  },
  ai: {
    attempts: 3,
    backoffMs: 20_000,
    concurrencyFactor: 0.5,
    lockDurationMs: 300_000,
    keepCompleted: 100,
    keepFailed: 200,
  },
  content: {
    attempts: 3,
    backoffMs: 20_000,
    concurrencyFactor: 0.5,
    lockDurationMs: 600_000,
    keepCompleted: 100,
    keepFailed: 200,
  },
  actions: {
    attempts: 1,
    backoffMs: 60_000,
    concurrencyFactor: 0.25,
    lockDurationMs: 180_000,
    keepCompleted: 200,
    keepFailed: 500,
  },
  maintenance: {
    attempts: 2,
    backoffMs: 60_000,
    concurrencyFactor: 0.25,
    lockDurationMs: 300_000,
    keepCompleted: 50,
    keepFailed: 100,
  },
};

// ─────────────────────────────────────────────────────────────
// Wire format
// ─────────────────────────────────────────────────────────────

/**
 * What actually travels through Redis.
 *
 * `jobRecordId` is optional because repeatable jobs are created by BullMQ from a stored
 * template that predates any JobRecord row; the worker creates the row on first execution.
 */
export interface JobEnvelope<K extends JobName = JobName> {
  jobName: K;
  payload: JobPayloads[K];
  websiteId: string | null;
  jobRecordId?: string;
  /** Set when the job was produced by a ScheduledJob row, so the worker can stamp lastRunAt. */
  scheduledJobId?: string;
  trigger: JobTrigger;
  enqueuedAt: string;
}

/**
 * Discriminated union of `{ jobName, payload }` pairs. Switching on `jobName` narrows
 * `payload` to the matching type, which is what makes the worker's dispatcher type-safe.
 */
export type JobDispatch = {
  [K in JobName]: { jobName: K; payload: JobPayloads[K] };
}[JobName];

/** Reads the website a payload belongs to; `null` for portfolio-wide and global jobs. */
export function websiteIdOfPayload(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as { websiteId?: unknown }).websiteId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
