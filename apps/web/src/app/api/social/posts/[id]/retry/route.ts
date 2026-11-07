import { prisma } from '@seo/db';
import { ValidationError } from '@seo/shared';
import { route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { enqueuePostDispatch, requireOwnedPost } from '@/app/api/_lib/social';

/**
 * `POST /api/social/posts/[id]/retry` — try a failed (or hand-off) post again.
 *
 * A failed publish is never retried automatically, because the platform may have accepted the
 * post and only the response was lost. Retrying is therefore a human decision: this route puts
 * the post back to APPROVED — which is what makes the publisher willing to try — and queues it.
 * The operator is expected to have checked the platform first; the screen asks them to.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const post = await requireOwnedPost(user, params.id);
  if (post.status !== 'FAILED' && post.status !== 'MANUAL_PENDING') {
    throw new ValidationError(`Only failed or hand-off posts can be retried; this one is ${post.status.toLowerCase()}.`);
  }

  await prisma.$transaction([
    // Clearing the slot is what makes "now" true: the publisher holds back anything scheduled later.
    prisma.socialPost.update({ where: { id: post.id }, data: { status: 'APPROVED', error: null, scheduledFor: null } }),
    ...(post.actionId
      ? [prisma.seoAction.update({ where: { id: post.actionId }, data: { status: 'APPROVED', error: null } })]
      : []),
  ]);

  // A retried post goes now, even if its original slot was later today.
  const job = await enqueuePostDispatch({ id: post.id, websiteId: post.websiteId, scheduledFor: null }, 'retry');
  return { postId: post.id, job };
});
