import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import {
  getBacklinksData,
  type BacklinkFollowFilter,
  type BacklinkStatusFilter,
} from '@/server/queries/backlinks';
import { BacklinksView } from '@/components/backlinks/backlinks-view';

export const metadata: Metadata = { title: 'Backlinks' };
export const dynamic = 'force-dynamic';

type RawSearchParams = Record<string, string | string[] | undefined>;

const PAGE_SIZE = 50;
const DEFAULT_WINDOW_DAYS = 30;

function first(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

function int(raw: string | string[] | undefined, fallback: number, min: number, max: number): number {
  const value = Number(first(raw));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function follow(raw: string | string[] | undefined): BacklinkFollowFilter {
  const value = first(raw);
  return value === 'follow' || value === 'nofollow' ? value : 'all';
}

function status(raw: string | string[] | undefined): BacklinkStatusFilter {
  const value = first(raw);
  return value === 'active' || value === 'lost' ? value : 'all';
}

export default async function BacklinksPage({
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
  const search = first(query.search)?.trim() ?? '';
  const sort = first(query.sort);
  const order = first(query.order) === 'asc' ? 'asc' : 'desc';

  try {
    const data = await getBacklinksData(user.id, websiteId, {
      windowDays: int(query.days, DEFAULT_WINDOW_DAYS, 1, 365),
      page: int(query.page, 1, 1, 100_000),
      pageSize: int(query.pageSize, PAGE_SIZE, 10, 200),
      ...(search ? { search } : {}),
      follow: follow(query.follow),
      status: status(query.status),
      suspiciousOnly: first(query.suspicious) === 'true',
      ...(sort ? { sort } : {}),
      order,
    });
    return <BacklinksView data={data} />;
  } catch {
    notFound();
  }
}
