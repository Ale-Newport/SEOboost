import { z } from 'zod';
import { ActionRisk, ActionStatus, ActionType } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import {
  type ActionSort,
  getActionSummary,
  listActions,
} from '@/server/queries/actions';
import {
  multiValueParam,
  parseEnumList,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `GET /api/actions` — the prioritised action queue.
 *
 * Without `websiteId` this spans every site the user owns, which is what the portfolio queue
 * needs; with one it is a single-site view. Either way the set of readable websites is
 * resolved from ownership first, so a filter can never widen the scope.
 */

const SORTS: ActionSort[] = ['priorityScore', 'proposedAt', 'updatedAt', 'impactScore'];

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  status: multiValueParam,
  type: multiValueParam,
  risk: multiValueParam,
  minPriority: z.coerce.number().min(0).max(100).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  const sort = SORTS.find((candidate) => candidate === query.sort) ?? 'priorityScore';

  const filters = {
    websiteIds: scope.websiteIds,
    status: parseEnumList(query.status, Object.values(ActionStatus)),
    type: parseEnumList(query.type, Object.values(ActionType)),
    risk: parseEnumList(query.risk, Object.values(ActionRisk)),
    ...(query.minPriority === undefined ? {} : { minPriority: query.minPriority }),
    ...(query.search ? { search: query.search } : {}),
    page: query.page,
    pageSize: query.pageSize,
    sort,
    order: query.order,
  };

  const [page, summary] = await Promise.all([
    listActions(filters),
    getActionSummary(scope.websiteIds),
  ]);

  return { ...page, summary, scope: { websiteIds: scope.websiteIds, websiteId: query.websiteId ?? null } };
});
