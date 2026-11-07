import { z } from 'zod';
import { isUniqueViolation, prisma } from '@seo/db';
import { ConflictError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly, requireScopedWebsite } from '@/app/api/_lib/common';
import { normaliseCommunity, topicFields } from '@/app/api/_lib/social';

/**
 * `POST /api/social/topics` — add a listening topic.
 *
 * A topic is a phrase in the audience's own words ("how do I track macros"), not a brand slogan;
 * the copy on the form says so. The platform list is restricted to platforms some reader can
 * actually search, so a topic can never silently target a platform that is never queried.
 */

const bodySchema = topicFields.extend({ websiteId: z.string().trim().min(1) });

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, body.websiteId);

  try {
    const topic = await prisma.socialTopic.create({
      data: {
        websiteId: website.id,
        name: body.name,
        query: body.query,
        keywords: body.keywords,
        negativeKeywords: body.negativeKeywords,
        platforms: [...new Set(body.platforms)],
        communities: [...new Set(body.communities.map(normaliseCommunity))],
        kind: body.kind,
        isActive: body.isActive,
        source: 'manual',
      },
    });
    return { topic };
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('A topic with that search phrase already exists for this site.');
    throw err;
  }
});
