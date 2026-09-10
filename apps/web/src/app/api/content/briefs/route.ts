import { z } from 'zod';
import { OpportunityStatus, prisma } from '@seo/db';
import { ValidationError, createLogger, paginationSchema } from '@seo/shared';
import { readBody, readQuery, route } from '@/lib/api';
import { getOpportunity, listBriefs } from '@/server/queries/content';
import { resolveScope, websiteScopeSchema } from '@/app/api/_lib/common';

const log = createLogger('api:content');

/**
 * `/api/content/briefs` — list, and create one from an accepted opportunity.
 *
 * The brief created here is a *skeleton*: it carries across exactly the facts the opportunity
 * already established (target keyword, secondaries, intent, suggested URL) and nothing else.
 * The outline, questions, entities and competitor analysis are produced by the BRIEF pipeline
 * stage, which has the SERP data and the brand knowledge base — inventing them here would put
 * unsourced content in front of a writer.
 */

const listQuerySchema = websiteScopeSchema.merge(paginationSchema).extend({
  status: z.string().trim().max(40).optional(),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, listQuerySchema);
  const scope = await resolveScope(user, query.websiteId);

  return listBriefs({
    websiteIds: scope.websiteIds,
    ...(query.status ? { status: query.status } : {}),
    ...(query.search ? { search: query.search } : {}),
    page: query.page,
    pageSize: query.pageSize,
  });
});

const createSchema = z.object({
  opportunityId: z.string().trim().min(1),
  /** Overrides the keyword carried from the opportunity, when the operator picked a better one. */
  targetKeyword: z.string().trim().max(300).optional(),
  audience: z.string().trim().max(500).optional(),
  targetWordCount: z.coerce.number().int().min(100).max(20_000).optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, createSchema);
  const opportunity = await getOpportunity(user.id, body.opportunityId);

  const targetKeyword =
    body.targetKeyword ?? opportunity.targetKeyword ?? opportunity.keyword?.keyword ?? null;
  if (!targetKeyword) {
    throw new ValidationError(
      'This opportunity has no target keyword. Pass targetKeyword explicitly, or link a keyword to the opportunity first.',
    );
  }

  const brief = await prisma.$transaction(async (tx) => {
    const created = await tx.contentBrief.create({
      data: {
        websiteId: opportunity.websiteId,
        opportunityId: opportunity.id,
        title: opportunity.title,
        targetKeyword,
        secondaryKeywords: opportunity.secondaryKeywords,
        intent: opportunity.keyword?.intent ?? 'UNKNOWN',
        funnelStage: opportunity.keyword?.funnelStage ?? 'UNKNOWN',
        audience: body.audience ?? null,
        suggestedUrl: opportunity.suggestedUrl ?? null,
        targetWordCount: body.targetWordCount ?? null,
        status: 'DRAFT',
      },
    });

    // Accepting is implicit: a brief exists, so the opportunity is being worked on.
    if (
      opportunity.status === OpportunityStatus.IDENTIFIED ||
      opportunity.status === OpportunityStatus.ACCEPTED
    ) {
      await tx.contentOpportunity.update({
        where: { id: opportunity.id },
        data: { status: OpportunityStatus.IN_PROGRESS },
      });
    }
    return created;
  });

  log.info('content brief created from opportunity', {
    briefId: brief.id,
    opportunityId: opportunity.id,
  });

  return {
    brief,
    nextStep:
      'Run the BRIEF pipeline stage on a draft created from this brief to fill in the outline, ' +
      'questions and competitor analysis.',
  };
});
