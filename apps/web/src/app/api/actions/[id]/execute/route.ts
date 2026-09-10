import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ActionStatus, ApprovalStatus, json, prisma, readJson } from '@seo/db';
import { ConflictError, createLogger } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { evaluateGuardrail, getActionDetail } from '@/server/queries/actions';
import { assertNotReadOnly, enqueueSummary } from '@/app/api/_lib/common';

const log = createLogger('api:actions');

/**
 * `POST /api/actions/[id]/execute` — hand the action to the actions queue.
 *
 * The guardrail is enforced *here*, not only in the UI: an action that the site's autonomy
 * level does not allow to run unattended is refused unless a human has already approved it.
 * When it is refused we also make sure an `Approval` row exists, so the refusal turns into
 * something the operator can act on instead of a dead end.
 */

const bodySchema = z.object({
  /** Run every guard and produce the diff without writing to the live site. */
  dryRun: z.boolean().optional(),
});

const NOT_EXECUTABLE: ActionStatus[] = [
  ActionStatus.EXECUTING,
  ActionStatus.COMPLETED,
  ActionStatus.REJECTED,
  ActionStatus.CANCELLED,
  ActionStatus.ROLLED_BACK,
];

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  if (!body.dryRun) await assertNotReadOnly();

  const action = await getActionDetail(user.id, params.id);

  if (NOT_EXECUTABLE.includes(action.status)) {
    throw new ConflictError(`This action is ${action.status} and cannot be executed.`);
  }

  const settings = action.website.settings;
  const guardrail = evaluateGuardrail({
    actionType: action.type,
    autonomyLevel: settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
    autoApproveSafe: settings?.autoApproveSafe ?? false,
  });

  const alreadyApproved = action.status === ActionStatus.APPROVED || action.approvedAt !== null;

  if (!alreadyApproved && !guardrail.allowed) {
    const approvalId = await ensureApproval(action, guardrail.risk);
    log.info('action execution refused by guardrail', {
      actionId: action.id,
      type: action.type,
      autonomyLevel: settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
    });

    return NextResponse.json(
      {
        error: guardrail.reason,
        code: 'APPROVAL_REQUIRED',
        enqueued: false,
        requiresApproval: true,
        approvalId,
        risk: guardrail.risk,
      },
      { status: 409 },
    );
  }

  // Carry the approval that authorised this run so the executor can record it on the ChangeLog.
  const approvalId = action.approvals.find(
    (approval) => approval.status === ApprovalStatus.APPROVED,
  )?.id;

  const result = await enqueue(
    'actions.execute',
    {
      websiteId: action.websiteId,
      actionId: action.id,
      ...(approvalId ? { approvalId } : {}),
      ...(body.dryRun ? { dryRun: true } : {}),
    },
    { websiteId: action.websiteId, trigger: 'manual', dedupeKey: `actions.execute:${action.id}` },
  );

  // A dry run must not move the action's status — nothing is changing on the live site.
  if (!body.dryRun) {
    await prisma.seoAction.update({
      where: { id: action.id },
      data: { status: ActionStatus.QUEUED, error: null },
    });
  }

  return {
    action: { id: action.id, status: body.dryRun ? action.status : ActionStatus.QUEUED },
    guardrail,
    dryRun: body.dryRun === true,
    job: enqueueSummary(result),
  };
});

/**
 * Make sure a refused action has an open approval to act on.
 * Reuses an existing pending row so repeatedly pressing "run" cannot spam the queue.
 */
async function ensureApproval(
  action: Awaited<ReturnType<typeof getActionDetail>>,
  risk: 'SAFE' | 'MEDIUM' | 'HIGH',
): Promise<string> {
  const existing = action.approvals.find((approval) => approval.status === ApprovalStatus.PENDING);
  if (existing) return existing.id;

  const created = await prisma.approval.create({
    data: {
      websiteId: action.websiteId,
      actionId: action.id,
      kind: 'action',
      title: action.title,
      description: action.reasoning,
      risk,
      status: ApprovalStatus.PENDING,
      payload: json(readJson<Record<string, unknown>>(action.payload, {})),
      diff: json(readJson<Record<string, unknown>>(action.evidence, {})),
    },
    select: { id: true },
  });

  await prisma.seoAction.update({
    where: { id: action.id },
    data: { status: ActionStatus.AWAITING_APPROVAL },
  });

  return created.id;
}
