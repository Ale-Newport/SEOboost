import { z } from 'zod';
import { ActionRisk, ActionStatus, ApprovalStatus, prisma } from '@seo/db';
import { ALWAYS_REQUIRES_APPROVAL, createLogger } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly, enqueueSummary, resolveScope } from '@/app/api/_lib/common';

const log = createLogger('api:approvals');

/**
 * `POST /api/approvals/bulk-approve-safe` — clear the low-risk backlog in one step.
 *
 * "Safe" is enforced twice, in the query and again per row: the query only selects
 * `risk = SAFE` pending approvals the user owns, and each candidate is re-checked against
 * `ALWAYS_REQUIRES_APPROVAL` before it is approved. An item that is mislabelled SAFE but whose
 * action type may never run unattended is reported as skipped, never approved in bulk.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1).optional(),
  /** Restrict to these approval ids; omit to take every safe pending item in scope. */
  ids: z.array(z.string().trim().min(1)).max(500).optional(),
  note: z.string().trim().max(1000).optional(),
  /** Upper bound so one press cannot queue an unbounded number of live-site writes. */
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();

  const scope = await resolveScope(user, body.websiteId);
  if (scope.websiteIds.length === 0) {
    return { approved: 0, skipped: [], jobs: [] };
  }

  const candidates = await prisma.approval.findMany({
    where: {
      websiteId: { in: scope.websiteIds },
      status: ApprovalStatus.PENDING,
      // The enforcement that matters: only SAFE rows are ever considered.
      risk: ActionRisk.SAFE,
      ...(body.ids?.length ? { id: { in: body.ids } } : {}),
    },
    select: {
      id: true,
      websiteId: true,
      title: true,
      actionId: true,
      action: { select: { id: true, type: true, status: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: body.limit,
  });

  const skipped: Array<{ id: string; reason: string }> = [];
  const approvable: typeof candidates = [];

  for (const candidate of candidates) {
    const type = candidate.action?.type;
    if (type && (ALWAYS_REQUIRES_APPROVAL as readonly string[]).includes(type)) {
      skipped.push({
        id: candidate.id,
        reason: `${type} always requires an explicit, individual decision and is never bulk-approved.`,
      });
      continue;
    }
    approvable.push(candidate);
  }

  if (approvable.length === 0) {
    return { approved: 0, skipped, jobs: [], requested: candidates.length };
  }

  const now = new Date();
  const approvalIds = approvable.map((row) => row.id);
  const actionIds = approvable
    .map((row) => row.actionId)
    .filter((id): id is string => typeof id === 'string');

  await prisma.$transaction([
    prisma.approval.updateMany({
      where: { id: { in: approvalIds } },
      data: {
        status: ApprovalStatus.APPROVED,
        decidedAt: now,
        userId: user.id,
        decisionNote: body.note ?? 'Bulk-approved (safe risk band).',
      },
    }),
    prisma.seoAction.updateMany({
      where: { id: { in: actionIds } },
      data: { status: ActionStatus.APPROVED, approvedAt: now, error: null },
    }),
  ]);

  // Queued one at a time so a single failing enqueue does not lose the rest.
  const jobs = [];
  for (const candidate of approvable) {
    if (!candidate.actionId) continue;
    const result = await enqueue(
      'actions.execute',
      { websiteId: candidate.websiteId, actionId: candidate.actionId, approvalId: candidate.id },
      {
        websiteId: candidate.websiteId,
        trigger: 'manual',
        dedupeKey: `actions.execute:${candidate.actionId}`,
      },
    );
    const summary = enqueueSummary(result);
    if (summary.enqueued) {
      await prisma.seoAction.update({
        where: { id: candidate.actionId },
        data: { status: ActionStatus.QUEUED },
      });
    }
    jobs.push({ approvalId: candidate.id, actionId: candidate.actionId, ...summary });
  }

  log.info('bulk approved safe changes', {
    userId: user.id,
    approved: approvalIds.length,
    skipped: skipped.length,
  });

  return { approved: approvalIds.length, approvalIds, skipped, jobs, requested: candidates.length };
});
