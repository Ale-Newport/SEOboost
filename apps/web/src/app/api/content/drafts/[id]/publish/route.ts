import { z } from 'zod';
import { ContentStage } from '@seo/db';
import { ConflictError, createLogger } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { getAdapterForWebsite } from '@seo/integrations/adapters/registry';
import { readBody, route } from '@/lib/api';
import { requireDraft } from '@/server/queries/content';
import { assertNotReadOnly, enqueueSummary, skipped } from '@/app/api/_lib/common';

const log = createLogger('api:content');

/**
 * `POST /api/content/drafts/[id]/publish` — hand an approved draft to the CMS adapter.
 *
 * Two prerequisites are checked before anything is queued, because both produce a job that can
 * only fail: the draft must have been approved by a human, and the site must actually have a
 * publishing integration. A missing adapter returns a typed `skipped` result naming what to
 * connect rather than a queued job that dies in the worker.
 */

const bodySchema = z.object({
  /** Run every guard and produce the diff without writing to the live site. */
  dryRun: z.boolean().optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  if (!body.dryRun) await assertNotReadOnly();

  const draft = await requireDraft(user.id, params.id);

  if (draft.stage === ContentStage.PUBLISHED) {
    throw new ConflictError('This draft has already been published.');
  }
  if (draft.stage !== ContentStage.APPROVED) {
    throw new ConflictError(
      `A draft must be approved before it can be published; this one is at stage ${draft.stage}. ` +
        'Call POST /api/content/drafts/{id}/approve first.',
    );
  }

  const adapter = await getAdapterForWebsite(draft.websiteId);
  if (!adapter.adapter) {
    return skipped(
      adapter.reason,
      'Connect WordPress, Shopify, Webflow, a git repository or a webhook under Settings → Integrations.',
    );
  }

  const result = await enqueue(
    'content.publish',
    {
      websiteId: draft.websiteId,
      draftId: draft.id,
      ...(body.dryRun ? { dryRun: true } : {}),
    },
    { websiteId: draft.websiteId, trigger: 'manual', dedupeKey: `content.publish:${draft.id}` },
  );

  log.info('content publish queued', { draftId: draft.id, dryRun: body.dryRun === true });

  return {
    draftId: draft.id,
    adapter: { provider: adapter.provider, capabilities: adapter.adapter.capabilities },
    dryRun: body.dryRun === true,
    job: enqueueSummary(result),
  };
});
