import { z } from 'zod';
import { SuggestionStatus, prisma } from '@seo/db';
import { ValidationError, createLogger } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { getAdapterForWebsite } from '@seo/integrations/adapters/registry';
import { readBody, route } from '@/lib/api';
import {
  assertNotReadOnly,
  enqueueSummary,
  requireScopedWebsite,
  skipped,
} from '@/app/api/_lib/common';

const log = createLogger('api:links');

/**
 * `POST /api/links/apply` — write approved internal links to the live site.
 *
 * Only `APPROVED` suggestions are ever queued. Ids that are still pending, already applied or
 * rejected come back in `skippedSuggestions` with the reason: silently approving-on-apply would
 * defeat the review step that the approve endpoint exists for.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  /** Suggestion ids to apply; omit to apply every approved suggestion for the site. */
  suggestionIds: z.array(z.string().trim().min(1)).max(500).optional(),
  dryRun: z.boolean().optional(),
  /** Upper bound on a single batch, so one press cannot rewrite a whole site. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  if (!body.dryRun) await assertNotReadOnly();

  const website = await requireScopedWebsite(user, body.websiteId);

  const candidates = await prisma.internalLinkSuggestion.findMany({
    where: {
      websiteId: website.id,
      ...(body.suggestionIds?.length ? { id: { in: body.suggestionIds } } : {}),
    },
    select: { id: true, status: true },
    orderBy: [{ impactScore: 'desc' }],
    take: body.suggestionIds?.length ? body.suggestionIds.length : body.limit,
  });

  const approved = candidates.filter((row) => row.status === SuggestionStatus.APPROVED);
  const skippedSuggestions = candidates
    .filter((row) => row.status !== SuggestionStatus.APPROVED)
    .map((row) => ({
      id: row.id,
      reason: `Suggestion is ${row.status}; only APPROVED suggestions are applied.`,
    }));

  if (body.suggestionIds?.length) {
    const found = new Set(candidates.map((row) => row.id));
    for (const id of body.suggestionIds) {
      if (!found.has(id)) {
        skippedSuggestions.push({ id, reason: 'Not found on this website.' });
      }
    }
  }

  if (approved.length === 0) {
    throw new ValidationError(
      'No approved link suggestions to apply. Approve them first with POST /api/links/{id}/approve.',
    );
  }

  const adapter = await getAdapterForWebsite(website.id);
  if (!adapter.adapter) {
    return skipped(
      adapter.reason,
      'Connect WordPress, Shopify, Webflow, a git repository or a webhook under Settings → Integrations.',
    );
  }

  const ids = approved.slice(0, body.limit).map((row) => row.id);
  const result = await enqueue(
    'links.apply-suggestion',
    {
      websiteId: website.id,
      suggestionIds: ids,
      actorUserId: user.id,
      ...(body.dryRun ? { dryRun: true } : {}),
    },
    { websiteId: website.id, trigger: 'manual' },
  );

  log.info('internal link application queued', {
    websiteId: website.id,
    count: ids.length,
    dryRun: body.dryRun === true,
  });

  return {
    websiteId: website.id,
    queued: ids.length,
    suggestionIds: ids,
    skippedSuggestions,
    dryRun: body.dryRun === true,
    job: enqueueSummary(result),
  };
});
