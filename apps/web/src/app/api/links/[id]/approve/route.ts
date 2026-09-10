import { z } from 'zod';
import { SuggestionStatus, prisma } from '@seo/db';
import { ConflictError, NotFoundError } from '@seo/shared';
import { readBody, requireWebsite, route } from '@/lib/api';

/**
 * `POST /api/links/[id]/approve` — mark one internal link suggestion as approved.
 *
 * Approving does not touch the site: applying is a separate call (`POST /api/links/apply`) that
 * batches approved suggestions into one adapter write, which is both cheaper and safer than a
 * write per link.
 */

const bodySchema = z.object({
  /** Replace the suggested anchor before approving. */
  anchorText: z.string().trim().min(1).max(300).optional(),
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
    throw new ConflictError('This link has already been applied.');
  }

  const updated = await prisma.internalLinkSuggestion.update({
    where: { id: suggestion.id },
    data: {
      status: SuggestionStatus.APPROVED,
      rejectedReason: null,
      ...(body.anchorText ? { anchorText: body.anchorText } : {}),
    },
  });

  return { suggestion: updated };
});
