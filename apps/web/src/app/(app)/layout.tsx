import { redirect } from 'next/navigation';
import { prisma } from '@seo/db';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { Topbar } from '@/components/layout/topbar';
import { getCurrentUser } from '@/lib/auth';

/** Every screen in this group reads session-scoped data; none of it may be cached. */
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  // The middleware only checks that a cookie exists; this is the real gate.
  if (!user) redirect('/login');

  /*
   * One round trip for the whole shell.
   *
   * `$transaction` with an array pipelines these four reads over a single connection, which
   * matters because the shell re-renders on every navigation in the group. The badge counts
   * are scoped through the `website` relation so they can only ever count rows this user owns.
   */
  const [websites, pendingApprovals, runningJobs, openOpportunities] = await prisma.$transaction([
    prisma.website.findMany({
      where: { userId: user.id, status: { not: 'ARCHIVED' } },
      orderBy: [{ name: 'asc' }],
      select: { id: true, name: true, domain: true, faviconUrl: true, healthScore: true },
    }),
    prisma.approval.count({ where: { status: 'PENDING', website: { userId: user.id } } }),
    prisma.jobRecord.count({
      where: { status: { in: ['QUEUED', 'RUNNING'] }, website: { userId: user.id } },
    }),
    prisma.contentOpportunity.count({
      where: { status: 'IDENTIFIED', website: { userId: user.id } },
    }),
  ]);

  // Nothing in this shell means anything without a site — send them to set one up.
  if (websites.length === 0) redirect('/onboarding');

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-lg"
      >
        Skip to content
      </a>

      {/*
        One sidebar that changes context: portfolio navigation at the top level, and the site's
        own twenty-section navigation once you are inside a website. Stacking a second rail
        beside the first would cost ~250px of content width on every site screen.
      */}
      <AppSidebar
        sites={websites}
        badges={{ pendingApprovals, runningJobs, openOpportunities }}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          breadcrumb={<Breadcrumb sites={websites.map(({ id, name }) => ({ id, name }))} />}
        />
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
