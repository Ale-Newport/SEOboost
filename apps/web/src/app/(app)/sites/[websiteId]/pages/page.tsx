import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { FileText, Layers, Link2, ScanLine, TrendingDown } from 'lucide-react';
import { PageType } from '@seo/db';

import { requireWebsite } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth';
import { getPageFacets, listPages, type PageListFilters } from '@/server/queries/pages';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { PagesListView } from '@/components/pages/pages-list-view';
import { formatNumber, formatPercent } from '@/lib/utils';
import { getPageInventory } from './queries';

export const metadata: Metadata = { title: 'Pages' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** Repeated (`?t=A&t=B`) or comma-separated (`?t=A,B`) — the toolbar writes the first form. */
function many(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function bool(value: string | string[] | undefined): boolean | undefined {
  const raw = first(value)?.toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return undefined;
}

function int(value: string | string[] | undefined): number | undefined {
  const parsed = Number(first(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

/**
 * `10..90`, `10..`, `..90` — the same encoding `NumberRangeFilter` writes.
 * Parsed here rather than imported from the filter module because that module is a client
 * boundary; a server component may not call functions across it.
 */
function range(value: string | string[] | undefined): { min?: number; max?: number } {
  const raw = first(value);
  if (raw === undefined) return {};
  const [rawMin = '', rawMax = ''] = raw.split('..');
  const min = Number(rawMin);
  const max = Number(rawMax);
  return {
    ...(rawMin.trim() !== '' && Number.isFinite(min) ? { min } : {}),
    ...(rawMax.trim() !== '' && Number.isFinite(max) ? { max } : {}),
  };
}

const PAGE_TYPES = new Set<string>(Object.values(PageType));

function pageTypes(value: string | string[] | undefined): PageType[] {
  return many(value).filter((entry): entry is PageType => PAGE_TYPES.has(entry));
}

function buildFilters(websiteId: string, params: SearchParams): PageListFilters {
  const words = range(params.words);
  const types = pageTypes(params.pageType);
  const statusCodes = many(params.statusCode)
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry));

  return {
    websiteId,
    page: int(params.page) ?? 1,
    pageSize: int(params.pageSize) ?? 50,
    ...(first(params.sort) === undefined ? {} : { sort: first(params.sort) }),
    order: first(params.order) === 'asc' ? 'asc' : 'desc',
    ...(first(params.search) === undefined ? {} : { search: first(params.search) }),
    ...(types.length > 0 ? { pageType: types } : {}),
    ...(statusCodes.length > 0 ? { statusCode: statusCodes } : {}),
    ...(bool(params.indexable) === undefined ? {} : { indexable: bool(params.indexable) }),
    ...(bool(params.orphan) === undefined ? {} : { orphan: bool(params.orphan) }),
    ...(bool(params.inSitemap) === undefined ? {} : { inSitemap: bool(params.inSitemap) }),
    ...(bool(params.hasIssues) === undefined ? {} : { hasIssues: bool(params.hasIssues) }),
    ...(words.min === undefined ? {} : { minWordCount: words.min }),
    ...(words.max === undefined ? {} : { maxWordCount: words.max }),
  };
}

export default async function PagesPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;

  const website = await requireWebsite(user.id, websiteId).catch(() => null);
  if (!website) notFound();

  const query = await searchParams;
  const filters = buildFilters(website.id, query);
  const thinContentWords = website.settings?.thinContentWords ?? 300;

  const [result, facets, inventory] = await Promise.all([
    listPages(filters),
    getPageFacets(website.id),
    getPageInventory(website.id, thinContentWords),
  ]);

  const indexableShare = inventory.total > 0 ? inventory.indexable / inventory.total : null;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Pages"
        description={
          inventory.total === 0
            ? 'The page inventory is built by the crawler.'
            : `${formatNumber(inventory.total)} crawled page${inventory.total === 1 ? '' : 's'} on ${website.domain}, with search performance from the last 28 days.`
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/sites/${website.id}/technical`}>Technical audit</Link>
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard
          label="Pages"
          value={formatNumber(inventory.total)}
          icon={FileText}
          info="Every URL the last crawl found and still sees. Pages dropped by a later crawl are archived, not counted."
          footer={<Link className="hover:text-foreground hover:underline" href={`/sites/${website.id}/pages`}>All pages</Link>}
        />
        <MetricCard
          label="Indexable"
          value={formatNumber(inventory.indexable)}
          icon={ScanLine}
          info="Pages that return 200, are not blocked by robots or a noindex directive, and canonicalise to themselves."
          footer={
            <Link className="hover:text-foreground hover:underline" href={`/sites/${website.id}/pages?indexable=false`}>
              {formatNumber(inventory.nonIndexable)} non-indexable
              {indexableShare === null ? '' : ` · ${formatPercent(indexableShare, 0)} indexable`}
            </Link>
          }
        />
        <MetricCard
          label="Orphans"
          value={formatNumber(inventory.orphans)}
          icon={Link2}
          info="Indexable pages with no internal links pointing at them. Search engines reach them only through the sitemap, and they inherit no authority."
          footer={
            <Link className="hover:text-foreground hover:underline" href={`/sites/${website.id}/pages?orphan=true`}>
              Review orphans
            </Link>
          }
        />
        <MetricCard
          label="Thin pages"
          value={formatNumber(inventory.thin)}
          icon={Layers}
          info={`Fewer than ${formatNumber(inventory.thinContentWords)} words of body copy — this site's own thin-content threshold, set in Settings.`}
          footer={
            <Link
              className="hover:text-foreground hover:underline"
              href={`/sites/${website.id}/pages?words=..${inventory.thinContentWords - 1}`}
            >
              Under {formatNumber(inventory.thinContentWords)} words
            </Link>
          }
        />
        <MetricCard
          label="Declining"
          value={formatNumber(inventory.declining)}
          icon={TrendingDown}
          info="Pages whose clicks fell more than 20% against the previous 28 days, and that had clicks to lose."
          footer={
            <Link
              className="hover:text-foreground hover:underline"
              href={`/sites/${website.id}/pages?sort=clicksTrendPct&order=asc`}
            >
              Sort by steepest drop
            </Link>
          }
        />
      </div>

      {inventory.total === 0 ? (
        <EmptyState
          bordered
          icon={FileText}
          title={inventory.hasCompletedCrawl ? 'The last crawl found no pages' : 'No pages crawled yet'}
          description={
            inventory.hasCompletedCrawl
              ? 'A crawl finished but returned nothing indexable. Check the crawl settings — include/exclude patterns, robots.txt and the start URL — then run it again.'
              : 'Run a crawl to build the page inventory. Everything on this screen — word counts, internal links, indexability and page scores — comes from it.'
          }
          action={
            <Button asChild>
              <Link href={`/sites/${website.id}`}>
                {inventory.hasCompletedCrawl ? 'Review crawl settings' : 'Start a crawl'}
              </Link>
            </Button>
          }
        />
      ) : (
        <PagesListView
          websiteId={website.id}
          result={result}
          facets={facets}
          thinContentWords={inventory.thinContentWords}
        />
      )}
    </div>
  );
}
