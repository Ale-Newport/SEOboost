import 'server-only';
import { prisma } from '@seo/db';
import { lastNDays, previousPeriod, round } from '@seo/shared';
import { analysePortfolio, rankSitesByNeed, type PortfolioSiteInput } from '@seo/seo-engine';
import { GSC_LAG_DAYS, getKeywordCounts, getPerformanceSummary } from './analytics';

/**
 * The portfolio dashboard read model.
 *
 * Every number here is derived from stored data. With no integrations connected the traffic
 * figures are zero and the UI says so — nothing is estimated or filled in.
 */
export async function getDashboardData(userId: string) {
  const websites = await prisma.website.findMany({
    where: { userId, status: { not: 'ARCHIVED' } },
    include: { settings: true },
    orderBy: { createdAt: 'asc' },
  });
  const websiteIds = websites.map((w) => w.id);

  if (websiteIds.length === 0) {
    return {
      websites: [],
      portfolio: null,
      performance: null,
      keywordCounts: { top3: 0, top10: 0, top100: 0, total: 0, tracked: 0 },
      counts: {
        indexedPages: 0, openIssues: 0, criticalIssues: 0, opportunities: 0,
        decliningPages: 0, pendingApprovals: 0, actionsThisWeek: 0, runningJobs: 0,
      },
      insights: [],
      siteRanking: [],
      recentActions: [],
      pendingApprovals: [],
      isEmpty: true,
    };
  }

  const range = lastNDays(28, GSC_LAG_DAYS);
  const previous = previousPeriod(range);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [
    performance,
    keywordCounts,
    indexedPages,
    openIssues,
    criticalIssues,
    opportunities,
    decliningPages,
    pendingApprovals,
    actionsThisWeek,
    runningJobs,
    recentActions,
    approvalRows,
    perSiteMetrics,
    perSitePrevMetrics,
    perSiteIssues,
    perSiteCriticalIssues,
    perSiteOpportunities,
    perSiteApprovals,
    clusters,
    topKeywords,
  ] = await Promise.all([
    getPerformanceSummary({ websiteIds, days: 28, compare: true }),
    getKeywordCounts(websiteIds),
    prisma.page.count({ where: { websiteId: { in: websiteIds }, isActive: true, isIndexable: true } }),
    prisma.technicalIssue.count({ where: { websiteId: { in: websiteIds }, status: 'OPEN' } }),
    prisma.technicalIssue.count({ where: { websiteId: { in: websiteIds }, status: 'OPEN', severity: 'CRITICAL' } }),
    prisma.contentOpportunity.count({ where: { websiteId: { in: websiteIds }, status: 'IDENTIFIED' } }),
    prisma.page.count({ where: { websiteId: { in: websiteIds }, isActive: true, clicksTrendPct: { lt: -20 } } }),
    prisma.approval.count({ where: { websiteId: { in: websiteIds }, status: 'PENDING' } }),
    prisma.seoAction.count({
      where: { websiteId: { in: websiteIds }, status: 'COMPLETED', completedAt: { gte: weekAgo } },
    }),
    prisma.jobRecord.count({ where: { websiteId: { in: websiteIds }, status: { in: ['QUEUED', 'RUNNING'] } } }),
    prisma.seoAction.findMany({
      where: { websiteId: { in: websiteIds } },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true, websiteId: true, type: true, title: true, status: true, priorityScore: true,
        risk: true, updatedAt: true, affectedUrls: true,
        website: { select: { name: true, domain: true } },
      },
    }),
    prisma.approval.findMany({
      where: { websiteId: { in: websiteIds }, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: {
        id: true, websiteId: true, kind: true, title: true, risk: true, createdAt: true,
        website: { select: { name: true } },
      },
    }),
    prisma.searchConsoleDaily.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: websiteIds }, date: { gte: range.start, lte: range.end }, source: 'gsc', country: null, device: null },
      _sum: { clicks: true, impressions: true },
      _avg: { position: true },
    }),
    prisma.searchConsoleDaily.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: websiteIds }, date: { gte: previous.start, lte: previous.end }, source: 'gsc', country: null, device: null },
      _sum: { clicks: true, impressions: true },
    }),
    prisma.technicalIssue.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: websiteIds }, status: 'OPEN' },
      _count: { _all: true },
    }),
    prisma.technicalIssue.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: websiteIds }, status: 'OPEN', severity: 'CRITICAL' },
      _count: { _all: true },
    }),
    prisma.contentOpportunity.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: websiteIds }, status: 'IDENTIFIED' },
      _count: { _all: true },
      _max: { priorityScore: true },
    }),
    prisma.approval.groupBy({
      by: ['websiteId'],
      where: { websiteId: { in: websiteIds }, status: 'PENDING' },
      _count: { _all: true },
    }),
    prisma.keywordCluster.findMany({
      where: { websiteId: { in: websiteIds } },
      select: { websiteId: true, name: true },
      orderBy: { totalImpressions: 'desc' },
      take: 200,
    }),
    prisma.keyword.findMany({
      where: { websiteId: { in: websiteIds }, impressions28d: { gt: 0 } },
      select: { websiteId: true, keyword: true },
      orderBy: { impressions28d: 'desc' },
      take: 400,
    }),
  ]);

  const byId = <T extends { websiteId: string }>(rows: T[]) => new Map(rows.map((r) => [r.websiteId, r]));
  const metricsMap = byId(perSiteMetrics);
  const prevMetricsMap = byId(perSitePrevMetrics);
  const issuesMap = byId(perSiteIssues);
  const criticalMap = byId(perSiteCriticalIssues);
  const opportunityMap = byId(perSiteOpportunities);
  const approvalMap = byId(perSiteApprovals);

  const groupStrings = <T extends { websiteId: string }>(rows: T[], pick: (row: T) => string) => {
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const list = map.get(row.websiteId) ?? [];
      if (list.length < 40) list.push(pick(row));
      map.set(row.websiteId, list);
    }
    return map;
  };
  const clusterMap = groupStrings(clusters, (c) => c.name);
  const keywordMap = groupStrings(topKeywords, (k) => k.keyword);

  const portfolioInput: PortfolioSiteInput[] = websites.map((website) => {
    const metrics = metricsMap.get(website.id);
    const prevMetrics = prevMetricsMap.get(website.id);
    return {
      websiteId: website.id,
      name: website.name,
      domain: website.domain,
      healthScore: website.healthScore,
      geoScore: website.geoScore,
      aiVisibilityScore: website.aiVisibilityScore,
      clicks28d: metrics?._sum.clicks ?? 0,
      clicksPrev28d: prevMetrics?._sum.clicks ?? 0,
      impressions28d: metrics?._sum.impressions ?? 0,
      impressionsPrev28d: prevMetrics?._sum.impressions ?? 0,
      avgPosition: metrics?._avg.position ?? null,
      openCriticalIssues: criticalMap.get(website.id)?._count._all ?? 0,
      openIssues: issuesMap.get(website.id)?._count._all ?? 0,
      opportunityCount: opportunityMap.get(website.id)?._count._all ?? 0,
      topOpportunityScore: opportunityMap.get(website.id)?._max.priorityScore ?? 0,
      pendingApprovals: approvalMap.get(website.id)?._count._all ?? 0,
      topKeywords: keywordMap.get(website.id) ?? [],
      topicNames: clusterMap.get(website.id) ?? [],
      lastCrawlAt: website.lastCrawlAt,
      lastAnalysisAt: website.lastAnalysisAt,
    };
  });

  const portfolio = analysePortfolio(portfolioInput);

  return {
    websites: portfolioInput.map((site) => {
      const website = websites.find((w) => w.id === site.websiteId)!;
      return {
        ...site,
        status: website.status,
        protocol: website.protocol,
        isDemo: website.isDemo,
        autonomyLevel: website.settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
        clicksChangePct:
          site.clicksPrev28d > 0
            ? round(((site.clicks28d - site.clicksPrev28d) / site.clicksPrev28d) * 100, 1)
            : null,
      };
    }),
    portfolio: portfolio.totals,
    performance,
    keywordCounts,
    counts: {
      indexedPages,
      openIssues,
      criticalIssues,
      opportunities,
      decliningPages,
      pendingApprovals,
      actionsThisWeek,
      runningJobs,
    },
    insights: portfolio.insights,
    siteRanking: rankSitesByNeed(portfolioInput),
    recentActions,
    pendingApprovals: approvalRows,
    isEmpty: false,
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboardData>>;
