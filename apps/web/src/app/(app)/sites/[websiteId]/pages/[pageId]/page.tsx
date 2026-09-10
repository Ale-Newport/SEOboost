import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { requireWebsite } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth';
import { PageDetailView } from '@/components/pages/page-detail-view';
import { shortenUrl } from '@/lib/utils';
import { getPageDetail } from './queries';

export const dynamic = 'force-dynamic';

type RouteParams = { websiteId: string; pageId: string };

/**
 * `cache` so the metadata pass and the render pass share one load: without it this screen would
 * run its whole query set twice for every request.
 */
const load = cache(async (websiteId: string, pageId: string) => {
  const user = await getCurrentUser();
  if (!user) return null;

  const website = await requireWebsite(user.id, websiteId).catch(() => null);
  if (!website) return null;

  const detail = await getPageDetail(website.id, pageId, website.settings?.thinContentWords ?? 300);
  if (!detail) return null;

  return { website, detail };
});

export async function generateMetadata({ params }: { params: Promise<RouteParams> }): Promise<Metadata> {
  const { websiteId, pageId } = await params;
  const loaded = await load(websiteId, pageId).catch(() => null);
  if (!loaded) return { title: 'Page' };
  const { page } = loaded.detail.profile;
  return { title: page.title ?? shortenUrl(page.path, 60) };
}

export default async function PageDetailPage({ params }: { params: Promise<RouteParams> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId, pageId } = await params;
  const loaded = await load(websiteId, pageId);
  if (!loaded) notFound();

  return (
    <PageDetailView
      websiteId={loaded.website.id}
      websiteDomain={loaded.website.domain}
      data={loaded.detail}
    />
  );
}
