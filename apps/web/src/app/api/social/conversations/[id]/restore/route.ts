import { prisma } from '@seo/db';
import { route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { requireOwnedConversation } from '@/app/api/_lib/social';

/** `POST /api/social/conversations/[id]/restore` — undo a dismissal (or an expiry) back to the inbox. */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const conversation = await requireOwnedConversation(user, params.id);
  const updated = await prisma.socialConversation.update({
    where: { id: conversation.id },
    data: { status: 'NEW' },
    select: { id: true, status: true },
  });
  return { conversation: updated };
});
