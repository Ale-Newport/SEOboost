import { prisma } from '@seo/db';
import { NotFoundError, createLogger } from '@seo/shared';
import { requireWebsite, route } from '@/lib/api';

const log = createLogger('api:competitor');

type Params = { id: string; competitorId: string };

/**
 * Stop tracking a competitor.
 *
 * The delete cascades to the observed keyword and page rows, which is intended: those are
 * observations *about* this competitor and keeping them would leave gap analyses citing a
 * competitor the operator removed.
 */
export const DELETE = route<Params>(async ({ user, params }) => {
  await requireWebsite(user.id, params.id);

  // Scoped by websiteId too, so an id belonging to another site cannot be deleted from here.
  const result = await prisma.competitor.deleteMany({
    where: { id: params.competitorId, websiteId: params.id },
  });
  if (result.count === 0) throw new NotFoundError('Competitor');

  log.info('competitor removed', { websiteId: params.id, competitorId: params.competitorId });
  return { deleted: true, competitorId: params.competitorId };
});
