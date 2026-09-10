import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getHistory } from '@/components/history/queries';
import { HistoryView } from '@/components/history/history-view';
import { paramInt, paramList, paramValue, type RawSearchParams } from '@/components/content/search-params';

export const metadata: Metadata = { title: 'History' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/** `yyyy-MM-dd` or nothing — a malformed date is dropped rather than shifting the window. */
function dateParam(value: string | string[] | undefined): string | undefined {
  const raw = paramValue(value);
  return raw !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

/**
 * The audit trail for one site.
 *
 * Filters, paging and the date window all come from the URL so the screen is linkable, and the
 * server reads exactly the params the client controls write.
 */
export default async function HistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  const query = await searchParams;

  const actors = paramList(query.actor);
  const changeTypes = paramList(query.changeType);
  const rawPageSize = paramInt(query.pageSize, PAGE_SIZE);

  try {
    const data = await getHistory(user.id, websiteId, {
      ...(actors.length > 0 ? { actors } : {}),
      ...(changeTypes.length > 0 ? { changeTypes } : {}),
      ...(dateParam(query.from) ? { from: dateParam(query.from) as string } : {}),
      ...(dateParam(query.to) ? { to: dateParam(query.to) as string } : {}),
      page: paramInt(query.page, 1),
      pageSize: Math.min(rawPageSize, MAX_PAGE_SIZE),
    });
    return <HistoryView data={data} />;
  } catch {
    notFound();
  }
}
