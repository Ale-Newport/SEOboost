import { z } from 'zod';
import { redditMarkRead, redditReply } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { platformCall } from '../../_lib';

/**
 * `POST /api/accounts/reddit/inbox` — mark inbox items read, or reply to one.
 *
 * Replying to someone who wrote to you (a reply to your comment, a mention, a message) is a
 * conversation you are already in, so it is sent as written; posting into communities goes
 * through `/compose` and its guardrails.
 */
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), ids: z.array(z.string().regex(/^t[134]_[a-z0-9]+$/i)).min(1).max(100), accountId: z.string().optional() }),
  z.object({ action: z.literal('reply'), thingId: z.string().regex(/^t[134]_[a-z0-9]+$/i), body: z.string().trim().min(2).max(10_000), accountId: z.string().optional() }),
]);

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const { secrets } = await loadPersonalAccount(user.id, 'REDDIT', body.accountId ?? null);
  const token = secrets.credentials.accessToken ?? '';
  if (body.action === 'read') {
    await platformCall(() => redditMarkRead(token, body.ids));
    return { read: body.ids.length };
  }
  return platformCall(() => redditReply(token, body.thingId, body.body));
});
