/**
 * Cron evaluation tests.
 *
 * `../cron` has no imports at all, so these run without Redis, Postgres or any env var.
 * Every expectation is pinned to a fixed `from` instant and asserted as an ISO string, because
 * a "next Monday" computed relative to the wall clock would pass or fail depending on the day
 * the suite happens to run.
 */

import { describe, expect, it } from 'vitest';
import { computeNextRun, computeNextRuns, isValidCron, parseCron } from '../cron';

/** 2024-05-15 is a Wednesday; every relative expectation below is anchored to it. */
const WEDNESDAY_NOON = new Date('2024-05-15T12:00:00.000Z');

function nextIso(expression: string, from: Date = WEDNESDAY_NOON): string | null {
  return computeNextRun(expression, from)?.toISOString() ?? null;
}

describe('parseCron', () => {
  it('accepts standard five-field expressions', () => {
    const result = parseCron('0 3 * * 1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.minutes).toEqual([0]);
    expect(result.schedule.hours).toEqual([3]);
    expect(result.schedule.daysOfWeek).toEqual([1]);
    expect(result.schedule.domRestricted).toBe(false);
    expect(result.schedule.dowRestricted).toBe(true);
  });

  it('expands step and range syntax', () => {
    const result = parseCron('*/15 9-11 * * *');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.schedule.minutes).toEqual([0, 15, 30, 45]);
    expect(result.schedule.hours).toEqual([9, 10, 11]);
  });

  it('normalises both spellings of Sunday', () => {
    const zero = parseCron('0 0 * * 0');
    const seven = parseCron('0 0 * * 7');
    expect(zero.ok && seven.ok).toBe(true);
    if (!zero.ok || !seven.ok) return;
    expect(zero.schedule.daysOfWeek).toEqual([0]);
    expect(seven.schedule.daysOfWeek).toEqual([0]);
  });

  it('resolves three-letter month and weekday names', () => {
    expect(nextIso('0 3 * * mon')).toBe(nextIso('0 3 * * 1'));
    expect(nextIso('0 0 1 jan *')).toBe('2025-01-01T00:00:00.000Z');
  });

  it('rejects malformed expressions instead of throwing', () => {
    expect(parseCron('').ok).toBe(false);
    expect(parseCron('* *').ok).toBe(false);
    expect(parseCron('60 * * * *').ok).toBe(false);
    expect(parseCron('0 24 * * *').ok).toBe(false);
    expect(parseCron('not a cron').ok).toBe(false);
    expect(isValidCron('0 3 * * 1')).toBe(true);
    expect(isValidCron('0 3 * * 8')).toBe(false);
  });
});

describe("computeNextRun — '0 3 * * 1' (Mondays at 03:00)", () => {
  it('finds the coming Monday from mid-week', () => {
    expect(nextIso('0 3 * * 1')).toBe('2024-05-20T03:00:00.000Z');
  });

  it('stays on the same Monday when the hour has not arrived yet', () => {
    expect(nextIso('0 3 * * 1', new Date('2024-05-20T01:00:00.000Z'))).toBe(
      '2024-05-20T03:00:00.000Z',
    );
  });

  it('is strictly forward-looking: the firing instant itself does not match', () => {
    expect(nextIso('0 3 * * 1', new Date('2024-05-20T03:00:00.000Z'))).toBe(
      '2024-05-27T03:00:00.000Z',
    );
  });
});

describe("computeNextRun — '*/15 * * * *' (every quarter hour)", () => {
  it('rounds up to the next quarter', () => {
    expect(nextIso('*/15 * * * *', new Date('2024-05-15T12:07:30.000Z'))).toBe(
      '2024-05-15T12:15:00.000Z',
    );
  });

  it('rolls into the next hour past :45', () => {
    expect(nextIso('*/15 * * * *', new Date('2024-05-15T12:45:00.000Z'))).toBe(
      '2024-05-15T13:00:00.000Z',
    );
  });

  it('rolls across midnight', () => {
    expect(nextIso('*/15 * * * *', new Date('2024-05-15T23:52:00.000Z'))).toBe(
      '2024-05-16T00:00:00.000Z',
    );
  });
});

describe("computeNextRun — '0 0 1 * *' (first of the month)", () => {
  it('finds the first of next month', () => {
    expect(nextIso('0 0 1 * *')).toBe('2024-06-01T00:00:00.000Z');
  });

  it('crosses a month boundary from the last minute of January', () => {
    expect(nextIso('0 0 1 * *', new Date('2024-01-31T23:59:00.000Z'))).toBe(
      '2024-02-01T00:00:00.000Z',
    );
  });

  it('crosses a year boundary', () => {
    expect(nextIso('0 0 1 * *', new Date('2024-12-15T00:00:00.000Z'))).toBe(
      '2025-01-01T00:00:00.000Z',
    );
  });
});

describe('computeNextRun — edge cases', () => {
  it('expands the @daily and @hourly macros', () => {
    expect(nextIso('@daily')).toBe('2024-05-16T00:00:00.000Z');
    expect(nextIso('@hourly')).toBe('2024-05-15T13:00:00.000Z');
    expect(nextIso('@monthly')).toBe('2024-06-01T00:00:00.000Z');
  });

  it('supports an optional leading seconds field', () => {
    expect(nextIso('30 * * * * *', new Date('2024-05-15T12:00:10.000Z'))).toBe(
      '2024-05-15T12:00:30.000Z',
    );
  });

  it('fires on either day field when both are restricted (standard cron OR)', () => {
    // The 1st of June 2024 is a Saturday, so the nearest match is the Friday before it.
    expect(nextIso('0 0 1 * fri')).toBe('2024-05-17T00:00:00.000Z');
  });

  it('returns null for an expression with no reachable occurrence', () => {
    expect(computeNextRun('0 0 30 2 *', WEDNESDAY_NOON)).toBeNull();
  });

  it('returns null rather than throwing on an invalid expression', () => {
    expect(computeNextRun('nonsense', WEDNESDAY_NOON)).toBeNull();
  });

  it('interprets the expression in the requested timezone', () => {
    // 03:00 America/New_York on 16 May 2024 is 07:00 UTC (EDT, UTC-4).
    const next = computeNextRun('0 3 * * *', WEDNESDAY_NOON, { timeZone: 'America/New_York' });
    expect(next?.toISOString()).toBe('2024-05-16T07:00:00.000Z');
  });

  it('falls back to UTC for an unknown timezone instead of failing', () => {
    const next = computeNextRun('0 3 * * *', WEDNESDAY_NOON, { timeZone: 'Mars/Olympus_Mons' });
    expect(next?.toISOString()).toBe('2024-05-16T03:00:00.000Z');
  });

  it('respects a shortened search horizon', () => {
    expect(computeNextRun('0 0 1 1 *', WEDNESDAY_NOON, { horizonDays: 30 })).toBeNull();
  });
});

describe('computeNextRuns', () => {
  it('returns consecutive, strictly increasing occurrences', () => {
    const runs = computeNextRuns('0 0 1 * *', 3, WEDNESDAY_NOON);
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2024-06-01T00:00:00.000Z',
      '2024-07-01T00:00:00.000Z',
      '2024-08-01T00:00:00.000Z',
    ]);
  });

  it('returns the weekly schedule used by the default crawl', () => {
    const runs = computeNextRuns('0 3 * * 1', 2, WEDNESDAY_NOON);
    expect(runs.map((d) => d.toISOString())).toEqual([
      '2024-05-20T03:00:00.000Z',
      '2024-05-27T03:00:00.000Z',
    ]);
  });

  it('stops early when the expression never fires', () => {
    expect(computeNextRuns('0 0 30 2 *', 3, WEDNESDAY_NOON)).toEqual([]);
  });

  // Each run is its own calendar walk, so an unbounded count from an API query string would be
  // a hang rather than a big answer.
  it('clamps an absurd or nonsensical count', () => {
    expect(computeNextRuns('* * * * *', 10_000, WEDNESDAY_NOON)).toHaveLength(500);
    expect(computeNextRuns('* * * * *', 0, WEDNESDAY_NOON)).toEqual([]);
    expect(computeNextRuns('* * * * *', -5, WEDNESDAY_NOON)).toEqual([]);
    expect(computeNextRuns('* * * * *', Number.NaN, WEDNESDAY_NOON)).toEqual([]);
  });
});
