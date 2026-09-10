import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { SiteArchitectureView } from '@/components/links/site-architecture-view';

export const metadata: Metadata = { title: 'Site architecture' };
export const dynamic = 'force-dynamic';

/**
 * The graph itself is fetched client-side from `/api/links/graph`, because the node cap, the
 * indexable-only filter and the colour mode are all controls the operator turns repeatedly and
 * a re-render of the whole route for each one would be visibly slower than a refetch.
 */
export default async function SiteArchitecturePage({ params }: { params: Promise<{ websiteId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;

  const website = await prisma.website
    .findFirst({
      where: { id: websiteId, userId: user.id },
      select: { id: true, name: true, domain: true, protocol: true },
    })
    .catch(() => null);
  if (!website) notFound();

  const completedCrawls = await prisma.crawl
    .count({ where: { websiteId: website.id, status: 'COMPLETED' } })
    .catch(() => 0);

  return (
    <SiteArchitectureView
      websiteId={website.id}
      websiteName={website.name}
      siteUrl={`${website.protocol}://${website.domain}`}
      hasCrawl={completedCrawls > 0}
    />
  );
}
