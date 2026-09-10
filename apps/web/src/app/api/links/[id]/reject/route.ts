import { z } from 'zod';
import { SuggestionStatus, prisma } from '@seo/db';
import { ConflictError, NotFoundError } from '@seo/shared';
import { readBody, requireWebsite, route } from '@/lib/api';

/**
 * `POST /api/links/[id]/reject`.
 *
 * The reason is stored on the row: the link suggester reads rejected pairs back so the same
 * source → target suggestion is not re-proposed on every analysis run.
 */

const bodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);

  const suggestion = await prisma.internalLinkSuggestion.findUnique({
    where: { id: params.id },
    select: { id: true, websiteId: true, status: true },
  });
  if (!suggestion) throw new NotFoundError('Link suggestion');
  await requireWebsite(user.id, suggestion.websiteId);

  if (suggestion.status === SuggestionStatus.APPLIED) {
    throw new ConflictError('This link has already been applied and cannot be rejected.');
  }

  const updated = await prisma.internalLinkSuggestion.update({
    where: { id: suggestion.id },
    data: {
      status: SuggestionStatus.REJECTED,
      rejectedReason: body.reason ?? 'Rejected by the operator.',
    },
  });

  return { suggestion: updated };
});
