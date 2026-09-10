import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getSiteSettings } from '@/components/site-settings/queries';
import { SettingsView } from '@/components/site-settings/settings-view';
import { paramValue, type RawSearchParams } from '@/components/content/search-params';

export const metadata: Metadata = { title: 'Site settings' };
export const dynamic = 'force-dynamic';

/**
 * Everything about one site that is a choice rather than a measurement: its profile, how it is
 * crawled, which models answer for it, what the writers may say, what it is connected to, and
 * where its thresholds sit.
 */
export default async function SiteSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  const query = await searchParams;

  try {
    const data = await getSiteSettings(user.id, websiteId);
    return <SettingsView data={data} initialTab={paramValue(query.tab) ?? 'general'} />;
  } catch {
    notFound();
  }
}
