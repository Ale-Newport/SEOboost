import 'server-only';
import {
  type AutonomyLevel,
  type CmsType,
  type IntegrationProvider,
  type IntegrationStatus,
  type Prisma,
  type WebsiteStatus,
  prisma,
} from '@seo/db';
import { lastNDays, percentChange, previousPeriod, round } from '@seo/shared';
import { GSC_LAG_DAYS } from './analytics';

/**
 * Website read models shared by `/api/websites` and the site list/overview screens.
 *
 * Every rolled-up figure is a count or a sum over stored rows. A site with no crawl and no
 * connected Search Console reports zeros — the UI turns that into an onboarding prompt rather
 * than a chart, and nothing here estimates a number that was never measured.
 */

export interface WebsiteRollup {
  pages: number;
  indexablePages: number;
  orphanPages: number;
  keywords: number;
  trackedKeywords: number;
  openIssues: number;
  criticalIssues: number;
  opportunities: number;
  pendingApprovals: number;
  runningJobs: number;
  clicks28d: number;
  impressions28d: number;
  clicksPrev28d: number;
  impressionsPrev28d: number;
  /** Null when the previous window had no clicks — a percentage against zero is meaningless. */
  clicksChangePct: number | null;
  /** Impression-weighted, so a quiet day cannot drag the average. Null with no impressions. */
  avgPosition: number | null;
}

export interface WebsiteSummary {
  id: string;
  name: string;
  domain: string;
  protocol: string;
  url: string;
  status: WebsiteStatus;
  cmsType: CmsType;
  isDemo: boolean;
  faviconUrl: string | null;
  primaryLanguage: string;
  targetCountry: string;
  healthScore: number | null;
  geoScore: number | null;
  aiVisibilityScore: number | null;
  contentScore: number | null;
  autonomyLevel: AutonomyLevel;
  lastCrawlAt: Date | null;
  lastAnalysisAt: Date | null;
  createdAt: Date;
  metrics: WebsiteRollup;
}

const EMPTY_ROLLUP: WebsiteRollup = {
  pages: 0,
  indexablePages: 0,
  orphanPages: 0,
  keywords: 0,
  trackedKeywords: 0,
  openIssues: 0,
  criticalIssues: 0,
  opportunities: 0,
  pendingApprovals: 0,
  runningJobs: 0,
  clicks28d: 0,
  impressions28d: 0,
  clicksPrev28d: 0,
  impressionsPrev28d: 0,
  clicksChangePct: null,
  avgPosition: null,
};

/** The ids a user owns — the guard every portfolio-wide query starts from. */
export async function websiteIdsForUser(
  userId: string,
  options: { includeArchived?: boolean } = {},
): Promise<string[]> {
  const rows = await prisma.website.findMany({
    where: {
      userId,
      ...(options.includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((row) => row.id);
}

/** Site-level rollups for a set of websites, keyed by website id. */
export async function getWebsiteRollups(websiteIds: string[]): Promise<Map<string, WebsiteRollup>> {
  const rollups = new Map<string, WebsiteRollup>();
  if (websiteIds.length === 0) return rollups;

  const range = lastNDays(28, GSC_LAG_DAYS);
  const previous = previousPeriod(range);

  const where = { websiteId: { in: websiteIds } };

  const [
    pages,
    indexablePages,
    orphanPages,
    keywords,
    trackedKeywords,
    openIssues,
    criticalIssues,
    opportunities,
    pendingApprovals,
    runningJobs,
    current,
    prior,
  ] = await Promise.all([
    prisma.page.groupBy({
      by: ['websiteId'],
      where: { ...where, isActive: true },
      _count: { _all: true },
    }),
    prisma.page.groupBy({
      by: ['websiteId'],
      where: { ...where, isActive: true, isIndexable: true },
      _count: { _all: true },
    }),
    prisma.page.groupBy({
      by: ['websiteId'],
      where: { ...where, isActive: true, isOrphan: true },
      _count: { _all: true },
    }),
    prisma.keyword.groupBy({ by: ['websiteId'], where, _count: { _all: true } }),
    prisma.keyword.groupBy({
      by: ['websiteId'],
      where: { ...where, isTracked: true },
      _count: { _all: true },
    }),
    prisma.technicalIssue.groupBy({
      by: ['websiteId'],
      where: { ...where, status: 'OPEN' },
      _count: { _all: true },
    }),
    prisma.technicalIssue.groupBy({
      by: ['websiteId'],
      where: { ...where, status: 'OPEN', severity: 'CRITICAL' },
      _count: { _all: true },
    }),
    prisma.contentOpportunity.groupBy({
      by: ['websiteId'],
      where: { ...where, status: 'IDENTIFIED' },
      _count: { _all: true },
    }),
    prisma.approval.groupBy({
      by: ['websiteId'],
      where: { ...where, status: 'PENDING' },
      _count: { _all: true },
    }),
    prisma.jobRecord.groupBy({
      by: ['websiteId'],
      where: { ...where, status: { in: ['QUEUED', 'RUNNING'] } },
      _count: { _all: true },
    }),
    prisma.searchConsoleDaily.findMany({
      where: {
        ...where,
        source: 'gsc',
        country: null,
        device: null,
        date: { gte: range.start, lte: range.end },
      },
      select: { websiteId: true, clicks: true, impressions: true, position: true },
    }),
    prisma.searchConsoleDaily.findMany({
      where: {
        ...where,
        source: 'gsc',
        country: null,
        device: null,
        date: { gte: previous.start, lte: previous.end },
      },
      select: { websiteId: true, clicks: true, impressions: true },
    }),
  ]);

  // Prisma's groupBy return type is a per-model `PickEnumerable`; this is the shape they all
  // share once `by: ['websiteId']` and `_count: { _all: true }` are fixed.
  const countMap = (rows: ReadonlyArray<{ websiteId: string | null; _count: { _all: number } }>) =>
    new Map(rows.flatMap((row) => (row.websiteId ? [[row.websiteId, row._count._all] as const] : [])));

  const pageMap = countMap(pages);
  const indexableMap = countMap(indexablePages);
  const orphanMap = countMap(orphanPages);
  const keywordMap = countMap(keywords);
  const trackedMap = countMap(trackedKeywords);
  const issueMap = countMap(openIssues);
  const criticalMap = countMap(criticalIssues);
  const opportunityMap = countMap(opportunities);
  const approvalMap = countMap(pendingApprovals);
  const jobMap = countMap(runningJobs);

  const traffic = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (const row of current) {
    const entry = traffic.get(row.websiteId) ?? { clicks: 0, impressions: 0, weighted: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    traffic.set(row.websiteId, entry);
  }

  const priorTraffic = new Map<string, { clicks: number; impressions: number }>();
  for (const row of prior) {
    const entry = priorTraffic.get(row.websiteId) ?? { clicks: 0, impressions: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    priorTraffic.set(row.websiteId, entry);
  }

  for (const websiteId of websiteIds) {
    const now = traffic.get(websiteId);
    const before = priorTraffic.get(websiteId);
    rollups.set(websiteId, {
      pages: pageMap.get(websiteId) ?? 0,
      indexablePages: indexableMap.get(websiteId) ?? 0,
      orphanPages: orphanMap.get(websiteId) ?? 0,
      keywords: keywordMap.get(websiteId) ?? 0,
      trackedKeywords: trackedMap.get(websiteId) ?? 0,
      openIssues: issueMap.get(websiteId) ?? 0,
      criticalIssues: criticalMap.get(websiteId) ?? 0,
      opportunities: opportunityMap.get(websiteId) ?? 0,
      pendingApprovals: approvalMap.get(websiteId) ?? 0,
      runningJobs: jobMap.get(websiteId) ?? 0,
      clicks28d: now?.clicks ?? 0,
      impressions28d: now?.impressions ?? 0,
      clicksPrev28d: before?.clicks ?? 0,
      impressionsPrev28d: before?.impressions ?? 0,
      clicksChangePct: percentChange(before?.clicks ?? 0, now?.clicks ?? 0),
      avgPosition: now && now.impressions > 0 ? round(now.weighted / now.impressions, 1) : null,
    });
  }

  return rollups;
}

/** The site list: every website a user owns, with its rolled-up metrics. */
export async function listWebsiteSummaries(
  userId: string,
  options: { includeArchived?: boolean } = {},
): Promise<WebsiteSummary[]> {
  const websites = await prisma.website.findMany({
    where: {
      userId,
      ...(options.includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
    },
    include: { settings: { select: { autonomyLevel: true } } },
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  });

  const rollups = await getWebsiteRollups(websites.map((w) => w.id));

  return websites.map((website) => ({
    id: website.id,
    name: website.name,
    domain: website.domain,
    protocol: website.protocol,
    url: `${website.protocol}://${website.domain}`,
    status: website.status,
    cmsType: website.cmsType,
    isDemo: website.isDemo,
    faviconUrl: website.faviconUrl,
    primaryLanguage: website.primaryLanguage,
    targetCountry: website.targetCountry,
    healthScore: website.healthScore,
    geoScore: website.geoScore,
    aiVisibilityScore: website.aiVisibilityScore,
    contentScore: website.contentScore,
    autonomyLevel: website.settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
    lastCrawlAt: website.lastCrawlAt,
    lastAnalysisAt: website.lastAnalysisAt,
    createdAt: website.createdAt,
    metrics: rollups.get(website.id) ?? EMPTY_ROLLUP,
  }));
}

/** Non-secret integration state. Credentials never leave the server, so they are not selected. */
export interface WebsiteIntegrationStatus {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  accountEmail: string | null;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  expiresAt: Date | null;
}

export interface WebsiteDetail extends WebsiteSummary {
  description: string | null;
  businessCategory: string | null;
  targetAudience: string | null;
  conversionGoal: string | null;
  brandName: string | null;
  targetLocales: string[];
  updatedAt: Date;
  integrations: WebsiteIntegrationStatus[];
  latestCrawl: {
    id: string;
    status: string;
    pagesCrawled: number;
    pagesDiscovered: number;
    issuesFound: number;
    startedAt: Date | null;
    finishedAt: Date | null;
    error: string | null;
  } | null;
  competitorCount: number;
  hasKnowledgeBase: boolean;
  brandFactCount: number;
}

/** Everything the site overview header needs, in one round trip. */
export async function getWebsiteDetail(websiteId: string): Promise<WebsiteDetail | null> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    include: { settings: { select: { autonomyLevel: true } } },
  });
  if (!website) return null;

  const [rollups, integrations, latestCrawl, competitorCount, knowledgeBase, brandFactCount] =
    await Promise.all([
      getWebsiteRollups([websiteId]),
      prisma.integration.findMany({
        where: { websiteId },
        select: {
          provider: true,
          status: true,
          accountEmail: true,
          lastSyncAt: true,
          lastSyncStatus: true,
          lastError: true,
          expiresAt: true,
        },
        orderBy: { provider: 'asc' },
      }),
      prisma.crawl.findFirst({
        where: { websiteId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          pagesCrawled: true,
          pagesDiscovered: true,
          issuesFound: true,
          startedAt: true,
          finishedAt: true,
          error: true,
        },
      }),
      prisma.competitor.count({ where: { websiteId, isActive: true } }),
      prisma.knowledgeBase.findUnique({ where: { websiteId }, select: { id: true } }),
      prisma.brandFact.count({ where: { websiteId } }),
    ]);

  return {
    id: website.id,
    name: website.name,
    domain: website.domain,
    protocol: website.protocol,
    url: `${website.protocol}://${website.domain}`,
    status: website.status,
    cmsType: website.cmsType,
    isDemo: website.isDemo,
    faviconUrl: website.faviconUrl,
    primaryLanguage: website.primaryLanguage,
    targetCountry: website.targetCountry,
    healthScore: website.healthScore,
    geoScore: website.geoScore,
    aiVisibilityScore: website.aiVisibilityScore,
    contentScore: website.contentScore,
    autonomyLevel: website.settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
    lastCrawlAt: website.lastCrawlAt,
    lastAnalysisAt: website.lastAnalysisAt,
    createdAt: website.createdAt,
    metrics: rollups.get(websiteId) ?? EMPTY_ROLLUP,
    description: website.description,
    businessCategory: website.businessCategory,
    targetAudience: website.targetAudience,
    conversionGoal: website.conversionGoal,
    brandName: website.brandName,
    targetLocales: website.targetLocales,
    updatedAt: website.updatedAt,
    integrations,
    latestCrawl,
    competitorCount,
    hasKnowledgeBase: knowledgeBase !== null,
    brandFactCount,
  };
}

export interface CrawlHistoryItem {
  id: string;
  status: string;
  trigger: string;
  maxPages: number;
  maxDepth: number;
  renderJs: boolean;
  pagesDiscovered: number;
  pagesCrawled: number;
  pagesFailed: number;
  issuesFound: number;
  sitemapUrlCount: number;
  robotsTxtFound: boolean;
  /**
   * 0-100 against pages discovered so far — the only denominator that exists mid-crawl.
   * Null while nothing has been discovered yet, so the UI shows a spinner rather than "0%".
   */
  progressPct: number | null;
  progressMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  error: string | null;
  createdAt: Date;
}

const CRAWL_HISTORY_SELECT = {
  id: true,
  status: true,
  trigger: true,
  maxPages: true,
  maxDepth: true,
  renderJs: true,
  pagesDiscovered: true,
  pagesCrawled: true,
  pagesFailed: true,
  issuesFound: true,
  sitemapUrlCount: true,
  robotsTxtFound: true,
  progressMessage: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  error: true,
  createdAt: true,
} satisfies Prisma.CrawlSelect;

/** Crawl history with derived progress. Terminal crawls report 100% only when they completed. */
export async function listCrawls(
  websiteId: string,
  options: { page?: number; pageSize?: number } = {},
): Promise<{ items: CrawlHistoryItem[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(Math.max(1, options.pageSize ?? 20), 100);

  const [rows, total] = await Promise.all([
    prisma.crawl.findMany({
      where: { websiteId },
      // Explicit select: `Crawl` also carries `robotsTxtBody` and the full `sitemapUrls`
      // array, which can each be hundreds of kilobytes. A page of 100 crawls would drag
      // megabytes out of Postgres for columns this list never renders.
      select: CRAWL_HISTORY_SELECT,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.crawl.count({ where: { websiteId } }),
  ]);

  const items = rows.map<CrawlHistoryItem>((row) => {
    const denominator = row.pagesDiscovered > 0 ? row.pagesDiscovered : null;
    const done = row.pagesCrawled + row.pagesFailed;
    const progressPct =
      row.status === 'COMPLETED'
        ? 100
        : denominator === null
          ? null
          : round(Math.min(100, (done / denominator) * 100), 1);

    return {
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      maxPages: row.maxPages,
      maxDepth: row.maxDepth,
      renderJs: row.renderJs,
      pagesDiscovered: row.pagesDiscovered,
      pagesCrawled: row.pagesCrawled,
      pagesFailed: row.pagesFailed,
      issuesFound: row.issuesFound,
      sitemapUrlCount: row.sitemapUrlCount,
      robotsTxtFound: row.robotsTxtFound,
      progressPct,
      progressMessage: row.progressMessage,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      durationMs: row.durationMs,
      error: row.error,
      createdAt: row.createdAt,
    };
  });

  return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
