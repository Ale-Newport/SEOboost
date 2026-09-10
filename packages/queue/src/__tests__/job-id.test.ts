import { describe, expect, it } from 'vitest';
import { buildJobId } from '../queue';

/**
 * Regression tests for a bug that silently broke every background job:
 * BullMQ rejects a custom job id containing `:` ("Custom Id cannot contain :"), and the failure
 * surfaced as "Redis is unreachable" — sending the operator to debug a perfectly healthy broker.
 */
describe('buildJobId', () => {
  it('never emits a colon — BullMQ rejects those outright', () => {
    expect(buildJobId('crawl.site')).not.toContain(':');
    expect(buildJobId('crawl.site', 'abc123')).not.toContain(':');
    expect(buildJobId('analysis.technical-audit', 'audit:with:colons')).not.toContain(':');
  });

  it('is deterministic for a given dedupe key, so a retry cannot duplicate the job', () => {
    expect(buildJobId('crawl.site', 'site-1')).toBe(buildJobId('crawl.site', 'site-1'));
  });

  it('distinguishes different jobs and different keys', () => {
    expect(buildJobId('crawl.site', 'a')).not.toBe(buildJobId('crawl.site', 'b'));
    expect(buildJobId('crawl.site', 'a')).not.toBe(buildJobId('gsc.sync', 'a'));
  });

  it('is random when no dedupe key is supplied', () => {
    expect(buildJobId('crawl.site')).not.toBe(buildJobId('crawl.site'));
  });

  it('sanitises anything a caller passes, not just colons', () => {
    const id = buildJobId('crawl.site', 'https://example.com/a b?c=1#d');
    expect(id).toMatch(/^crawl\.site--[A-Za-z0-9._-]+$/);
  });

  it('keeps the job name readable at the front for log grepping', () => {
    expect(buildJobId('gsc.backfill', 'x').startsWith('gsc.backfill')).toBe(true);
  });
});
