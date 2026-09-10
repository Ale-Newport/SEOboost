import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { getStrategyData } from '@/server/queries/strategy';
import { StrategyView } from '@/components/site/strategy-view';

export const metadata: Metadata = { title: 'AI SEO Manager' };
export const dynamic = 'force-dynamic';

export default async function StrategyPage({ params }: { params: Promise<{ websiteId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  try {
    const data = await getStrategyData(user.id, websiteId);
    return <StrategyView data={data} />;
  } catch {
    notFound();
  }
}
