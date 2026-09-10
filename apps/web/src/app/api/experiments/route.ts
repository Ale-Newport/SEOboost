import { z } from 'zod';
import {
  ExperimentOutcome,
  ExperimentStatus,
  type Prisma,
  buildPaginated,
  paginate,
  prisma,
  readJson,
} from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { summariseActionOutcomes } from '@seo/seo-engine';
import { readQuery, route } from '@/lib/api';
import {
  multiValueParam,
  parseEnumList,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `GET /api/experiments?websiteId=` — measured changes and what they did.
 *
 * The roll-up comes from `summariseActionOutcomes`, which only counts experiments that have
 * actually been evaluated. Nothing is projected for a change that is still inside its
 * measurement window: the honest answer there is "not yet", and the UI shows it that way.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  status: multiValueParam,
  outcome: multiValueParam,
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  if (scope.websiteIds.length === 0) {
    return { ...buildPaginated([], 0, query.page, query.pageSize), summary: null };
  }

  const where: Prisma.ExperimentWhereInput = {
    websiteId: { in: scope.websiteIds },
    ...(() => {
      const statuses = parseEnumList(query.status, Object.values(ExperimentStatus));
      return statuses?.length ? { status: { in: statuses } } : {};
    })(),
    ...(() => {
      const outcomes = parseEnumList(query.outcome, Object.values(ExperimentOutcome));
      return outcomes?.length ? { outcome: { in: outcomes } } : {};
    })(),
  };

  const [rows, total, all] = await Promise.all([
    prisma.experiment.findMany({
      where,
      orderBy: [{ measureStart: 'desc' }],
      ...paginate(query.page, query.pageSize),
      include: {
        website: { select: { id: true, name: true, domain: true } },
        action: { select: { id: true, type: true, title: true, status: true, executedAt: true } },
        page: { select: { id: true, url: true, title: true } },
      },
    }),
    prisma.experiment.count({ where }),
    prisma.experiment.findMany({
      where: { websiteId: { in: scope.websiteIds } },
      select: { outcome: true, deltaPct: true, action: { select: { type: true } } },
    }),
  ]);

  const summary = summariseActionOutcomes(
    all
      .filter((row) => row.action !== null)
      .map((row) => ({
        actionType: row.action?.type ?? 'CUSTOM',
        outcome: row.outcome,
        deltaPct: row.deltaPct,
      })),
  );

  return {
    ...buildPaginated(
      rows.map((row) => ({
        ...row,
        beforeState: readJson<Record<string, unknown>>(row.beforeState, {}),
        afterState: readJson<Record<string, unknown>>(row.afterState, {}),
        baselineMetrics: readJson<Record<string, number>>(row.baselineMetrics, {}),
        resultMetrics: readJson<Record<string, number>>(row.resultMetrics, {}),
      })),
      total,
      query.page,
      query.pageSize,
    ),
    summary,
  };
});
