import { z } from 'zod';
import { ContentStage } from '@seo/db';
import { ValidationError } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { requireDraft } from '@/server/queries/content';
import { enqueueSummary } from '@/app/api/_lib/common';

/**
 * `POST /api/content/drafts/[id]/stage/[stage]/run` — run one pipeline stage.
 *
 * Stages are queued rather than run inline: several of them make model calls that take minutes
 * and are subject to the AI budget guard, and the Jobs screen is where a long-running stage is
 * meant to be watched.
 */

const bodySchema = z.object({
  /** Re-run a stage that already completed. */
  force: z.boolean().optional(),
});

const STAGES = Object.values(ContentStage);

export const POST = route<{ id: string; stage: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const draft = await requireDraft(user.id, params.id);

  const stage = STAGES.find((candidate) => candidate === params.stage.toUpperCase());
  if (!stage) {
    throw new ValidationError(
      `Unknown pipeline stage "${params.stage}". Valid stages: ${STAGES.join(', ')}.`,
    );
  }

  const result = await enqueue(
    'content.pipeline-stage',
    {
      websiteId: draft.websiteId,
      draftId: draft.id,
      stage,
      ...(body.force ? { force: true } : {}),
    },
    {
      websiteId: draft.websiteId,
      trigger: 'manual',
      dedupeKey: `content.pipeline-stage:${draft.id}:${stage}`,
    },
  );

  return { draftId: draft.id, stage, job: enqueueSummary(result) };
});
