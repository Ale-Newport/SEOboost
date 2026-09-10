import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import { getGlobalSettings } from '@/server/queries/settings';
import { PageHeader } from '@/components/ui/page-header';
import { GlobalSettingsView } from '@/components/settings/global-settings-view';

export const metadata: Metadata = { title: 'Settings' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const settings = await getGlobalSettings(user);

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Settings"
        description="Installation-wide defaults. Per-site overrides live in each website's own settings."
      />
      <GlobalSettingsView settings={settings} />
    </div>
  );
}
