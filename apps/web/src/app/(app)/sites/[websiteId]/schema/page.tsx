import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@seo/db';
import { listConnectedAdapters } from '@seo/integrations/adapters/registry';

import { getCurrentUser } from '@/lib/auth';
import { StructuredDataView } from '@/components/schema/structured-data-view';

export const metadata: Metadata = { title: 'Structured data' };
export const dynamic = 'force-dynamic';

/**
 * The item list, the declined reasons and the validator all talk to `/api/schema*` from the
 * browser so filtering and validating never re-render the route. The server contributes the two
 * facts the client cannot see: whether a crawl has ever completed (generation reads crawled page
 * text) and whether a connected adapter can actually inject a `<script>` tag — the difference
 * between "Deploy" doing something and the operator pasting the tag in by hand.
 */
export default async function StructuredDataPage({ params }: { params: Promise<{ websiteId: string }> }) {
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

  // Capability only — credentials never cross the server boundary.
  const injector = connected.find((adapter) => adapter.capabilities.injectStructuredData) ?? null;

  return (
    <StructuredDataView
      websiteId={website.id}
      websiteName={website.name}
      siteUrl={`${website.protocol}://${website.domain}`}
      hasCrawl={completedCrawls > 0}
      canDeploy={injector !== null}
      adapterLabel={injector?.label ?? null}
    />
  );
}
