'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, ChevronsUpDown, Globe, LayoutGrid, Plus, Search } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SCORE_GRADE_TEXT, scoreGrade } from '@/components/ui/score-ring';
import { cn } from '@/lib/utils';

export interface SiteSwitcherSite {
  id: string;
  name: string;
  domain: string;
  faviconUrl?: string | null;
  /** 0-100, or null when the site has not been analysed yet. Never invented. */
  healthScore?: number | null;
}

export interface SiteSwitcherProps {
  sites: SiteSwitcherSite[];
  /** Omit to derive the active site from the URL (`/sites/<id>/...`). */
  currentSiteId?: string | null;
  className?: string;
}

/** Above this many sites, scanning beats scrolling — so a filter box appears. */
const SEARCH_THRESHOLD = 7;

function siteIdFromPath(pathname: string): string | null {
  const match = /^\/sites\/([^/]+)/.exec(pathname);
  return match?.[1] ?? null;
}

function HealthDot({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) {
    return (
      <span className="tabular text-2xs text-muted-foreground" title="Not analysed yet">
        —
      </span>
    );
  }
  const rounded = Math.round(score);
  return (
    <span
      className={cn('tabular text-2xs font-medium', SCORE_GRADE_TEXT[scoreGrade(rounded)])}
      title={`Health score ${rounded}`}
    >
      {rounded}
    </span>
  );
}

/**
 * Site picker for the sidebar header.
 *
 * Switching preserves nothing but the site: jumping from one site's Keywords screen to
 * another's would carry filters and ids that mean nothing there, so every switch lands on the
 * target site's overview.
 */
export function SiteSwitcher({ sites, currentSiteId, className }: SiteSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);

  const activeId = currentSiteId ?? siteIdFromPath(pathname);
  const active = sites.find((site) => site.id === activeId) ?? null;
  const showSearch = sites.length > SEARCH_THRESHOLD;

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sites;
    return sites.filter(
      (site) =>
        site.name.toLowerCase().includes(needle) || site.domain.toLowerCase().includes(needle),
    );
  }, [sites, query]);

  /*
   * Radix parks focus on the first menu item when the menu opens. With a filter box present the
   * caret belongs there instead, and the dropdown exposes no open-autofocus hook — so focus is
   * moved on the next frame, once Radix has finished its own focus pass.
   */
  React.useEffect(() => {
    if (!open || !showSearch) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, showSearch]);

  const select = (id: string) => {
    setOpen(false);
    router.push(`/sites/${id}`);
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <DropdownMenuTrigger
        className={cn(
          'flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        aria-label={active ? `Current site: ${active.name}. Switch site` : 'Choose a site'}
      >
        {active ? (
          <Avatar name={active.name} src={active.faviconUrl ?? undefined} size="sm" />
        ) : (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-sm border border-border bg-muted text-muted-foreground">
            <LayoutGrid className="size-3.5" aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-tight text-foreground">
            {active ? active.name : 'All sites'}
          </span>
          <span className="block truncate text-2xs leading-tight text-muted-foreground">
            {active ? active.domain : `${sites.length} ${sites.length === 1 ? 'site' : 'sites'}`}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[19rem] p-0">
        {showSearch ? (
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              /*
               * Radix's typeahead listens on the menu content, so a plain character would jump
               * the selection instead of reaching this box. Only printable keys and Backspace
               * are swallowed — arrows, Enter and Escape still drive the menu itself.
               */
              onKeyDown={(event) => {
                if (event.key.length === 1 || event.key === 'Backspace') event.stopPropagation();
              }}
              placeholder="Filter sites"
              aria-label="Filter sites"
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        ) : null}

        <div className="max-h-[18rem] overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No site matches “{query.trim()}”.
            </p>
          ) : (
            filtered.map((site) => {
              const isActive = site.id === activeId;
              return (
                <DropdownMenuItem
                  key={site.id}
                  onSelect={() => select(site.id)}
                  className="flex items-center gap-2.5 px-2 py-1.5"
                >
                  <Avatar name={site.name} src={site.faviconUrl ?? undefined} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm leading-tight text-foreground">{site.name}</span>
                    <span className="block truncate text-2xs leading-tight text-muted-foreground">
                      {site.domain}
                    </span>
                  </span>
                  <HealthDot score={site.healthScore} />
                  {isActive ? (
                    <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  ) : (
                    <span className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                </DropdownMenuItem>
              );
            })
          )}
        </div>

        <DropdownMenuSeparator className="my-0" />

        <div className="p-1">
          <DropdownMenuItem
            onSelect={() => {
              setOpen(false);
              router.push('/sites');
            }}
            className="gap-2 px-2 py-1.5"
          >
            <Globe className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm">All sites</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            /*
             * `/sites/new` rather than `/onboarding`: the wizard is first-run setup and walks
             * through provider and integration choices that are already made by the time a
             * second site is added. The sidebar's own "Add website" points here too.
             */
            onSelect={() => {
              setOpen(false);
              router.push('/sites/new');
            }}
            className="gap-2 px-2 py-1.5"
          >
            <Plus className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="text-sm">Add website</span>
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
