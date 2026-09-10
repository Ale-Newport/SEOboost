import { z } from 'zod';
import { readQuery, route } from '@/lib/api';
import { getContentCalendar } from '@/server/queries/content';
import { resolveScope, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/content/calendar` — the cross-site pipeline, grouped by day and by stage.
 *
 * Drafts with no publish or schedule date are placed on the day they last moved; nothing is
 * projected into the future, so an empty week is an empty week rather than a guess.
 */

const querySchema = websiteScopeSchema.extend({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  return getContentCalendar({
    websiteIds: scope.websiteIds,
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(query.limit ? { limit: query.limit } : {}),
  });
});
