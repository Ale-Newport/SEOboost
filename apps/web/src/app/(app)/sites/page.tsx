import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Globe, Plus } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { getDashboardData } from '@/server/queries/dashboard';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { SiteCard } from '@/components/site/site-card';

export const metadata: Metadata = { title: 'Websites' };
export const dynamic = 'force-dynamic';

export default async function SitesPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const data = await getDashboardData(user.id);
  const needById = new Map(data.siteRanking.map((r) => [r.websiteId, r]));

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Websites"
        description={
          data.websites.length === 0
            ? 'No websites yet.'
            : `${data.websites.length} website${data.websites.length === 1 ? '' : 's'} in your portfolio`
        }
        actions={
          <Button asChild size="sm">
            <Link href="/sites/new">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add website
            </Link>
          </Button>
        }
      />

      {data.websites.length === 0 ? (
        <EmptyState
          bordered
          icon={Globe}
          title="No websites yet"
          description="Add a site and the platform will crawl it, audit it against ~60 technical rules, and produce a first action plan."
          action={
            <Button asChild>
              <Link href="/sites/new">
                <Plus className="mr-2 h-4 w-4" />
                Add your first website
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.websites.map((site) => (
            <SiteCard key={site.websiteId} site={site} need={needById.get(site.websiteId) ?? null} />
          ))}
        </div>
      )}
    </div>
  );
}
