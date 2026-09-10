import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowUpRight, Plus, Sparkles } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth';
import { getDashboardData } from '@/server/queries/dashboard';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { PortfolioMetrics } from '@/components/dashboard/portfolio-metrics';
import { PortfolioChart } from '@/components/dashboard/portfolio-chart';
import { WebsiteTable } from '@/components/dashboard/website-table';
import { AiActivityPanel } from '@/components/dashboard/ai-activity-panel';
import { InsightsPanel } from '@/components/dashboard/insights-panel';
import { PendingApprovalsPanel } from '@/components/dashboard/pending-approvals-panel';
import { getPerformanceSeries } from '@/server/queries/analytics';

export const metadata: Metadata = { title: 'Dashboard' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const data = await getDashboardData(user.id);

  if (data.isEmpty) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-16">
        <EmptyState
          icon={Sparkles}
          title="Your SEO command center is ready"
          description="Add your first website and the platform will crawl it, audit it, import your Search Console data and tell you what to work on first."
          action={
            <Button asChild size="lg">
              <Link href="/onboarding">
                <Plus className="mr-2 h-4 w-4" />
                Add your first website
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  const series = await getPerformanceSeries({
    websiteIds: data.websites.map((w) => w.websiteId),
    days: 90,
    compare: true,
  });

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="SEO command center"
        description={`${data.websites.length} website${data.websites.length === 1 ? '' : 's'} · portfolio performance over the last 28 days`}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/actions">
                Review AI actions
                <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" />
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/sites/new">
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add website
              </Link>
            </Button>
          </div>
        }
      />

      <PortfolioMetrics
        performance={data.performance}
        keywordCounts={data.keywordCounts}
        counts={data.counts}
        websites={data.websites}
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <PortfolioChart series={series} hasData={data.performance?.hasData ?? false} />
        <AiActivityPanel counts={data.counts} recentActions={data.recentActions} />
      </div>

      <WebsiteTable websites={data.websites} ranking={data.siteRanking} />

      <div className="grid gap-6 lg:grid-cols-2">
        <InsightsPanel insights={data.insights} />
        <PendingApprovalsPanel approvals={data.pendingApprovals} total={data.counts.pendingApprovals} />
      </div>
    </div>
  );
}
