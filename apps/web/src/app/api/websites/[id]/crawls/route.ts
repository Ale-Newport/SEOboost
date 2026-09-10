import { prisma } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { readQuery, requireWebsite, route } from '@/lib/api';
import { listCrawls } from '@/server/queries/websites';

type Params = { id: string };

/**
 * Crawl history with derived progress.
 *
 * `progressPct` is computed from pages discovered so far — the only denominator that exists
 * mid-crawl — and stays null until discovery has found something, so a just-started crawl shows
 * a spinner instead of a 0% bar that looks stuck.
 */
export const GET = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const query = readQuery(request, paginationSchema);

  // Queried independently of the page window: the live crawl drives the polling banner, and it
  // would disappear the moment the operator paged back through history.
  const [result, active] = await Promise.all([
    listCrawls(params.id, { page: query.page, pageSize: query.pageSize }),
    prisma.crawl.findFirst({
      where: { websiteId: params.id, status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    }),
  ]);

  return { ...result, activeCrawlId: active?.id ?? null, activeCrawlStatus: active?.status ?? null };
});
