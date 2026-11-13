import { z } from 'zod';
import { fetchGitHubIdentity, listMyRepos, listNotifications } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { readQuery, route } from '@/lib/api';
import { personalAccountWire, platformCall } from '../../_lib';

/** `GET /api/accounts/github/overview` — profile, my repositories and the notifications inbox. */
const querySchema = z.object({ accountId: z.string().optional(), all: z.enum(['true', 'false']).optional() });

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const { account, secrets } = await loadPersonalAccount(user.id, 'GITHUB', query.accountId ?? null);
  const token = secrets.credentials.accessToken ?? '';
  const [profile, repos, notifications] = await platformCall(() =>
    Promise.all([fetchGitHubIdentity(token), listMyRepos(token), listNotifications(token, query.all === 'true')]),
  );
  return { account: personalAccountWire(account), profile, repos, notifications };
});
