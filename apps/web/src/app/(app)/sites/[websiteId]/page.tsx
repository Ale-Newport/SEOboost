import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { getSiteOverview } from '@/server/queries/site-overview';
import { SiteOverviewView } from '@/components/site/site-overview-view';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}): Promise<Metadata> {
  const user = await getCurrentUser();
  if (!user) return { title: 'Website' };
  try {
    const { websiteId } = await params;
    const overview = await getSiteOverview(user.id, websiteId);
    return { title: overview.website.name };
  } catch {
    return { title: 'Website' };
  }
}

export default async function SiteOverviewPage({ params }: { params: Promise<{ websiteId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  try {
    const overview = await getSiteOverview(user.id, websiteId);
    return <SiteOverviewView overview={overview} />;
  } catch {
    notFound();
  }
}
