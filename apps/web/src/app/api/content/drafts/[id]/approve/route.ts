import { z } from 'zod';
import { ContentStage, ContentStageStatus, prisma } from '@seo/db';
import { ConflictError, createLogger } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { requireDraft, unverifiedClaimsOf } from '@/server/queries/content';
import { actorName } from '@/app/api/_lib/common';

const log = createLogger('api:content');

/**
 * `POST /api/content/drafts/[id]/approve` — sign off a draft for publishing.
 *
 * Approval is blocked while the fact-check stage still has unverified claims outstanding.
 * Publishing an unverified claim is exactly the failure mode this product exists to avoid, so
 * the operator has to acknowledge them explicitly (`acknowledgeUnverified`) — which is recorded
 * on the approval version — rather than the check being a soft warning in the UI.
 */

const bodySchema = z.object({
  note: z.string().trim().max(1000).optional(),
  /** Approve despite outstanding unverified claims. Recorded in the version history. */
  acknowledgeUnverified: z.boolean().optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const draft = await requireDraft(user.id, params.id);

  if (draft.stage === ContentStage.PUBLISHED) {
    throw new ConflictError('This draft has already been published.');
  }

  const unverified = unverifiedClaimsOf(draft);
  if (unverified.length > 0 && body.acknowledgeUnverified !== true) {
    throw new ConflictError(
      `This draft still has ${unverified.length} claim(s) the fact-check stage could not verify. ` +
        'Fix or remove them, or re-send with acknowledgeUnverified: true to approve anyway.',
    );
  }

  const latest = await prisma.contentVersion.findFirst({
    where: { draftId: draft.id },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const [updated] = await prisma.$transaction([
    prisma.contentDraft.update({
      where: { id: draft.id },
      data: { stage: ContentStage.APPROVED, currentStageStatus: ContentStageStatus.COMPLETED },
    }),
    // The approval itself is a version, so the exact text that was signed off is recoverable.
    prisma.contentVersion.create({
      data: {
        draftId: draft.id,
        version: (latest?.version ?? 0) + 1,
        title: draft.title,
        bodyMarkdown: draft.bodyMarkdown,
        metaTitle: draft.metaTitle,
        metaDescription: draft.metaDescription,
        authorType: 'human',
        authorName: actorName(user),
        changeSummary:
          `Approved for publishing.${body.note ? ` Note: ${body.note}` : ''}` +
          (unverified.length > 0
            ? ` Approved with ${unverified.length} unverified claim(s) acknowledged.`
            : ''),
      },
    }),
  ]);

  log.info('content draft approved', {
    draftId: draft.id,
    userId: user.id,
    unverifiedClaims: unverified.length,
  });

  return {
    draft: { id: updated.id, stage: updated.stage, currentStageStatus: updated.currentStageStatus },
    unverifiedClaims: unverified.length,
  };
});
