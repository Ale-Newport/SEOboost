import { z } from 'zod';
import { prisma } from '@seo/db';
import { SOCIAL_HARD_LIMITS } from '@seo/seo-engine';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly, requireScopedWebsite } from '@/app/api/_lib/common';

/**
 * `PATCH /api/social/settings` — the site's social caps, disclosure and UTM campaign.
 *
 * The bounds come from `SOCIAL_HARD_LIMITS`, the same constants the guardrails clamp to, so the
 * operator can tighten the caps but this endpoint cannot be used to lift them.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  socialDailyPostLimit: z.number().int().min(1).max(SOCIAL_HARD_LIMITS.dailyPostsPerAccount).optional(),
  socialDailyReplyLimit: z.number().int().min(0).max(SOCIAL_HARD_LIMITS.dailyReplies).optional(),
  socialMaxPromoRatio: z.number().min(0).max(SOCIAL_HARD_LIMITS.maxPromoRatio).optional(),
  socialDisclosure: z.string().trim().max(300).nullable().optional(),
  socialUtmCampaign: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_-]+$/i, 'Use letters, digits, dashes or underscores — it ends up in a URL.')
    .optional(),
});

export const PATCH = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, body.websiteId);

  const data = {
    ...(body.socialDailyPostLimit === undefined ? {} : { socialDailyPostLimit: body.socialDailyPostLimit }),
    ...(body.socialDailyReplyLimit === undefined ? {} : { socialDailyReplyLimit: body.socialDailyReplyLimit }),
    ...(body.socialMaxPromoRatio === undefined ? {} : { socialMaxPromoRatio: body.socialMaxPromoRatio }),
    ...(body.socialDisclosure === undefined ? {} : { socialDisclosure: body.socialDisclosure || null }),
    ...(body.socialUtmCampaign === undefined ? {} : { socialUtmCampaign: body.socialUtmCampaign }),
  };

  const settings = await prisma.websiteSettings.upsert({
    where: { websiteId: website.id },
    create: { websiteId: website.id, ...data },
    update: data,
    select: {
      socialDailyPostLimit: true,
      socialDailyReplyLimit: true,
      socialMaxPromoRatio: true,
      socialDisclosure: true,
      socialUtmCampaign: true,
    },
  });
  return { settings };
});
