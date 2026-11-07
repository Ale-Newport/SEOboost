import { prisma } from '@seo/db';
import { ValidationError } from '@seo/shared';
import { route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { requireOwnedPost } from '@/app/api/_lib/social';

/**
 * `POST /api/social/posts/[id]/cancel` — withdraw a post before it goes out.
 *
 * The post, its action and any pending approval are closed together so nothing is left in the
 * Approvals queue pointing at a post that will never be published. A reply's thread goes back to
 * the shortlist, so it can still be answered another way.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const post = await requireOwnedPost(user, params.id);
  if (['PUBLISHED', 'PUBLISHING', 'CANCELLED', 'REJECTED'].includes(post.status)) {
    throw new ValidationError(`A ${post.status.toLowerCase()} post cannot be cancelled.`);
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.socialPost.update({ where: { id: post.id }, data: { status: 'CANCELLED' } });
    if (post.actionId) {
      await tx.seoAction.update({ where: { id: post.actionId }, data: { status: 'CANCELLED' } });
      await tx.approval.updateMany({
        where: { actionId: post.actionId, status: 'PENDING' },
        data: { status: 'REJECTED', decidedAt: now, userId: user.id, decisionNote: 'Cancelled from the Social screen.' },
      });
    }
    if (post.conversationId) {
      await tx.socialConversation.updateMany({
        where: { id: post.conversationId, status: 'DRAFTED' },
        data: { status: 'SHORTLISTED' },
      });
    }
  });
  return { postId: post.id, status: 'CANCELLED' };
});
