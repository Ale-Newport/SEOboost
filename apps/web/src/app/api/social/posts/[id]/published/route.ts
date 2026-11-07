import { z } from 'zod';
import { markSocialPostPublished } from '@seo/agents';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { requireOwnedPost } from '@/app/api/_lib/social';

/**
 * `POST /api/social/posts/[id]/published` — "I posted this by hand".
 *
 * Closes the loop for platforms with no posting API (Hacker News) or no connected account: the
 * action completes, the thread is marked answered, and the URL — when given — lets the metrics
 * and the history screen point at the real post.
 */

const bodySchema = z.object({
  externalUrl: z.string().trim().url().nullable().optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const post = await requireOwnedPost(user, params.id);
  const updated = await markSocialPostPublished(post.id, [post.websiteId], user.id, body.externalUrl ?? null);
  return { post: { id: updated.id, status: updated.status, externalUrl: updated.externalUrl } };
});
