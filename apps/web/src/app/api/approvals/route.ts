import { ActionRisk, ApprovalStatus } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import { getApprovalSummary, listApprovals } from '@/server/queries/approvals';
import {
  multiValueParam,
  parseEnumList,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';
import { z } from 'zod';

/**
 * `GET /api/approvals` — the pending queue with the diff for each item.
 *
 * Defaults to PENDING and to oldest-first: this is a to-do list, and the oldest undecided
 * change is the one holding work up.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  status: multiValueParam,
  risk: multiValueParam,
  kind: z.string().trim().max(60).optional(),
  // Overrides the shared default of `desc`: the approval queue reads oldest-first.
  order: z.enum(['asc', 'desc']).default('asc'),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  const [page, summary] = await Promise.all([
    listApprovals({
      websiteIds: scope.websiteIds,
      status: parseEnumList(query.status, Object.values(ApprovalStatus)),
      risk: parseEnumList(query.risk, Object.values(ActionRisk)),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.search ? { search: query.search } : {}),
      page: query.page,
      pageSize: query.pageSize,
      order: query.order,
    }),
    getApprovalSummary(scope.websiteIds),
  ]);

  return { ...page, summary };
});
