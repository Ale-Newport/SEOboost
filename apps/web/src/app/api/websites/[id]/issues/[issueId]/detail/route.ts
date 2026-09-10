import { prisma } from '@seo/db';
import { NotFoundError } from '@seo/shared';
import { requireWebsite, route } from '@/lib/api';

type Params = { id: string; issueId: string };

/**
 * `GET /api/websites/[id]/issues/[issueId]/detail` — one issue with its evidence.
 *
 * The list endpoint deliberately omits `evidence`: it is an arbitrarily large JSON blob per row
 * and paging a thousand of them would dwarf everything else on the wire. The audit drawer needs
 * exactly one, so it fetches exactly one.
 */
export const GET = route<Params>(async ({ user, params }) => {
  await requireWebsite(user.id, params.id);

  const issue = await prisma.technicalIssue.findFirst({
    where: { id: params.issueId, websiteId: params.id },
    select: {
      id: true,
      ruleId: true,
      title: true,
      category: true,
      severity: true,
      status: true,
      url: true,
      description: true,
      recommendation: true,
      evidence: true,
      estimatedImpact: true,
      confidence: true,
      autoFixable: true,
      weight: true,
      fingerprint: true,
      discoveredAt: true,
      lastSeenAt: true,
      resolvedAt: true,
      ignoredAt: true,
      ignoredReason: true,
      crawlId: true,
      page: { select: { id: true, url: true, title: true } },
    },
  });
  if (!issue) throw new NotFoundError('Issue');

  // Any action already raised from this finding, so the drawer can link to it instead of
  // offering to create a second one.
  const action = await prisma.seoAction.findFirst({
    where: { websiteId: params.id, sourceType: 'technical-issue', sourceId: issue.id },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, title: true, priorityScore: true },
  });

  return { issue, action };
});
