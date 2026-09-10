import { z } from 'zod';
import { prisma } from '@seo/db';
import { isConfigured } from '@seo/shared';
import {
  type CompetitorKeywordRow,
  type OurKeywordRow,
  analyseKeywordGaps,
  buildCompetitorOverview,
} from '@seo/seo-engine';
import { readQuery, requireWebsite, route } from '@/lib/api';
import { intParam, listParam } from '@/server/queries/filters';

type Params = { id: string };

const querySchema = z.object({
  competitorId: listParam(z.string().min(1).max(60)).optional(),
  limit: intParam.min(1).max(1000).optional(),
  /** Rank we consider "already winning"; gaps above it are dropped. Defaults to the top 10. */
  underperformingThreshold: intParam.min(1).max(100).optional(),
});

/**
 * Keyword gaps against tracked competitors.
 *
 * The analysis is pure — it runs over rows the competitor job observed — so when there are no
 * observations there is nothing to compute. Rather than return an empty gap list (which reads
 * as "you have no gaps", the opposite of the truth), the endpoint returns a typed `skipped`
 * result naming exactly what is missing.
 */
export const GET = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const query = readQuery(request, querySchema);

  const competitors = await prisma.competitor.findMany({
    where: {
      websiteId: website.id,
      isActive: true,
      ...(query.competitorId ? { id: { in: query.competitorId } } : {}),
    },
    select: { id: true, domain: true, name: true, lastAnalysedAt: true },
  });

  if (competitors.length === 0) {
    return {
      skipped: true as const,
      reason: 'No competitors are being tracked for this site.',
      remedy: 'Add a competitor domain, then run the competitor analysis.',
      gaps: [],
      overviews: [],
    };
  }

  // Both sides are capped because the analysis runs in memory. The ordering decides *which*
  // rows survive the cap, so both are explicit: competitor rows by best rank (only positions
  // 1-20 count as a gap at all) and our keywords by impressions, so the ones that would
  // actually be judged "already ranking" are the ones present.
  const COMPETITOR_ROW_CAP = 20_000;
  const OUR_ROW_CAP = 50_000;

  const [competitorRows, competitorRowTotal, ourRows, ourRowTotal] = await Promise.all([
    prisma.competitorKeyword.findMany({
      where: { competitorId: { in: competitors.map((c) => c.id) } },
      select: {
        competitorId: true,
        keyword: true,
        position: true,
        url: true,
        estimatedVolume: true,
      },
      orderBy: [{ position: 'asc' }, { keyword: 'asc' }],
      take: COMPETITOR_ROW_CAP,
    }),
    prisma.competitorKeyword.count({
      where: { competitorId: { in: competitors.map((c) => c.id) } },
    }),
    prisma.keyword.findMany({
      where: { websiteId: website.id },
      select: { keyword: true, currentPosition: true, impressions28d: true, rankingUrl: true },
      orderBy: [{ impressions28d: 'desc' }, { keyword: 'asc' }],
      take: OUR_ROW_CAP,
    }),
    prisma.keyword.count({ where: { websiteId: website.id } }),
  ]);

  if (competitorRows.length === 0) {
    const analysed = competitors.filter((c) => c.lastAnalysedAt !== null).length;
    return {
      skipped: true as const,
      reason:
        analysed > 0
          ? 'The competitor analysis has run but observed no competitor rankings yet.'
          : 'The competitor analysis has not run yet, so no competitor rankings have been observed.',
      remedy: isConfigured.anySerp()
        ? 'Run the competitor analysis job for this site.'
        : 'Configure a SERP provider (DATAFORSEO_LOGIN, SERPAPI_KEY or SERPER_API_KEY) so competitor rankings can be collected.',
      gaps: [],
      overviews: [],
    };
  }

  const domainById = new Map(competitors.map((c) => [c.id, c.domain]));
  const competitorKeywords: CompetitorKeywordRow[] = competitorRows.map((row) => ({
    competitorDomain: domainById.get(row.competitorId) ?? '',
    keyword: row.keyword,
    position: row.position,
    url: row.url,
    estimatedVolume: row.estimatedVolume,
  }));

  const ourKeywords: OurKeywordRow[] = ourRows.map((row) => ({
    keyword: row.keyword,
    position: row.currentPosition,
    impressions: row.impressions28d,
    url: row.rankingUrl,
  }));

  const gaps = analyseKeywordGaps(ourKeywords, competitorKeywords, {
    maxResults: query.limit ?? 200,
    ...(query.underperformingThreshold === undefined
      ? {}
      : { underperformingThreshold: query.underperformingThreshold }),
  });

  const overviews = competitors.map((competitor) => ({
    competitorId: competitor.id,
    name: competitor.name,
    lastAnalysedAt: competitor.lastAnalysedAt,
    ...buildCompetitorOverview(competitor.domain, ourKeywords, competitorKeywords),
  }));

  return {
    skipped: false as const,
    gaps,
    overviews,
    counts: {
      competitors: competitors.length,
      observedCompetitorKeywords: competitorRows.length,
      ourKeywords: ourRows.length,
      gaps: gaps.length,
      missing: gaps.filter((gap) => gap.gapType === 'missing').length,
      underperforming: gaps.filter((gap) => gap.gapType === 'underperforming').length,
    },
    // Said out loud rather than left implicit: past the cap this is a sample, and a "missing"
    // gap could be a keyword we do rank for that fell outside the window.
    truncated: {
      competitorKeywords: competitorRowTotal > competitorRows.length,
      ourKeywords: ourRowTotal > ourRows.length,
      observedCompetitorKeywordTotal: competitorRowTotal,
      ourKeywordTotal: ourRowTotal,
    },
  };
});
