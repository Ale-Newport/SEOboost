import { z } from 'zod';
import { ActionStatus, ApprovalStatus, prisma } from '@seo/db';
import { ConflictError, createLogger } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { getActionDetail } from '@/server/queries/actions';

const log = createLogger('api:actions');

/**
 * `POST /api/actions/[id]/reject` — decline a proposed action.
 *
 * The row is kept rather than deleted: a rejected proposal is training data for the feedback
 * loop and part of the audit trail of what the platform wanted to do and was not allowed to.
 */

const bodySchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

const NOT_REJECTABLE: ActionStatus[] = [
  ActionStatus.EXECUTING,
  ActionStatus.COMPLETED,
  ActionStatus.ROLLED_BACK,
];

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const action = await getActionDetail(user.id, params.id);

  if (NOT_REJECTABLE.includes(action.status)) {
    throw new ConflictError(`This action is ${action.status} and can no longer be rejected.`);
  }

  const now = new Date();
  const [updated, approvals] = await prisma.$transaction([
    prisma.seoAction.update({
      where: { id: action.id },
      data: { status: ActionStatus.REJECTED, approvedAt: null },
    }),
    prisma.approval.updateMany({
      where: { actionId: action.id, status: ApprovalStatus.PENDING },
      data: {
        status: ApprovalStatus.REJECTED,
        decidedAt: now,
        userId: user.id,
        decisionNote: body.note ?? null,
      },
    }),
  ]);

  log.info('action rejected', { actionId: action.id, userId: user.id, approvalsClosed: approvals.count });

  return {
    action: { id: updated.id, status: updated.status },
    approvalsClosed: approvals.count,
  };
});
