'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { GLOBAL_NAV, siteNav } from '@/lib/nav';
import { cn } from '@/lib/utils';

export interface BreadcrumbSiteRef {
  id: string;
  name: string;
}

export interface BreadcrumbProps {
  /** Lets the trail turn `/sites/<cuid>` into the site's name without another query. */
  sites?: BreadcrumbSiteRef[];
  /** Wins over `sites` when the surrounding page already knows which site it is showing. */
  siteName?: string;
  className?: string;
}

/**
 * Segment labels are derived from the navigation definition rather than duplicated here, so a
 * rename in `lib/nav.ts` moves through the breadcrumb automatically and the two can never
 * disagree about what a section is called.
 */
const SEGMENT_LABEL: ReadonlyMap<string, string> = (() => {
  const labels = new Map<string, string>();
  const PLACEHOLDER_ID = '__site__';

  const collect = (groups: Array<{ items: Array<{ href: string; label: string }> }>) => {
    for (const group of groups) {
      for (const item of group.items) {
        const segment = item.href.split('/').filter(Boolean).at(-1);
        if (segment && segment !== PLACEHOLDER_ID) labels.set(segment, item.label);
      }
    }
  };

  collect(GLOBAL_NAV);
  collect(siteNav(PLACEHOLDER_ID));
  return labels;
})();

/** cuid-shaped segments are record ids, not words — humanising one produces nonsense. */
function looksLikeId(segment: string): boolean {
  return /^c[a-z0-9]{20,}$/i.test(segment) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment);
}

function humanize(segment: string): string {
  const words = decodeURIComponent(segment).replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Crumb {
  href: string;
  label: string;
  /** Ids keep their raw form in a mono face — they are identifiers, not prose. */
  mono: boolean;
}

function buildTrail(pathname: string, sites: BreadcrumbSiteRef[], siteName?: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [{ href: '/', label: 'Dashboard', mono: false }];

  const trail: Crumb[] = [{ href: '/', label: 'Dashboard', mono: false }];

  segments.forEach((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join('/')}`;
    const isSiteId = segments[0] === 'sites' && index === 1;

    if (isSiteId) {
      const resolved = siteName ?? sites.find((site) => site.id === segment)?.name;
      trail.push({ href, label: resolved ?? segment.slice(0, 8), mono: !resolved });
      return;
    }

    const known = SEGMENT_LABEL.get(segment);
    if (known) {
      trail.push({ href, label: known, mono: false });
      return;
    }

    trail.push(
      looksLikeId(segment)
        ? { href, label: segment.slice(0, 8), mono: true }
        : { href, label: humanize(segment), mono: false },
    );
  });

  return trail;
}

/**
 * Path-derived breadcrumb. The last crumb is the current page and is deliberately not a link —
 * a link to where you already are is noise for pointer and keyboard users alike.
 */
export function Breadcrumb({ sites, siteName, className }: BreadcrumbProps) {
  const pathname = usePathname();
  // Splitting a path and reading a lookup map is cheaper than memoising it.
  const trail = buildTrail(pathname, sites ?? [], siteName);

  return (
    <nav aria-label="Breadcrumb" className={cn('min-w-0 overflow-hidden', className)}>
      <ol className="flex min-w-0 items-center gap-1 text-sm">
        {trail.map((crumb, index) => {
          const isLast = index === trail.length - 1;
          return (
            <li key={crumb.href} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />
              ) : null}
              {isLast ? (
                <span
                  aria-current="page"
                  className={cn(
                    'truncate font-medium text-foreground',
                    crumb.mono && 'font-mono text-xs',
                  )}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  href={crumb.href}
                  className={cn(
                    'truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    crumb.mono && 'font-mono text-xs',
                  )}
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
