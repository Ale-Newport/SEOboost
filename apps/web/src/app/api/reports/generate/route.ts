import { z } from 'zod';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite } from '@/app/api/_lib/common';

/**
 * `POST /api/reports/generate`.
 *
 * A `portfolio` report spans every site the user owns and therefore carries no `websiteId`;
 * every other type needs one. The period is optional — the generator derives the window from
 * the report type when it is omitted, which is the behaviour the scheduler relies on.
 */

const bodySchema = z
  .object({
    websiteId: z.string().trim().min(1).optional(),
    type: z.enum(['weekly', 'monthly', 'quarterly', 'portfolio', 'custom']),
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((value) => value.type === 'portfolio' || Boolean(value.websiteId), {
    message: 'websiteId is required for every report type except "portfolio".',
  })
  .refine(
    (value) => value.type !== 'custom' || (Boolean(value.periodStart) && Boolean(value.periodEnd)),
    { message: 'A custom report needs both periodStart and periodEnd.' },
  );

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);

  const website = body.websiteId ? await requireScopedWebsite(user, body.websiteId) : null;

  const result = await enqueue(
    'reports.generate',
    {
      ...(website ? { websiteId: website.id } : {}),
      type: body.type,
      ...(body.periodStart ? { periodStart: body.periodStart } : {}),
      ...(body.periodEnd ? { periodEnd: body.periodEnd } : {}),
      userId: user.id,
    },
    { websiteId: website?.id ?? null, trigger: 'manual' },
  );

  return { type: body.type, websiteId: website?.id ?? null, job: enqueueSummary(result) };
});
