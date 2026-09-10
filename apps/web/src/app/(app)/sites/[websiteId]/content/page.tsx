import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ContentStage, ContentStageStatus, prisma } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { listBriefs, listDrafts } from '@/server/queries/content';
import { ContentPipelineView } from '@/components/content/content-pipeline-view';
import {
  isoDate,
  toOutline,
  toQualityFlags,
  toStage,
  toStageStatus,
  toUnverifiedClaims,
} from '@/components/content/normalize';
import { paramEnums, paramInt, paramValue, type RawSearchParams } from '@/components/content/search-params';
import type { BriefRow, DraftRow, StageCount } from '@/components/content/types';

export const metadata: Metadata = { title: 'Content pipeline' };
export const dynamic = 'force-dynamic';

const DRAFT_PAGE_SIZE = 25;
/** Briefs paginate in the browser: the list is short and switching tabs should not refetch. */
const BRIEF_PAGE_SIZE = 100;

export default async function ContentPipelinePage({
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

  const website = await prisma.website.findFirst({
    where: { id: websiteId, userId: user.id },
    select: { id: true, name: true, domain: true },
  });
  if (!website) notFound();

  const stage = paramEnums(query.stage, Object.values(ContentStage));
  const stageStatus = paramEnums(query.stageStatus, Object.values(ContentStageStatus));
  const search = paramValue(query.search);
  const page = paramInt(query.page, 1);
  const order = paramValue(query.order) === 'asc' ? 'asc' : 'desc';

  const [drafts, briefs, stageGroups, briefTotal] = await Promise.all([
    listDrafts({
      websiteIds: [website.id],
      ...(stage ? { stage } : {}),
      ...(stageStatus ? { stageStatus } : {}),
      ...(search ? { search } : {}),
      page,
      pageSize: DRAFT_PAGE_SIZE,
      order,
    }),
    listBriefs({ websiteIds: [website.id], page: 1, pageSize: BRIEF_PAGE_SIZE }),
    prisma.contentDraft.groupBy({
      by: ['stage'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.contentBrief.count({ where: { websiteId: website.id } }),
  ]);

  const draftRows: DraftRow[] = drafts.items.map((draft) => {
    const flags = toQualityFlags(draft.qualityFlags);
    return {
      id: draft.id,
      title: draft.title,
      slug: draft.slug,
      kind: draft.kind,
      stage: toStage(draft.stage),
      stageStatus: toStageStatus(draft.currentStageStatus),
      targetKeyword: draft.targetKeyword ?? draft.brief?.targetKeyword ?? null,
      wordCount: draft.wordCount,
      qualityScore: draft.qualityScore,
      seoScore: draft.seoScore,
      geoScore: draft.geoScore,
      readabilityScore: draft.readabilityScore,
      unverifiedClaimCount: toUnverifiedClaims(draft.unverifiedClaims).length,
      blockingFlagCount: flags.filter((flag) => flag.severity === 'BLOCKING').length,
      scheduledFor: isoDate(draft.scheduledFor),
      publishedAt: isoDate(draft.publishedAt),
      publishedUrl: draft.publishedUrl,
      updatedAt: draft.updatedAt.toISOString(),
      pageUrl: draft.page?.url ?? null,
    };
  });

  const briefRows: BriefRow[] = briefs.items.map((brief) => ({
    id: brief.id,
    title: brief.title,
    targetKeyword: brief.targetKeyword,
    secondaryKeywords: brief.secondaryKeywords,
    intent: brief.intent,
    funnelStage: brief.funnelStage,
    status: brief.status,
    outlineLength: toOutline(brief.outline).length,
    questionCount: brief.questions.length,
    targetWordCount: brief.targetWordCount,
    suggestedUrl: brief.suggestedUrl,
    draftCount: brief._count.drafts,
    createdAt: brief.createdAt.toISOString(),
  }));

  const stageCounts: StageCount[] = stageGroups.map((group) => ({
    stage: toStage(group.stage),
    count: group._count._all,
  }));

  return (
    <ContentPipelineView
      website={website}
      drafts={draftRows}
      draftTotal={drafts.total}
      draftPage={drafts.page}
      draftPageSize={drafts.pageSize}
      briefs={briefRows}
      briefTotal={briefTotal}
      stageCounts={stageCounts}
    />
  );
}
