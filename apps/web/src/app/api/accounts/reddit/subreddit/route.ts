import { z } from 'zod';
import { readRedditCredentials, redditCommunityInfo, redditSubredditListing } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { classifyPromotionPolicy } from '@seo/seo-engine';
import { readQuery, route } from '@/lib/api';
import { platformCall } from '../../_lib';

/** `GET /api/accounts/reddit/subreddit` — a subreddit's hot/new posts, its rules and what they allow. */
const querySchema = z.object({
  name: z.string().trim().min(2).max(40),
  sort: z.enum(['hot', 'new']).default('hot'),
  accountId: z.string().optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const { secrets } = await loadPersonalAccount(user.id, 'REDDIT', query.accountId ?? null);
  const token = secrets.credentials.accessToken ?? '';
  const [posts, info] = await platformCall(() =>
    Promise.all([redditSubredditListing(token, query.name, query.sort), redditCommunityInfo(query.name, readRedditCredentials(secrets.credentials))]),
  );
  const policy = classifyPromotionPolicy(info.rules, info.description);
  return { subreddit: info, policy, posts };
});
