import { prisma } from '@seo/db';
import type { EmbeddingOwner } from '@seo/db';
import { ValidationError, chunk, cosineSimilarity, createLogger, errorMessage, mapWithConcurrency, round } from '@seo/shared';
import { sha256 } from '@seo/shared/hash';
import { hasEmbeddingProvider, resolveModel } from './registry';
import type { WebsiteModelSettings } from './registry';
import { assertWithinBudget, recordUsage } from './usage';
import type { ProviderName } from './types';

const log = createLogger('ai:embeddings');

/**
 * Vector storage and similarity search.
 *
 * Vectors live in `EmbeddingRecord.vector` (a plain Postgres `Float[]`) and similarity is
 * computed in-process. That is deliberate for the scale this product targets: a site with a
 * few thousand pages and keywords ranks in single-digit milliseconds, and it keeps the
 * install requirement at "any Postgres" rather than "Postgres with pgvector".
 *
 * PGVECTOR UPGRADE PATH (do this once a single site passes ~100k vectors, or when p95 for
 * `findSimilar` exceeds ~200ms):
 *  1. `CREATE EXTENSION vector;` and add `vectorV vector(1536)` alongside the existing column
 *     via a migration, backfilling from `vector` in batches.
 *  2. Build an HNSW index: `CREATE INDEX ON "EmbeddingRecord" USING hnsw (vectorV vector_cosine_ops)`.
 *     One index per dimensionality — mixing embedding models in one column is not supported,
 *     hence the `model` column and the re-embed-on-model-change rule in `upsertEmbeddingsBatch`.
 *  3. Replace the body of `findSimilar` with `prisma.$queryRaw` using the `<=>` cosine-distance
 *     operator and `ORDER BY ... LIMIT`. The exported signature and `SimilarMatch` shape are
 *     designed to survive that swap unchanged; nothing outside this file needs to know.
 */

/** OpenAI and Gemini both accept large batches; 96 keeps a single request well inside limits. */
export const EMBEDDING_BATCH_SIZE = 96;

/** Batches in flight at once. Low enough to stay under per-minute rate limits on free tiers. */
const BATCH_CONCURRENCY = 2;

/** Above this many rows the in-process scan is no longer the right tool — see the note above. */
const SCAN_WARN_THRESHOLD = 100_000;

/**
 * Rows pulled per page while scanning. Vectors are large (1536 floats ≈ 12KB each), so the
 * scan is paginated: peak memory is one page plus the top-K result set, not the whole
 * partition. 500 rows ≈ 6MB in flight.
 */
const SCAN_PAGE_SIZE = 500;

export interface EmbeddingRouteOptions {
  websiteId?: string | null;
  /** The site's `WebsiteSettings` row, so a per-site embedding model is honoured. */
  settings?: WebsiteModelSettings | null;
  provider?: string | null;
  model?: string | null;
  /** Reduce the output vector size where the model supports it. */
  dimensions?: number;
  /** Label recorded in `AiUsage`. */
  task?: string;
  agent?: string | null;
  signal?: AbortSignal;
}

export interface EmbedTextsResult {
  vectors: number[][];
  model: string;
  provider: ProviderName;
  dimensions: number;
  tokensIn: number;
  costUsd: number;
}

/** True when a provider with an embeddings API is configured. Never throws. */
export function isEmbeddingAvailable(): boolean {
  return hasEmbeddingProvider();
}

/**
 * Embed texts through the resolved embedding provider, in batches.
 *
 * Order is preserved: `vectors[i]` always corresponds to `texts[i]`, which the upsert path
 * relies on to pair vectors back to rows.
 */
export async function embedTexts(
  texts: readonly string[],
  opts: EmbeddingRouteOptions = {},
): Promise<EmbedTextsResult> {
  // Embeddings are the cheapest call per unit but the easiest to run away with: a backfill
  // embeds an entire corpus. Without this guard a re-embed loop could spend past the cap that
  // every generation call respects.
  if (texts.length) await assertWithinBudget(opts.websiteId ?? null);

  const route = await resolveModel('embedding', {
    settings: opts.settings,
    provider: opts.provider,
    model: opts.model,
  });

  if (!texts.length) {
    return {
      vectors: [],
      model: route.model,
      provider: route.providerName,
      dimensions: 0,
      tokensIn: 0,
      costUsd: 0,
    };
  }

  const batches = chunk(texts, EMBEDDING_BATCH_SIZE);
  const started = Date.now();

  const results = await mapWithConcurrency(batches, BATCH_CONCURRENCY, async (batch) =>
    route.provider.embed([...batch], {
      model: route.model,
      ...(opts.dimensions ? { dimensions: opts.dimensions } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
  );

  const vectors = results.flatMap((result) => result.vectors);
  const tokensIn = results.reduce((total, result) => total + result.tokensIn, 0);
  const costUsd = round(
    results.reduce((total, result) => total + result.costUsd, 0),
    6,
  );

  await recordUsage({
    websiteId: opts.websiteId ?? null,
    provider: route.providerName,
    model: route.model,
    task: opts.task ?? 'embedding',
    agent: opts.agent ?? null,
    tokensIn,
    tokensOut: 0,
    costUsd,
    latencyMs: Date.now() - started,
    success: true,
  });

  return {
    vectors,
    model: results[0]?.model ?? route.model,
    provider: route.providerName,
    dimensions: vectors[0]?.length ?? 0,
    tokensIn,
    costUsd,
  };
}

export interface UpsertEmbeddingInput {
  websiteId: string;
  ownerType: EmbeddingOwner;
  ownerId: string;
  /** Set only for `ownerType: 'PAGE'` — the column is unique and FK-constrained. */
  pageId?: string | null;
  /** Set only for `ownerType: 'KEYWORD'`. */
  keywordId?: string | null;
  text: string;
  model?: string | null;
}

export type UpsertStatus = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface UpsertEmbeddingResult {
  ownerType: EmbeddingOwner;
  ownerId: string;
  status: UpsertStatus;
  model: string | null;
  dimensions: number;
}

export interface UpsertEmbeddingsBatchResult {
  results: UpsertEmbeddingResult[];
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  tokensIn: number;
  costUsd: number;
  model: string | null;
  provider: ProviderName | null;
}

function ownerKey(ownerType: EmbeddingOwner, ownerId: string): string {
  return `${ownerType}:${ownerId}`;
}

/**
 * `pageId` and `keywordId` are unique, FK-constrained columns that exist so a deleted page or
 * keyword cascades its vector away. A value that contradicts `ownerType` would either violate
 * that unique constraint against an unrelated row or attach the wrong cascade, so it is dropped
 * rather than written.
 */
function relationIds(input: UpsertEmbeddingInput): { pageId: string | null; keywordId: string | null } {
  return {
    pageId: input.ownerType === 'PAGE' ? (input.pageId ?? null) : null,
    keywordId: input.ownerType === 'KEYWORD' ? (input.keywordId ?? null) : null,
  };
}

/**
 * Embed and store one owner's text, skipping the model call when neither the text nor the
 * model has changed since the last run. Re-embedding is the dominant cost of every crawl and
 * refresh cycle, so the hash check is the difference between a cheap incremental run and
 * paying for the whole corpus again.
 */
export async function upsertEmbedding(
  input: UpsertEmbeddingInput,
  opts: EmbeddingRouteOptions = {},
): Promise<UpsertEmbeddingResult> {
  const batch = await upsertEmbeddingsBatch([input], opts);
  const result = batch.results[0];
  if (result) return result;
  // Unreachable in practice: the batch always emits one result per input.
  return { ownerType: input.ownerType, ownerId: input.ownerId, status: 'skipped', model: null, dimensions: 0 };
}

/**
 * Owners handled per internal slice. A backfill can legitimately hand this function an entire
 * corpus; embedding all of it before writing anything would hold every vector in memory at once
 * (100k × 1536 floats is well over half a gigabyte) and put a 100k-element `IN (…)` in the
 * lookup. Slicing keeps peak memory flat and commits rows as it goes, so a failure halfway
 * through a backfill keeps the work already done.
 */
const UPSERT_SLICE_SIZE = 500;

/**
 * Batch form used by backfills and the crawl pipeline. One model resolution and one
 * existing-row lookup per slice, with batched embedding calls inside each slice.
 */
export async function upsertEmbeddingsBatch(
  items: readonly UpsertEmbeddingInput[],
  opts: EmbeddingRouteOptions = {},
): Promise<UpsertEmbeddingsBatchResult> {
  if (items.length <= UPSERT_SLICE_SIZE) return upsertSlice(items, opts);

  const merged: UpsertEmbeddingsBatchResult = {
    results: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    tokensIn: 0,
    costUsd: 0,
    model: null,
    provider: null,
  };
  for (const slice of chunk(items, UPSERT_SLICE_SIZE)) {
    const part = await upsertSlice(slice, opts);
    merged.results.push(...part.results);
    merged.created += part.created;
    merged.updated += part.updated;
    merged.unchanged += part.unchanged;
    merged.skipped += part.skipped;
    merged.tokensIn += part.tokensIn;
    merged.costUsd += part.costUsd;
    merged.model = part.model ?? merged.model;
    merged.provider = part.provider ?? merged.provider;
  }
  merged.costUsd = round(merged.costUsd, 6);
  return merged;
}

async function upsertSlice(
  items: readonly UpsertEmbeddingInput[],
  opts: EmbeddingRouteOptions = {},
): Promise<UpsertEmbeddingsBatchResult> {
  const empty: UpsertEmbeddingsBatchResult = {
    results: [],
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    tokensIn: 0,
    costUsd: 0,
    model: null,
    provider: null,
  };
  if (!items.length) return empty;

  const route = await resolveModel('embedding', {
    settings: opts.settings,
    provider: opts.provider,
    model: opts.model ?? items[0]?.model ?? null,
  });

  const results = new Map<string, UpsertEmbeddingResult>();
  const candidates: Array<{ input: UpsertEmbeddingInput; textHash: string }> = [];

  for (const input of items) {
    const key = ownerKey(input.ownerType, input.ownerId);
    const text = input.text.trim();
    if (!text) {
      // No text is not an error — an empty page simply has nothing to embed.
      results.set(key, {
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        status: 'skipped',
        model: null,
        dimensions: 0,
      });
      continue;
    }
    candidates.push({ input: { ...input, text }, textHash: sha256(text) });
  }

  if (!candidates.length) {
    return { ...empty, results: [...results.values()], skipped: results.size };
  }

  // Load current rows so unchanged owners never reach the provider.
  const idsByType = new Map<EmbeddingOwner, string[]>();
  for (const candidate of candidates) {
    const list = idsByType.get(candidate.input.ownerType) ?? [];
    list.push(candidate.input.ownerId);
    idsByType.set(candidate.input.ownerType, list);
  }

  const existingRows = await prisma.embeddingRecord.findMany({
    where: {
      OR: [...idsByType.entries()].map(([ownerType, ownerIds]) => ({
        ownerType,
        ownerId: { in: ownerIds },
      })),
    },
    select: { ownerType: true, ownerId: true, textHash: true, model: true, dimensions: true },
  });
  const existing = new Map(existingRows.map((row) => [ownerKey(row.ownerType, row.ownerId), row]));

  const toEmbed: Array<{ input: UpsertEmbeddingInput; textHash: string }> = [];
  for (const candidate of candidates) {
    const key = ownerKey(candidate.input.ownerType, candidate.input.ownerId);
    const row = existing.get(key);
    // A model change invalidates the vector even when the text is identical: vectors from
    // different models are not comparable, so a mixed corpus produces meaningless scores.
    if (row && row.textHash === candidate.textHash && row.model === route.model) {
      results.set(key, {
        ownerType: candidate.input.ownerType,
        ownerId: candidate.input.ownerId,
        status: 'unchanged',
        model: row.model,
        dimensions: row.dimensions,
      });
      continue;
    }
    toEmbed.push(candidate);
  }

  if (!toEmbed.length) {
    return {
      results: [...results.values()],
      created: 0,
      updated: 0,
      unchanged: [...results.values()].filter((r) => r.status === 'unchanged').length,
      skipped: [...results.values()].filter((r) => r.status === 'skipped').length,
      tokensIn: 0,
      costUsd: 0,
      model: route.model,
      provider: route.providerName,
    };
  }

  const embedded = await embedTexts(
    toEmbed.map((candidate) => candidate.input.text),
    { ...opts, provider: route.providerName, model: route.model },
  );

  let created = 0;
  let updated = 0;

  for (const [index, candidate] of toEmbed.entries()) {
    const key = ownerKey(candidate.input.ownerType, candidate.input.ownerId);
    const vector = embedded.vectors[index];
    if (!vector || !vector.length) {
      log.warn('provider returned no vector for an owner', {
        ownerType: candidate.input.ownerType,
        ownerId: candidate.input.ownerId,
        model: embedded.model,
      });
      results.set(key, {
        ownerType: candidate.input.ownerType,
        ownerId: candidate.input.ownerId,
        status: 'skipped',
        model: embedded.model,
        dimensions: 0,
      });
      continue;
    }

    const data = {
      websiteId: candidate.input.websiteId,
      ...relationIds(candidate.input),
      model: embedded.model,
      dimensions: vector.length,
      vector,
      textHash: candidate.textHash,
    };

    try {
      await prisma.embeddingRecord.upsert({
        where: {
          ownerType_ownerId: {
            ownerType: candidate.input.ownerType,
            ownerId: candidate.input.ownerId,
          },
        },
        create: {
          ownerType: candidate.input.ownerType,
          ownerId: candidate.input.ownerId,
          ...data,
        },
        update: data,
      });
      const wasPresent = existing.has(key);
      if (wasPresent) updated += 1;
      else created += 1;
      results.set(key, {
        ownerType: candidate.input.ownerType,
        ownerId: candidate.input.ownerId,
        status: wasPresent ? 'updated' : 'created',
        model: embedded.model,
        dimensions: vector.length,
      });
    } catch (err) {
      // A dangling pageId/keywordId (row deleted mid-run) must not abort a whole backfill.
      log.warn('failed to persist embedding', {
        ownerType: candidate.input.ownerType,
        ownerId: candidate.input.ownerId,
        error: errorMessage(err),
      });
      results.set(key, {
        ownerType: candidate.input.ownerType,
        ownerId: candidate.input.ownerId,
        status: 'skipped',
        model: embedded.model,
        dimensions: vector.length,
      });
    }
  }

  const all = [...results.values()];
  return {
    results: all,
    created,
    updated,
    unchanged: all.filter((result) => result.status === 'unchanged').length,
    skipped: all.filter((result) => result.status === 'skipped').length,
    tokensIn: embedded.tokensIn,
    costUsd: embedded.costUsd,
    model: embedded.model,
    provider: embedded.provider,
  };
}

export interface SimilarMatch {
  ownerType: EmbeddingOwner;
  ownerId: string;
  pageId: string | null;
  keywordId: string | null;
  /** Cosine similarity, -1..1. Practically 0..1 for text embeddings. */
  score: number;
  model: string;
}

export interface FindSimilarOptions {
  websiteId: string;
  ownerType: EmbeddingOwner;
  vector: readonly number[];
  limit?: number;
  /** Drop matches below this cosine score. 0.75+ is a useful "related content" threshold. */
  minScore?: number;
  excludeOwnerId?: string | readonly string[];
}

const DEFAULT_LIMIT = 10;

/** Insert into a descending-by-score array capped at `limit`. Keeps peak memory at O(limit). */
function pushTopK(matches: SimilarMatch[], candidate: SimilarMatch, limit: number): void {
  if (matches.length >= limit && candidate.score <= (matches[matches.length - 1]?.score ?? 0)) {
    return;
  }
  // Insert *after* equal scores so ties keep scan order, matching the stable sort this replaced.
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((matches[mid]?.score ?? 0) >= candidate.score) low = mid + 1;
    else high = mid;
  }
  matches.splice(low, 0, candidate);
  if (matches.length > limit) matches.length = limit;
}

/**
 * Rank one site's vectors of a given owner type against `vector`.
 *
 * Scans that site+type partition in process (see the pgvector note at the top of this file).
 * The scan is paginated and only the top `limit` matches are retained, so a large partition
 * costs time but not memory — loading every vector of a 100k-page site at once is hundreds of
 * megabytes and would take the process down rather than merely being slow.
 *
 * Rows embedded with a different model than the query vector are still compared — the caller
 * controls the model, and filtering them out silently would look like missing data. A
 * dimension mismatch is the visible symptom, so it is logged once per call.
 */
export async function findSimilar(options: FindSimilarOptions): Promise<SimilarMatch[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));
  const minScore = options.minScore ?? 0;
  if (!options.vector.length) {
    throw new ValidationError('findSimilar requires a non-empty query vector');
  }

  const excluded = new Set(
    typeof options.excludeOwnerId === 'string'
      ? [options.excludeOwnerId]
      : (options.excludeOwnerId ?? []),
  );

  const query = [...options.vector];
  const matches: SimilarMatch[] = [];
  let mismatched = 0;
  let scanned = 0;
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.embeddingRecord.findMany({
      where: { websiteId: options.websiteId, ownerType: options.ownerType },
      select: {
        id: true,
        ownerType: true,
        ownerId: true,
        pageId: true,
        keywordId: true,
        vector: true,
        model: true,
        dimensions: true,
      },
      orderBy: { id: 'asc' },
      take: SCAN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!page.length) break;

    for (const row of page) {
      scanned += 1;
      if (excluded.has(row.ownerId)) continue;
      if (row.dimensions !== query.length) mismatched += 1;
      const score = cosineSimilarity(query, row.vector);
      if (score < minScore) continue;
      pushTopK(
        matches,
        {
          ownerType: row.ownerType,
          ownerId: row.ownerId,
          pageId: row.pageId,
          keywordId: row.keywordId,
          score: round(score, 6),
          model: row.model,
        },
        limit,
      );
    }

    // A short page is the last page; a full page without a usable cursor would loop forever,
    // so the absence of an id ends the scan too.
    if (page.length < SCAN_PAGE_SIZE) break;
    const last = page[page.length - 1]?.id;
    if (!last || last === cursor) break;
    cursor = last;
  }

  if (scanned > SCAN_WARN_THRESHOLD) {
    log.warn('embedding scan is above the in-process threshold — consider the pgvector path', {
      websiteId: options.websiteId,
      ownerType: options.ownerType,
      rows: scanned,
    });
  }

  if (mismatched) {
    log.warn('some stored vectors have a different dimensionality than the query', {
      websiteId: options.websiteId,
      ownerType: options.ownerType,
      mismatched,
      queryDimensions: query.length,
    });
  }

  return matches;
}

export interface FindSimilarToOwnerOptions {
  websiteId: string;
  ownerType: EmbeddingOwner;
  ownerId: string;
  /** Owner type to search against; defaults to `ownerType` (page → page, keyword → keyword). */
  targetOwnerType?: EmbeddingOwner;
  limit?: number;
  minScore?: number;
  /** Additional owners to exclude; the source owner is always excluded from its own results. */
  excludeOwnerId?: string | readonly string[];
}

/**
 * Related-content lookup starting from an owner that already has a stored vector.
 * Returns an empty list rather than throwing when the owner has not been embedded yet — the
 * caller is usually rendering a "related pages" panel that should simply stay empty.
 */
export async function findSimilarToOwner(
  options: FindSimilarToOwnerOptions,
): Promise<SimilarMatch[]> {
  const source = await prisma.embeddingRecord.findUnique({
    where: { ownerType_ownerId: { ownerType: options.ownerType, ownerId: options.ownerId } },
    select: { vector: true },
  });
  if (!source || !source.vector.length) {
    log.debug('owner has no stored embedding yet', {
      ownerType: options.ownerType,
      ownerId: options.ownerId,
    });
    return [];
  }

  const extra =
    typeof options.excludeOwnerId === 'string'
      ? [options.excludeOwnerId]
      : [...(options.excludeOwnerId ?? [])];

  return findSimilar({
    websiteId: options.websiteId,
    ownerType: options.targetOwnerType ?? options.ownerType,
    vector: source.vector,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
    excludeOwnerId: [options.ownerId, ...extra],
  });
}
