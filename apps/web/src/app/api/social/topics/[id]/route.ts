import { isUniqueViolation, prisma } from '@seo/db';
import { ConflictError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { normaliseCommunity, requireOwnedTopic, topicFields } from '@/app/api/_lib/social';

/**
 * `PATCH | DELETE /api/social/topics/[id]`.
 *
 * Deleting a topic keeps the conversations it found (their `topicId` is nulled by the schema):
 * a thread already in the inbox, or already answered, is history the operator may still need.
 */

const patchSchema = topicFields.partial();

export const PATCH = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, patchSchema);
  await assertNotReadOnly();
  const topic = await requireOwnedTopic(user, params.id);

  try {
    const updated = await prisma.socialTopic.update({
      where: { id: topic.id },
      data: {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.query === undefined ? {} : { query: body.query }),
        ...(body.keywords === undefined ? {} : { keywords: body.keywords }),
        ...(body.negativeKeywords === undefined ? {} : { negativeKeywords: body.negativeKeywords }),
        ...(body.platforms === undefined ? {} : { platforms: [...new Set(body.platforms)] }),
        ...(body.communities === undefined ? {} : { communities: [...new Set(body.communities.map(normaliseCommunity))] }),
        ...(body.kind === undefined ? {} : { kind: body.kind }),
        ...(body.isActive === undefined ? {} : { isActive: body.isActive }),
      },
    });
    return { topic: updated };
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A topic with that search phrase already exists for this site.');
    throw err;
  }
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const topic = await requireOwnedTopic(user, params.id);
  await prisma.socialTopic.delete({ where: { id: topic.id } });
  return { removed: topic.id };
});
