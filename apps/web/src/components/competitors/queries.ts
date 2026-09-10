import 'server-only';
import { prisma } from '@seo/db';
import { ForbiddenError, NotFoundError, isConfigured } from '@seo/shared';
import {
  type CompetitorKeywordRow,
  type CompetitorOverview,
  type KeywordGap,
  type OurKeywordRow,
  analyseKeywordGaps,
  buildCompetitorOverview,
} from '@seo/seo-engine';

/**
 * Read model for the Competitors screen.
 *
 * It lives beside the view rather than in `server/queries` because nothing else reads it, and
 * it mirrors `GET /api/websites/[id]/competitors` + `…/competitors/gaps` exactly — the page is
 * a server component, so it calls the read model directly instead of fetching its own API.
 *
 * The two halves of the screen come from different places on purpose:
 *  - the per-competitor counters are what the competitor analysis job *recorded* (they can be
 *    stale, and are absent entirely until it has run once), and
 *  - the gap table and win/loss split are computed live from the observed rows, so they can
 *    never disagree with what is in the database right now.
 */

/** Keep the live gap list to something a human can act on; the engine ranks before it truncates. */
const MAX_GAPS = 300;

export interface CompetitorRow {
  id: string;
  domain: string;
  name: string | null;
  isManual: boolean;
  isActive: boolean;
  notes: string | null;
  /** Counters written by the analysis job. Zero *and* `lastAnalysedAt === null` means "never run". */
  sharedKeywords: number;
  gapKeywords: number;
  estimatedKeywords: number;
  serpOverlapPct: number;
  avgPosition: number | null;
  topicalStrengths: string[];
  contentVelocity: number | null;
  lastAnalysedAt: Date | null;
  createdAt: Date;
  /** Rows observed for this competitor right now — the evidence behind the counters. */
  observedKeywords: number;
  observedPages: number;
  /** Live recomputation from the observed rows; null when nothing has been observed. */
  live: CompetitorOverview | null;
}

export type GapAnalysis =
  | {
      available: false;
      /** Why there is no gap table — never an empty list, which would read as "no gaps". */
      reason: string;
      remedy: string;
    }
  | {
      available: true;
      gaps: KeywordGap[];
      counts: {
        gaps: number;
        missing: number;
        underperforming: number;
        observedCompetitorKeywords: number;
        ourKeywords: number;
      };
    };

export interface CompetitorsData {
  website: { id: string; name: string; domain: string; protocol: string };
  competitors: CompetitorRow[];
  totals: {
    tracked: number;
    analysed: number;
    sharedKeywords: number;
    gapKeywords: number;
  };
  /** A SERP provider is what collects competitor rankings; without one nothing can be observed. */
  serpConfigured: boolean;
  gapAnalysis: GapAnalysis;
}

/**
 * Everything the Competitors screen needs, in one pass.
 * Throws `NotFoundError`/`ForbiddenError` so the page can render `notFound()`.
 */
export async function getCompetitorsData(userId: string, websiteId: string): Promise<CompetitorsData> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, userId: true, name: true, domain: true, protocol: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const competitors = await prisma.competitor.findMany({
    where: { websiteId },
    orderBy: [{ isActive: 'desc' }, { serpOverlapPct: 'desc' }, { domain: 'asc' }],
    include: { _count: { select: { keywords: true, pages: true } } },
  });

  const serpConfigured = isConfigured.anySerp();
  const activeIds = competitors.filter((row) => row.isActive).map((row) => row.id);

  const [competitorRows, ourRows] = await Promise.all([
    activeIds.length
      ? prisma.competitorKeyword.findMany({
          where: { competitorId: { in: activeIds } },
          select: { competitorId: true, keyword: true, position: true, url: true, estimatedVolume: true },
          orderBy: { position: 'asc' },
          take: 20_000,
        })
      : Promise.resolve([]),
    prisma.keyword.findMany({
      where: { websiteId },
      select: { keyword: true, currentPosition: true, impressions28d: true, rankingUrl: true },
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

  const liveByDomain = new Map<string, CompetitorOverview>();
  if (observed.length > 0) {
    for (const id of activeIds) {
      const domain = domainById.get(id);
      if (!domain) continue;
      liveByDomain.set(domain, buildCompetitorOverview(domain, ours, observed));
    }
  }

  const rows: CompetitorRow[] = competitors.map(({ _count, ...row }) => ({
    id: row.id,
    domain: row.domain,
    name: row.name,
    isManual: row.isManual,
    isActive: row.isActive,
    notes: row.notes,
    sharedKeywords: row.sharedKeywords,
    gapKeywords: row.gapKeywords,
    estimatedKeywords: row.estimatedKeywords,
    serpOverlapPct: row.serpOverlapPct,
    avgPosition: row.avgPosition,
    topicalStrengths: row.topicalStrengths,
    contentVelocity: row.contentVelocity,
    lastAnalysedAt: row.lastAnalysedAt,
    createdAt: row.createdAt,
    observedKeywords: _count.keywords,
    observedPages: _count.pages,
    live: liveByDomain.get(row.domain) ?? null,
  }));

  return {
    website: {
      id: website.id,
      name: website.name,
      domain: website.domain,
      protocol: website.protocol,
    },
    competitors: rows,
    totals: {
      tracked: rows.length,
      analysed: rows.filter((row) => row.lastAnalysedAt !== null).length,
      sharedKeywords: rows.reduce((total, row) => total + row.sharedKeywords, 0),
      gapKeywords: rows.reduce((total, row) => total + row.gapKeywords, 0),
    },
    serpConfigured,
    gapAnalysis: buildGapAnalysis({ competitors: rows, observed, ours, serpConfigured }),
  };
}

function buildGapAnalysis(input: {
  competitors: CompetitorRow[];
  observed: CompetitorKeywordRow[];
  ours: OurKeywordRow[];
  serpConfigured: boolean;
}): GapAnalysis {
  const active = input.competitors.filter((row) => row.isActive);

  if (active.length === 0) {
    return {
      available: false,
      reason: 'No active competitors are being tracked for this site.',
      remedy: 'Add a competitor domain above, then run the competitor analysis.',
    };
  }

  if (input.observed.length === 0) {
    const analysed = active.filter((row) => row.lastAnalysedAt !== null).length;
    return {
      available: false,
      reason:
        analysed > 0
          ? 'The competitor analysis has run but observed no competitor rankings yet.'
          : 'The competitor analysis has not run yet, so no competitor rankings have been observed.',
      remedy: input.serpConfigured
        ? 'Run the competitor analysis for this site — it collects the SERP rankings the gap analysis compares against.'
        : 'Configure a SERP provider (DATAFORSEO_LOGIN, SERPAPI_KEY or SERPER_API_KEY) so competitor rankings can be collected.',
    };
  }

  const gaps = analyseKeywordGaps(input.ours, input.observed, { maxResults: MAX_GAPS });

  return {
    available: true,
    gaps,
    counts: {
      gaps: gaps.length,
      missing: gaps.filter((gap) => gap.gapType === 'missing').length,
      underperforming: gaps.filter((gap) => gap.gapType === 'underperforming').length,
      observedCompetitorKeywords: input.observed.length,
      ourKeywords: input.ours.length,
    },
  };
}
