/**
 * Bounded reads and writes.
 *
 * Every processor in this app has to survive a 10,000-page site on a small container, so no
 * query here is allowed to be unbounded: reads walk the table by keyset (`cursor` on the
 * primary key, which Postgres serves from the index), and writes go out in fixed-size chunks.
 * The helpers also carry an explicit `maxRows` ceiling, because "the site is bigger than we
 * budgeted for" must degrade into a documented partial pass rather than into an OOM kill.
 */

import { type Prisma, prisma } from '@seo/db';

/** Rows fetched per keyset page. Small enough to stay cheap, large enough to amortise latency. */
export const READ_BATCH = 250;

/** Rows per `createMany` chunk; keeps us well under Postgres' 65 535 bind-parameter limit. */
export const WRITE_CHUNK = 500;

export interface BatchOptions {
  batchSize?: number;
  /** Hard ceiling on rows visited. Reaching it is reported, never silently ignored. */
  maxRows?: number;
}

export interface BatchRun {
  processed: number;
  /** True when `maxRows` stopped the walk before the table was exhausted. */
  truncated: boolean;
}

/**
 * Walks a table in keyset order, handing each page to `handle`.
 *
 * `fetchPage` must return rows ordered by `id` ascending and start *after* `cursor`, which is
 * what makes the walk stable while other jobs insert rows behind us.
 */
export async function forEachBatch<T extends { id: string }>(
  fetchPage: (cursor: string | null, take: number) => Promise<T[]>,
  handle: (rows: T[]) => Promise<void>,
  options: BatchOptions = {},
): Promise<BatchRun> {
  const batchSize = options.batchSize ?? READ_BATCH;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;

  let cursor: string | null = null;
  let processed = 0;

  for (;;) {
    const remaining = maxRows - processed;
    if (remaining <= 0) return { processed, truncated: true };

    const take = Math.min(batchSize, remaining);
    const rows: T[] = await fetchPage(cursor, take);
    if (rows.length === 0) return { processed, truncated: false };

    await handle(rows);
    processed += rows.length;
    cursor = rows[rows.length - 1].id;

    if (rows.length < take) return { processed, truncated: false };
  }
}

/**
 * Collects at most `maxRows` rows into memory.
 *
 * Used only where an algorithm genuinely needs the whole set at once (clustering, the link
 * graph, the site-wide audit). The returned `truncated` flag is surfaced in the job result so
 * a partial analysis is never presented as a complete one.
 */
export async function collectBatches<T extends { id: string }>(
  fetchPage: (cursor: string | null, take: number) => Promise<T[]>,
  options: BatchOptions = {},
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  const run = await forEachBatch(
    fetchPage,
    async (page) => {
      rows.push(...page);
    },
    options,
  );
  return { rows, truncated: run.truncated };
}

/** Splits `items` into fixed-size chunks without copying the whole array first. */
export function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

/**
 * Runs prepared Prisma operations in transactional chunks.
 *
 * Per-row `update` is unavoidable when each row gets a different value; batching the promises
 * into one `$transaction` turns N round trips into N/chunk, which is the difference between a
 * 10-second and a 10-minute reconcile on a large site.
 */
export async function runChunked(
  operations: readonly Prisma.PrismaPromise<unknown>[],
  chunkSize = 100,
): Promise<number> {
  let applied = 0;
  for (const slice of chunks(operations, chunkSize)) {
    await prisma.$transaction(slice);
    applied += slice.length;
  }
  return applied;
}
