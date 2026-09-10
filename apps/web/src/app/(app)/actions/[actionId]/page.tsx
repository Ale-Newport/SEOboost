import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { prisma, readJson, type ActionExecution } from '@seo/db';

import { getCurrentUser } from '@/lib/auth';
import { evaluateGuardrail, getActionDetail, type ActionDetail } from '@/server/queries/actions';
import { ActionDetailView, type ActionAgentRun } from '@/components/actions/action-detail-view';

export const metadata: Metadata = { title: 'Action' };
export const dynamic = 'force-dynamic';

/**
 * Action types whose inverse is simply writing the previous field values back.
 * Mirrors `POST /api/actions/[id]/rollback`, which is the enforcement — this copy exists so the
 * button can explain itself before the operator presses it rather than after.
 */
const REVERSIBLE_TYPES = new Set([
  'UPDATE_TITLE',
  'UPDATE_META_DESCRIPTION',
  'UPDATE_CONTENT',
  'REFRESH_CONTENT',
  'FIX_TECHNICAL_ISSUE',
]);

function hasSnapshot(execution: ActionExecution): boolean {
  const rollback = readJson<Record<string, unknown>>(execution.rollbackData, {});
  if (Object.keys(rollback).length > 0) return true;
  return Object.keys(readJson<Record<string, unknown>>(execution.beforeState, {})).length > 0;
}

/** Why this action cannot be rolled back, or `null` when it can. */
function rollbackBlockedReason(action: ActionDetail): string | null {
  if (action.status === 'ROLLED_BACK') return 'This action has already been rolled back.';
  if (action.executedAt === null && action.executions.length === 0) {
    return 'This action never executed, so there is nothing to roll back.';
  }
  if (!REVERSIBLE_TYPES.has(action.type)) {
    return (
      `${action.type.replace(/_/g, ' ').toLowerCase()} cannot be rolled back automatically: undoing it ` +
      'means removing something that was added, which the site adapters cannot do safely. Reverse it ' +
      'in the CMS and mark the action rolled back there.'
    );
  }
  if (!action.executions.some(hasSnapshot)) {
    return (
      'No execution of this action recorded the previous values, so there is nothing to restore. ' +
      'This happens with write-only integrations — a webhook cannot read the site back.'
    );
  }
  return null;
}

export default async function ActionDetailPage({ params }: { params: Promise<{ actionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { actionId } = await params;

  let action: ActionDetail;
  try {
    // Ownership is enforced inside the read model, so a forbidden action is a 404 here.
    action = await getActionDetail(user.id, actionId);
  } catch {
    notFound();
  }

  const settings = action.website.settings;
  const guardrail = evaluateGuardrail({
    actionType: action.type,
    autonomyLevel: settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
    autoApproveSafe: settings?.autoApproveSafe ?? false,
  });

  /*
   * Agent runs are not linked to individual proposals in the schema, so the closest honest
   * attribution is the last run of the required agent on this site before the action appeared.
   * The view labels it as exactly that rather than claiming a hard link.
   */
  const agentRun: ActionAgentRun | null = action.requiredAgent
    ? await prisma.agentRun.findFirst({
        where: {
          websiteId: action.websiteId,
          agent: action.requiredAgent,
          startedAt: { lte: action.proposedAt },
        },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          agent: true,
          status: true,
          trigger: true,
          summary: true,
          model: true,
          costUsd: true,
          actionsCreated: true,
          startedAt: true,
          finishedAt: true,
        },
      })
    : null;

  return (
    <ActionDetailView
      action={action}
      guardrail={guardrail}
      rollbackBlockedReason={rollbackBlockedReason(action)}
      agentRun={agentRun}
    />
  );
}
