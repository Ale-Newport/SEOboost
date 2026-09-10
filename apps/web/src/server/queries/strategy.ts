import 'server-only';
import { prisma, readJson } from '@seo/db';
import { ForbiddenError, NotFoundError } from '@seo/shared';
import { summariseActionOutcomes } from '@seo/seo-engine';

export interface PlanItem {
  title: string;
  reason?: string;
  actionId?: string;
  impact?: string;
  effort?: string;
  urls?: string[];
}

/** The AI SEO Manager screen: the current plan, the actions it produced, and what has been measured. */
export async function getStrategyData(userId: string, websiteId: string) {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, userId: true, name: true, domain: true, healthScore: true, geoScore: true, lastAnalysisAt: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const [plan, actions, experiments, agentRuns, latestManagerRun] = await Promise.all([
    prisma.strategyPlan.findFirst({
      where: { websiteId, isCurrent: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.seoAction.findMany({
      where: { websiteId, status: { in: ['PROPOSED', 'AWAITING_APPROVAL', 'QUEUED', 'APPROVED', 'EXECUTING'] } },
      orderBy: { priorityScore: 'desc' },
      take: 25,
      select: {
        id: true, type: true, title: true, status: true, risk: true, reasoning: true,
        priorityScore: true, priorityFactors: true, impactScore: true, effortScore: true,
        confidenceScore: true, businessValue: true, riskScore: true, affectedUrls: true,
        requiredAgent: true, autoExecutable: true, proposedAt: true,
      },
    }),
    prisma.experiment.findMany({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true, name: true, metric: true, status: true, outcome: true, deltaPct: true,
        interpretation: true, changeSummary: true, measureStart: true, evaluatedAt: true,
        action: { select: { id: true, type: true, title: true } },
      },
    }),
    prisma.agentRun.findMany({
      where: { websiteId },
      orderBy: { startedAt: 'desc' },
      take: 12,
      select: {
        id: true, agent: true, status: true, summary: true, confidence: true,
        actionsCreated: true, startedAt: true, durationMs: true, costUsd: true, error: true,
      },
    }),
    prisma.agentRun.findFirst({
      where: { websiteId, agent: 'SEOManagerAgent' },
      orderBy: { startedAt: 'desc' },
      select: { id: true, status: true, startedAt: true, error: true },
    }),
  ]);

  const outcomeSummary = summariseActionOutcomes(
    experiments
      .filter((e) => e.action)
      .map((e) => ({
        actionType: e.action!.type,
        outcome: e.outcome,
        deltaPct: e.deltaPct,
      })),
  );

  return {
    website,
    plan: plan
      ? {
          ...plan,
          today: readJson<PlanItem[]>(plan.today, []),
          thisWeek: readJson<PlanItem[]>(plan.thisWeek, []),
          thisMonth: readJson<PlanItem[]>(plan.thisMonth, []),
          biggestProblems: readJson<string[]>(plan.biggestProblems, []),
          biggestOpportunities: readJson<string[]>(plan.biggestOpportunities, []),
          observedResults: readJson<string[]>(plan.observedResults, []),
        }
      : null,
    actions,
    experiments,
    agentRuns,
    latestManagerRun,
    outcomeSummary,
  };
}

export type StrategyData = Awaited<ReturnType<typeof getStrategyData>>;
