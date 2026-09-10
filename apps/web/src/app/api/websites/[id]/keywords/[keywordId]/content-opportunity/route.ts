import { OpportunityStatus, OpportunityType, json, prisma } from '@seo/db';
import { NotFoundError, ValidationError, createLogger, round } from '@seo/shared';
import { requireWebsite, route } from '@/lib/api';

const log = createLogger('api:keyword-opportunity');

type Params = { id: string; keywordId: string };

/**
 * Open a content opportunity for one keyword, so a brief can be created from it.
 *
 * `/api/content/briefs` takes an `opportunityId`, and nothing else in the API turns a keyword
 * into one — the Keywords screen's "Create content brief" button needs this step. It records
 * only facts that already exist: the keyword, its measured demand, and the scoring engine's own
 * reasoning. Nothing about the *content* — outline, questions, entities, competitors — is
 * produced here; that is the BRIEF pipeline stage's job, which has the SERP data to do it.
 *
 * Re-posting is safe: an open opportunity for the keyword is returned rather than duplicated.
 */
export const POST = route<Params>(async ({ user, params }) => {
  const website = await requireWebsite(user.id, params.id);

  const keyword = await prisma.keyword.findFirst({
    where: { id: params.keywordId, websiteId: website.id },
    select: {
      id: true,
      keyword: true,
      pageId: true,
      clusterId: true,
      clicks28d: true,
      impressions28d: true,
      currentPosition: true,
      searchVolume: true,
      difficulty: true,
      isContentGap: true,
      opportunityScore: true,
      opportunityReason: true,
    },
  });
  if (!keyword) throw new NotFoundError('Keyword');

  const existing = await prisma.contentOpportunity.findFirst({
    where: {
      websiteId: website.id,
      keywordId: keyword.id,
      status: {
        in: [OpportunityStatus.IDENTIFIED, OpportunityStatus.ACCEPTED, OpportunityStatus.IN_PROGRESS],
      },
    },
    select: { id: true, title: true, status: true },
    orderBy: { discoveredAt: 'desc' },
  });
  if (existing) return { opportunity: existing, created: false };

  if (keyword.opportunityScore === null) {
    throw new ValidationError(
      'This keyword has not been scored yet, so there is nothing to justify a brief. Run the keyword analysis for this site first.',
    );
  }

  // The type follows the evidence: a keyword already mapped to a page is an improvement, not a
  // new page. Guessing a more specific format (comparison, glossary…) would need SERP data.
  const type = keyword.pageId === null ? OpportunityType.NEW_ARTICLE : OpportunityType.IMPROVE_EXISTING_PAGE;

  const reasoning =
    keyword.opportunityReason ??
    `Opportunity score ${Math.round(keyword.opportunityScore)}/100, from ` +
      `${keyword.impressions28d.toLocaleString()} impressions and ${keyword.clicks28d.toLocaleString()} clicks ` +
      `in the last 28 days` +
      (keyword.currentPosition === null
        ? ', with no current ranking.'
        : ` at average position ${keyword.currentPosition.toFixed(1)}.`);

  const opportunity = await prisma.contentOpportunity.create({
    data: {
      websiteId: website.id,
      keywordId: keyword.id,
      ...(keyword.clusterId === null ? {} : { clusterId: keyword.clusterId }),
      ...(keyword.pageId === null ? {} : { pageId: keyword.pageId }),
      type,
      // Accepted, not identified: a person asked for this one by name.
      status: OpportunityStatus.ACCEPTED,
      title: keyword.keyword,
      targetKeyword: keyword.keyword,
      reasoning,
      evidence: json({
        origin: 'keywords-screen',
        requestedBy: user.id,
        impressions28d: keyword.impressions28d,
        clicks28d: keyword.clicks28d,
        currentPosition: keyword.currentPosition,
        searchVolume: keyword.searchVolume,
        difficulty: keyword.difficulty,
        isContentGap: keyword.isContentGap,
      }),
      // Impact is the engine's own opportunity score. Effort and confidence stay at zero because
      // nothing here measures them, and an invented number would mis-rank the whole backlog.
      impactScore: round(keyword.opportunityScore, 1),
      priorityScore: round(keyword.opportunityScore, 1),
    },
    select: { id: true, title: true, status: true },
  });

  log.info('content opportunity opened from keyword', {
    websiteId: website.id,
    keywordId: keyword.id,
    opportunityId: opportunity.id,
  });

  return { opportunity, created: true };
});
