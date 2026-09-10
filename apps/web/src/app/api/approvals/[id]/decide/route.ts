import { ActionStatus, ApprovalStatus, json, prisma, readJson } from '@seo/db';
import { ConflictError, approvalDecisionSchema, createLogger } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { getApproval } from '@/server/queries/approvals';
import { assertNotReadOnly, enqueueSummary } from '@/app/api/_lib/common';

const log = createLogger('api:approvals');

/**
 * `POST /api/approvals/[id]/decide` — the human checkpoint.
 *
 * Approving an action-backed item queues the execution immediately: approval *is* the
 * instruction to apply the change, and making the operator press a second button would only
 * create a window where an approved change silently sits undone. An `editedPayload` is merged
 * onto the action before it is queued, so the executor applies exactly what was approved —
 * never the agent's original proposal.
 */

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, approvalDecisionSchema);
  await assertNotReadOnly();

  const approval = await getApproval(user.id, params.id);
  if (approval.status !== ApprovalStatus.PENDING) {
    throw new ConflictError(`This approval was already ${approval.status.toLowerCase()}.`);
  }

  const now = new Date();
  const approved = body.decision === 'APPROVE';
  const edited = body.editedPayload;

  await prisma.$transaction(async (tx) => {
    await tx.approval.update({
      where: { id: approval.id },
      data: {
        status: approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
        decidedAt: now,
        userId: user.id,
        decisionNote: body.note ?? null,
        // Left untouched when the operator did not edit, so a re-decision cannot blank a
        // previously recorded edit.
        ...(edited === undefined ? {} : { editedPayload: json(edited) }),
      },
    });

    if (!approval.actionId) return;

    if (!approved) {
      await tx.seoAction.update({
        where: { id: approval.actionId },
        data: { status: ActionStatus.REJECTED },
      });
      return;
    }

    // The edited payload replaces the agent's proposal field by field, so an operator can
    // fix a title and approve in one step without hand-editing the action.
    const action = await tx.seoAction.findUnique({
      where: { id: approval.actionId },
      select: { payload: true },
    });
    const mergedPayload = {
      ...readJson<Record<string, unknown>>(action?.payload, {}),
      ...(edited ?? {}),
    };

    await tx.seoAction.update({
      where: { id: approval.actionId },
      data: {
        status: ActionStatus.APPROVED,
        approvedAt: now,
        error: null,
        payload: json(mergedPayload),
      },
    });
  });

  let job = null;
  if (approved && approval.actionId) {
    const result = await enqueue(
      'actions.execute',
      { websiteId: approval.websiteId, actionId: approval.actionId, approvalId: approval.id },
      {
        websiteId: approval.websiteId,
        trigger: 'manual',
        dedupeKey: `actions.execute:${approval.actionId}`,
      },
    );
    job = enqueueSummary(result);
    if (job.enqueued) {
      await prisma.seoAction.update({
        where: { id: approval.actionId },
        data: { status: ActionStatus.QUEUED },
      });
    }
  }

  log.info('approval decided', {
    approvalId: approval.id,
    decision: body.decision,
    actionId: approval.actionId,
    edited: edited !== undefined,
  });

  return {
    approval: {
      id: approval.id,
      status: approved ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED,
      decidedAt: now,
    },
    actionId: approval.actionId,
    job,
  };
});
