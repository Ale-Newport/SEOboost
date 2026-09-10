import 'server-only';
import { prisma } from '@seo/db';
import { NotFoundError, ForbiddenError, lastNDays, previousPeriod, round } from '@seo/shared';
import { GSC_LAG_DAYS, getKeywordCounts, getPerformanceSummary, getRankingDistribution } from './analytics';

/**
 * Everything the site Overview page renders, in one pass.
 *
 * Deliberately a single function with parallel queries rather than per-widget fetches: the
 * overview is the most-visited page in the product and N round-trips would dominate its latency.
 */
export async function getSiteOverview(userId: string, websiteId: string) {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    include: { settings: true, knowledgeBase: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const range = lastNDays(28, GSC_LAG_DAYS);
  const previous = previousPeriod(range);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [
    performance,
    keywordCounts,
    rankingDistribution,
    pageCounts,
    issuesBySeverity,
    topIssues,
    opportunities,
    topActions,
    pendingApprovals,
    latestCrawl,
    latestGeoAudit,
    integrations,
    scoreHistory,
    decliningPages,
    strikingDistanceCount,
    orphanCount,
    linkSuggestionCount,
    recentChanges,
    strategyPlan,
    aiVisibility,
    runningJobs,
  ] = await Promise.all([
    getPerformanceSummary({ websiteId, days: 28, compare: true }),
    getKeywordCounts([websiteId]),
    getRankingDistribution(websiteId),
    prisma.page.groupBy({
      by: ['isIndexable'],
      where: { websiteId, isActive: true },
      _count: { _all: true },
    }),
    prisma.technicalIssue.groupBy({
      by: ['severity'],
      where: { websiteId, status: 'OPEN' },
      _count: { _all: true },
    }),
    prisma.technicalIssue.findMany({
      where: { websiteId, status: 'OPEN' },
      orderBy: [{ severity: 'asc' }, { estimatedImpact: 'desc' }],
      take: 5,
      select: {
        id: true, ruleId: true, title: true, severity: true, category: true, url: true,
        description: true, recommendation: true, autoFixable: true,
      },
    }),
    prisma.contentOpportunity.findMany({
      where: { websiteId, status: 'IDENTIFIED' },
      orderBy: { priorityScore: 'desc' },
      take: 5,
      select: {
        id: true, type: true, title: true, targetKeyword: true, priorityScore: true,
        reasoning: true, estimatedTrafficGain: true,
      },
    }),
    prisma.seoAction.findMany({
      where: { websiteId, status: { in: ['PROPOSED', 'AWAITING_APPROVAL', 'QUEUED'] } },
      orderBy: { priorityScore: 'desc' },
      take: 6,
      select: {
        id: true, type: true, title: true, status: true, risk: true, priorityScore: true,
        reasoning: true, affectedUrls: true, impactScore: true, effortScore: true, confidenceScore: true,
      },
    }),
    prisma.approval.count({ where: { websiteId, status: 'PENDING' } }),
    prisma.crawl.findFirst({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, status: true, pagesCrawled: true, pagesDiscovered: true, pagesFailed: true,
        issuesFound: true, startedAt: true, finishedAt: true, durationMs: true, error: true,
        progressMessage: true, createdAt: true, sitemapUrlCount: true, robotsTxtFound: true,
      },
    }),
    prisma.geoAudit.findFirst({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, overallScore: true, dimensions: true, findings: true, summary: true, createdAt: true, pagesAudited: true },
    }),
    prisma.integration.findMany({
      where: { websiteId },
      select: { provider: true, status: true, lastSyncAt: true, lastError: true, accountEmail: true },
    }),
    prisma.scoreSnapshot.findMany({
      where: { websiteId },
      orderBy: { date: 'asc' },
      take: 90,
      select: {
        date: true, healthScore: true, geoScore: true, aiVisibilityScore: true,
        clicks28d: true, impressions28d: true, avgPosition: true, openIssues: true,
      },
    }),
    prisma.page.count({ where: { websiteId, isActive: true, clicksTrendPct: { lt: -20 }, clicks28d: { gt: 0 } } }),
    prisma.keyword.count({ where: { websiteId, currentPosition: { gte: 8, lte: 20 } } }),
    prisma.page.count({ where: { websiteId, isActive: true, isOrphan: true, isIndexable: true } }),
    prisma.internalLinkSuggestion.count({ where: { websiteId, status: 'PENDING' } }),
    prisma.changeLog.findMany({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { id: true, actor: true, agent: true, changeType: true, summary: true, targetUrl: true, createdAt: true, approved: true },
    }),
    prisma.strategyPlan.findFirst({
      where: { websiteId, isCurrent: true },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, periodLabel: true, situation: true, strategy: true, today: true,
        thisWeek: true, thisMonth: true, biggestProblems: true, biggestOpportunities: true,
        observedResults: true, confidence: true, createdAt: true,
      },
    }),
    getAiVisibilitySnapshot(websiteId),
    prisma.jobRecord.count({ where: { websiteId, status: { in: ['QUEUED', 'RUNNING'] } } }),
  ]);

  const severityCounts = Object.fromEntries(
    issuesBySeverity.map((row) => [row.severity, row._count._all]),
  ) as Record<string, number>;

  const indexablePages = pageCounts.find((p) => p.isIndexable)?._count._all ?? 0;
  const nonIndexablePages = pageCounts.find((p) => !p.isIndexable)?._count._all ?? 0;

  const actionsThisWeek = await prisma.seoAction.count({
    where: { websiteId, status: 'COMPLETED', completedAt: { gte: weekAgo } },
  });

  return {
    website,
    performance,
    keywordCounts,
    rankingDistribution,
    pages: {
      total: indexablePages + nonIndexablePages,
      indexable: indexablePages,
      nonIndexable: nonIndexablePages,
      orphans: orphanCount,
      declining: decliningPages,
    },
    issues: {
      bySeverity: severityCounts,
      total: Object.values(severityCounts).reduce((s, n) => s + n, 0),
      critical: severityCounts.CRITICAL ?? 0,
      top: topIssues,
    },
    opportunities,
    actions: topActions,
    counts: {
      pendingApprovals,
      strikingDistance: strikingDistanceCount,
      linkSuggestions: linkSuggestionCount,
      actionsThisWeek,
      runningJobs,
    },
    latestCrawl,
    geoAudit: latestGeoAudit,
    integrations,
    scoreHistory: scoreHistory.map((snapshot) => ({
      date: snapshot.date.toISOString().slice(0, 10),
      health: snapshot.healthScore,
      geo: snapshot.geoScore,
      aiVisibility: snapshot.aiVisibilityScore,
      clicks: snapshot.clicks28d,
      impressions: snapshot.impressions28d,
      position: snapshot.avgPosition,
      openIssues: snapshot.openIssues,
    })),
    recentChanges,
    strategyPlan,
    aiVisibility,
    range: { from: range.start, to: range.end, previousFrom: previous.start, previousTo: previous.end },
  };
}

export type SiteOverview = Awaited<ReturnType<typeof getSiteOverview>>;

/**
 * AI-visibility roll-up.
 * These are OBSERVATIONAL metrics: they describe what assistants said when we asked, not a
 * ranking guarantee. The UI labels them as such.
 */
async function getAiVisibilitySnapshot(websiteId: string) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [promptCount, runs] = await Promise.all([
    prisma.aiVisibilityPrompt.count({ where: { websiteId, isActive: true } }),
    prisma.aiVisibilityRun.findMany({
      where: { websiteId, runAt: { gte: since } },
      select: { brandMentioned: true, ourUrlsCited: true, competitorsMentioned: true, provider: true, runAt: true },
    }),
  ]);

  if (runs.length === 0) {
    return {
      promptCount,
      runCount: 0,
      mentionRate: null,
      citationRate: null,
      competitorShare: [] as Array<{ name: string; share: number }>,
      providers: [] as string[],
      lastRunAt: null as Date | null,
    };
  }

  const mentions = runs.filter((r) => r.brandMentioned).length;
  const citations = runs.filter((r) => r.ourUrlsCited.length > 0).length;

  const competitorCounts = new Map<string, number>();
  for (const run of runs) {
    for (const competitor of run.competitorsMentioned) {
      competitorCounts.set(competitor, (competitorCounts.get(competitor) ?? 0) + 1);
    }
  }
  const totalCompetitorMentions = [...competitorCounts.values()].reduce((s, n) => s + n, 0) + mentions;

  return {
    promptCount,
    runCount: runs.length,
    mentionRate: round(mentions / runs.length, 3),
    citationRate: round(citations / runs.length, 3),
    competitorShare: [...competitorCounts.entries()]
      .map(([name, count]) => ({ name, share: totalCompetitorMentions > 0 ? round(count / totalCompetitorMentions, 3) : 0 }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 8),
    providers: [...new Set(runs.map((r) => r.provider))],
    lastRunAt: runs.reduce<Date | null>((latest, r) => (!latest || r.runAt > latest ? r.runAt : latest), null),
  };
}
