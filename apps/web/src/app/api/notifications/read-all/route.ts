import { z } from 'zod';
import { type Prisma, prisma } from '@seo/db';
import { readBody, route } from '@/lib/api';
import { resolveScope } from '@/app/api/_lib/common';

/**
 * `POST /api/notifications/read-all` — clear the inbox.
 *
 * Scoped exactly like the list endpoint, so "mark all read" never touches a row the caller
 * cannot see; passing a `websiteId` limits it to that site's notifications.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1).optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const scope = await resolveScope(user, body.websiteId);

  const audience: Prisma.NotificationWhereInput[] = [
    { userId: user.id },
    { userId: null, websiteId: { in: scope.websiteIds } },
  ];

  const result = await prisma.notification.updateMany({
    where: {
      AND: [
        { OR: audience },
        { isRead: false },
        ...(body.websiteId ? [{ websiteId: body.websiteId }] : []),
      ],
    },
    data: { isRead: true, readAt: new Date() },
  });

  return { marked: result.count };
});
