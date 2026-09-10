import 'server-only';
import { type Prisma, prisma } from '@seo/db';
import { round, type ExplainableScore, type ScoreFactor } from '@seo/shared';
import type {
  KeywordClusterRow,
  KeywordHistoryPoint,
  KeywordHistorySource,
  KeywordProfile,
  KeywordSibling,
} from '@/components/keywords/types';

/**
 * Read models that only the Keywords screen needs.
 *
 * They live beside the route rather than in `server/queries` because nothing else asks for
 * them: `getKeywordFacets` already returns the trimmed cluster rows the filter bar uses, and
 * the per-keyword profile joins history that would be wasted work on a list of 200 rows.
 *
 * The profile is resolved on the server from the `?id=` URL param rather than fetched by the
 * Sheet, so an opened keyword survives a refresh and can be linked to.
 */

// ─────────────────────────────────────────────────────────────
// Clusters
// ─────────────────────────────────────────────────────────────

const CLUSTER_LIMIT = 300;

export async function listKeywordClusters(websiteId: string): Promise<KeywordClusterRow[]> {
  const rows = await prisma.keywordCluster.findMany({
    where: { websiteId },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      parentTopic: true,
      intent: true,
      keywordCount: true,
      totalVolume: true,
      totalImpressions: true,
      totalClicks: true,
      avgPosition: true,
      coverageScore: true,
      opportunityScore: true,
      pillarPageId: true,
    },
    orderBy: [{ opportunityScore: { sort: 'desc', nulls: 'last' } }, { keywordCount: 'desc' }, { name: 'asc' }],
    take: CLUSTER_LIMIT,
  });

  // `pillarPageId` carries no Prisma relation on the cluster, so the URLs are resolved in one
  // follow-up lookup rather than N per-row queries.
  const pillarIds = [...new Set(rows.map((row) => row.pillarPageId).filter((id): id is string => id !== null))];
  const pillarUrls = new Map<string, string>();
  if (pillarIds.length > 0) {
    const pages = await prisma.page.findMany({
      where: { id: { in: pillarIds }, websiteId },
      select: { id: true, url: true },
    });
    for (const page of pages) pillarUrls.set(page.id, page.url);
  }

  return rows.map(({ pillarPageId, ...rest }) => ({
    ...rest,
    pillarPageUrl: pillarPageId === null ? null : (pillarUrls.get(pillarPageId) ?? null),
  }));
}

// ─────────────────────────────────────────────────────────────
// One keyword's profile
// ─────────────────────────────────────────────────────────────

const HISTORY_DAYS = 90;
const SIBLING_LIMIT = 12;

const PROFILE_SELECT = {
  id: true,
  websiteId: true,
  keyword: true,
  normalized: true,
  locale: true,
  intent: true,
  funnelStage: true,
  source: true,
  isTracked: true,
  isBranded: true,
  isContentGap: true,
  hasCannibalization: true,
  searchVolume: true,
  volumeSource: true,
  difficulty: true,
  cpc: true,
  currentPosition: true,
  previousPosition: true,
  positionChange: true,
  bestPosition: true,
  rankingUrl: true,
  clicks28d: true,
  impressions28d: true,
  ctr28d: true,
  position28d: true,
  opportunityScore: true,
  opportunityReason: true,
  opportunityFactors: true,
  businessValue: true,
  relevanceScore: true,
  geoPotential: true,
  clusterId: true,
  firstSeenAt: true,
  lastSeenAt: true,
  cluster: {
    select: {
      id: true,
      name: true,
      keywordCount: true,
      avgPosition: true,
      coverageScore: true,
      opportunityScore: true,
    },
  },
  page: { select: { url: true } },
} satisfies Prisma.KeywordSelect;

type ProfileRow = Prisma.KeywordGetPayload<{ select: typeof PROFILE_SELECT }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toScoreFactor(value: unknown): ScoreFactor | null {
  if (!isRecord(value)) return null;
  const { key, label, explanation } = value;
  if (typeof key !== 'string' || typeof label !== 'string' || typeof explanation !== 'string') return null;
  const numeric = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0);
  return {
    key,
    label,
    value: numeric(value.value),
    weight: numeric(value.weight),
    contribution: numeric(value.contribution),
    explanation,
  };
}

/**
 * Rebuild the explainable score from the JSON column.
 *
 * Two writers fill `opportunityFactors`: the keyword processor stores the bare factor array, the
 * keyword agent stores `{ factors, intentSource }`. Both shapes are read; anything else counts as
 * "no breakdown recorded" and the UI says so rather than showing a bare number.
 */
function readOpportunity(row: ProfileRow): ExplainableScore | null {
  if (row.opportunityScore === null) return null;

  const raw: unknown = row.opportunityFactors;
  const list: unknown = Array.isArray(raw) ? raw : isRecord(raw) ? raw.factors : null;
  const factors = Array.isArray(list)
    ? list.map(toScoreFactor).filter((factor): factor is ScoreFactor => factor !== null)
    : [];

  return {
    score: row.opportunityScore,
    factors,
    summary:
      row.opportunityReason ??
      (factors.length > 0
        ? 'Weighted from the factors below.'
        : 'No explanation was stored with this score. Re-run the keyword analysis to regenerate it.'),
  };
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Per-day history: the keyword's own metric rows, falling back to its Search Console query rows. */
async function loadHistory(row: ProfileRow): Promise<{ history: KeywordHistoryPoint[]; source: KeywordHistorySource }> {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000);

  const metrics = await prisma.keywordMetric.findMany({
    where: { keywordId: row.id, date: { gte: since } },
    select: { date: true, clicks: true, impressions: true, ctr: true, position: true },
    orderBy: { date: 'asc' },
  });

  if (metrics.length > 0) {
    return {
      source: 'KEYWORD_METRIC',
      history: metrics.map((metric) => ({
        date: dateKey(metric.date),
        clicks: metric.clicks,
        impressions: metric.impressions,
        ctr: metric.ctr,
        position: metric.position,
      })),
    };
  }

  const gsc = await prisma.gscQueryMetric.findMany({
    where: { websiteId: row.websiteId, query: row.keyword, date: { gte: since } },
    select: { date: true, clicks: true, impressions: true, position: true },
    orderBy: { date: 'asc' },
  });
  if (gsc.length === 0) return { history: [], source: 'NONE' };

  // One query can appear on several URLs on the same day; roll them into one weighted point.
  const byDate = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const metric of gsc) {
    const key = dateKey(metric.date);
    const entry = byDate.get(key) ?? { clicks: 0, impressions: 0, weighted: 0 };
    entry.clicks += metric.clicks;
    entry.impressions += metric.impressions;
    entry.weighted += metric.position * metric.impressions;
    byDate.set(key, entry);
  }

  return {
    source: 'SEARCH_CONSOLE',
    history: [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, entry]) => ({
        date,
        clicks: entry.clicks,
        impressions: entry.impressions,
        ctr: entry.impressions > 0 ? round(entry.clicks / entry.impressions, 5) : null,
        position: entry.impressions > 0 ? round(entry.weighted / entry.impressions, 2) : null,
      })),
  };
}

/** Full profile for the keyword Sheet. Returns null when the id does not belong to this website. */
export async function getKeywordProfile(websiteId: string, keywordId: string): Promise<KeywordProfile | null> {
  const row = await prisma.keyword.findFirst({
    where: { id: keywordId, websiteId },
    select: PROFILE_SELECT,
  });
  if (!row) return null;

  const [{ history, source }, siblings, brief] = await Promise.all([
    loadHistory(row),
    row.clusterId === null
      ? Promise.resolve<KeywordSibling[]>([])
      : prisma.keyword.findMany({
          where: { clusterId: row.clusterId, id: { not: row.id } },
          select: {
            id: true,
            keyword: true,
            currentPosition: true,
            impressions28d: true,
            clicks28d: true,
            opportunityScore: true,
          },
          orderBy: [{ impressions28d: 'desc' }, { keyword: 'asc' }],
          take: SIBLING_LIMIT,
        }),
    prisma.contentBrief.findFirst({
      where: { websiteId, opportunity: { keywordId: row.id } },
      select: { id: true, title: true, status: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    id: row.id,
    keyword: row.keyword,
    normalized: row.normalized,
    locale: row.locale,
    intent: row.intent,
    funnelStage: row.funnelStage,
    source: row.source,
    isTracked: row.isTracked,
    isBranded: row.isBranded,
    isContentGap: row.isContentGap,
    hasCannibalization: row.hasCannibalization,
    searchVolume: row.searchVolume,
    volumeSource: row.volumeSource,
    difficulty: row.difficulty,
    cpc: row.cpc,
    currentPosition: row.currentPosition,
    previousPosition: row.previousPosition,
    positionChange: row.positionChange,
    bestPosition: row.bestPosition,
    rankingUrl: row.rankingUrl,
    clicks28d: row.clicks28d,
    impressions28d: row.impressions28d,
    ctr28d: row.ctr28d,
    position28d: row.position28d,
    businessValue: row.businessValue,
    relevanceScore: row.relevanceScore,
    geoPotential: row.geoPotential,
    pageUrl: row.page?.url ?? null,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    opportunity: readOpportunity(row),
    history,
    historySource: source,
    cluster: row.cluster,
    siblings,
    brief,
  };
}
