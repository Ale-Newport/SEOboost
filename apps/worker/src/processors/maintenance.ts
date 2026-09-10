/**
 * Housekeeping: reports, digests and retention.
 *
 * Reports are assembled from rows this platform actually recorded — Search Console totals,
 * issue transitions, executed actions and their measured experiments. There is no "estimated
 * traffic" or narrative filler: when a period has no data, the report says so and the number
 * is absent rather than invented.
 *
 * Retention deletes in bounded batches and never touches live data: the newest completed crawl
 * of every site is always kept, because that is the crawl the audit and every score read from.
 */

import {
  ActionStatus,
  ApprovalStatus,
  type ExperimentOutcome,
  IssueStatus,
  NotificationSeverity,
  type Prisma,
  WebsiteStatus,
  json,
  prisma,
} from '@seo/db';
import { cleanupOldJobs, type JobHandler } from '@seo/queue';
import {
  addDays,
  clamp,
  createLogger,
  errorMessage,
  formatDateKey,
  lastNDays,
  percentChange,
  previousPeriod,
  round,
  toUtcDate,
  truncate,
  type DateRange,
} from '@seo/shared';
import {
  analysePortfolio,
  compareQueries,
  rankSitesByNeed,
  summariseActionOutcomes,
  type ExperimentOutcomeValue,
  type PortfolioSiteInput,
} from '@seo/seo-engine';
import { loadQueryAggregates, loadSiteTotals } from '../lib/gsc';
import { skip } from '../lib/result';

const log = createLogger('worker:maintenance');

/** Days each report type looks back when the payload gives no explicit period. */
const PERIOD_DAYS: Record<string, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  portfolio: 30,
  custom: 30,
};

/** Retention floor and ceiling. A bad payload cannot wipe the history. */
const MIN_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 730;
const DEFAULT_RETENTION_DAYS = 90;

/** Rows deleted per statement, and the maximum number of statements per target. */
const DELETE_BATCH = 1_000;
const MAX_DELETE_BATCHES = 100;

// ─────────────────────────────────────────────────────────────
// reports.generate
// ─────────────────────────────────────────────────────────────

export interface ReportResult {
  status: 'completed';
  reportId: string;
  type: string;
  scope: 'website' | 'portfolio';
  periodStart: string;
  periodEnd: string;
  highlights: number;
}

export const reportsGenerate: JobHandler<'reports.generate'> = async ({ payload, ctx }) => {
  const days = PERIOD_DAYS[payload.type] ?? 30;
  const period: DateRange =
    payload.periodStart && payload.periodEnd
      ? { start: toUtcDate(payload.periodStart), end: toUtcDate(payload.periodEnd) }
      : lastNDays(days, 3);
  const previous = previousPeriod(period);

  await ctx.updateProgress(10, 'Collecting the period');

  if (!payload.websiteId || payload.type === 'portfolio') {
    return buildPortfolioReport(payload.userId ?? null, payload.type, period, ctx.updateProgress);
  }

  const website = await prisma.website.findUnique({
    where: { id: payload.websiteId },
    select: { id: true, name: true, domain: true, healthScore: true, geoScore: true, aiVisibilityScore: true, contentScore: true },
  });
  if (!website) return skip(`Website ${payload.websiteId} no longer exists.`);

  const [totals, previousTotals] = await Promise.all([
    loadSiteTotals(website.id, period),
    loadSiteTotals(website.id, previous),
  ]);

  await ctx.updateProgress(30, 'Comparing queries');
  const [currentQueries, previousQueries] = await Promise.all([
    loadQueryAggregates(website.id, period, { limit: 2_000 }),
    loadQueryAggregates(website.id, previous, { limit: 2_000 }),
  ]);
  const movement = compareQueries({ current: currentQueries, previous: previousQueries });

  await ctx.updateProgress(50, 'Reading issues and actions');
  const [issuesOpened, issuesResolved, openBySeverity, actions, experiments, topPages, publishedDrafts] =
    await Promise.all([
      prisma.technicalIssue.count({
        where: { websiteId: website.id, discoveredAt: { gte: period.start, lte: period.end } },
      }),
      prisma.technicalIssue.count({
        where: { websiteId: website.id, resolvedAt: { gte: period.start, lte: period.end } },
      }),
      prisma.technicalIssue.groupBy({
        by: ['severity'],
        where: {
          websiteId: website.id,
          status: { in: [IssueStatus.OPEN, IssueStatus.REGRESSED, IssueStatus.IN_PROGRESS] },
        },
        _count: { _all: true },
      }),
      prisma.seoAction.findMany({
        where: { websiteId: website.id, executedAt: { gte: period.start, lte: period.end } },
        select: { id: true, type: true, title: true, status: true, executedAt: true },
        take: 200,
      }),
      prisma.experiment.findMany({
        where: { websiteId: website.id, evaluatedAt: { gte: period.start, lte: period.end } },
        select: { outcome: true, deltaPct: true, name: true, action: { select: { type: true } } },
        take: 200,
      }),
      prisma.page.findMany({
        where: { websiteId: website.id, isActive: true },
        orderBy: { clicks28d: 'desc' },
        take: 10,
        select: { url: true, title: true, clicks28d: true, impressions28d: true, position28d: true, clicksTrendPct: true },
      }),
      prisma.contentDraft.count({
        where: { websiteId: website.id, publishedAt: { gte: period.start, lte: period.end } },
      }),
    ]);

  const outcomes = summariseActionOutcomes(
    experiments.map((experiment) => ({
      actionType: experiment.action?.type ?? 'CUSTOM',
      outcome: experiment.outcome as ExperimentOutcomeValue,
      deltaPct: experiment.deltaPct,
    })),
  );

  const [snapshotStart, snapshotEnd] = await Promise.all([
    prisma.scoreSnapshot.findFirst({
      where: { websiteId: website.id, date: { gte: period.start } },
      orderBy: { date: 'asc' },
    }),
    prisma.scoreSnapshot.findFirst({
      where: { websiteId: website.id, date: { lte: period.end } },
      orderBy: { date: 'desc' },
    }),
  ]);

  const clicksChange = percentChange(previousTotals.clicks, totals.clicks);
  const highlights = buildHighlights({
    clicksChange,
    clicks: totals.clicks,
    hasData: totals.days > 0,
    issuesResolved,
    issuesOpened,
    published: publishedDrafts,
    winners: movement.filter((query) => query.status === 'improved' || query.status === 'new').slice(0, 5),
    losers: movement.filter((query) => query.status === 'declined' || query.status === 'lost').slice(0, 5),
    positiveExperiments: experiments.filter((experiment) => experiment.outcome === 'LIKELY_POSITIVE').length,
  });

  const data = {
    site: { name: website.name, domain: website.domain },
    period: { start: formatDateKey(period.start), end: formatDateKey(period.end), days },
    traffic: {
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: totals.ctr,
      avgPosition: totals.position,
      daysWithData: totals.days,
      previous: {
        clicks: previousTotals.clicks,
        impressions: previousTotals.impressions,
        ctr: previousTotals.ctr,
        avgPosition: previousTotals.position,
      },
      change: {
        clicksPct: clicksChange,
        impressionsPct: percentChange(previousTotals.impressions, totals.impressions),
      },
    },
    scores: {
      health: website.healthScore,
      geo: website.geoScore,
      aiVisibility: website.aiVisibilityScore,
      content: website.contentScore,
      healthAtStart: snapshotStart?.healthScore ?? null,
      healthAtEnd: snapshotEnd?.healthScore ?? null,
    },
    queries: {
      improved: movement.filter((query) => query.status === 'improved').slice(0, 20),
      declined: movement.filter((query) => query.status === 'declined').slice(0, 20),
      new: movement.filter((query) => query.status === 'new').slice(0, 20),
      lost: movement.filter((query) => query.status === 'lost').slice(0, 20),
    },
    topPages,
    issues: {
      opened: issuesOpened,
      resolved: issuesResolved,
      openBySeverity: Object.fromEntries(
        openBySeverity.map((row) => [row.severity, row._count._all]),
      ),
    },
    actions: {
      executed: actions.length,
      byType: countBy(actions.map((action) => action.type)),
      outcomes,
      measured: experiments.length,
    },
    content: { published: publishedDrafts },
  };

  await ctx.updateProgress(80, 'Writing the report');

  const report = await prisma.report.create({
    data: {
      websiteId: website.id,
      type: payload.type,
      title: `${capitalise(payload.type)} report — ${website.name}`,
      periodStart: period.start,
      periodEnd: period.end,
      data: json(data),
      summary: truncate(
        totals.days === 0
          ? `No Search Console data was available for ${website.domain} in this period, so this report covers on-site work only: ${issuesResolved} issue(s) resolved, ${actions.length} action(s) executed.`
          : `${totals.clicks.toLocaleString()} clicks and ${totals.impressions.toLocaleString()} impressions${
              clicksChange === null ? '' : ` (${clicksChange >= 0 ? '+' : ''}${round(clicksChange, 1)}% clicks)`
            }. ${issuesResolved} issue(s) resolved, ${actions.length} action(s) executed, ${publishedDrafts} page(s) published.`,
        2_000,
      ),
      highlights: json(highlights),
    },
    select: { id: true },
  });

  await notify(website.id, payload.userId ?? null, {
    type: 'report',
    severity: NotificationSeverity.INFO,
    title: `${capitalise(payload.type)} report ready`,
    message: `The ${payload.type} report for ${website.name} covering ${formatDateKey(period.start)} → ${formatDateKey(period.end)} is ready.`,
    link: `/reports/${report.id}`,
    data: { reportId: report.id },
    dedupeKey: `report:${report.id}`,
  });

  await ctx.updateProgress(100, 'Report ready');
  const result: ReportResult = {
    status: 'completed',
    reportId: report.id,
    type: payload.type,
    scope: 'website',
    periodStart: formatDateKey(period.start),
    periodEnd: formatDateKey(period.end),
    highlights: highlights.length,
  };
  return result;
};

interface HighlightInput {
  clicksChange: number | null;
  clicks: number;
  hasData: boolean;
  issuesResolved: number;
  issuesOpened: number;
  published: number;
  winners: Array<{ query: string; clicksChange: number }>;
  losers: Array<{ query: string; clicksChange: number }>;
  positiveExperiments: number;
}

/** Facts worth putting at the top of a report — each one is a number we measured. */
function buildHighlights(input: HighlightInput): string[] {
  const highlights: string[] = [];

  if (!input.hasData) {
    highlights.push('No search performance data was available for this period.');
  } else if (input.clicksChange !== null) {
    highlights.push(
      `Organic clicks ${input.clicksChange >= 0 ? 'rose' : 'fell'} ${Math.abs(round(input.clicksChange, 1))}% to ${input.clicks.toLocaleString()}.`,
    );
  }
  if (input.issuesResolved > 0) highlights.push(`${input.issuesResolved} technical issue(s) resolved.`);
  if (input.issuesOpened > 0) highlights.push(`${input.issuesOpened} new issue(s) detected.`);
  if (input.published > 0) highlights.push(`${input.published} page(s) published.`);
  if (input.positiveExperiments > 0) {
    highlights.push(`${input.positiveExperiments} measured change(s) came back likely positive.`);
  }
  for (const winner of input.winners.slice(0, 3)) {
    highlights.push(`"${winner.query}" gained ${winner.clicksChange} click(s).`);
  }
  for (const loser of input.losers.slice(0, 2)) {
    highlights.push(`"${loser.query}" lost ${Math.abs(loser.clicksChange)} click(s).`);
  }
  return highlights;
}

async function buildPortfolioReport(
  userId: string | null,
  type: string,
  period: DateRange,
  progress: (percent: number, message?: string) => Promise<void>,
): Promise<ReportResult | ReturnType<typeof skip>> {
  const websites = await prisma.website.findMany({
    where: { status: WebsiteStatus.ACTIVE, ...(userId ? { userId } : {}) },
    select: {
      id: true,
      name: true,
      domain: true,
      healthScore: true,
      geoScore: true,
      aiVisibilityScore: true,
      lastCrawlAt: true,
      lastAnalysisAt: true,
    },
    take: 200,
  });

  if (websites.length === 0) {
    return skip('There are no active websites to report on.');
  }

  const sites: PortfolioSiteInput[] = [];
  let index = 0;

  for (const website of websites) {
    index += 1;
    await progress(10 + (index / websites.length) * 60, `Reading ${website.domain}`);

    const [pageTotals, issues, criticalIssues, opportunities, approvals, keywords, clusters] =
      await Promise.all([
        prisma.page.aggregate({
          where: { websiteId: website.id, isActive: true },
          _sum: { clicks28d: true, impressions28d: true, clicksPrev28d: true, impressionsPrev28d: true },
          _avg: { position28d: true },
        }),
        prisma.technicalIssue.count({
          where: {
            websiteId: website.id,
            status: { in: [IssueStatus.OPEN, IssueStatus.REGRESSED, IssueStatus.IN_PROGRESS] },
          },
        }),
        prisma.technicalIssue.count({
          where: {
            websiteId: website.id,
            severity: 'CRITICAL',
            status: { in: [IssueStatus.OPEN, IssueStatus.REGRESSED, IssueStatus.IN_PROGRESS] },
          },
        }),
        prisma.contentOpportunity.aggregate({
          where: { websiteId: website.id, status: 'IDENTIFIED' },
          _count: { _all: true },
          _max: { priorityScore: true },
        }),
        prisma.approval.count({ where: { websiteId: website.id, status: ApprovalStatus.PENDING } }),
        prisma.keyword.findMany({
          where: { websiteId: website.id },
          orderBy: { impressions28d: 'desc' },
          take: 20,
          select: { keyword: true },
        }),
        prisma.keywordCluster.findMany({
          where: { websiteId: website.id },
          orderBy: { totalImpressions: 'desc' },
          take: 20,
          select: { name: true },
        }),
      ]);

    sites.push({
      websiteId: website.id,
      name: website.name,
      domain: website.domain,
      healthScore: website.healthScore,
      geoScore: website.geoScore,
      aiVisibilityScore: website.aiVisibilityScore,
      clicks28d: pageTotals._sum.clicks28d ?? 0,
      clicksPrev28d: pageTotals._sum.clicksPrev28d ?? 0,
      impressions28d: pageTotals._sum.impressions28d ?? 0,
      impressionsPrev28d: pageTotals._sum.impressionsPrev28d ?? 0,
      avgPosition: pageTotals._avg.position28d,
      openCriticalIssues: criticalIssues,
      openIssues: issues,
      opportunityCount: opportunities._count._all,
      topOpportunityScore: opportunities._max.priorityScore ?? 0,
      pendingApprovals: approvals,
      topKeywords: keywords.map((keyword) => keyword.keyword),
      topicNames: clusters.map((cluster) => cluster.name),
      lastCrawlAt: website.lastCrawlAt,
      lastAnalysisAt: website.lastAnalysisAt,
    });
  }

  await progress(80, 'Analysing the portfolio');
  const analysis = analysePortfolio(sites);
  const ranked = rankSitesByNeed(sites);

  const report = await prisma.report.create({
    data: {
      type,
      title: `Portfolio report — ${sites.length} site(s)`,
      periodStart: period.start,
      periodEnd: period.end,
      data: json({
        period: { start: formatDateKey(period.start), end: formatDateKey(period.end) },
        totals: analysis.totals,
        insights: analysis.insights,
        sites: sites.map((site) => ({
          websiteId: site.websiteId,
          name: site.name,
          domain: site.domain,
          clicks28d: site.clicks28d,
          clicksPrev28d: site.clicksPrev28d,
          healthScore: site.healthScore,
          openIssues: site.openIssues,
          pendingApprovals: site.pendingApprovals,
        })),
        attentionOrder: ranked,
      }),
      summary: truncate(
        `${sites.length} active site(s), ${analysis.totals.clicks28d.toLocaleString()} clicks in the last 28 days, ` +
          `${analysis.totals.openIssues} open issue(s) and ${analysis.totals.pendingApprovals} approval(s) waiting.`,
        2_000,
      ),
      highlights: json(analysis.insights.slice(0, 10).map((insight) => insight.title)),
    },
    select: { id: true },
  });

  if (userId) {
    await notify(null, userId, {
      type: 'report',
      severity: NotificationSeverity.INFO,
      title: 'Portfolio report ready',
      message: `Your portfolio report covering ${sites.length} site(s) is ready.`,
      link: `/reports/${report.id}`,
      data: { reportId: report.id },
      dedupeKey: `report:${report.id}`,
    });
  }

  await progress(100, 'Portfolio report ready');
  return {
    status: 'completed',
    reportId: report.id,
    type,
    scope: 'portfolio',
    periodStart: formatDateKey(period.start),
    periodEnd: formatDateKey(period.end),
    highlights: analysis.insights.length,
  };
}

// ─────────────────────────────────────────────────────────────
// notifications.digest
// ─────────────────────────────────────────────────────────────

export interface DigestResult {
  status: 'completed';
  frequency: string;
  websites: number;
  digestsCreated: number;
}

export const notificationsDigest: JobHandler<'notifications.digest'> = async ({ payload, ctx }) => {
  const since = addDays(new Date(), payload.frequency === 'weekly' ? -7 : -1);

  const websites = await prisma.website.findMany({
    where: {
      status: WebsiteStatus.ACTIVE,
      ...(payload.websiteId ? { id: payload.websiteId } : {}),
      ...(payload.userId ? { userId: payload.userId } : {}),
    },
    select: { id: true, name: true, userId: true },
    take: 200,
  });

  if (websites.length === 0) return skip('There are no active websites to build a digest for.');

  const dateKey = formatDateKey(new Date());
  let created = 0;
  let index = 0;

  for (const website of websites) {
    index += 1;
    await ctx.updateProgress((index / websites.length) * 90, `Summarising ${website.name}`);

    const [newIssues, criticalIssues, approvals, failedJobs, decayOpportunities, measured] =
      await Promise.all([
        prisma.technicalIssue.count({
          where: { websiteId: website.id, discoveredAt: { gte: since } },
        }),
        prisma.technicalIssue.count({
          where: {
            websiteId: website.id,
            severity: 'CRITICAL',
            status: { in: [IssueStatus.OPEN, IssueStatus.REGRESSED] },
          },
        }),
        prisma.approval.count({ where: { websiteId: website.id, status: ApprovalStatus.PENDING } }),
        prisma.jobRecord.count({
          where: { websiteId: website.id, status: 'FAILED', finishedAt: { gte: since } },
        }),
        prisma.contentOpportunity.count({
          where: { websiteId: website.id, status: 'IDENTIFIED', discoveredAt: { gte: since } },
        }),
        prisma.experiment.count({
          where: { websiteId: website.id, evaluatedAt: { gte: since } },
        }),
      ]);

    const nothingHappened =
      newIssues === 0 &&
      criticalIssues === 0 &&
      approvals === 0 &&
      failedJobs === 0 &&
      decayOpportunities === 0 &&
      measured === 0;
    if (nothingHappened) continue;

    const lines: string[] = [];
    if (criticalIssues > 0) lines.push(`${criticalIssues} critical issue(s) open`);
    if (newIssues > 0) lines.push(`${newIssues} new issue(s) found`);
    if (approvals > 0) lines.push(`${approvals} action(s) waiting for approval`);
    if (decayOpportunities > 0) lines.push(`${decayOpportunities} new content opportunity(ies)`);
    if (measured > 0) lines.push(`${measured} change(s) measured`);
    if (failedJobs > 0) lines.push(`${failedJobs} background job(s) failed`);

    const wrote = await notify(website.id, website.userId, {
      type: `digest-${payload.frequency}`,
      severity: criticalIssues > 0 || failedJobs > 0 ? NotificationSeverity.WARNING : NotificationSeverity.INFO,
      title: `${payload.frequency === 'weekly' ? 'Weekly' : 'Daily'} digest — ${website.name}`,
      message: `${lines.join(' · ')}.`,
      link: `/websites/${website.id}`,
      data: { newIssues, criticalIssues, approvals, failedJobs, decayOpportunities, measured },
      dedupeKey: `digest:${payload.frequency}:${website.id}:${dateKey}`,
    });
    if (wrote) created += 1;
  }

  await ctx.updateProgress(100, `Wrote ${created} digest(s)`);
  const result: DigestResult = {
    status: 'completed',
    frequency: payload.frequency,
    websites: websites.length,
    digestsCreated: created,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// maintenance.cleanup
// ─────────────────────────────────────────────────────────────

export interface CleanupResult {
  status: 'completed';
  retentionDays: number;
  cutoff: string;
  expiredSessions: number;
  deleted: Record<string, number>;
}

export const maintenanceCleanup: JobHandler<'maintenance.cleanup'> = async ({ payload, ctx }) => {
  const retentionDays = Math.round(
    clamp(payload.olderThanDays ?? DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS),
  );
  const cutoff = addDays(new Date(), -retentionDays);
  const targets = payload.targets ?? [
    'job-records',
    'crawl-pages',
    'page-snapshots',
    'serp-snapshots',
    'ai-usage',
    'notifications',
    'agent-runs',
    'orphan-embeddings',
  ];

  const deleted: Record<string, number> = {};

  // Expired sessions are pruned on every run: they are a security surface, not a retention
  // preference, and the window is the session's own expiry rather than `olderThanDays`.
  const sessions = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  let step = 0;
  for (const target of targets) {
    step += 1;
    await ctx.updateProgress((step / targets.length) * 90, `Pruning ${target}`);

    switch (target) {
      case 'job-records': {
        const result = await cleanupOldJobs(retentionDays);
        deleted['job-records'] = result.deletedRecords;
        deleted['broker-jobs'] = result.removedFromBroker;
        break;
      }
      case 'crawl-pages':
        deleted['crawl-pages'] = await pruneCrawlPages(cutoff);
        break;
      case 'page-snapshots':
        deleted['page-snapshots'] = await deleteInBatches(
          (ids) => prisma.pageSnapshot.deleteMany({ where: { id: { in: ids } } }),
          (take) =>
            prisma.pageSnapshot.findMany({
              where: { capturedAt: { lt: cutoff } },
              select: { id: true },
              take,
            }),
        );
        break;
      case 'serp-snapshots':
        deleted['serp-snapshots'] = await deleteInBatches(
          (ids) => prisma.serpSnapshot.deleteMany({ where: { id: { in: ids } } }),
          (take) =>
            prisma.serpSnapshot.findMany({
              where: { capturedAt: { lt: cutoff } },
              select: { id: true },
              take,
            }),
        );
        break;
      case 'ai-usage':
        deleted['ai-usage'] = await deleteInBatches(
          (ids) => prisma.aiUsage.deleteMany({ where: { id: { in: ids } } }),
          (take) =>
            prisma.aiUsage.findMany({ where: { createdAt: { lt: cutoff } }, select: { id: true }, take }),
        );
        break;
      case 'notifications':
        deleted['notifications'] = await deleteInBatches(
          (ids) => prisma.notification.deleteMany({ where: { id: { in: ids } } }),
          (take) =>
            prisma.notification.findMany({
              // Unread notifications are never pruned: they are still someone's inbox.
              where: { isRead: true, createdAt: { lt: cutoff } },
              select: { id: true },
              take,
            }),
        );
        break;
      case 'agent-runs':
        deleted['agent-runs'] = await deleteInBatches(
          (ids) => prisma.agentRun.deleteMany({ where: { id: { in: ids } } }),
          (take) =>
            prisma.agentRun.findMany({
              where: { startedAt: { lt: cutoff }, status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
              select: { id: true },
              take,
            }),
        );
        break;
      case 'orphan-embeddings':
        deleted['orphan-embeddings'] = await pruneOrphanEmbeddings();
        break;
      default:
        break;
    }
  }

  log.info('cleanup complete', { retentionDays, deleted, expiredSessions: sessions.count });
  await ctx.updateProgress(100, 'Cleanup complete');

  const result: CleanupResult = {
    status: 'completed',
    retentionDays,
    cutoff: cutoff.toISOString(),
    expiredSessions: sessions.count,
    deleted,
  };
  return result;
};

/**
 * Drops the page bodies of old crawls while keeping the crawl rows themselves.
 *
 * The `Crawl` row is history the operator looks at; the `CrawlPage` rows under it are bulk
 * storage that only the newest completed crawl still needs. That newest crawl per site is
 * always excluded — the audit, the scores and the GEO pass all read from it.
 */
async function pruneCrawlPages(cutoff: Date): Promise<number> {
  const websites = await prisma.website.findMany({ select: { id: true }, take: 1_000 });
  const keep = new Set<string>();

  for (const website of websites) {
    const latest = await prisma.crawl.findFirst({
      where: { websiteId: website.id, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (latest) keep.add(latest.id);
  }

  const oldCrawls = await prisma.crawl.findMany({
    where: { createdAt: { lt: cutoff }, id: { notIn: [...keep] } },
    select: { id: true },
    take: 500,
  });
  if (oldCrawls.length === 0) return 0;

  let removed = 0;
  for (const crawl of oldCrawls) {
    const result = await prisma.crawlPage.deleteMany({ where: { crawlId: crawl.id } });
    removed += result.count;
  }
  return removed;
}

/**
 * Deletes embedding rows whose owner is gone.
 *
 * Page and keyword embeddings are cleaned up by their foreign keys; cluster, entity and draft
 * embeddings reference their owner by a loose `ownerId`, so they can outlive it.
 */
async function pruneOrphanEmbeddings(): Promise<number> {
  let removed = 0;

  for (const ownerType of ['CLUSTER', 'ENTITY', 'DRAFT'] as const) {
    let cursor: string | null = null;
    for (let batch = 0; batch < MAX_DELETE_BATCHES; batch += 1) {
      const where: Prisma.EmbeddingRecordWhereInput = {
        ownerType,
        ...(cursor === null ? {} : { id: { gt: cursor } }),
      };
      const rows = await prisma.embeddingRecord.findMany({
        where,
        orderBy: { id: 'asc' },
        take: DELETE_BATCH,
        select: { id: true, ownerId: true },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;

      const ownerIds = rows.map((row) => row.ownerId);
      const alive = new Set<string>();
      if (ownerType === 'CLUSTER') {
        const found = await prisma.keywordCluster.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true },
        });
        for (const row of found) alive.add(row.id);
      } else if (ownerType === 'ENTITY') {
        const found = await prisma.entity.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true },
        });
        for (const row of found) alive.add(row.id);
      } else {
        const found = await prisma.contentDraft.findMany({
          where: { id: { in: ownerIds } },
          select: { id: true },
        });
        for (const row of found) alive.add(row.id);
      }

      const orphanIds = rows.filter((row) => !alive.has(row.ownerId)).map((row) => row.id);
      if (orphanIds.length) {
        const result = await prisma.embeddingRecord.deleteMany({ where: { id: { in: orphanIds } } });
        removed += result.count;
      }
      if (rows.length < DELETE_BATCH) break;
    }
  }

  return removed;
}

/** Deletes by id in bounded batches so one statement never locks a huge range. */
async function deleteInBatches(
  remove: (ids: string[]) => Promise<{ count: number }>,
  find: (take: number) => Promise<Array<{ id: string }>>,
): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_DELETE_BATCHES; batch += 1) {
    const rows = await find(DELETE_BATCH);
    if (rows.length === 0) break;
    const result = await remove(rows.map((row) => row.id));
    removed += result.count;
    if (rows.length < DELETE_BATCH) break;
  }
  return removed;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

interface NotifyInput {
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  link?: string;
  data: Record<string, unknown>;
  dedupeKey: string;
}

/** Writes a notification, treating a duplicate dedupe key as "already told them". */
async function notify(
  websiteId: string | null,
  userId: string | null,
  input: NotifyInput,
): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: {
        websiteId,
        userId,
        type: input.type,
        severity: input.severity,
        title: truncate(input.title, 200),
        message: truncate(input.message, 1_000),
        link: input.link ?? null,
        data: json(input.data),
        dedupeKey: input.dedupeKey,
      },
    });
    return true;
  } catch (err) {
    log.debug('notification skipped', { dedupeKey: input.dedupeKey, error: errorMessage(err) });
    return false;
  }
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Kept for the reports UI, which shows the outcome label next to a measured action. */
export function outcomeLabel(outcome: ExperimentOutcome): string {
  switch (outcome) {
    case 'LIKELY_POSITIVE':
      return 'Likely positive';
    case 'LIKELY_NEGATIVE':
      return 'Likely negative';
    case 'INCONCLUSIVE':
      return 'Inconclusive';
    default:
      return 'Pending';
  }
}

/** Actions that finished but were never measured — surfaced by the digest when it matters. */
export async function countUnmeasuredActions(websiteId: string): Promise<number> {
  return prisma.seoAction.count({
    where: {
      websiteId,
      status: ActionStatus.COMPLETED,
      measureAfter: { lte: new Date() },
    },
  });
}
