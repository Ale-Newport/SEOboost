import { z } from 'zod';
import { ActionStatus, ApprovalStatus, prisma } from '@seo/db';
import { ConflictError, createLogger } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { getActionDetail } from '@/server/queries/actions';

const log = createLogger('api:actions');

/**
 * `POST /api/actions/[id]/approve` — record the human decision.
 *
 * Approving does not run anything: execution is a separate, explicit call so the operator can
 * approve a batch and schedule the work afterwards. Any open `Approval` rows for the action
 * are closed in the same transaction, so the approvals queue can never keep showing an item
 * whose action has already been decided.
 */

const bodySchema = z.object({
  note: z.string().trim().max(1000).optional(),
});

/** Statuses where approval is meaningless because the action is already past that point. */
const NOT_APPROVABLE: ActionStatus[] = [
  ActionStatus.EXECUTING,
  ActionStatus.COMPLETED,
  ActionStatus.ROLLED_BACK,
  ActionStatus.CANCELLED,
];

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const action = await getActionDetail(user.id, params.id);

  if (NOT_APPROVABLE.includes(action.status)) {
    throw new ConflictError(`This action is ${action.status} and can no longer be approved.`);
  }

  const now = new Date();
  const [updated, approvals] = await prisma.$transaction([
    prisma.seoAction.update({
      where: { id: action.id },
      data: { status: ActionStatus.APPROVED, approvedAt: now, error: null },
    }),
    prisma.approval.updateMany({
      where: { actionId: action.id, status: ApprovalStatus.PENDING },
      data: {
        status: ApprovalStatus.APPROVED,
        decidedAt: now,
        userId: user.id,
        decisionNote: body.note ?? null,
      },
    }),
  ]);

  log.info('action approved', { actionId: action.id, userId: user.id, approvalsClosed: approvals.count });

  return {
    action: { id: updated.id, status: updated.status, approvedAt: updated.approvedAt },
    approvalsClosed: approvals.count,
    nextStep: 'Call POST /api/actions/{id}/execute to apply this change.',
  };
});
