import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { prisma } from '@seo/db';
import { getCurrentUser } from '@/lib/auth';
import { PageHeader } from '@/components/ui/page-header';
import { RedditWorkspace } from '@/components/accounts/reddit-workspace';

export const metadata: Metadata = { title: 'Reddit' };
export const dynamic = 'force-dynamic';

export default async function RedditPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const sites = await prisma.website.findMany({ where: { userId: user.id }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  return (
    <div className="space-y-6">
      <PageHeader
        title="Reddit"
        description={
          <>
            Your linked Reddit account. Posts and comments into communities pass the same anti-spam guardrails as the social module.{' '}
            <Link className="text-primary hover:underline" href="/accounts">Manage accounts</Link>
          </>
        }
      />
      <RedditWorkspace sites={sites} />
    </div>
  );
}
