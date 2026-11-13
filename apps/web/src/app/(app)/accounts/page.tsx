import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { PageHeader } from '@/components/ui/page-header';
import { AccountsView } from '@/components/accounts/accounts-view';

export const metadata: Metadata = { title: 'Accounts' };
export const dynamic = 'force-dynamic';

/** The operator's own GitHub and Reddit accounts and mailboxes, linked once and used across the app. */
export default async function AccountsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return (
    <div className="space-y-6">
      <PageHeader title="Accounts" description="Link your own GitHub and Reddit once, then use them from here on any site, and keep your mailboxes beside them." />
      <AccountsView />
    </div>
  );
}
