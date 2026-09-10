import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { getGeoReadiness } from '@/server/queries/geo';
import { GeoView } from '@/components/geo/geo-view';

export const metadata: Metadata = { title: 'GEO readiness' };
export const dynamic = 'force-dynamic';

export default async function GeoPage({ params }: { params: Promise<{ websiteId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  try {
    const data = await getGeoReadiness(user.id, websiteId);
    return <GeoView data={data} />;
  } catch {
    notFound();
  }
}
