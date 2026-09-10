import { z } from 'zod';
import { OpportunityStatus, json, prisma, readJson } from '@seo/db';
import { ConflictError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { getOpportunity } from '@/server/queries/content';

/**
 * `POST /api/content/opportunities/[id]/reject`.
 *
 * The row is kept and the reason recorded on `evidence`: a rejected opportunity is the signal
 * the discovery pass needs so it stops re-proposing the same thing every run.
 */

const bodySchema = z.object({
  reason: z.string().trim().max(1000).optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const opportunity = await getOpportunity(user.id, params.id);

  if (opportunity.status === OpportunityStatus.COMPLETED) {
    throw new ConflictError('This opportunity is already completed and cannot be rejected.');
  }

  const evidence = readJson<Record<string, unknown>>(opportunity.evidence, {});
  const updated = await prisma.contentOpportunity.update({
    where: { id: opportunity.id },
    data: {
      status: OpportunityStatus.REJECTED,
      evidence: json({
        ...evidence,
        rejectedAt: new Date().toISOString(),
        ...(body.reason ? { rejectionReason: body.reason } : {}),
      }),
    },
    select: { id: true, status: true, updatedAt: true },
  });

  return { opportunity: updated };
});
