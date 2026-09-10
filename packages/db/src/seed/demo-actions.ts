import { addDays, clamp, round, toUtcDate } from '@seo/shared';
import {
  calculateHealthScore,
  calculatePriority,
  canAutoExecute,
  evaluateExperiment,
  riskBandForActionType,
} from '@seo/seo-engine';
import type { ActionRisk, ActionStatus, ActionType } from '@prisma/client';
import { prisma } from '../client';
import { createManyChunked, json } from '../helpers';
import type { IssueLifetime } from './demo-crawl';
import type { DemoInsightsResult } from './demo-insights';
import type { DemoMetrics } from './demo-metrics';
import { pageDailySeries } from './demo-metrics';
import type { DemoCrawl } from './demo-pages';
import type { DemoSiteBlueprint } from './demo-sites';
import { Rng } from './rng';

/**
 * The action layer: what the platform proposes, what a human approved, what ran, and what the one
 * completed experiment measured afterwards.
 *
 * Actions are derived from findings that already exist in the database, so every action on the demo
 * board can be traced back to the issue, CTR gap or link suggestion that produced it.
 */

export interface DemoActionsResult {
  counts: Record<string, number>;
  experimentOutcome: string | null;
}

/** Which action type addresses a given rule. Mirrors how the worker routes real findings. */
const ACTION_BY_RULE: Record<string, ActionType> = {
  MISSING_META_DESCRIPTION: 'UPDATE_META_DESCRIPTION',
  META_DESCRIPTION_TOO_LONG: 'UPDATE_META_DESCRIPTION',
  META_DESCRIPTION_TOO_SHORT: 'UPDATE_META_DESCRIPTION',
  DUPLICATE_META_DESCRIPTION: 'UPDATE_META_DESCRIPTION',
  MISSING_TITLE: 'UPDATE_TITLE',
  TITLE_TOO_LONG: 'UPDATE_TITLE',
  TITLE_TOO_SHORT: 'UPDATE_TITLE',
  DUPLICATE_TITLE: 'UPDATE_TITLE',
  MISSING_STRUCTURED_DATA: 'ADD_STRUCTURED_DATA',
  MISSING_ORGANIZATION_SCHEMA: 'ADD_STRUCTURED_DATA',
  MISSING_BREADCRUMBS: 'ADD_STRUCTURED_DATA',
  MALFORMED_STRUCTURED_DATA: 'ADD_STRUCTURED_DATA',
  ORPHAN_PAGE: 'ADD_INTERNAL_LINKS',
  LOW_INTERNAL_LINKS: 'ADD_INTERNAL_LINKS',
  BROKEN_INTERNAL_LINK: 'ADD_INTERNAL_LINKS',
  INTERNAL_LINK_TO_REDIRECT: 'ADD_INTERNAL_LINKS',
  THIN_CONTENT: 'REFRESH_CONTENT',
};

const EFFORT_BY_ACTION: Partial<Record<ActionType, number>> = {
  UPDATE_META_DESCRIPTION: 1,
  UPDATE_TITLE: 1,
  ADD_STRUCTURED_DATA: 2,
  ADD_INTERNAL_LINKS: 2,
  REFRESH_CONTENT: 4,
  FIX_TECHNICAL_ISSUE: 3,
};

const RISK_LEVEL: Record<ActionRisk, number> = { SAFE: 1, MEDIUM: 2.5, HIGH: 4 };

export async function persistDemoActions(
  site: DemoSiteBlueprint,
  websiteId: string,
  userId: string,
  crawl: DemoCrawl,
  metrics: DemoMetrics,
  insights: DemoInsightsResult,
  issueLifetimes: IssueLifetime[],
  auditStats: { indexablePages: number; orphanPages: number },
  pageIdByPath: Map<string, string>,
  withExperiment: boolean,
  now: Date,
): Promise<DemoActionsResult> {
  const rng = new Rng(`${site.key}:actions`);
  const counts: Record<string, number> = {};

  const openIssues = await prisma.technicalIssue.findMany({
    where: { websiteId, status: 'OPEN', autoFixable: true },
    orderBy: { estimatedImpact: 'desc' },
    take: 6,
    select: { id: true, ruleId: true, title: true, url: true, description: true, recommendation: true, estimatedImpact: true, confidence: true, severity: true },
  });

  // Statuses are spread deliberately so the board, the approvals queue and the history view all
  // have something in them on a fresh install.
  const statusCycle: ActionStatus[] = ['PROPOSED', 'AWAITING_APPROVAL', 'APPROVED', 'COMPLETED', 'PROPOSED', 'AWAITING_APPROVAL'];
  let actionCount = 0;
  let approvalCount = 0;
  let executionCount = 0;
  let changeLogCount = 0;

  for (const [index, issue] of openIssues.entries()) {
    const type = ACTION_BY_RULE[issue.ruleId] ?? 'FIX_TECHNICAL_ISSUE';
    const risk = riskBandForActionType(type);
    const effort = EFFORT_BY_ACTION[type] ?? 3;
    const priority = calculatePriority({
      impact: clamp(issue.estimatedImpact),
      confidence: issue.confidence,
      businessValue: 0.6,
      effort,
      risk: RISK_LEVEL[risk],
    });
    const guard = canAutoExecute({ actionType: type, autonomyLevel: site.autonomyLevel, autoApproveSafe: false });
    const status = statusCycle[index % statusCycle.length];

    const action = await prisma.seoAction.create({
      data: {
        websiteId,
        type,
        title: `${issue.title}${issue.url ? ` — ${new URL(issue.url).pathname}` : ''}`,
        status,
        risk,
        reasoning: `${issue.description} ${issue.recommendation}`,
        evidence: json({ ruleId: issue.ruleId, severity: issue.severity, issueId: issue.id, guard }),
        affectedUrls: issue.url ? [issue.url] : [],
        requiredAgent: type === 'REFRESH_CONTENT' ? 'content-agent' : 'technical-agent',
        payload: json({ ruleId: issue.ruleId, url: issue.url }),
        impactScore: round(clamp(issue.estimatedImpact) * 100, 1),
        effortScore: effort,
        confidenceScore: issue.confidence,
        businessValue: 0.6,
        riskScore: RISK_LEVEL[risk],
        priorityScore: priority.score,
        priorityFactors: json(priority.factors),
        sourceType: 'TechnicalIssue',
        sourceId: issue.id,
        autoExecutable: guard.allowed,
        proposedAt: new Date(now.getTime() - rng.int(2, 20) * 86_400_000),
        approvedAt: status === 'APPROVED' || status === 'COMPLETED' ? new Date(now.getTime() - 3 * 86_400_000) : null,
        executedAt: status === 'COMPLETED' ? new Date(now.getTime() - 2 * 86_400_000) : null,
        completedAt: status === 'COMPLETED' ? new Date(now.getTime() - 2 * 86_400_000) : null,
      },
      select: { id: true, title: true },
    });
    actionCount++;

    if (status === 'AWAITING_APPROVAL') {
      await prisma.approval.create({
        data: {
          websiteId,
          actionId: action.id,
          kind: 'ACTION',
          title: action.title,
          description: issue.recommendation,
          risk,
          status: 'PENDING',
          payload: json({ ruleId: issue.ruleId, url: issue.url }),
        },
      });
      approvalCount++;
    }

    if (status === 'APPROVED' || status === 'COMPLETED') {
      await prisma.approval.create({
        data: {
          websiteId,
          actionId: action.id,
          userId,
          kind: 'ACTION',
          title: action.title,
          description: issue.recommendation,
          risk,
          status: 'APPROVED',
          payload: json({ ruleId: issue.ruleId, url: issue.url }),
          decidedAt: new Date(now.getTime() - 3 * 86_400_000),
          decisionNote: 'Approved in the demo dataset so the history view is not empty.',
        },
      });
      approvalCount++;
    }

    if (status === 'COMPLETED') {
      await prisma.actionExecution.create({
        data: {
          actionId: action.id,
          attempt: 1,
          status: 'COMPLETED',
          adapter: 'demo',
          request: json({ ruleId: issue.ruleId, url: issue.url }),
          response: json({ applied: true }),
          beforeState: json({ note: 'captured before the change' }),
          afterState: json({ note: 'captured after the change' }),
          startedAt: new Date(now.getTime() - 2 * 86_400_000),
          finishedAt: new Date(now.getTime() - 2 * 86_400_000 + 4_200),
          durationMs: 4_200,
        },
      });
      executionCount++;

      await prisma.changeLog.create({
        data: {
          websiteId,
          actionId: action.id,
          userId,
          actor: 'agent',
          agent: 'technical-agent',
          changeType: type,
          targetUrl: issue.url,
          summary: `Applied: ${issue.title}`,
          reason: issue.recommendation,
          approved: true,
          rollbackable: true,
          createdAt: new Date(now.getTime() - 2 * 86_400_000),
        },
      });
      changeLogCount++;
    }
  }

  // One action per site that comes from the internal-link engine rather than the rule engine.
  const topLink = insights.linkSuggestions[0];
  if (topLink) {
    const priority = calculatePriority({ impact: topLink.impactScore, confidence: 0.7, businessValue: 0.6, effort: 2, risk: 1 });
    await prisma.seoAction.create({
      data: {
        websiteId,
        type: 'ADD_INTERNAL_LINKS',
        title: `Add an internal link using the anchor "${topLink.anchorText}"`,
        status: 'AWAITING_APPROVAL',
        risk: riskBandForActionType('ADD_INTERNAL_LINKS'),
        reasoning: topLink.reason,
        evidence: json({ suggestionId: topLink.id }),
        payload: json({ suggestionId: topLink.id, anchorText: topLink.anchorText }),
        impactScore: round(topLink.impactScore * 100, 1),
        effortScore: 2,
        confidenceScore: 0.7,
        businessValue: 0.6,
        riskScore: 1,
        priorityScore: priority.score,
        priorityFactors: json(priority.factors),
        sourceType: 'InternalLinkSuggestion',
        sourceId: topLink.id,
        autoExecutable: canAutoExecute({
          actionType: 'ADD_INTERNAL_LINKS',
          autonomyLevel: site.autonomyLevel,
          autoApproveSafe: false,
        }).allowed,
        proposedAt: new Date(now.getTime() - 86_400_000),
      },
    });
    actionCount++;
  }

  // ── The completed experiment ───────────────────────────────────────────────
  let experimentOutcome: string | null = null;
  if (withExperiment) {
    const measured = site.queries.find((query) => query.stepDaysAgo !== undefined);
    const pageId = measured ? pageIdByPath.get(measured.path) ?? null : null;
    if (measured && pageId) {
      experimentOutcome = await createExperiment(site, websiteId, userId, metrics, measured.path, measured.stepDaysAgo!, pageId, crawl, now);
      counts.Experiment = 1;
      actionCount++;
      changeLogCount++;
    }
  }

  // ── Daily score history ────────────────────────────────────────────────────
  const snapshotCount = await writeScoreSnapshots(websiteId, metrics, issueLifetimes, auditStats, crawl.pages.length);

  // ── A couple of notifications so the inbox is not empty ────────────────────
  await createManyChunked(prisma.notification, [
    {
      websiteId,
      userId,
      type: 'CRAWL_COMPLETED',
      severity: 'INFO',
      title: `Crawl finished for ${site.name}`,
      message: `${crawl.pages.length} URLs crawled. See the technical issues view for what it found.`,
      link: `/websites/${websiteId}/technical`,
      data: json({ demo: true }),
      dedupeKey: `demo:${websiteId}:crawl-completed`,
      createdAt: new Date(now.getTime() - 86_400_000),
    },
    {
      websiteId,
      userId,
      type: 'APPROVALS_PENDING',
      severity: 'WARNING',
      title: `${approvalCount > 0 ? 'Actions are waiting for your approval' : 'No approvals pending'}`,
      message: 'Demo actions are proposals only — nothing in the demo dataset can execute against a real site.',
      link: `/websites/${websiteId}/actions`,
      data: json({ demo: true }),
      dedupeKey: `demo:${websiteId}:approvals-pending`,
      createdAt: new Date(now.getTime() - 43_200_000),
    },
  ]);

  return {
    experimentOutcome,
    counts: {
      ...counts,
      SeoAction: actionCount,
      Approval: approvalCount,
      ActionExecution: executionCount,
      ChangeLog: changeLogCount,
      Notification: 2,
      ScoreSnapshot: snapshotCount,
    },
  };
}

/**
 * A finished experiment, evaluated by the real evaluator against the real generated series.
 *
 * The seed does not choose the outcome: it applies a step change to the modelled CTR 63 days ago
 * and then asks `evaluateExperiment` what it can conclude. If the effect were too small or too
 * noisy to separate, the demo would honestly show "inconclusive".
 */
async function createExperiment(
  site: DemoSiteBlueprint,
  websiteId: string,
  userId: string,
  metrics: DemoMetrics,
  path: string,
  stepDaysAgo: number,
  pageId: string,
  crawl: DemoCrawl,
  now: Date,
): Promise<string> {
  const page = crawl.byPath.get(path);
  const series = pageDailySeries(metrics, path);
  const changeDate = toUtcDate(new Date(now.getTime() - stepDaysAgo * 86_400_000));

  const baseline = { start: metrics.range.start, end: addDays(changeDate, -1) };
  const measurement = { start: changeDate, end: metrics.range.end };

  const evaluation = evaluateExperiment(
    { metric: 'clicks', baseline, measurement, minDays: 28, settlingDays: 7 },
    series,
    series,
    now,
  );

  const action = await prisma.seoAction.create({
    data: {
      websiteId,
      type: 'UPDATE_META_DESCRIPTION',
      title: `Rewrite the meta description for ${path}`,
      status: 'EVALUATED',
      risk: 'SAFE',
      reasoning:
        'The page ranked on the first page but was under-clicked against the position/CTR curve, so the snippet was rewritten to lead with the specific method rather than the category.',
      evidence: json({ experiment: true, path }),
      affectedUrls: page ? [page.url] : [],
      payload: json({ path }),
      impactScore: 62,
      effortScore: 1,
      confidenceScore: 0.7,
      businessValue: 0.7,
      riskScore: 1,
      priorityScore: 68,
      sourceType: 'ContentOpportunity',
      autoExecutable: true,
      proposedAt: addDays(changeDate, -3),
      approvedAt: addDays(changeDate, -1),
      executedAt: changeDate,
      completedAt: changeDate,
      measureAfter: addDays(changeDate, 28),
    },
    select: { id: true },
  });

  await prisma.experiment.create({
    data: {
      websiteId,
      actionId: action.id,
      pageId,
      name: `Meta description rewrite — ${path}`,
      hypothesis: 'Leading the snippet with the method name will lift click-through at an unchanged position.',
      metric: 'clicks',
      status: 'COMPLETED',
      outcome: evaluation.outcome,
      changeSummary: 'Meta description rewritten; title and body copy unchanged.',
      beforeState: json({ metaDescription: page?.metaDescription ?? null }),
      afterState: json({ metaDescription: `${page?.metaDescription ?? ''} (rewritten)` }),
      baselineStart: baseline.start,
      baselineEnd: baseline.end,
      measureStart: measurement.start,
      measureEnd: measurement.end,
      minDays: 28,
      baselineMetrics: json(evaluation.baselineMetrics),
      resultMetrics: json(evaluation.resultMetrics),
      deltaPct: evaluation.deltaPct,
      significance: evaluation.pValue,
      interpretation: evaluation.interpretation,
      evaluatedAt: new Date(now.getTime() - 86_400_000),
    },
  });

  await prisma.changeLog.create({
    data: {
      websiteId,
      actionId: action.id,
      userId,
      actor: 'agent',
      agent: 'content-agent',
      changeType: 'UPDATE_META_DESCRIPTION',
      targetUrl: page?.url ?? null,
      summary: `Rewrote the meta description on ${path}`,
      reason: 'Click-through was well below the curve for the position the page held.',
      approved: true,
      rollbackable: true,
      resultMetrics: json({ deltaPct: evaluation.deltaPct, outcome: evaluation.outcome, pValue: evaluation.pValue }),
      createdAt: changeDate,
    },
  });

  return `${site.name}: ${evaluation.outcome} (${evaluation.deltaPct === null ? 'n/a' : `${evaluation.deltaPct > 0 ? '+' : ''}${evaluation.deltaPct}%`})`;
}

/**
 * Daily score history.
 *
 * The health score for each day is *recomputed* from the issues that were open on that day, using
 * the same `calculateHealthScore` the dashboard uses — so the curve is a consequence of the issue
 * timeline rather than a drawn line.
 */
async function writeScoreSnapshots(
  websiteId: string,
  metrics: DemoMetrics,
  issueLifetimes: IssueLifetime[],
  auditStats: { indexablePages: number; orphanPages: number },
  pageCount: number,
): Promise<number> {
  const clicksByDate = new Map(metrics.siteDaily.map((day) => [day.date.getTime(), day]));
  const rows = metrics.days.map((date) => {
    const openOnDay = issueLifetimes.filter(
      (issue) => issue.discoveredAt <= date && (issue.resolvedAt === null || issue.resolvedAt > date),
    );
    const health = calculateHealthScore({
      issues: openOnDay.map((issue) => ({ category: issue.category, severity: issue.severity, weight: issue.weight })),
      pageCount,
    });

    let clicks = 0;
    let impressions = 0;
    let weightedPosition = 0;
    for (let back = 0; back < 28; back++) {
      const day = clicksByDate.get(date.getTime() - back * 86_400_000);
      if (!day) continue;
      clicks += day.clicks;
      impressions += day.impressions;
      weightedPosition += day.position * day.impressions;
    }

    const dayRows = metrics.rows.filter((row) => row.date.getTime() === date.getTime());
    return {
      websiteId,
      date: toUtcDate(date),
      healthScore: health.score,
      openIssues: openOnDay.length,
      criticalIssues: openOnDay.filter((issue) => issue.severity === 'CRITICAL').length,
      indexablePages: auditStats.indexablePages,
      orphanPages: auditStats.orphanPages,
      keywordsTop3: dayRows.filter((row) => row.position <= 3).length,
      keywordsTop10: dayRows.filter((row) => row.position <= 10).length,
      keywordsTop100: dayRows.filter((row) => row.position <= 100).length,
      clicks28d: clicks,
      impressions28d: impressions,
      avgPosition: impressions > 0 ? round(weightedPosition / impressions, 2) : null,
    };
  });

  await createManyChunked(prisma.scoreSnapshot, rows);
  return rows.length;
}
