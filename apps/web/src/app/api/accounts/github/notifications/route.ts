import { z } from 'zod';
import { markNotificationRead } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { readBody, route } from '@/lib/api';
import { platformCall } from '../../_lib';

/** `POST /api/accounts/github/notifications` — mark one notification thread as read. */
const bodySchema = z.object({ threadId: z.string().regex(/^\d+$/), accountId: z.string().optional() });

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const { secrets } = await loadPersonalAccount(user.id, 'GITHUB', body.accountId ?? null);
  await platformCall(() => markNotificationRead(secrets.credentials.accessToken ?? '', body.threadId));
  return { read: body.threadId };
});
