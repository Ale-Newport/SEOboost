import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CalendarDays } from 'lucide-react';

import { OpportunityStatus, OpportunityType, prisma } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { listOpportunities } from '@/server/queries/content';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { humanizeStatus } from '@/components/ui/badge';
import type { FacetOption } from '@/components/data/filter-bar';
import {
  isoDate,
  toOpportunityEvidence,
  toOpportunityStatus,
  toOpportunityType,
  toPriorityScore,
} from '@/components/content/normalize';
import { opportunityTypeMeta } from '@/components/content/meta';
import type { OpportunityItem } from '@/components/content/types';
import {
  OpportunityQueue,
  type PortfolioOpportunity,
} from './opportunity-queue';

/**
 * The cross-site opportunity queue.
 *
 * `listOpportunities` already ranks by priority then discovery date, so ordering the whole
 * portfolio is a matter of handing it every owned website at once. Every number on the screen is
 * read back from the opportunity record — the priority factors, the evidence and the
 * cannibalisation check are the discovery pass's own, never recomputed here.
 */

export const metadata: Metadata = { title: 'Opportunities' };
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const PAGE_SIZE = 20;

function paramList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function paramOne(value: string | string[] | undefined): string | undefined {
  const [first] = paramList(value);
  return first;
}

function intParam(value: string | string[] | undefined, fallback: number): number {
  const parsed = Number(paramOne(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function numberParam(value: string | string[] | undefined): number | undefined {
  const raw = paramOne(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function enumList<T extends string>(value: string | string[] | undefined, allowed: readonly T[]): T[] {
  const wanted = new Set(paramList(value).map((entry) => entry.toUpperCase()));
  return allowed.filter((entry) => wanted.has(entry));
}

export default async function PortfolioOpportunitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const query = await searchParams;

  const websites = await prisma.website.findMany({
    where: { userId: user.id, status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, domain: true },
    orderBy: [{ name: 'asc' }],
  });
  const ownedIds = websites.map((website) => website.id);
  const websiteById = new Map(websites.map((website) => [website.id, website]));

  // A site filter narrows the owned set; it can never widen the scope.
  const requestedSites = new Set(paramList(query.site));
  const websiteIds = requestedSites.size === 0 ? ownedIds : ownedIds.filter((id) => requestedSites.has(id));

  const status = enumList(query.status, Object.values(OpportunityStatus));
  const type = enumList(query.type, Object.values(OpportunityType));
  const minPriority = numberParam(query.minPriority);
  const search = paramOne(query.search) ?? '';
  const page = intParam(query.page, 1);
  const pageSize = Math.min(100, intParam(query.pageSize, PAGE_SIZE));

  const [result, typeFacets, statusFacets, siteFacets, openCount] = await Promise.all([
    listOpportunities({
      websiteIds,
      ...(status.length ? { status } : {}),
      ...(type.length ? { type } : {}),
      ...(minPriority === undefined ? {} : { minPriority }),
      ...(search ? { search } : {}),
      page,
      pageSize,
    }),
    prisma.contentOpportunity.groupBy({
      by: ['type'],
      where: { websiteId: { in: ownedIds } },
      _count: { _all: true },
    }),
    prisma.contentOpportunity.groupBy({
      by: ['status'],
      where: { websiteId: { in: ownedIds } },
      _count: { _all: true },
    }),
    prisma.contentOpportunity.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: ownedIds } },
      _count: { _all: true },
    }),
    prisma.contentOpportunity.count({
      where: { websiteId: { in: ownedIds }, status: OpportunityStatus.IDENTIFIED },
    }),
  ]);

  const rows: PortfolioOpportunity[] = result.items.flatMap((row) => {
    const website = websiteById.get(row.websiteId);
    if (!website) return [];

    const opportunity: OpportunityItem = {
      id: row.id,
      type: toOpportunityType(row.type),
      status: toOpportunityStatus(row.status),
      title: row.title,
      targetKeyword: row.targetKeyword,
      secondaryKeywords: row.secondaryKeywords,
      suggestedUrl: row.suggestedUrl,
      reasoning: row.reasoning,
      priorityScore: row.priorityScore,
      impactScore: row.impactScore,
      effortScore: row.effortScore,
      confidenceScore: row.confidenceScore,
      estimatedTrafficGain: row.estimatedTrafficGain,
      cannibalizationChecked: row.cannibalizationChecked,
      cannibalizationRisk: row.cannibalizationRisk,
      existingPageMatch: row.existingPageMatch,
      discoveredAt: row.discoveredAt.toISOString(),
      expiresAt: isoDate(row.expiresAt),
      briefCount: row._count.briefs,
      priority: toPriorityScore(row.priorityScore, row.evidence),
      evidence: toOpportunityEvidence(row.evidence),
      keyword: row.keyword
        ? {
            id: row.keyword.id,
            keyword: row.keyword.keyword,
            intent: row.keyword.intent,
            funnelStage: row.keyword.funnelStage,
            searchVolume: row.keyword.searchVolume,
          }
        : null,
      page: row.page ? { id: row.page.id, url: row.page.url, title: row.page.title } : null,
      cluster: row.cluster ? { id: row.cluster.id, name: row.cluster.name } : null,
    };

    return [
      {
        websiteId: website.id,
        websiteName: website.name,
        websiteDomain: website.domain,
        opportunity,
      },
    ];
  });

  const totalProposed = typeFacets.reduce((sum, facet) => sum + facet._count._all, 0);
  // How many proposals do *not* put a new URL on a site. Derived from the stored type, so it is
  // a count of decisions the pass actually made.
  const reuseCount = typeFacets.reduce(
    (sum, facet) => (opportunityTypeMeta(facet.type).createsPage ? sum : sum + facet._count._all),
    0,
  );

  const typeCounts = new Map(typeFacets.map((facet) => [facet.type as string, facet._count._all]));
  const typeOptions: FacetOption[] = Object.values(OpportunityType)
    .map((value) => ({
      value,
      label: opportunityTypeMeta(value).label,
      icon: opportunityTypeMeta(value).icon,
      count: typeCounts.get(value) ?? 0,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const statusCounts = new Map(statusFacets.map((facet) => [facet.status as string, facet._count._all]));
  const statusOptions: FacetOption[] = Object.values(OpportunityStatus).map((value) => ({
    value,
    label: humanizeStatus(value),
    count: statusCounts.get(value) ?? 0,
  }));

  const siteCounts = new Map(siteFacets.map((facet) => [facet.websiteId, facet._count._all]));
  const siteOptions: FacetOption[] = websites
    .map((website) => ({
      value: website.id,
      label: website.name,
      count: siteCounts.get(website.id) ?? 0,
    }))
    .filter((option) => option.count > 0);

  return (
    <div className="space-y-4 px-4 py-6 md:px-6">
      <PageHeader
        title="Opportunities"
        description="Every content opportunity across every website you own, ranked by priority. Each one was checked against the pages that site already has before it was raised."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/calendar">
              <CalendarDays aria-hidden="true" />
              Content calendar
            </Link>
          </Button>
        }
      />

      <OpportunityQueue
        rows={rows}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        openCount={openCount}
        totalProposed={totalProposed}
        reuseCount={reuseCount}
        siteOptions={siteOptions}
        typeOptions={typeOptions}
        statusOptions={statusOptions}
        hasWebsites={websites.length > 0}
      />
    </div>
  );
}
