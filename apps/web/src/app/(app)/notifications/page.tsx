import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { prisma } from '@seo/db';
import { getCurrentUser } from '@/lib/auth';
import { PageHeader } from '@/components/ui/page-header';
import { NotificationList } from '@/components/notifications/notification-list';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ unread?: string; type?: string; site?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const filters = await searchParams;
  const unreadOnly = filters.unread === 'true';

  const scope = {
    OR: [{ userId: user.id }, { website: { userId: user.id } }],
    ...(unreadOnly ? { isRead: false } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.site ? { websiteId: filters.site } : {}),
  };

  const [notifications, unreadCount, websites, types] = await Promise.all([
    prisma.notification.findMany({
      where: scope,
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      include: { website: { select: { id: true, name: true } } },
    }),
    prisma.notification.count({
      where: { OR: [{ userId: user.id }, { website: { userId: user.id } }], isRead: false },
    }),
    prisma.website.findMany({
      where: { userId: user.id, status: { not: 'ARCHIVED' } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.notification.groupBy({
      by: ['type'],
      where: { OR: [{ userId: user.id }, { website: { userId: user.id } }] },
      _count: { _all: true },
      orderBy: { _count: { type: 'desc' } },
    }),
  ]);

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Notifications"
        description={
          unreadCount > 0
            ? `${unreadCount} unread`
            : 'Everything here has been read. New alerts appear as the agents and monitors find things.'
        }
      />
      <NotificationList
        notifications={notifications.map((notification) => ({
          id: notification.id,
          type: notification.type,
          severity: notification.severity,
          title: notification.title,
          message: notification.message,
          link: notification.link,
          isRead: notification.isRead,
          createdAt: notification.createdAt.toISOString(),
          websiteId: notification.websiteId,
          websiteName: notification.website?.name ?? null,
        }))}
        unreadCount={unreadCount}
        websites={websites}
        types={types.map((row) => ({ type: row.type, count: row._count._all }))}
        truncated={notifications.length === PAGE_SIZE}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
