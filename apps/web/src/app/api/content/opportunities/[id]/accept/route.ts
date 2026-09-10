import { z } from 'zod';
import { OpportunityStatus, json, prisma, readJson } from '@seo/db';
import { ConflictError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { getOpportunity } from '@/server/queries/content';

/**
 * `POST /api/content/opportunities/[id]/accept`.
 *
 * Accepting only moves the status. Turning it into work is a separate, explicit call
 * (`POST /api/content/briefs`) so accepting a batch never silently starts model spend.
 */

const bodySchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const opportunity = await getOpportunity(user.id, params.id);

  if (opportunity.status === OpportunityStatus.COMPLETED) {
    throw new ConflictError('This opportunity is already completed.');
  }

  // The note is merged into `evidence` rather than replacing it: evidence is the audit trail
  // of why the opportunity was raised, and a human note belongs alongside it, not instead of it.
  const evidence = readJson<Record<string, unknown>>(opportunity.evidence, {});

  const updated = await prisma.contentOpportunity.update({
    where: { id: opportunity.id },
    data: {
      status: OpportunityStatus.ACCEPTED,
      ...(body.note ? { evidence: json({ ...evidence, acceptanceNote: body.note }) } : {}),
    },
    select: { id: true, status: true, updatedAt: true },
  });

  return {
    opportunity: updated,
    nextStep: 'POST /api/content/briefs with this opportunityId to create a brief.',
  };
});
