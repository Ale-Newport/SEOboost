import { z } from 'zod';
import { prisma } from '@seo/db';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite, skipped } from '@/app/api/_lib/common';

/**
 * `POST /api/geo/audit` — queue a GEO audit.
 *
 * A GEO score is computed from page content, so a site with no crawled pages has nothing to
 * score. That prerequisite is checked here rather than in the worker so the caller gets an
 * actionable answer instead of a job that fails a minute later.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  /** Audit every indexable page instead of the usual representative sample. */
  full: z.boolean().optional(),
  pageIds: z.array(z.string().trim().min(1)).max(2000).optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  const pageCount = await prisma.page.count({
    where: { websiteId: website.id, isActive: true, ...(body.pageIds ? { id: { in: body.pageIds } } : {}) },
  });
  if (pageCount === 0) {
    return skipped(
      'This website has no crawled pages to audit.',
      'Run a crawl first (POST /api/websites/{id}/crawl), then queue the GEO audit again.',
    );
  }

  const result = await enqueue(
    'geo.audit',
    {
      websiteId: website.id,
      ...(body.full ? { full: true } : {}),
      ...(body.pageIds?.length ? { pageIds: body.pageIds } : {}),
    },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `geo.audit:${website.id}` },
  );

  return { websiteId: website.id, pagesInScope: pageCount, job: enqueueSummary(result) };
});
