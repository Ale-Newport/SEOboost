import { prisma } from '@seo/db';
import { ForbiddenError, NotFoundError } from '@seo/shared';
import { route } from '@/lib/api';

/**
 * `POST /api/notifications/[id]/read`.
 *
 * Marking read is idempotent — a second call keeps the original `readAt` rather than moving it,
 * so "when did I see this?" stays answerable.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  const notification = await prisma.notification.findUnique({
    where: { id: params.id },
    select: {
      id: true,
      userId: true,
      websiteId: true,
      isRead: true,
      readAt: true,
      website: { select: { userId: true } },
    },
  });
  if (!notification) throw new NotFoundError('Notification');

  const isMine =
    notification.userId === user.id ||
    (notification.userId === null && notification.website?.userId === user.id);
  if (!isMine) throw new ForbiddenError('You do not have access to this notification.');

  if (notification.isRead) {
    return { id: notification.id, isRead: true, readAt: notification.readAt };
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { isRead: true, readAt: new Date() },
    select: { id: true, isRead: true, readAt: true },
  });
  return updated;
});
