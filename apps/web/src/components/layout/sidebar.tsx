'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { ChevronLeft, PanelLeftClose, PanelLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NavItem } from '@/lib/nav';

export interface SidebarBadges {
  pendingApprovals?: number;
  runningJobs?: number;
  openOpportunities?: number;
}

interface SidebarProps {
  sections: Array<{ section: string; items: NavItem[] }>;
  badges?: SidebarBadges;
  header?: React.ReactNode;
  backLink?: { href: string; label: string };
  footer?: React.ReactNode;
}

export function Sidebar({ sections, badges, header, backLink, footer }: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    // A site's Overview href is a prefix of every sub-page, so it only matches exactly.
    const isSiteRoot = /^\/sites\/[^/]+$/.test(href);
    if (isSiteRoot) return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200',
        collapsed ? 'w-[64px]' : 'w-[248px]',
      )}
      aria-label="Primary"
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-3">
        {!collapsed && <div className="min-w-0 flex-1">{header}</div>}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="ml-auto rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      {backLink && (
        <Link
          href={backLink.href}
          className={cn(
            'mx-2 mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            collapsed && 'justify-center px-0',
          )}
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          {!collapsed && <span className="truncate">{backLink.label}</span>}
        </Link>
      )}

      <nav className="flex-1 overflow-y-auto px-2 py-3">
        {sections.map((group) => (
          <div key={group.section} className="mb-4 last:mb-0">
            {!collapsed && (
              <p className="px-2 pb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                {group.section}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                const badgeValue = item.badgeKey ? badges?.[item.badgeKey] : undefined;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      title={collapsed ? item.label : item.description}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                        active
                          ? 'bg-primary/10 font-medium text-primary'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        collapsed && 'justify-center px-0',
                      )}
                    >
                      <item.icon className={cn('h-4 w-4 shrink-0', active && 'text-primary')} />
                      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
                      {!collapsed && badgeValue !== undefined && badgeValue > 0 && (
                        <span className="tabular rounded-full bg-primary px-1.5 py-0.5 text-2xs font-semibold text-primary-foreground">
                          {badgeValue > 99 ? '99+' : badgeValue}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {footer && <div className="border-t border-border p-2">{footer}</div>}
    </aside>
  );
}
