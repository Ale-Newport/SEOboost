import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { OpportunityStatus, OpportunityType, prisma } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { listOpportunities } from '@/server/queries/content';
import { OpportunitiesView } from '@/components/content/opportunities-view';
import {
  isoDate,
  toOpportunityEvidence,
  toOpportunityStatus,
  toOpportunityType,
  toPriorityScore,
} from '@/components/content/normalize';
import { paramEnums, paramInt, paramNumber, paramValue, type RawSearchParams } from '@/components/content/search-params';
import type { OpportunityFacetCount, OpportunityItem } from '@/components/content/types';

export const metadata: Metadata = { title: 'Content opportunities' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function OpportunitiesPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  const query = await searchParams;

  // `listOpportunities` takes an already-scoped id list, so ownership is checked here.
  const website = await prisma.website.findFirst({
    where: { id: websiteId, userId: user.id },
    select: { id: true, name: true, domain: true },
  });
  if (!website) notFound();

  const status = paramEnums(query.status, Object.values(OpportunityStatus));
  const type = paramEnums(query.type, Object.values(OpportunityType));
  const search = paramValue(query.search);
  const minPriority = paramNumber(query.minPriority);
  const page = paramInt(query.page, 1);

  const [result, typeFacets, statusFacets, openCount] = await Promise.all([
    listOpportunities({
      websiteIds: [website.id],
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
      ...(search ? { search } : {}),
      ...(minPriority === undefined ? {} : { minPriority }),
      page,
      pageSize: PAGE_SIZE,
    }),
    prisma.contentOpportunity.groupBy({
      by: ['type'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.contentOpportunity.groupBy({
      by: ['status'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.contentOpportunity.count({
      where: { websiteId: website.id, status: OpportunityStatus.IDENTIFIED },
    }),
  ]);

  const items: OpportunityItem[] = result.items.map((row) => ({
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
  }));

  const typeCounts: OpportunityFacetCount[] = typeFacets.map((row) => ({
    value: row.type,
    count: row._count._all,
  }));
  const statusCounts: OpportunityFacetCount[] = statusFacets.map((row) => ({
    value: row.status,
    count: row._count._all,
  }));

  return (
    <OpportunitiesView
      website={website}
      items={items}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      typeFacets={typeCounts}
      statusFacets={statusCounts}
      openCount={openCount}
    />
  );
}
