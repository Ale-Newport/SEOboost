import { z } from 'zod';
import { readQuery, route } from '@/lib/api';
import { CONVERSATION_FILTERS } from '@/components/social/types';
import { getSocialOverview } from '@/server/queries/social';

/**
 * `GET /api/social?websiteId=&filter=` — the Social screen's read model.
 *
 * The same function backs the server-rendered page, so the API and the screen cannot disagree
 * about what a site's social state is. Credentials are never part of it.
 */

const querySchema = z.object({
  websiteId: z.string().trim().min(1),
  filter: z.enum(CONVERSATION_FILTERS).default('open'),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  return getSocialOverview(user.id, query.websiteId, { conversationFilter: query.filter });
});
