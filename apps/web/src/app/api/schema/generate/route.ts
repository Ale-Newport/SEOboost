import { z } from 'zod';
import { prisma } from '@seo/db';
import { SCHEMA_TYPES } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite, skipped } from '@/app/api/_lib/common';
import { findAgent } from '@/app/api/_lib/agents';

/**
 * `POST /api/schema/generate` — queue JSON-LD generation.
 *
 * Runs through the schema agent rather than a bespoke job so generation, validation and the
 * "only mark up what is visibly on the page" rule all stay in one place. Generation needs page
 * content, so a site with no crawl is refused here instead of failing in the worker.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  pageIds: z.array(z.string().trim().min(1)).max(1000).optional(),
  /** Restrict generation to these schema types; omit to let the agent choose per page type. */
  schemaTypes: z.array(z.enum(SCHEMA_TYPES)).max(20).optional(),
  /** Regenerate items that already exist for the pages in scope. */
  force: z.boolean().optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  const pagesInScope = await prisma.page.count({
    where: {
      websiteId: website.id,
      isActive: true,
      ...(body.pageIds?.length ? { id: { in: body.pageIds } } : {}),
    },
  });
  if (pagesInScope === 0) {
    return skipped(
      'There are no crawled pages in scope, so there is nothing to mark up.',
      'Run a crawl first, or pass pageIds that exist on this website.',
    );
  }

  const agent = findAgent('schema');
  const result = await enqueue(
    'agents.run',
    {
      websiteId: website.id,
      agent: agent?.key ?? 'schema',
      trigger: 'manual',
      input: {
        ...(body.pageIds?.length ? { pageIds: body.pageIds } : {}),
        ...(body.schemaTypes?.length ? { schemaTypes: body.schemaTypes } : {}),
        ...(body.force ? { force: true } : {}),
      },
    },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `agents.run:schema:${website.id}` },
  );

  return { websiteId: website.id, pagesInScope, job: enqueueSummary(result) };
});
