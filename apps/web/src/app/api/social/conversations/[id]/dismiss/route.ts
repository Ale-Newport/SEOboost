import { prisma } from '@seo/db';
import { route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { requireOwnedConversation } from '@/app/api/_lib/social';

/**
 * `POST /api/social/conversations/[id]/dismiss` — "not for us".
 *
 * Dismissed threads stay stored (and are never re-surfaced by the next listening run, which
 * only refreshes their numbers), so the inbox stops showing them without losing the record.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const conversation = await requireOwnedConversation(user, params.id);
  const updated = await prisma.socialConversation.update({
    where: { id: conversation.id },
    data: { status: 'DISMISSED' },
    select: { id: true, status: true },
  });
  return { conversation: updated };
});
