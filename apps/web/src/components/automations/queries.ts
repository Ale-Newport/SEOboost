import 'server-only';
import { AgentRunStatus, prisma } from '@seo/db';
import type { AutonomyLevel } from '@seo/db';
import { ForbiddenError, NotFoundError, isConfigured, startOfMonth } from '@seo/shared';
import { type ScheduleSummary, ensureDefaultSchedules, listSchedules } from '@seo/queue';
import { AGENT_CATALOGUE, type AgentCatalogueEntry } from '@/app/api/_lib/agents';

/**
 * Read model for the per-site Automations screen.
 *
 * It lives beside the view because nothing else reads it. Two things are worth knowing:
 *
 *  - `ensureDefaultSchedules` is called on load. It is idempotent, touches no broker, and only
 *    projects the site's own `WebsiteSettings` cron columns into `ScheduledJob` rows — without it
 *    a site whose settings were edited before the scheduler ever ran would show no schedules at
 *    all, which would read as "automation is off" rather than "the rows are not created yet".
 *  - month-to-date spend is summed from `AiUsage`, so a site with no AI runs reports 0 rather
 *    than an estimate.
 */

export interface AgentSummary extends AgentCatalogueEntry {
  /** The most recent run of this agent for this site, or null when it has never run here. */
  lastRun: {
    id: string;
    status: AgentRunStatus;
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
    summary: string | null;
    actionsCreated: number;
    costUsd: number | null;
    error: string | null;
  } | null;
  /** Total runs recorded for this site. */
  runCount: number;
  /** The agent needs an AI provider and none is configured. */
  blockedByMissingAi: boolean;
}

export interface AutomationsData {
  website: { id: string; name: string; domain: string; status: string };
  automation: {
    autonomyLevel: AutonomyLevel;
    autoApproveSafe: boolean;
    monthlyAiBudgetUsd: number | null;
  };
  schedules: ScheduleSummary[];
  agents: AgentSummary[];
  spend: {
    monthToDateUsd: number;
    /** Calls recorded this month — 0 means nothing has been spent, not "unknown". */
    calls: number;
    periodStart: Date;
  };
  environment: {
    aiConfigured: boolean;
    /** Without a broker, schedules and "run now" record a job that no worker will pick up. */
    queueConfigured: boolean;
  };
}

export async function getAutomationsData(userId: string, websiteId: string): Promise<AutomationsData> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, userId: true, name: true, domain: true, status: true, settings: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const settings =
    website.settings ?? (await prisma.websiteSettings.create({ data: { websiteId: website.id } }));

  await ensureDefaultSchedules(website.id);

  const periodStart = startOfMonth(new Date());
  const [schedules, latestRuns, runCounts, spend] = await Promise.all([
    listSchedules(website.id),
    prisma.agentRun.findMany({
      where: { websiteId: website.id },
      orderBy: { startedAt: 'desc' },
      // One row per agent is all the screen shows; a generous cap keeps that true for every agent
      // without a query per agent.
      take: 200,
      select: {
        id: true,
        agent: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        summary: true,
        actionsCreated: true,
        costUsd: true,
        error: true,
      },
    }),
    prisma.agentRun.groupBy({
      by: ['agent'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.aiUsage.aggregate({
      where: { websiteId: website.id, createdAt: { gte: periodStart } },
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
  ]);

  const aiConfigured = isConfigured.anyAi();
  const countByAgent = new Map(runCounts.map((row) => [row.agent, row._count._all]));

  const agents: AgentSummary[] = AGENT_CATALOGUE.map((entry) => {
    // Runs are recorded under either the registry key or the framework class name, depending on
    // which caller queued them; match both rather than showing "never run" for a real run.
    const lastRun =
      latestRuns.find((run) => run.agent === entry.key || run.agent === entry.name) ?? null;
    const runCount = (countByAgent.get(entry.key) ?? 0) + (countByAgent.get(entry.name) ?? 0);

    return {
      ...entry,
      lastRun,
      runCount,
      blockedByMissingAi: entry.requiresAi && !aiConfigured,
    };
  });

  return {
    website: {
      id: website.id,
      name: website.name,
      domain: website.domain,
      status: website.status,
    },
    automation: {
      autonomyLevel: settings.autonomyLevel,
      autoApproveSafe: settings.autoApproveSafe,
      monthlyAiBudgetUsd: settings.monthlyAiBudgetUsd,
    },
    schedules,
    agents,
    spend: {
      monthToDateUsd: spend._sum.costUsd ?? 0,
      calls: spend._count._all,
      periodStart,
    },
    environment: {
      aiConfigured,
      queueConfigured: isConfigured.redis(),
    },
  };
}
