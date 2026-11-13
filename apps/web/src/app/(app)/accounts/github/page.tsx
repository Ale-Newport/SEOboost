import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getCurrentUser } from '@/lib/auth';
import { PageHeader } from '@/components/ui/page-header';
import { GitHubWorkspace } from '@/components/accounts/github-workspace';

export const metadata: Metadata = { title: 'GitHub' };
export const dynamic = 'force-dynamic';

/** `?repo=owner/name` opens that repository straight away (e.g. from a pasted link). */
export default async function GitHubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const query = await searchParams;
  const repo = typeof query.repo === 'string' ? query.repo.slice(0, 300) : null;
  return (
    <div className="space-y-6">
      <PageHeader
        title="GitHub"
        description={
          <>
            Your linked GitHub account. Every star, fork, issue and comment is a click of yours. <Link className="text-primary hover:underline" href="/accounts">Manage accounts</Link>
          </>
        }
      />
      <GitHubWorkspace initialRef={repo} />
    </div>
  );
}
