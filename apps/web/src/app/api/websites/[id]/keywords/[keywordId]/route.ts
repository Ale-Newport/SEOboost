import { z } from 'zod';
import { FunnelStage, type Prisma, SearchIntent, prisma } from '@seo/db';
import { NotFoundError, ValidationError, createLogger } from '@seo/shared';
import { readBody, requireWebsite, route } from '@/lib/api';

const log = createLogger('api:keyword');

type Params = { id: string; keywordId: string };

/**
 * Curation for a single keyword.
 *
 * Only the columns a human owns are writable here. Everything measured — positions, clicks,
 * volumes, opportunity scores — is written by the sync and analysis jobs, and letting the API
 * overwrite them would put an unverifiable number next to provider-sourced ones with no way to
 * tell them apart afterwards.
 *
 * `pageId: null` clears a mapping; a non-null id must belong to the same website.
 */
const patchSchema = z
  .object({
    /** Include in rank tracking and the tracked-keyword rollups. */
    isTracked: z.boolean().optional(),
    /** Brand queries are excluded from most opportunity maths, so this is a real signal. */
    isBranded: z.boolean().optional(),
    intent: z.nativeEnum(SearchIntent).optional(),
    funnelStage: z.nativeEnum(FunnelStage).optional(),
    /** The page this keyword is meant to win. Null unmaps it. */
    pageId: z.string().trim().min(1).max(60).nullable().optional(),
    /** Move to an existing cluster, or null to unassign. */
    clusterId: z.string().trim().min(1).max(60).nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Send at least one field to change.',
  });

export const PATCH = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const input = await readBody(request, patchSchema);

  const keyword = await prisma.keyword.findFirst({
    where: { id: params.keywordId, websiteId: params.id },
    select: { id: true, keyword: true, isTracked: true },
  });
  if (!keyword) throw new NotFoundError('Keyword');

  // Both foreign keys are re-scoped to this website: an id from another site would otherwise be
  // reachable through this route and would leak that site's URL back in the keyword list.
  if (input.pageId) {
    const page = await prisma.page.findFirst({
      where: { id: input.pageId, websiteId: params.id },
      select: { id: true },
    });
    if (!page) throw new ValidationError('That page does not belong to this website.');
  }
  if (input.clusterId) {
    const cluster = await prisma.keywordCluster.findFirst({
      where: { id: input.clusterId, websiteId: params.id },
      select: { id: true },
    });
    if (!cluster) throw new ValidationError('That cluster does not belong to this website.');
  }

  const data: Prisma.KeywordUncheckedUpdateInput = {};
  if (input.isTracked !== undefined) data.isTracked = input.isTracked;
  if (input.isBranded !== undefined) data.isBranded = input.isBranded;
  if (input.intent !== undefined) data.intent = input.intent;
  if (input.funnelStage !== undefined) data.funnelStage = input.funnelStage;
  if (input.pageId !== undefined) data.pageId = input.pageId;
  if (input.clusterId !== undefined) data.clusterId = input.clusterId;

  const updated = await prisma.keyword.update({ where: { id: keyword.id }, data });

  log.info('keyword updated', {
    websiteId: params.id,
    keywordId: keyword.id,
    fields: Object.keys(data),
  });

  return { keyword: updated };
});

/**
 * Delete one keyword.
 *
 * Only the keyword row goes: its historical GSC and ranking rows are scoped to the website (and
 * detach with `SetNull`), so removing a mis-imported keyword never rewrites measured history.
 */
export const DELETE = route<Params>(async ({ user, params }) => {
  await requireWebsite(user.id, params.id);

  // Scoped by websiteId as well as id, so an id from another site cannot be deleted here.
  const result = await prisma.keyword.deleteMany({
    where: { id: params.keywordId, websiteId: params.id },
  });
  if (result.count === 0) throw new NotFoundError('Keyword');

  log.info('keyword deleted', { websiteId: params.id, keywordId: params.keywordId });
  return { deleted: true, keywordId: params.keywordId };
});
