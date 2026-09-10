import { z } from 'zod';
import { NotificationSeverity, type Prisma, buildPaginated, paginate, prisma, readJson } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import {
  booleanParam,
  multiValueParam,
  parseEnumList,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `GET /api/notifications` — the operator's inbox.
 *
 * A notification is addressed either to a user (`userId`) or to a website (system events that
 * anyone with access should see). Both are included, scoped by ownership; a notification for a
 * different user's account is never returned even when it concerns a shared website.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  severity: multiValueParam,
  unreadOnly: booleanParam(false),
  type: z.string().trim().max(80).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  const audience: Prisma.NotificationWhereInput[] = [
    { userId: user.id },
    { userId: null, websiteId: { in: scope.websiteIds } },
  ];

  const where: Prisma.NotificationWhereInput = {
    AND: [
      { OR: audience },
      ...(query.websiteId ? [{ websiteId: query.websiteId }] : []),
      ...(query.unreadOnly ? [{ isRead: false }] : []),
      ...(query.type ? [{ type: query.type }] : []),
      ...(() => {
        const severities = parseEnumList(query.severity, Object.values(NotificationSeverity));
        return severities?.length ? [{ severity: { in: severities } }] : [];
      })(),
    ],
  };

  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      ...paginate(query.page, query.pageSize),
      select: {
        id: true,
        websiteId: true,
        userId: true,
        type: true,
        severity: true,
        title: true,
        message: true,
        link: true,
        data: true,
        isRead: true,
        readAt: true,
        createdAt: true,
        website: { select: { id: true, name: true, domain: true } },
      },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { AND: [{ OR: audience }, { isRead: false }] } }),
  ]);

  return {
    ...buildPaginated(
      items.map((item) => ({ ...item, data: readJson<Record<string, unknown>>(item.data, {}) })),
      total,
      query.page,
      query.pageSize,
    ),
    unread,
  };
});
