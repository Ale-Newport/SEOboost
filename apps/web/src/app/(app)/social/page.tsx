import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { getSocialAccountsMatrix } from '@/server/queries/social';
import { PageHeader } from '@/components/ui/page-header';
import { SocialAccountsMatrixView } from '@/components/social/accounts-matrix';

/**
 * Portfolio-wide social accounts: every site against every network, in one table.
 *
 * Built for the operator who runs a brand account per network for each of several sites — the
 * question this page answers is "which of my accounts need me today?", not how to post.
 */

export const metadata: Metadata = { title: 'Social accounts' };
export const dynamic = 'force-dynamic';

export default async function SocialAccountsPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const matrix = await getSocialAccountsMatrix(user.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Social accounts"
        description={
          <>
            One brand account per network for each site, connected with one click on the network&rsquo;s own page. Open a
            site&rsquo;s <Link className="text-primary hover:underline" href={matrix.sites[0] ? `/sites/${matrix.sites[0].id}/social?tab=accounts` : '/sites'}>Accounts tab</Link> to connect or reconnect.
          </>
        }
      />
      <SocialAccountsMatrixView matrix={matrix} />
    </div>
  );
}
