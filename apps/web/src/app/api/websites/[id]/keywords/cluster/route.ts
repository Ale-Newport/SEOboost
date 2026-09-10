import { z } from 'zod';
import { prisma } from '@seo/db';
import { createLogger, isConfigured } from '@seo/shared';
import { isAiAvailable } from '@seo/ai';
import { enqueue } from '@seo/queue';
import { readBody, requireWebsite, route } from '@/lib/api';

const log = createLogger('api:keyword-cluster');

type Params = { id: string };

const bodySchema = z.object({
  /** Omit to let the worker pick the best method the installation can actually run. */
  method: z.enum(['embedding', 'serp', 'lexical']).optional(),
  minClusterSize: z.coerce.number().int().min(2).max(100).optional(),
  keywordIds: z.array(z.string().min(1)).max(10_000).optional(),
});

interface SkippedResult {
  queued: false;
  skipped: true;
  reason: string;
  /** What the operator has to do to make this run — never a silent no-op. */
  remedy: string;
}

/**
 * Queue keyword clustering.
 *
 * Each method has a hard prerequisite, and asking for one that cannot run is answered with a
 * typed `skipped` result rather than a queued job that will fail in the worker an hour later:
 * embeddings need an AI provider, SERP clustering needs a SERP provider, lexical needs neither.
 */
export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const body = await readBody(request, bodySchema);

  const keywordCount = await prisma.keyword.count({ where: { websiteId: website.id } });
  if (keywordCount < 2) {
    return {
      queued: false,
      skipped: true,
      reason: `This site has ${keywordCount} keyword${keywordCount === 1 ? '' : 's'}; clustering needs at least 2.`,
      remedy: 'Connect Search Console or import a keyword list first.',
    } satisfies SkippedResult;
  }

  if (body.method === 'embedding' && !isAiAvailable()) {
    return {
      queued: false,
      skipped: true,
      reason: 'Embedding-based clustering needs an AI provider, and none is configured.',
      remedy: 'Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY — or cluster lexically instead.',
    } satisfies SkippedResult;
  }

  if (body.method === 'serp' && !isConfigured.anySerp()) {
    return {
      queued: false,
      skipped: true,
      reason: 'SERP-overlap clustering needs a SERP provider, and none is configured.',
      remedy:
        'Set DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD, SERPAPI_KEY or SERPER_API_KEY — or cluster lexically instead.',
    } satisfies SkippedResult;
  }

  const result = await enqueue(
    'keywords.cluster',
    {
      websiteId: website.id,
      ...(body.method === undefined ? {} : { method: body.method }),
      ...(body.minClusterSize === undefined ? {} : { minClusterSize: body.minClusterSize }),
      ...(body.keywordIds === undefined ? {} : { keywordIds: body.keywordIds }),
    },
    // One clustering run per site at a time: a second click while the first is in flight is a
    // no-op rather than two passes fighting over the same cluster rows.
    { dedupeKey: `cluster:${website.id}`, trigger: 'api' },
  );

  log.info('clustering requested', {
    websiteId: website.id,
    method: body.method ?? 'auto',
    keywordCount,
    queued: result.enqueued,
  });

  return {
    queued: result.enqueued,
    skipped: false as const,
    keywordCount,
    enqueue: result,
    message: result.enqueued
      ? 'Clustering queued.'
      : result.reason === 'duplicate'
        ? 'Clustering is already running for this site.'
        : 'Recorded, but no queue broker is reachable. Start Redis and the worker to run it.',
  };
});
