import { prisma } from '@seo/db';
import { isAiAvailable } from '@seo/ai';
import { readQuery, route } from '@/lib/api';
import { resolveScope, websiteScopeSchema } from '@/app/api/_lib/common';
import { AGENT_CATALOGUE, type AgentCatalogueEntry } from '@/app/api/_lib/agents';

/**
 * `GET /api/agents` — the registered agents with their last run.
 *
 * The catalogue is unioned with the distinct agent keys that actually appear in `AgentRun`
 * history, so an agent the worker runs but this build does not describe still shows up (as
 * `known: false`) rather than disappearing from the screen.
 */

interface AgentRow extends Partial<AgentCatalogueEntry> {
  key: string;
  label: string;
  known: boolean;
  runnable: boolean;
  blockedReason: string | null;
  lastRun: {
    id: string;
    status: string;
    summary: string | null;
    startedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
    actionsCreated: number;
    error: string | null;
  } | null;
  runCount: number;
}

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, websiteScopeSchema);
  const scope = await resolveScope(user, query.websiteId);
  const aiReady = isAiAvailable();

  const [runCounts, latestRuns] = await Promise.all([
    scope.websiteIds.length
      ? prisma.agentRun.groupBy({
          by: ['agent'],
          where: { websiteId: { in: scope.websiteIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    scope.websiteIds.length
      ? prisma.agentRun.findMany({
          where: { websiteId: { in: scope.websiteIds } },
          orderBy: { startedAt: 'desc' },
          // Enough to cover the newest run of every agent without loading the whole history.
          take: 200,
          select: {
            id: true,
            agent: true,
            status: true,
            summary: true,
            startedAt: true,
            finishedAt: true,
            durationMs: true,
            actionsCreated: true,
            error: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const countByAgent = new Map(runCounts.map((row) => [row.agent, row._count._all]));
  const lastRunByAgent = new Map<string, (typeof latestRuns)[number]>();
  for (const run of latestRuns) {
    if (!lastRunByAgent.has(run.agent)) lastRunByAgent.set(run.agent, run);
  }

  const rows: AgentRow[] = AGENT_CATALOGUE.map((agent) => {
    const lastRun = lastRunByAgent.get(agent.key) ?? null;
    const blocked = agent.requiresAi && !aiReady;
    return {
      ...agent,
      known: true,
      runnable: !blocked,
      blockedReason: blocked
        ? 'This agent needs a configured AI provider. Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY.'
        : null,
      lastRun: lastRun
        ? {
            id: lastRun.id,
            status: lastRun.status,
            summary: lastRun.summary,
            startedAt: lastRun.startedAt,
            finishedAt: lastRun.finishedAt,
            durationMs: lastRun.durationMs,
            actionsCreated: lastRun.actionsCreated,
            error: lastRun.error,
          }
        : null,
      runCount: countByAgent.get(agent.key) ?? 0,
    };
  });

  const described = new Set(AGENT_CATALOGUE.map((agent) => agent.key));
  for (const [key, run] of lastRunByAgent) {
    if (described.has(key)) continue;
    rows.push({
      key,
      label: key,
      known: false,
      runnable: false,
      blockedReason: 'This agent is not in this build’s catalogue; it can only be run by the worker.',
      lastRun: {
        id: run.id,
        status: run.status,
        summary: run.summary,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        actionsCreated: run.actionsCreated,
        error: run.error,
      },
      runCount: countByAgent.get(key) ?? 0,
    });
  }

  return { agents: rows, aiConfigured: aiReady, websiteId: query.websiteId ?? null };
});
