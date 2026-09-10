/**
 * Job catalogue tests.
 *
 * `../types` carries only `import type` declarations, so importing it here pulls in no Prisma
 * client, no ioredis and no env access — these assertions are pure table checks.
 *
 * The point of most of them is drift: the queue map, the derived name list and the per-lane
 * policy table are three structures that must stay in agreement, and nothing but a test
 * notices when a new job name is added to one and forgotten in another.
 */

import { describe, expect, it } from 'vitest';
import {
  JOB_NAMES,
  JOB_QUEUE,
  QUEUE_NAMES,
  QUEUE_POLICY,
  isJobName,
  isQueueName,
  jobsForQueue,
  queueForJob,
  websiteIdOfPayload,
  type JobName,
  type QueueName,
} from '../types';

describe('job → queue mapping', () => {
  it('assigns every job to a declared lane', () => {
    for (const jobName of JOB_NAMES) {
      expect(QUEUE_NAMES).toContain(JOB_QUEUE[jobName]);
    }
  });

  it('derives JOB_NAMES from JOB_QUEUE so the two cannot drift', () => {
    expect(JOB_NAMES).toEqual(Object.keys(JOB_QUEUE));
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
  });

  it('queueForJob agrees with the table', () => {
    for (const jobName of JOB_NAMES) {
      expect(queueForJob(jobName)).toBe(JOB_QUEUE[jobName]);
    }
  });

  it('pins the assignments whose reasoning is not obvious from the name', () => {
    // Shares the CMS adapter and its rate limits with the pipeline it terminates.
    expect(queueForJob('content.publish')).toBe('content');
    // Dominated by SERP-provider calls, which is where the rate limit that matters lives.
    expect(queueForJob('competitors.analyse')).toBe('sync');
    // Clustering is embedding-bound, unlike the rest of the keyword jobs.
    expect(queueForJob('keywords.cluster')).toBe('ai');
    expect(queueForJob('keywords.enrich')).toBe('sync');
    // Mutations to live customer properties run on the deliberately narrow lane.
    expect(queueForJob('links.apply-suggestion')).toBe('actions');
    expect(queueForJob('actions.execute')).toBe('actions');
    expect(queueForJob('crawl.site')).toBe('crawl');
    expect(queueForJob('maintenance.cleanup')).toBe('maintenance');
  });

  it('partitions the catalogue: jobsForQueue covers every job exactly once', () => {
    const seen: JobName[] = [];
    for (const queueName of QUEUE_NAMES) {
      const jobs = jobsForQueue(queueName);
      for (const jobName of jobs) {
        expect(JOB_QUEUE[jobName]).toBe(queueName);
        seen.push(jobName);
      }
    }
    expect(seen.length).toBe(JOB_NAMES.length);
    expect(new Set(seen)).toEqual(new Set(JOB_NAMES));
  });

  it('gives every lane at least one job', () => {
    for (const queueName of QUEUE_NAMES) {
      expect(jobsForQueue(queueName).length).toBeGreaterThan(0);
    }
  });
});

describe('guards', () => {
  it('isJobName accepts catalogue entries and rejects anything else', () => {
    expect(isJobName('crawl.site')).toBe(true);
    expect(isJobName('gsc.sync')).toBe(true);
    expect(isJobName('crawl.website')).toBe(false);
    expect(isJobName('')).toBe(false);
  });

  it('isJobName is not fooled by inherited Object properties', () => {
    // A job name arriving from a JSON column is attacker-adjacent input; a plain `in` check
    // would answer true for these and route them into the dispatcher.
    expect(isJobName('toString')).toBe(false);
    expect(isJobName('constructor')).toBe(false);
    expect(isJobName('__proto__')).toBe(false);
  });

  it('isQueueName accepts lanes and rejects anything else', () => {
    for (const queueName of QUEUE_NAMES) {
      expect(isQueueName(queueName)).toBe(true);
    }
    expect(isQueueName('crawl')).toBe(true);
    expect(isQueueName('crawler')).toBe(false);
    expect(isQueueName('')).toBe(false);
  });
});

describe('queue policy', () => {
  it('declares a policy for every lane', () => {
    for (const queueName of QUEUE_NAMES) {
      const policy = QUEUE_POLICY[queueName as QueueName];
      expect(policy).toBeDefined();
      expect(policy.attempts).toBeGreaterThanOrEqual(1);
      expect(policy.backoffMs).toBeGreaterThan(0);
      expect(policy.concurrencyFactor).toBeGreaterThan(0);
      expect(policy.lockDurationMs).toBeGreaterThan(0);
    }
  });

  it('never retries live-property mutations', () => {
    // A half-applied change to a customer's site is worse than a visible failure.
    expect(QUEUE_POLICY.actions.attempts).toBe(1);
  });

  it('retries the vendor-API lane hardest', () => {
    expect(QUEUE_POLICY.sync.attempts).toBeGreaterThan(QUEUE_POLICY.analysis.attempts);
  });

  it('gives the crawl lane a lock long enough for a slow page fetch', () => {
    expect(QUEUE_POLICY.crawl.lockDurationMs).toBeGreaterThanOrEqual(60_000);
  });
});

describe('websiteIdOfPayload', () => {
  it('reads the website a payload belongs to', () => {
    expect(websiteIdOfPayload({ websiteId: 'site_1' })).toBe('site_1');
  });

  it('returns null for portfolio-wide and malformed payloads', () => {
    expect(websiteIdOfPayload({ type: 'portfolio' })).toBeNull();
    expect(websiteIdOfPayload({ websiteId: '' })).toBeNull();
    expect(websiteIdOfPayload({ websiteId: 42 })).toBeNull();
    expect(websiteIdOfPayload(null)).toBeNull();
    expect(websiteIdOfPayload(undefined)).toBeNull();
    expect(websiteIdOfPayload('site_1')).toBeNull();
  });
});
