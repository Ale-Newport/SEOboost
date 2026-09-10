import { z } from 'zod';
import { type Prisma, prisma } from '@seo/db';
import { NotFoundError, brandFactSchema, createLogger, paginationSchema } from '@seo/shared';
import { readBody, readQuery, requireWebsite, route } from '@/lib/api';
import { booleanParam } from '@/server/queries/filters';

const log = createLogger('api:brand-facts');

type Params = { id: string };

const listQuerySchema = paginationSchema.extend({
  verified: booleanParam.optional(),
  category: z.string().trim().max(80).optional(),
  /** Hide facts whose `expiresAt` has passed — stale claims must not reach a writer. */
  includeExpired: booleanParam.optional(),
});

/**
 * First-party facts an AI writer is allowed to assert.
 *
 * Only `verified` rows are safe to put in published copy — that rule lives in the content
 * pipeline, and this endpoint exists to let a human curate the list. The `verified` counter in
 * the response is what the Content screen uses to warn before a draft cites nothing.
 */
export const GET = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const query = readQuery(request, listQuerySchema);

  const where: Prisma.BrandFactWhereInput = { websiteId: params.id };
  if (query.verified !== undefined) where.verified = query.verified;
  if (query.category) where.category = query.category;
  if (!query.includeExpired) {
    where.OR = [{ expiresAt: null }, { expiresAt: { gt: new Date() } }];
  }
  if (query.search) {
    where.fact = { contains: query.search, mode: 'insensitive' };
  }

  const [items, total, verified, expired] = await Promise.all([
    prisma.brandFact.findMany({
      where,
      orderBy: [{ verified: 'desc' }, { createdAt: 'desc' }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.brandFact.count({ where }),
    prisma.brandFact.count({ where: { websiteId: params.id, verified: true } }),
    prisma.brandFact.count({
      where: { websiteId: params.id, expiresAt: { lte: new Date() } },
    }),
  ]);

  return {
    items,
    total,
    page: query.page,
    pageSize: query.pageSize,
    totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    counts: { verified, unverified: total - verified, expired },
  };
});

const createSchema = brandFactSchema.extend({
  /** ISO date after which the fact should no longer be quoted (prices, headcount, awards…). */
  expiresAt: z.string().datetime().optional(),
});

export const POST = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const input = await readBody(request, createSchema);

  const fact = await prisma.brandFact.create({
    data: {
      websiteId: params.id,
      fact: input.fact,
      category: input.category?.trim() || null,
      source: input.source,
      sourceUrl: input.sourceUrl?.trim() || null,
      verified: input.verified,
      // Stamped only when a human actually marks it verified, so the audit trail is real.
      verifiedAt: input.verified ? new Date() : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    },
  });

  log.info('brand fact added', { websiteId: params.id, factId: fact.id, verified: fact.verified });
  return { fact };
});

const deleteQuerySchema = z.object({
  id: z.string().trim().min(1, 'Pass ?id=<factId> to choose which fact to delete'),
});

/** Delete one fact: `DELETE /api/websites/[id]/brand-facts?id=<factId>`. */
export const DELETE = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const query = readQuery(request, deleteQuerySchema);

  // Scoped by websiteId as well as id, so a fact id from another site cannot be deleted here.
  const result = await prisma.brandFact.deleteMany({
    where: { id: query.id, websiteId: params.id },
  });
  if (result.count === 0) throw new NotFoundError('Brand fact');

  log.info('brand fact deleted', { websiteId: params.id, factId: query.id });
  return { deleted: true, factId: query.id };
});
