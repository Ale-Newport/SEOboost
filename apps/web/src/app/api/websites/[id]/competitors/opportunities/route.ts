import { z } from 'zod';
import { OpportunityStatus, OpportunityType, json, prisma } from '@seo/db';
import { ValidationError, createLogger, normalizeKeyword } from '@seo/shared';
import {
  type CompetitorKeywordRow,
  type OurKeywordRow,
  analyseKeywordGaps,
} from '@seo/seo-engine';
import { readBody, requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';

const log = createLogger('api:competitor-gaps');

type Params = { id: string };

const createSchema = z.object({
  /** The gap keyword exactly as it appears in the gap table. */
  keyword: z.string().trim().min(1).max(300),
});

/** Statuses that mean "this keyword is already in the pipeline". */
const LIVE_STATUSES: OpportunityStatus[] = [
  OpportunityStatus.IDENTIFIED,
  OpportunityStatus.ACCEPTED,
  OpportunityStatus.IN_PROGRESS,
];

/**
 * `POST /api/websites/[id]/competitors/opportunities` — turn a keyword gap into a content
 * opportunity.
 *
 * The request carries only the keyword. Everything written to the row — the gap type, the score,
 * the reasoning and the evidence — is recomputed here from the stored observations with the same
 * engine the Competitors screen renders, so a hand-crafted request cannot invent an opportunity
 * for a keyword that is not actually a gap, and the two screens can never disagree.
 */
export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  await assertNotReadOnly();
  const input = await readBody(request, createSchema);
  const normalized = normalizeKeyword(input.keyword);

  const competitors = await prisma.competitor.findMany({
    where: { websiteId: website.id, isActive: true },
    select: { id: true, domain: true },
  });
  if (competitors.length === 0) {
    throw new ValidationError('No active competitors are tracked for this site, so there are no gaps.');
  }

  const [competitorRows, ourRows] = await Promise.all([
    prisma.competitorKeyword.findMany({
      where: { competitorId: { in: competitors.map((row) => row.id) } },
      select: { competitorId: true, keyword: true, position: true, url: true, estimatedVolume: true },
      orderBy: { position: 'asc' },
      take: 20_000,
    }),
    prisma.keyword.findMany({
      where: { websiteId: website.id },
      select: { id: true, keyword: true, currentPosition: true, impressions28d: true, rankingUrl: true },
      take: 50_000,
    }),
  ]);

  const domainById = new Map(competitors.map((row) => [row.id, row.domain]));
  const observed: CompetitorKeywordRow[] = competitorRows.map((row) => ({
    competitorDomain: domainById.get(row.competitorId) ?? '',
    keyword: row.keyword,
    position: row.position,
    url: row.url,
    estimatedVolume: row.estimatedVolume,
  }));
  const ours: OurKeywordRow[] = ourRows.map((row) => ({
    keyword: row.keyword,
    position: row.currentPosition,
    impressions: row.impressions28d,
    url: row.rankingUrl,
  }));

  // No result cap: the requested keyword must be findable even when it ranks low in the list.
  const gap = analyseKeywordGaps(ours, observed, { maxResults: Number.MAX_SAFE_INTEGER }).find(
    (candidate) => normalizeKeyword(candidate.keyword) === normalized,
  );
  if (!gap) {
    throw new ValidationError(
      `"${input.keyword}" is not currently a keyword gap for this site. It may already rank in the top 10, ` +
        'or the observation behind it may have been removed with its competitor.',
    );
  }

  const ourKeyword = ourRows.find((row) => normalizeKeyword(row.keyword) === normalized) ?? null;

  const existing = await prisma.contentOpportunity.findFirst({
    where: {
      websiteId: website.id,
      targetKeyword: gap.keyword,
      status: { in: LIVE_STATUSES },
    },
    select: { id: true, status: true },
  });
  if (existing) {
    return {
      created: false,
      opportunityId: existing.id,
      message: `"${gap.keyword}" is already an open opportunity.`,
    };
  }

  const opportunity = await prisma.contentOpportunity.create({
    data: {
      websiteId: website.id,
      ...(ourKeyword ? { keywordId: ourKeyword.id } : {}),
      // Missing entirely means new content; outranked means the existing page has to get better.
      type: gap.gapType === 'missing' ? OpportunityType.NEW_ARTICLE : OpportunityType.IMPROVE_EXISTING_PAGE,
      status: OpportunityStatus.IDENTIFIED,
      title:
        gap.gapType === 'missing'
          ? `Cover "${gap.keyword}"`
          : `Improve the page targeting "${gap.keyword}"`,
      targetKeyword: gap.keyword,
      reasoning: gap.reason,
      // The engine's own output, stored verbatim so the score stays auditable.
      evidence: json({ source: 'competitor-gap', gap, competitorDomains: gap.competitorDomains }),
      // Only the gap score is a real number here. Impact, effort and confidence are left at zero
      // rather than guessed — the content strategy agent scores them when it next runs.
      priorityScore: gap.gapScore,
    },
    select: { id: true },
  });

  log.info('opportunity created from keyword gap', {
    websiteId: website.id,
    keyword: gap.keyword,
    gapType: gap.gapType,
    opportunityId: opportunity.id,
  });

  return {
    created: true,
    opportunityId: opportunity.id,
    message: `Opportunity created for "${gap.keyword}".`,
  };
});
