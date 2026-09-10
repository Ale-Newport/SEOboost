import { z } from 'zod';
import { OpportunityStatus, OpportunityType } from '@seo/db';
import { paginationSchema } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import { listOpportunities } from '@/server/queries/content';
import {
  multiValueParam,
  parseEnumList,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/** `GET /api/content/opportunities` — ranked content opportunities, highest priority first. */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  status: multiValueParam,
  type: multiValueParam,
  minPriority: z.coerce.number().min(0).max(100).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  return listOpportunities({
    websiteIds: scope.websiteIds,
    status: parseEnumList(query.status, Object.values(OpportunityStatus)),
    type: parseEnumList(query.type, Object.values(OpportunityType)),
    ...(query.minPriority === undefined ? {} : { minPriority: query.minPriority }),
    ...(query.search ? { search: query.search } : {}),
    page: query.page,
    pageSize: query.pageSize,
  });
});
