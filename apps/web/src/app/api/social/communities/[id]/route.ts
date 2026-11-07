import { z } from 'zod';
import { prisma } from '@seo/db';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { requireOwnedCommunity } from '@/app/api/_lib/social';

/**
 * `PATCH /api/social/communities/[id]` — the operator's word on a community.
 *
 * Blocking wins over everything: a blocked community is dropped from listening and refused by
 * the publish-time guardrail. A policy override is for when the rules classifier read the rules
 * wrongly; the next rules refresh may re-classify it, which the screen explains.
 */

const bodySchema = z.object({
  isBlocked: z.boolean().optional(),
  promotionPolicy: z.enum(['ALLOWED', 'RESTRICTED', 'FORBIDDEN', 'UNKNOWN']).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const PATCH = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const community = await requireOwnedCommunity(user, params.id);

  const updated = await prisma.socialCommunity.update({
    where: { id: community.id },
    data: {
      ...(body.isBlocked === undefined ? {} : { isBlocked: body.isBlocked }),
      ...(body.promotionPolicy === undefined ? {} : { promotionPolicy: body.promotionPolicy }),
      ...(body.notes === undefined ? {} : { notes: body.notes || null }),
    },
  });
  return { community: updated };
});
