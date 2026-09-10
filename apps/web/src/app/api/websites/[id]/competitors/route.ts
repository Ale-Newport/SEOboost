import { z } from 'zod';
import { isUniqueViolation, prisma } from '@seo/db';
import { ConflictError, ValidationError, createLogger, domainSchema, isConfigured } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { readQuery, readBody, requireWebsite, route } from '@/lib/api';
import { booleanParam } from '@/server/queries/filters';

const log = createLogger('api:competitors');

type Params = { id: string };

const listQuerySchema = z.object({
  includeInactive: booleanParam.optional(),
});

/**
 * Tracked competitors and what we know about each.
 *
 * The counters (`sharedKeywords`, `gapKeywords`, `serpOverlapPct`…) are written by the
 * competitor analysis job from observed SERP rows. A competitor added a minute ago therefore
 * reads as all zeros with `lastAnalysedAt: null`, which the UI shows as "not analysed yet"
 * rather than as a competitor with no overlap.
 */
export const GET = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const query = readQuery(request, listQuerySchema);

  const competitors = await prisma.competitor.findMany({
    where: {
      websiteId: params.id,
      ...(query.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ serpOverlapPct: 'desc' }, { domain: 'asc' }],
    include: { _count: { select: { keywords: true, pages: true } } },
  });

  const analysed = competitors.filter((row) => row.lastAnalysedAt !== null).length;

  return {
    competitors: competitors.map(({ _count, ...competitor }) => ({
      ...competitor,
      observedKeywords: _count.keywords,
      observedPages: _count.pages,
    })),
    total: competitors.length,
    analysed,
    // Without a SERP provider the analysis job has no data source; the UI says so up front.
    serpConfigured: isConfigured.anySerp(),
  };
});

const createSchema = z.object({
  domain: domainSchema,
  name: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Queue a SERP-backed analysis immediately. Ignored when no SERP provider is configured. */
  analyse: z.boolean().default(false),
});

export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const input = await readBody(request, createSchema);

  if (input.domain === website.domain) {
    throw new ValidationError('A site cannot be its own competitor.');
  }

  let competitor;
  try {
    competitor = await prisma.competitor.create({
      data: {
        websiteId: website.id,
        domain: input.domain,
        name: input.name?.trim() || null,
        notes: input.notes?.trim() || null,
        isManual: true,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`${input.domain} is already tracked as a competitor.`);
    }
    throw err;
  }

  const serpConfigured = isConfigured.anySerp();
  const analysis =
    input.analyse && serpConfigured
      ? await enqueue(
          'competitors.analyse',
          { websiteId: website.id, competitorIds: [competitor.id] },
          { dedupeKey: `competitor:${competitor.id}`, trigger: 'api' },
        )
      : null;

  log.info('competitor added', { websiteId: website.id, domain: input.domain });

  return {
    competitor,
    analysis,
    serpConfigured,
    message:
      input.analyse && !serpConfigured
        ? 'Competitor saved. Analysis needs a SERP provider (DATAFORSEO_LOGIN, SERPAPI_KEY or SERPER_API_KEY).'
        : 'Competitor saved.',
  };
});
