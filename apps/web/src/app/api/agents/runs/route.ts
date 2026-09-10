import { z } from 'zod';
import { AgentRunStatus, type Prisma, buildPaginated, paginate, prisma, readJson } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import {
  multiValueParam,
  parseEnumList,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `GET /api/agents/runs` — agent run history.
 *
 * `toolCalls` is the run transcript and can be large, so it is only included for a single run
 * (`runId`); the list view returns the header fields and the cost, which is what the table shows.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  agent: z.string().trim().max(80).optional(),
  status: multiValueParam,
  /** Return one run in full, including its tool-call transcript. */
  runId: z.string().trim().min(1).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  if (scope.websiteIds.length === 0) {
    return buildPaginated([], 0, query.page, query.pageSize);
  }

  if (query.runId) {
    const run = await prisma.agentRun.findFirst({
      where: { id: query.runId, websiteId: { in: scope.websiteIds } },
      include: { website: { select: { id: true, name: true, domain: true } } },
    });
    if (!run) return { run: null };
    return {
      run: {
        ...run,
        input: readJson<Record<string, unknown>>(run.input, {}),
        output: readJson<Record<string, unknown>>(run.output, {}),
        toolCalls: readJson<unknown[]>(run.toolCalls, []),
      },
    };
  }

  const where: Prisma.AgentRunWhereInput = {
    websiteId: { in: scope.websiteIds },
    ...(query.agent ? { agent: query.agent } : {}),
    ...(() => {
      const statuses = parseEnumList(query.status, Object.values(AgentRunStatus));
      return statuses?.length ? { status: { in: statuses } } : {};
    })(),
  };

  const [items, total] = await Promise.all([
    prisma.agentRun.findMany({
      where,
      orderBy: { startedAt: query.order },
      ...paginate(query.page, query.pageSize),
      select: {
        id: true,
        websiteId: true,
        agent: true,
        trigger: true,
        status: true,
        summary: true,
        confidence: true,
        actionsCreated: true,
        error: true,
        provider: true,
        model: true,
        tokensIn: true,
        tokensOut: true,
        costUsd: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        website: { select: { id: true, name: true, domain: true } },
      },
    }),
    prisma.agentRun.count({ where }),
  ]);

  return buildPaginated(items, total, query.page, query.pageSize);
});
