import { z } from 'zod';
import { fetchRedditIdentity, redditHistory, redditInbox, redditSubscriptions } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { readQuery, route } from '@/lib/api';
import { personalAccountWire, platformCall } from '../../_lib';

/** `GET /api/accounts/reddit/overview` — profile and karma, inbox, my recent posts/comments, subscriptions. */
const querySchema = z.object({ accountId: z.string().optional() });

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const { account, secrets } = await loadPersonalAccount(user.id, 'REDDIT', query.accountId ?? null);
  const token = secrets.credentials.accessToken ?? '';
  const profile = await platformCall(() => fetchRedditIdentity(token));
  const [inbox, history, subscriptions] = await platformCall(() =>
    Promise.all([redditInbox(token), redditHistory(token, profile.name), redditSubscriptions(token)]),
  );
  return { account: personalAccountWire(account), profile, inbox, history, subscriptions };
});
