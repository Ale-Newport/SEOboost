import { z } from 'zod';
import { updateSocialPostDraft } from '@seo/agents';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { requireOwnedPost } from '@/app/api/_lib/social';

/**
 * `PATCH /api/social/posts/[id]` — edit a post that has not gone out yet.
 *
 * The action payload is updated alongside the post (inside `updateSocialPostDraft`), so the text
 * waiting in Approvals is always the text that will be published.
 */

const bodySchema = z.object({
  body: z.string().trim().min(2).max(100_000).optional(),
  title: z.string().trim().max(300).nullable().optional(),
  community: z.string().trim().max(120).nullable().optional(),
  scheduledFor: z.string().datetime({ offset: true }).nullable().optional(),
});

export const PATCH = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const post = await requireOwnedPost(user, params.id);

  const updated = await updateSocialPostDraft(post.id, [post.websiteId], {
    ...(body.body === undefined ? {} : { body: body.body }),
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.community === undefined ? {} : { community: body.community }),
    ...(body.scheduledFor === undefined ? {} : { scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null }),
  });
  return { post: { id: updated.id, status: updated.status, body: updated.body, scheduledFor: updated.scheduledFor } };
});
