import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { EntityGraphView } from './entity-graph-view';

export const metadata: Metadata = { title: 'Entity graph' };
export const dynamic = 'force-dynamic';

/**
 * The graph, its relationships and the coverage check all arrive from `/api/entities` in one
 * request, filtered client-side through the URL so a type filter does not re-render the route.
 * The server contributes the site identity and whether any crawled page text exists at all —
 * extraction reads that text, so without it the action is refused rather than queued.
 */
export default async function EntityGraphPage({ params }: { params: Promise<{ websiteId: string }> }) {
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

  const crawledPages = await prisma.crawlPage
    .count({ where: { crawl: { websiteId: website.id, status: 'COMPLETED' }, textContent: { not: null } } })
    .catch(() => 0);

  return (
    <EntityGraphView
      websiteId={website.id}
      websiteName={website.name}
      siteUrl={`${website.protocol}://${website.domain}`}
      hasCrawl={crawledPages > 0}
    />
  );
}
