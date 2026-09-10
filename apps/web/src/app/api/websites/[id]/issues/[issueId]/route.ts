import { z } from 'zod';
import { type Prisma, prisma } from '@seo/db';
import { NotFoundError, ValidationError, createLogger } from '@seo/shared';
import { readBody, requireWebsite, route } from '@/lib/api';

const log = createLogger('api:issue');

type Params = { id: string; issueId: string };

const patchSchema = z.object({
  action: z.enum(['ignore', 'reopen', 'resolve', 'start']),
  /** Required for `ignore`: a triaged issue with no reason is indistinguishable from a mistake. */
  reason: z.string().trim().max(500).optional(),
});

/**
 * Triage one issue.
 *
 * The audit columns are managed here rather than left to the caller: resolving stamps
 * `resolvedAt` and clears any earlier ignore, reopening clears both. Without that, an issue
 * that was ignored, resolved and later regressed would carry three contradictory timestamps and
 * the "why is this still here?" question would be unanswerable.
 *
 * Note that `resolve` records a human decision. The technical audit is what marks an issue
 * genuinely fixed on the next crawl — and it will reopen this one as REGRESSED if the problem
 * is still on the page.
 */
export const PATCH = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const input = await readBody(request, patchSchema);

  const issue = await prisma.technicalIssue.findFirst({
    where: { id: params.issueId, websiteId: params.id },
    select: { id: true, status: true, ruleId: true },
  });
  if (!issue) throw new NotFoundError('Issue');

  if (input.action === 'ignore' && !input.reason) {
    throw new ValidationError('Say why this issue is being ignored so the decision is auditable.');
  }

  const now = new Date();
  const data: Prisma.TechnicalIssueUpdateInput =
    input.action === 'ignore'
      ? { status: 'IGNORED', ignoredAt: now, ignoredReason: input.reason ?? null, resolvedAt: null }
      : input.action === 'resolve'
        ? { status: 'RESOLVED', resolvedAt: now, ignoredAt: null, ignoredReason: null }
        : input.action === 'start'
          ? { status: 'IN_PROGRESS', ignoredAt: null, ignoredReason: null, resolvedAt: null }
          : { status: 'OPEN', ignoredAt: null, ignoredReason: null, resolvedAt: null };

  const updated = await prisma.technicalIssue.update({ where: { id: issue.id }, data });

  log.info('issue triaged', {
    websiteId: params.id,
    issueId: issue.id,
    ruleId: issue.ruleId,
    from: issue.status,
    to: updated.status,
  });

  return { issue: updated };
});
