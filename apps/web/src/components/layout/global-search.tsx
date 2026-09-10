'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  Braces,
  Clock,
  FileText,
  Globe,
  KeyRound,
  Library,
  Search,
  Sparkles,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { z } from 'zod';
import { ApiError, apiGet } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Command palette.
 *
 * `/api/search` owns relevance — it can reach the database and rank across every entity type —
 * so cmdk's client-side filtering is switched off and every rendered item is a server result.
 * Filtering twice would silently hide rows the server considered a match.
 */

const SEARCH_ENDPOINT = '/api/search';
const DEBOUNCE_MS = 220;
const RECENT_KEY = 'seo-os:recent-searches';
const RECENT_LIMIT = 6;

/**
 * `/api/search` names the entity kind `group` (`'site' | 'page' | 'keyword' | …`). Both spellings
 * are accepted and collapsed to `kind` so the palette keeps working if the route is ever renamed,
 * and a row with neither still renders — it lands in "Other" rather than being dropped.
 */
const hitSchema = z
  .object({
    id: z.string(),
    group: z.string().nullish(),
    type: z.string().nullish(),
    title: z.string(),
    subtitle: z.string().nullish(),
    href: z.string(),
    badge: z.string().nullish(),
  })
  .transform((hit) => ({
    id: hit.id,
    kind: hit.group ?? hit.type ?? '',
    title: hit.title,
    subtitle: hit.subtitle,
    href: hit.href,
    badge: hit.badge,
  }));

/**
 * Tolerant of the three shapes a list endpoint reasonably returns. Anything else parses to
 * "no results" rather than throwing — a search box is not the place to surface a schema drift.
 */
const responseSchema = z.union([
  z.array(hitSchema),
  z.object({ results: z.array(hitSchema) }),
  z.object({ items: z.array(hitSchema) }),
  z.object({ groups: z.array(z.object({ items: z.array(hitSchema) })) }),
]);

type SearchHit = z.infer<typeof hitSchema>;

function normalise(payload: unknown): SearchHit[] {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) return [];
  const value = parsed.data;
  if (Array.isArray(value)) return value;
  if ('results' in value) return value.results;
  if ('items' in value) return value.items;
  return value.groups.flatMap((group) => group.items);
}

type GroupKey =
  | 'Sites'
  | 'Pages'
  | 'Keywords'
  | 'Issues'
  | 'Actions'
  | 'Content'
  | 'Competitors'
  | 'Other';

const GROUP_ORDER: GroupKey[] = [
  'Sites',
  'Pages',
  'Keywords',
  'Issues',
  'Actions',
  'Content',
  'Competitors',
  'Other',
];

const GROUP_ICON: Record<GroupKey, LucideIcon> = {
  Sites: Globe,
  Pages: Library,
  Keywords: KeyRound,
  Issues: TriangleAlert,
  Actions: Sparkles,
  Content: FileText,
  Competitors: Users,
  Other: Braces,
};

/** Maps whatever the API calls a row onto the groups the palette shows. */
function groupOf(kind: string): GroupKey {
  const key = kind.toLowerCase();
  // A competitor is somebody else's site; it gets its own heading rather than sitting under
  // the operator's own portfolio.
  if (key.includes('competitor')) return 'Competitors';
  if (key.includes('site') || key.includes('website')) return 'Sites';
  if (key.includes('page')) return 'Pages';
  if (key.includes('keyword') || key.includes('query') || key.includes('cluster')) return 'Keywords';
  if (key.includes('issue')) return 'Issues';
  if (key.includes('action') || key.includes('approval')) return 'Actions';
  if (key.includes('content') || key.includes('draft') || key.includes('brief') || key.includes('opportunit')) {
    return 'Content';
  }
  return 'Other';
}

/** Results carry hrefs from the server; only same-origin paths are ever navigated to. */
function safeHref(href: string): string | null {
  return href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') ? href : null;
}

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return z.array(z.string()).catch([]).parse(parsed).slice(0, RECENT_LIMIT);
  } catch {
    // Private mode, disabled storage, or a corrupt value — recents are a convenience.
    return [];
  }
}

function writeRecent(values: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(values.slice(0, RECENT_LIMIT)));
  } catch {
    /* ignore */
  }
}

export function GlobalSearch() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [recent, setRecent] = React.useState<string[]>([]);

  // Monotonic request id: fetches resolve out of order, and a stale one must never win.
  const requestRef = React.useRef(0);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  React.useEffect(() => {
    if (open) setRecent(readRecent());
  }, [open]);

  React.useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      requestRef.current += 1;
      setHits([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    const timer = window.setTimeout(() => {
      const requestId = (requestRef.current += 1);
      apiGet<unknown>(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(term)}`)
        .then((payload) => {
          if (requestRef.current !== requestId) return;
          setHits(normalise(payload));
          setError(null);
        })
        .catch((err: unknown) => {
          if (requestRef.current !== requestId) return;
          setHits([]);
          setError(
            err instanceof ApiError ? err.message : 'Search is unavailable right now.',
          );
        })
        .finally(() => {
          if (requestRef.current === requestId) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query]);

  const rememberTerm = (term: string) => {
    const trimmed = term.trim();
    if (trimmed.length < 2) return;
    const next = [trimmed, ...recent.filter((value) => value !== trimmed)].slice(0, RECENT_LIMIT);
    setRecent(next);
    writeRecent(next);
  };

  const openHit = (hit: SearchHit) => {
    const href = safeHref(hit.href);
    if (!href) return;
    rememberTerm(query);
    setOpen(false);
    setQuery('');
    router.push(href);
  };

  const grouped = React.useMemo(() => {
    const buckets = new Map<GroupKey, SearchHit[]>();
    for (const hit of hits) {
      const key = groupOf(hit.kind);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(hit);
      else buckets.set(key, [hit]);
    }
    return GROUP_ORDER.flatMap((key) => {
      const items = buckets.get(key);
      return items && items.length > 0 ? [{ key, items }] : [];
    });
  }, [hits]);

  const trimmed = query.trim();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'group hidden h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs md:flex md:w-56',
          'text-muted-foreground transition-colors hover:border-ring/60 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <Search className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Search</span>
        <kbd className="pointer-events-none hidden shrink-0 items-center gap-0.5 rounded border border-border bg-muted px-1 font-sans text-2xs text-muted-foreground lg:flex">
          <span className="text-xs leading-none">⌘</span>K
        </kbd>
      </button>

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search"
        className={cn(
          'flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors md:hidden',
          'hover:bg-accent hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <Search className="size-4" aria-hidden="true" />
      </button>

      <Command.Dialog
        open={open}
        onOpenChange={setOpen}
        shouldFilter={false}
        loop
        label="Search sites, pages, keywords, issues, actions and content"
        overlayClassName="fixed inset-0 z-50 bg-background/70 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0"
        contentClassName={cn(
          'fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2',
          'overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-popover',
          'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
        )}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-3.5">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder="Search sites, pages, keywords, issues…"
            className="h-11 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {loading ? (
            <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" aria-hidden="true" />
          ) : null}
        </div>

        <Command.List
          className={cn(
            'max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain p-1.5',
            '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5',
            '[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold',
            '[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider',
            '[&_[cmdk-group-heading]]:text-muted-foreground',
          )}
        >
          {error ? (
            <div role="alert" className="px-3 py-8 text-center text-sm text-destructive">
              {error}
            </div>
          ) : null}

          {!error && trimmed.length >= 2 ? (
            <Command.Empty className="px-3 py-10 text-center text-sm text-muted-foreground">
              {loading ? 'Searching…' : <>No matches for “{trimmed}”.</>}
            </Command.Empty>
          ) : null}

          {!error && trimmed.length < 2 ? (
            recent.length > 0 ? (
              <Command.Group heading="Recent searches">
                {recent.map((term) => (
                  <Command.Item
                    key={term}
                    value={`recent:${term}`}
                    onSelect={() => setQuery(term)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm',
                      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                    )}
                  >
                    <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate">{term}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            ) : (
              <p className="px-3 py-10 text-center text-sm leading-relaxed text-muted-foreground">
                Type at least two characters to search sites, pages, keywords, issues, AI actions
                and content.
              </p>
            )
          ) : null}

          {grouped.map(({ key, items }) => {
            const Icon = GROUP_ICON[key];
            return (
              <Command.Group key={key} heading={key}>
                {items.map((hit) => (
                  <Command.Item
                    key={`${hit.kind}:${hit.id}`}
                    value={`${hit.kind}:${hit.id}`}
                    onSelect={() => openHit(hit)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm',
                      'data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground',
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate leading-tight text-foreground">{hit.title}</span>
                      {hit.subtitle ? (
                        <span className="block truncate text-2xs leading-tight text-muted-foreground">
                          {hit.subtitle}
                        </span>
                      ) : null}
                    </span>
                    {hit.badge ? (
                      <span className="shrink-0 rounded border border-border px-1 py-0.5 text-2xs text-muted-foreground">
                        {hit.badge}
                      </span>
                    ) : null}
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>

        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-2xs text-muted-foreground">
          <span>
            <kbd className="rounded border border-border bg-muted px-1 font-sans">↑</kbd>{' '}
            <kbd className="rounded border border-border bg-muted px-1 font-sans">↓</kbd> to navigate
          </span>
          <span>
            <kbd className="rounded border border-border bg-muted px-1 font-sans">↵</kbd> to open ·{' '}
            <kbd className="rounded border border-border bg-muted px-1 font-sans">esc</kbd> to close
          </span>
        </div>
      </Command.Dialog>
    </>
  );
}
