import { z } from 'zod';
import { ActionStatus, type ActionExecution, json, prisma, readJson } from '@seo/db';
import { ConflictError, ValidationError, createLogger, errorMessage } from '@seo/shared';
import { applyChange, type ApplyPayload } from '@seo/integrations/adapters/apply';
import { readBody, route } from '@/lib/api';
import { getActionDetail } from '@/server/queries/actions';
import { actorName, assertNotReadOnly } from '@/app/api/_lib/common';

const log = createLogger('api:actions');

/**
 * `POST /api/actions/[id]/rollback` — restore what the action overwrote.
 *
 * Rollback is a *restore of a recorded before-state*, never a guess. It therefore needs two
 * things and refuses without them: an execution that captured the previous values, and an
 * action type whose inverse is "write the old values back". Additive changes (internal links,
 * redirects, publishes) are explicitly not rolled back automatically — undoing them means
 * removing something, which the adapters cannot do safely, so the route says so instead of
 * pretending.
 *
 * The write goes through the same `applyChange` path as the original, so the same adapter,
 * capability checks and diffing apply.
 */

const bodySchema = z.object({
  /** Produce the diff without writing, to preview what the restore would do. */
  dryRun: z.boolean().optional(),
  note: z.string().trim().max(1000).optional(),
});

/** Action types whose inverse is simply writing the previous field values back. */
const REVERSIBLE_TYPES = new Set([
  'UPDATE_TITLE',
  'UPDATE_META_DESCRIPTION',
  'UPDATE_CONTENT',
  'REFRESH_CONTENT',
  'FIX_TECHNICAL_ISSUE',
]);

/** Fields a restore may write. Everything else in a snapshot is metadata, not content. */
const RESTORABLE_FIELDS = [
  'title',
  'metaTitle',
  'metaDescription',
  'canonicalUrl',
  'slug',
  'excerpt',
  'bodyHtml',
  'bodyMarkdown',
] as const;

type RestorableField = (typeof RESTORABLE_FIELDS)[number];

function readSnapshot(execution: ActionExecution): Record<string, unknown> {
  const rollback = readJson<Record<string, unknown>>(execution.rollbackData, {});
  if (Object.keys(rollback).length > 0) return rollback;
  return readJson<Record<string, unknown>>(execution.beforeState, {});
}

/** Build the restore payload from a recorded snapshot. Only string fields are carried over. */
function buildRestorePayload(snapshot: Record<string, unknown>): {
  payload: ApplyPayload;
  fields: RestorableField[];
} {
  const payload: ApplyPayload = {};
  const fields: RestorableField[] = [];

  const externalId = snapshot.externalId;
  if (typeof externalId === 'string' && externalId) payload.externalId = externalId;

  for (const field of RESTORABLE_FIELDS) {
    const value = snapshot[field];
    if (typeof value !== 'string') continue;
    payload[field] = value;
    fields.push(field);
  }
  return { payload, fields };
}

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  if (!body.dryRun) await assertNotReadOnly();

  const action = await getActionDetail(user.id, params.id);

  if (action.status === ActionStatus.ROLLED_BACK) {
    throw new ConflictError('This action has already been rolled back.');
  }
  if (action.executedAt === null && action.executions.length === 0) {
    throw new ConflictError('This action never executed, so there is nothing to roll back.');
  }
  if (!REVERSIBLE_TYPES.has(action.type)) {
    throw new ValidationError(
      `${action.type} cannot be rolled back automatically: undoing it means removing something ` +
        'that was added, which the site adapters cannot do safely. Reverse it in the CMS and mark ' +
        'the action rolled back there.',
    );
  }

  const execution = action.executions.find((row) => Object.keys(readSnapshot(row)).length > 0);
  if (!execution) {
    throw new ConflictError(
      'No execution of this action recorded the previous values, so there is nothing to restore. ' +
        'This happens with write-only integrations (a webhook cannot read the site back).',
    );
  }

  const { payload, fields } = buildRestorePayload(readSnapshot(execution));
  if (fields.length === 0) {
    throw new ConflictError(
      'The recorded snapshot holds no restorable field values for this action type.',
    );
  }

  const result = await applyChange({
    websiteId: action.websiteId,
    actionType: action.type,
    payload,
    ...(body.dryRun ? { dryRun: true } : {}),
    approvedByUserId: user.id,
  });

  if (body.dryRun) {
    return { dryRun: true, restoredFields: fields, result };
  }

  const finished = new Date();
  const attempt = action.executions.length + 1;

  await prisma.$transaction(async (tx) => {
    await tx.actionExecution.create({
      data: {
        actionId: action.id,
        attempt,
        status: result.ok ? 'ROLLED_BACK' : 'FAILED',
        adapter: result.adapter ?? null,
        request: json({ rollbackOf: execution.id, payload }),
        response: json({
          changes: result.changes,
          via: result.via ?? null,
          warnings: result.warnings,
          url: result.url ?? null,
        }),
        beforeState: json(result.before ?? {}),
        afterState: json(result.after ?? {}),
        error: result.ok ? null : (result.error ?? 'Rollback failed'),
        finishedAt: finished,
      },
    });

    if (result.ok) {
      await tx.seoAction.update({
        where: { id: action.id },
        data: { status: ActionStatus.ROLLED_BACK, error: null },
      });
      // Mark the original change entries as reverted so the history reads correctly.
      await tx.changeLog.updateMany({
        where: { actionId: action.id, rolledBackAt: null },
        data: { rolledBackAt: finished },
      });
      await tx.changeLog.create({
        data: {
          websiteId: action.websiteId,
          actionId: action.id,
          userId: user.id,
          actor: actorName(user),
          changeType: 'ROLLBACK',
          targetUrl: result.url ?? action.affectedUrls[0] ?? null,
          summary: `Rolled back "${action.title}" (${fields.join(', ')} restored).`,
          beforeState: json(result.before ?? {}),
          afterState: json(result.after ?? {}),
          reason: body.note ?? 'Manual rollback from the actions queue.',
          approved: true,
          rollbackable: false,
        },
      });
    } else {
      await tx.seoAction.update({
        where: { id: action.id },
        data: { error: `Rollback failed: ${result.error ?? 'unknown adapter error'}` },
      });
    }
  });

  log.info('action rollback attempted', {
    actionId: action.id,
    ok: result.ok,
    fields,
    error: result.ok ? undefined : errorMessage(result.error),
  });

  return {
    ok: result.ok,
    restoredFields: fields,
    action: { id: action.id, status: result.ok ? ActionStatus.ROLLED_BACK : action.status },
    result,
  };
});
