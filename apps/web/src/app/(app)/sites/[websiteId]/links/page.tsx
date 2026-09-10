import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@seo/db';
import { listConnectedAdapters } from '@seo/integrations/adapters/registry';

import { getCurrentUser } from '@/lib/auth';
import { InternalLinksView } from '@/components/links/internal-links-view';
import type { CmsAdapterSummary } from '@/components/links/types';

export const metadata: Metadata = { title: 'Internal links' };
export const dynamic = 'force-dynamic';

/**
 * The suggestions, orphans and anchor tables are all read from `/api/links` in the browser so
 * that filtering and paging a long list never costs a server round-trip through this page. What
 * the server does own is the frame the client cannot infer: which site this is, whether a crawl
 * has ever completed (every number on the screen derives from one), and whether a CMS adapter
 * can actually write an approved link back into a page — the difference between "applied" and
 * "recorded for someone to place by hand".
 */
export default async function InternalLinksPage({ params }: { params: Promise<{ websiteId: string }> }) {
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

  const [completedCrawls, connected] = await Promise.all([
    prisma.crawl.count({ where: { websiteId: website.id, status: 'COMPLETED' } }).catch(() => 0),
    listConnectedAdapters(website.id).catch(() => []),
  ]);

  // Capabilities only — credentials never cross the server boundary.
  const adapters: CmsAdapterSummary[] = connected.map((adapter) => ({
    provider: adapter.provider,
    label: adapter.label,
    status: adapter.status,
    canUpdateContent: adapter.capabilities.updateContent,
    canInjectStructuredData: adapter.capabilities.injectStructuredData,
  }));

  return (
    <InternalLinksView
      websiteId={website.id}
      websiteName={website.name}
      siteUrl={`${website.protocol}://${website.domain}`}
      hasCrawl={completedCrawls > 0}
      adapters={adapters}
    />
  );
}
