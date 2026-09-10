import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getCompetitorsData } from '@/components/competitors/queries';
import { CompetitorsView } from '@/components/competitors/competitors-view';

export const metadata: Metadata = { title: 'Competitors' };
export const dynamic = 'force-dynamic';

export default async function CompetitorsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  try {
    const data = await getCompetitorsData(user.id, websiteId);
    return <CompetitorsView data={data} />;
  } catch {
    notFound();
  }
}
