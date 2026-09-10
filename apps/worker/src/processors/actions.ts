/**
 * The actions lane — where the platform changes a live website, and where it finds out whether
 * that helped.
 *
 * Two invariants hold this file together:
 *
 *  1. **The guardrail is re-evaluated here, never trusted from the enqueuer.** A job payload is
 *     just data; by the time it runs, the site's autonomy level may have been lowered, or the
 *     approval may have been withdrawn. `canAutoExecute` runs again at execution time, and an
 *     action that needs a human needs an `APPROVED` Approval row — not a flag in the payload.
 *  2. **Every change is measurable and reversible by record.** An execution writes the
 *     before-state, the after-state and the rollback data, opens an `Experiment` with a real
 *     baseline window, and sets `measureAfter`. `actions.measure` closes the loop by running
 *     the same statistical test for every action type, which is what feeds
 *     `calculatePriority`'s history adjustment.
 */

import {
  ActionStatus,
  ApprovalStatus,
  ExperimentStatus,
  type ExperimentOutcome,
  NotificationSeverity,
  type Prisma,
  json,
  prisma,
} from '@seo/db';
import type { JobHandler } from '@seo/queue';
import {
  addDays,
  createLogger,
  errorMessage,
  lastNDays,
  round,
  truncate,
} from '@seo/shared';
import { applyChange, summariseChanges, type ApplyChangeResult, type ApplyPayload } from '@seo/integrations';
import {
  canAutoExecute,
  evaluateExperiment,
  nextEvaluationDate,
  riskBandForActionType,
  type ExperimentOutcomeValue,
} from '@seo/seo-engine';
import { effectiveSettings, loadWebsite } from '../lib/website';
import { loadDailySeries } from '../lib/gsc';
import { skip } from '../lib/result';

const log = createLogger('worker:actions');

/** Days of history used as an experiment's baseline. Matches the product's rolling window. */
const BASELINE_DAYS = 28;

/** Days ignored after a change while Google re-crawls and re-ranks. */
const SETTLING_DAYS = 7;

/** Minimum observation window before an experiment may be called either way. */
const MIN_MEASURE_DAYS = 28;

/** Actions swept per `actions.measure` run when no specific action was named. */
const MEASURE_SWEEP_LIMIT = 50;

const TERMINAL_STATUSES: ActionStatus[] = [
  ActionStatus.COMPLETED,
  ActionStatus.ROLLED_BACK,
  ActionStatus.CANCELLED,
  ActionStatus.EVALUATED,
  ActionStatus.MEASURING,
  ActionStatus.REJECTED,
];

// ─────────────────────────────────────────────────────────────
// actions.execute
// ─────────────────────────────────────────────────────────────

export interface ActionExecuteResult {
  status: 'completed';
  actionId: string;
  actionType: string;
  dryRun: boolean;
  applied: boolean;
  adapter: string | null;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
  executionId: string;
  changeLogId: string | null;
  experimentId: string | null;
  measureAfter: string | null;
  warnings: string[];
}

/** Reads the action's stored payload into the adapter's input shape, ignoring unknown keys. */
function readApplyPayload(value: Prisma.JsonValue | null): ApplyPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof raw[key] === 'string' ? (raw[key] as string) : undefined;

  const payload: ApplyPayload = {
    externalId: str('externalId'),
    title: str('title'),
    metaTitle: str('metaTitle'),
    metaDescription: str('metaDescription'),
    canonicalUrl: str('canonicalUrl'),
    slug: str('slug'),
    excerpt: str('excerpt'),
    bodyHtml: str('bodyHtml'),
    bodyMarkdown: str('bodyMarkdown'),
    from: str('from'),
    to: str('to'),
    commitMessage: str('commitMessage'),
  };

  if (typeof raw.noindex === 'boolean') payload.noindex = raw.noindex;
  if (typeof raw.status === 'string') {
    Object.assign(payload, { status: raw.status });
  }
  if (raw.structuredData !== undefined && raw.structuredData !== null) {
    Object.assign(payload, { structuredData: raw.structuredData });
  }
  if (typeof raw.redirectType === 'number') {
    Object.assign(payload, { redirectType: raw.redirectType });
  }
  if (Array.isArray(raw.links)) {
    const links = raw.links
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .filter((item) => typeof item.anchor === 'string' && typeof item.href === 'string')
      .map((item) => ({
        anchor: String(item.anchor),
        href: String(item.href),
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
      }));
    if (links.length) payload.links = links;
  }
  return payload;
}

export const actionsExecute: JobHandler<'actions.execute'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const settings = effectiveSettings(website);
  const warnings: string[] = [];

  const action = await prisma.seoAction.findFirst({
    where: { id: payload.actionId, websiteId: website.id },
  });
  if (!action) return skip(`Action ${payload.actionId} does not exist for this website.`);
  if (TERMINAL_STATUSES.includes(action.status)) {
    return skip(`Action ${action.id} is already ${action.status}; nothing to execute.`);
  }

  await ctx.updateProgress(10, 'Checking the guardrail');

  // ── 1. guardrail, re-evaluated from current settings ─────
  const guard = canAutoExecute({
    actionType: action.type,
    autonomyLevel: settings.autonomyLevel,
    autoApproveSafe: settings.autoApproveSafe,
  });

  const approval = payload.approvalId
    ? await prisma.approval.findFirst({
        where: { id: payload.approvalId, websiteId: website.id, actionId: action.id },
      })
    : await prisma.approval.findFirst({
        where: { actionId: action.id, status: ApprovalStatus.APPROVED },
        orderBy: { decidedAt: 'desc' },
      });

  const hasApproval = approval?.status === ApprovalStatus.APPROVED;

  if (!guard.allowed && !hasApproval) {
    // Park the action where a human can see it, and create the approval request if the
    // proposer did not. Returning "skipped" is correct: nothing failed, consent is missing.
    const existingPending = await prisma.approval.findFirst({
      where: { actionId: action.id, status: ApprovalStatus.PENDING },
      select: { id: true },
    });
    if (!existingPending) {
      await prisma.approval.create({
        data: {
          websiteId: website.id,
          actionId: action.id,
          kind: action.type,
          title: action.title,
          description: action.reasoning,
          risk: riskBandForActionType(action.type),
          status: ApprovalStatus.PENDING,
          payload: json(action.payload),
        },
      });
    }
    await prisma.seoAction.update({
      where: { id: action.id },
      data: { status: ActionStatus.AWAITING_APPROVAL },
    });
    return skip(guard.reason, ['Approve this action in the Approvals queue']);
  }

  // ── 2. apply ─────────────────────────────────────────────
  const applyPayload = readApplyPayload(action.payload);
  const dryRun = payload.dryRun ?? false;
  const attempt =
    (await prisma.actionExecution.count({ where: { actionId: action.id } })) + 1;
  const startedAt = new Date();

  const execution = await prisma.actionExecution.create({
    data: {
      actionId: action.id,
      attempt,
      status: dryRun ? 'DRY_RUN' : 'RUNNING',
      request: json({ actionType: action.type, payload: applyPayload, dryRun }),
      startedAt,
    },
    select: { id: true },
  });

  if (!dryRun) {
    await prisma.seoAction.update({
      where: { id: action.id },
      data: { status: ActionStatus.EXECUTING, executedAt: startedAt, error: null },
    });
  }

  await ctx.updateProgress(40, dryRun ? 'Previewing the change' : 'Applying the change');

  const applied = await applyChange({
    websiteId: website.id,
    actionType: action.type,
    payload: applyPayload,
    dryRun,
    approvedByUserId: approval?.userId ?? null,
  }).catch(
    // A thrown adapter error is normalised into the same result shape as a returned failure, so
    // everything downstream (execution row, change log, rollback data) has one code path.
    (err: unknown): ApplyChangeResult => ({
      ok: false,
      dryRun,
      actionType: action.type,
      risk: riskBandForActionType(action.type),
      requiresApproval: !guard.allowed,
      before: null,
      after: null,
      changes: [],
      warnings: [],
      error: errorMessage(err),
      errorCode: 'ADAPTER_ERROR',
    }),
  );

  const finishedAt = new Date();
  warnings.push(...applied.warnings);

  await prisma.actionExecution.update({
    where: { id: execution.id },
    data: {
      status: applied.ok ? (dryRun ? 'DRY_RUN' : 'COMPLETED') : 'FAILED',
      adapter: applied.adapter ?? null,
      response: json({
        ok: applied.ok,
        errorCode: applied.errorCode ?? null,
        via: applied.via ?? null,
        url: applied.url ?? null,
        externalId: applied.externalId ?? null,
      }),
      beforeState: json(applied.before ?? {}),
      afterState: json(applied.after ?? {}),
      // Everything a revert needs: the remote content as it was, plus the exact field set we
      // touched, so a rollback does not have to guess which of the changes were ours.
      rollbackData: json({
        before: applied.before ?? null,
        changes: applied.changes,
        externalId: applied.externalId ?? null,
        adapter: applied.adapter ?? null,
      }),
      error: applied.ok ? null : truncate(applied.error ?? 'Unknown adapter failure', 2_000),
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
  });

  if (!applied.ok) {
    await prisma.seoAction.update({
      where: { id: action.id },
      data: {
        status: dryRun ? action.status : ActionStatus.FAILED,
        error: truncate(applied.error ?? 'The adapter refused the change', 2_000),
      },
    });
    const message = applied.error ?? 'The adapter refused the change';
    if (applied.errorCode === 'NO_ADAPTER') {
      return skip(message, ['Connect a publishing integration (WordPress, Git, Webflow, Shopify or a webhook)']);
    }
    if (applied.errorCode === 'MISSING_CAPABILITY' || applied.errorCode === 'UNSUPPORTED_ACTION') {
      return skip(message);
    }
    if (applied.errorCode === 'NO_CHANGE') {
      await prisma.seoAction.update({
        where: { id: action.id },
        data: { status: ActionStatus.COMPLETED, completedAt: finishedAt, error: null },
      });
      return skip('The site already matches the proposed change; nothing was written.');
    }
    throw new Error(`Applying ${action.type} failed: ${message}`);
  }

  if (dryRun) {
    const preview: ActionExecuteResult = {
      status: 'completed',
      actionId: action.id,
      actionType: action.type,
      dryRun: true,
      applied: false,
      adapter: applied.adapter ?? null,
      changes: applied.changes,
      executionId: execution.id,
      changeLogId: null,
      experimentId: null,
      measureAfter: null,
      warnings,
    };
    await ctx.updateProgress(100, 'Dry run complete');
    return preview;
  }

  // ── 3. audit trail ───────────────────────────────────────
  await ctx.updateProgress(70, 'Recording the change');

  const targetUrl = applied.url ?? action.affectedUrls[0] ?? null;
  const changeLog = await prisma.changeLog.create({
    data: {
      websiteId: website.id,
      actionId: action.id,
      userId: approval?.userId ?? null,
      actor: hasApproval ? 'user-approved' : 'platform',
      agent: action.requiredAgent,
      changeType: action.type,
      targetUrl,
      summary: summariseChanges(applied.changes) || action.title,
      beforeState: json(applied.before ?? {}),
      afterState: json(applied.after ?? {}),
      reason: truncate(action.reasoning, 2_000),
      approved: hasApproval,
      rollbackable: applied.before !== null,
    },
    select: { id: true },
  });

  // ── 4. experiment ────────────────────────────────────────
  const measureStart = finishedAt;
  const measureAfter = nextEvaluationDate(measureStart, MIN_MEASURE_DAYS, SETTLING_DAYS);
  const baseline = lastNDays(BASELINE_DAYS, 3, measureStart);

  const page = targetUrl
    ? await prisma.page.findFirst({
        where: { websiteId: website.id, OR: [{ url: targetUrl }, { normalizedUrl: targetUrl }] },
        select: { id: true },
      })
    : null;

  const experiment = await prisma.experiment.upsert({
    where: { actionId: action.id },
    create: {
      websiteId: website.id,
      actionId: action.id,
      pageId: page?.id ?? null,
      name: truncate(action.title, 200),
      hypothesis: truncate(action.reasoning, 1_000),
      metric: 'clicks',
      status: ExperimentStatus.RUNNING,
      changeSummary: summariseChanges(applied.changes) || action.title,
      beforeState: json(applied.before ?? {}),
      afterState: json(applied.after ?? {}),
      baselineStart: baseline.start,
      baselineEnd: baseline.end,
      measureStart,
      minDays: MIN_MEASURE_DAYS,
    },
    update: {
      status: ExperimentStatus.RUNNING,
      measureStart,
      measureEnd: null,
      afterState: json(applied.after ?? {}),
    },
    select: { id: true },
  });

  await prisma.seoAction.update({
    where: { id: action.id },
    data: {
      status: ActionStatus.COMPLETED,
      completedAt: finishedAt,
      measureAfter,
      error: null,
    },
  });

  log.info('action executed', {
    websiteId: website.id,
    actionId: action.id,
    type: action.type,
    adapter: applied.adapter,
  });

  await ctx.updateProgress(100, 'Change applied');
  const result: ActionExecuteResult = {
    status: 'completed',
    actionId: action.id,
    actionType: action.type,
    dryRun: false,
    applied: true,
    adapter: applied.adapter ?? null,
    changes: applied.changes,
    executionId: execution.id,
    changeLogId: changeLog.id,
    experimentId: experiment.id,
    measureAfter: measureAfter.toISOString(),
    warnings,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// actions.measure
// ─────────────────────────────────────────────────────────────

export interface MeasuredAction {
  actionId: string;
  experimentId: string;
  outcome: ExperimentOutcomeValue;
  deltaPct: number | null;
  pValue: number | null;
  needsMoreData: boolean;
  daysRemaining: number;
  interpretation: string;
}

export interface ActionsMeasureResult {
  status: 'completed';
  evaluated: number;
  concluded: number;
  stillMeasuring: number;
  results: MeasuredAction[];
}

const OUTCOME_MAP: Record<ExperimentOutcomeValue, ExperimentOutcome> = {
  PENDING: 'PENDING',
  LIKELY_POSITIVE: 'LIKELY_POSITIVE',
  INCONCLUSIVE: 'INCONCLUSIVE',
  LIKELY_NEGATIVE: 'LIKELY_NEGATIVE',
};

/**
 * Closes the loop on executed actions.
 *
 * The evaluator is deliberately conservative — it needs a real observation window and both an
 * effect size and statistical separation before it labels anything — so most first passes come
 * back "needs more data". That is not a failure: the action stays MEASURING and `measureAfter`
 * is pushed out by exactly the days still required.
 */
export const actionsMeasure: JobHandler<'actions.measure'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const now = new Date();

  const minDays = payload.minDaysSinceExecution ?? 0;
  const executedBefore = minDays > 0 ? addDays(now, -minDays) : now;

  const actions = await prisma.seoAction.findMany({
    where: {
      websiteId: website.id,
      ...(payload.actionId ? { id: payload.actionId } : {}),
      ...(payload.actionId
        ? {}
        : {
            status: { in: [ActionStatus.COMPLETED, ActionStatus.MEASURING] },
            measureAfter: { lte: now },
            executedAt: { lte: executedBefore },
          }),
    },
    orderBy: { measureAfter: 'asc' },
    take: payload.actionId ? 1 : MEASURE_SWEEP_LIMIT,
    select: {
      id: true,
      type: true,
      title: true,
      affectedUrls: true,
      measureAfter: true,
      experiment: {
        select: {
          id: true,
          metric: true,
          pageId: true,
          baselineStart: true,
          baselineEnd: true,
          measureStart: true,
          minDays: true,
        },
      },
    },
  });

  if (actions.length === 0) {
    return skip(
      payload.actionId
        ? `Action ${payload.actionId} is not due for measurement yet.`
        : 'No executed actions are due for measurement.',
    );
  }

  const results: MeasuredAction[] = [];
  let concluded = 0;
  let stillMeasuring = 0;
  let index = 0;

  for (const action of actions) {
    index += 1;
    await ctx.updateProgress((index / actions.length) * 90, `Measuring ${action.title}`);

    const experiment = action.experiment;
    if (!experiment) {
      log.warn('executed action has no experiment to measure', { actionId: action.id });
      continue;
    }

    const pageUrl = action.affectedUrls[0] ?? null;
    const seriesOptions = experiment.pageId
      ? { pageId: experiment.pageId }
      : pageUrl
        ? { pageUrl }
        : {};

    const [baselineSeries, measurementSeries] = await Promise.all([
      loadDailySeries(
        website.id,
        { start: experiment.baselineStart, end: experiment.baselineEnd },
        seriesOptions,
      ),
      loadDailySeries(website.id, { start: experiment.measureStart, end: now }, seriesOptions),
    ]);

    const metric = readMetric(experiment.metric);
    const evaluation = evaluateExperiment(
      {
        metric,
        baseline: { start: experiment.baselineStart, end: experiment.baselineEnd },
        measurement: { start: experiment.measureStart, end: now },
        minDays: experiment.minDays,
        settlingDays: SETTLING_DAYS,
      },
      baselineSeries,
      measurementSeries,
      now,
    );

    const conclusive = !evaluation.needsMoreData && evaluation.outcome !== 'PENDING';

    await prisma.experiment.update({
      where: { id: experiment.id },
      data: {
        outcome: OUTCOME_MAP[evaluation.outcome],
        status: conclusive ? ExperimentStatus.COMPLETED : ExperimentStatus.RUNNING,
        baselineMetrics: json(evaluation.baselineMetrics),
        resultMetrics: json(evaluation.resultMetrics),
        deltaPct: evaluation.deltaPct,
        significance: evaluation.pValue,
        interpretation: truncate(evaluation.interpretation, 2_000),
        evaluatedAt: now,
        ...(conclusive ? { measureEnd: now } : {}),
      },
    });

    // The change log is what the timeline reads; give it the measured result too.
    await prisma.changeLog.updateMany({
      where: { actionId: action.id },
      data: {
        resultMetrics: json({
          metric: evaluation.metric,
          baselineMean: evaluation.baselineMean,
          measurementMean: evaluation.measurementMean,
          deltaPct: evaluation.deltaPct,
          pValue: evaluation.pValue,
          outcome: evaluation.outcome,
          measuredAt: now.toISOString(),
        }),
      },
    });

    if (conclusive) {
      concluded += 1;
      await prisma.seoAction.update({
        where: { id: action.id },
        data: { status: ActionStatus.EVALUATED },
      });
      await createOutcomeNotification(website.id, action.id, action.title, evaluation.outcome, evaluation.deltaPct);
    } else {
      stillMeasuring += 1;
      await prisma.seoAction.update({
        where: { id: action.id },
        data: {
          status: ActionStatus.MEASURING,
          // Come back exactly when the missing days will have accumulated.
          measureAfter: addDays(now, Math.max(1, evaluation.daysRemaining)),
        },
      });
    }

    results.push({
      actionId: action.id,
      experimentId: experiment.id,
      outcome: evaluation.outcome,
      deltaPct: evaluation.deltaPct,
      pValue: evaluation.pValue,
      needsMoreData: evaluation.needsMoreData,
      daysRemaining: evaluation.daysRemaining,
      interpretation: evaluation.interpretation,
    });
  }

  await ctx.updateProgress(100, `Measured ${results.length} action(s)`);
  const result: ActionsMeasureResult = {
    status: 'completed',
    evaluated: results.length,
    concluded,
    stillMeasuring,
    results,
  };
  return result;
};

function readMetric(value: string): 'clicks' | 'impressions' | 'ctr' | 'position' {
  return value === 'impressions' || value === 'ctr' || value === 'position' ? value : 'clicks';
}

async function createOutcomeNotification(
  websiteId: string,
  actionId: string,
  title: string,
  outcome: ExperimentOutcomeValue,
  deltaPct: number | null,
): Promise<void> {
  const severity =
    outcome === 'LIKELY_POSITIVE'
      ? NotificationSeverity.SUCCESS
      : outcome === 'LIKELY_NEGATIVE'
        ? NotificationSeverity.WARNING
        : NotificationSeverity.INFO;

  const delta = deltaPct === null ? '' : ` (${deltaPct >= 0 ? '+' : ''}${round(deltaPct, 1)}%)`;

  await prisma.notification
    .create({
      data: {
        websiteId,
        type: 'action-measured',
        severity,
        title: `Result measured: ${truncate(title, 120)}`,
        message: `The change has been measured against its baseline: ${outcome.toLowerCase().replace('_', ' ')}${delta}.`,
        link: `/actions/${actionId}`,
        data: json({ actionId, outcome, deltaPct }),
        dedupeKey: `action-measured:${actionId}`,
      },
    })
    .catch((err: unknown) => {
      // A duplicate dedupeKey means the operator was already told; nothing to do.
      log.debug('notification not created', { actionId, error: errorMessage(err) });
    });
}
