import { z } from 'zod';
import { composeRedditAsPersonal } from '@seo/agents';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { enqueuePostDispatch } from '@/app/api/_lib/social';
import { platformCall } from '../../_lib';

/**
 * `POST /api/accounts/reddit/compose` — post or comment as the linked Reddit account.
 *
 * With a site chosen, it is queued through that site's social module (caps, approvals trail,
 * publish-time guardrails) and dispatched. Without one, the same guardrail functions run against
 * this account's own recent activity before anything is submitted; a blocked draft comes back
 * with the reasons instead of an error.
 */
const bodySchema = z.object({
  kind: z.enum(['post', 'comment']),
  subreddit: z.string().trim().max(40).optional(),
  title: z.string().trim().max(300).optional(),
  body: z.string().trim().min(2).max(10_000),
  thingId: z.string().regex(/^t[13]_[a-z0-9]+$/i).optional(),
  websiteId: z.string().trim().min(1).optional(),
  accountId: z.string().optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const outcome = await platformCall(() =>
    composeRedditAsPersonal({
      userId: user.id,
      accountId: body.accountId ?? null,
      kind: body.kind,
      subreddit: body.subreddit ?? null,
      title: body.title ?? null,
      body: body.body,
      thingId: body.thingId ?? null,
      websiteId: body.websiteId ?? null,
    }),
  );
  if (outcome.status === 'queued') {
    const job = await enqueuePostDispatch({ id: outcome.postId, websiteId: outcome.websiteId, scheduledFor: null }, 'create');
    return { ...outcome, job };
  }
  return outcome;
});
