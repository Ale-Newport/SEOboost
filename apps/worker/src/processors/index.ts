/**
 * The dispatch table.
 *
 * `ALL_HANDLERS` is typed as a *complete* map over `JobName`, so adding a job to the catalogue
 * in `@seo/queue` without writing its processor is a compile error rather than a job that
 * silently fails at runtime with "no handler registered".
 *
 * Workers are started one per lane. The lane is the unit of concurrency and retry policy, so a
 * slow crawl cannot starve a cheap score recomputation, and a provider rate limit is contained
 * to the lane that talks to that provider.
 */

import type { Worker } from 'bullmq';
import {
  QUEUE_NAMES,
  createJobRouter,
  jobsForQueue,
  registerWorker,
  type JobEnvelope,
  type JobHandler,
  type JobHandlerMap,
  type JobName,
  type QueueName,
} from '@seo/queue';
import { createLogger } from '@seo/shared';
import { crawlCancel, crawlSite } from './crawl';
import { fullAnalysis, pageScores, siteScores, technicalAudit } from './analysis';
import { bingSync, ga4Sync, gscBackfill, gscSync } from './sync';
import { keywordsCluster, keywordsDiscover, keywordsEnrich } from './keywords';
import { contentDetectDecay, contentPipelineStage, contentPublish } from './content';
import { actionsExecute, actionsMeasure } from './actions';
import {
  agentsManagerPlan,
  agentsRun,
  aivisDiscoverPrompts,
  aivisRunPrompts,
  competitorsAnalyse,
  embeddingsBackfill,
  entitiesExtract,
  geoAudit,
  linksAnalyseInternal,
  linksApplySuggestion,
  serpFetch,
} from './ai';
import { maintenanceCleanup, notificationsDigest, reportsGenerate } from './maintenance';

const log = createLogger('worker:processors');

/** Every job in the catalogue, with its processor. Missing entries do not compile. */
type CompleteHandlerMap = { [K in JobName]: JobHandler<K> };

export const ALL_HANDLERS: CompleteHandlerMap = {
  'crawl.site': crawlSite,
  'crawl.cancel': crawlCancel,

  'analysis.technical-audit': technicalAudit,
  'analysis.page-scores': pageScores,
  'analysis.site-scores': siteScores,
  'analysis.full': fullAnalysis,

  'gsc.sync': gscSync,
  'gsc.backfill': gscBackfill,
  'bing.sync': bingSync,
  'ga4.sync': ga4Sync,

  'keywords.discover': keywordsDiscover,
  'keywords.enrich': keywordsEnrich,
  'keywords.cluster': keywordsCluster,

  'serp.fetch': serpFetch,
  'competitors.analyse': competitorsAnalyse,

  'links.analyse-internal': linksAnalyseInternal,
  'links.apply-suggestion': linksApplySuggestion,

  'content.pipeline-stage': contentPipelineStage,
  'content.detect-decay': contentDetectDecay,
  'content.publish': contentPublish,

  'geo.audit': geoAudit,
  'entities.extract': entitiesExtract,

  'aivis.discover-prompts': aivisDiscoverPrompts,
  'aivis.run-prompts': aivisRunPrompts,

  'agents.run': agentsRun,
  'agents.manager-plan': agentsManagerPlan,

  'actions.execute': actionsExecute,
  'actions.measure': actionsMeasure,

  'reports.generate': reportsGenerate,
  'notifications.digest': notificationsDigest,

  'embeddings.backfill': embeddingsBackfill,
  'maintenance.cleanup': maintenanceCleanup,
};

/**
 * Throughput caps for the lanes that talk to somebody else's API.
 *
 * These are process-wide ceilings, on top of each provider client's own retry/backoff: they
 * exist so a fan-out across a large portfolio cannot burn a vendor quota in the first minute.
 */
const LANE_LIMITS: Partial<Record<QueueName, { max: number; durationMs: number }>> = {
  sync: { max: 60, durationMs: 60_000 },
  ai: { max: 30, durationMs: 60_000 },
  content: { max: 20, durationMs: 60_000 },
};

/**
 * The handlers for one lane.
 *
 * The loop copies each handler under its own job name, so the key/value correlation that
 * `JobHandlerMap` expresses holds by construction — TypeScript just cannot prove it for a
 * computed key, which is why the assembled object is asserted once here rather than per entry.
 */
function laneHandlers(queue: QueueName): JobHandlerMap {
  const map: Record<string, unknown> = {};
  for (const name of jobsForQueue(queue)) map[name] = ALL_HANDLERS[name];
  return map as JobHandlerMap;
}

export interface RegisteredWorkers {
  workers: Worker<JobEnvelope, unknown, string>[];
  /** Lanes that could not start because Redis is unavailable. */
  unstarted: QueueName[];
}

/** Starts one worker per lane. Lanes with no broker are reported, not thrown. */
export function registerAllWorkers(): RegisteredWorkers {
  const workers: Worker<JobEnvelope, unknown, string>[] = [];
  const unstarted: QueueName[] = [];

  for (const queue of QUEUE_NAMES) {
    const limiter = LANE_LIMITS[queue];
    const worker = registerWorker(queue, createJobRouter(laneHandlers(queue)), {
      ...(limiter ? { limiter } : {}),
    });
    if (worker) workers.push(worker);
    else unstarted.push(queue);
  }

  log.info('workers registered', {
    started: workers.length,
    lanes: QUEUE_NAMES.length,
    unstarted,
  });
  return { workers, unstarted };
}

/** Every job name this worker can process — used by the startup banner. */
export function handledJobNames(): JobName[] {
  return Object.keys(ALL_HANDLERS) as JobName[];
}
