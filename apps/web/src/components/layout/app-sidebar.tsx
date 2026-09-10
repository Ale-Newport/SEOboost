'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plus, Sparkles } from 'lucide-react';
import { Sidebar, type SidebarBadges } from '@/components/layout/sidebar';
import { SiteSwitcher } from '@/components/layout/site-switcher';
import { GLOBAL_NAV, siteNav } from '@/lib/nav';

export interface SidebarSite {
  id: string;
  name: string;
  domain: string;
  faviconUrl?: string | null;
  healthScore: number | null;
}

/**
 * One sidebar, two contexts.
 *
 * At portfolio level it shows the global navigation. Inside a website it *becomes* that site's
 * navigation with a back link, rather than stacking a second column beside the first — twenty
 * site sections do not fit in a secondary rail without eating the content area.
 */
export function AppSidebar({ sites, badges }: { sites: SidebarSite[]; badges: SidebarBadges }) {
  const pathname = usePathname();
  const websiteId = useMemo(() => {
    const match = /^\/sites\/([^/]+)/.exec(pathname);
    const id = match?.[1];
    // `/sites/new` is a page, not a website id.
    return id && id !== 'new' ? id : null;
  }, [pathname]);

  const activeSite = websiteId ? sites.find((s) => s.id === websiteId) ?? null : null;

  const addWebsite = (
    <Link
      href="/sites/new"
      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="truncate">Add website</span>
    </Link>
  );

  if (activeSite) {
    return (
      <Sidebar
        sections={siteNav(activeSite.id)}
        badges={badges}
        backLink={{ href: '/', label: 'All websites' }}
        header={<SiteSwitcher sites={sites} currentSiteId={activeSite.id} />}
        footer={addWebsite}
      />
    );
  }

  return (
    <Sidebar
      sections={GLOBAL_NAV}
      badges={badges}
      header={
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-sm">SEO OS</span>
        </Link>
      }
      footer={addWebsite}
    />
  );
}
