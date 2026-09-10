import { z } from 'zod';
import { EntityType, prisma } from '@seo/db';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite, skipped } from '@/app/api/_lib/common';

/**
 * `POST /api/entities/extract` — rebuild the entity graph from the site's own content.
 *
 * Extraction reads crawled page text, schema markup and the knowledge base, so a site with no
 * completed crawl has nothing to extract from and is told so rather than queued.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  pageIds: z.array(z.string().trim().min(1)).max(2000).optional(),
  types: z.array(z.nativeEnum(EntityType)).max(20).optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  const crawledPages = await prisma.crawlPage.count({
    where: { crawl: { websiteId: website.id, status: 'COMPLETED' }, textContent: { not: null } },
  });
  if (crawledPages === 0) {
    return skipped(
      'No crawled page content is stored for this website, so no entities can be extracted.',
      'Run a crawl first; entity extraction reads the page text it captures.',
    );
  }

  const result = await enqueue(
    'entities.extract',
    {
      websiteId: website.id,
      ...(body.pageIds?.length ? { pageIds: body.pageIds } : {}),
      ...(body.types?.length ? { types: body.types } : {}),
    },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `entities.extract:${website.id}` },
  );

  return { websiteId: website.id, pagesWithContent: crawledPages, job: enqueueSummary(result) };
});
