import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getIndexationData } from '@/server/queries/indexation';
import { IndexationView } from '@/components/indexation/indexation-view';

export const metadata: Metadata = { title: 'Indexation' };
export const dynamic = 'force-dynamic';

export default async function IndexationPage({ params }: { params: Promise<{ websiteId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  try {
    const data = await getIndexationData(user.id, websiteId);
    return <IndexationView data={data} />;
  } catch {
    notFound();
  }
}
