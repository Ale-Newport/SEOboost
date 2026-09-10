/**
 * The content lane: the writing pipeline, decay detection and publishing.
 *
 * The pipeline is a state machine on `ContentDraft.stage`, advanced one stage per job. Running
 * a stage per job (rather than one long job per draft) is what makes it observable — every
 * stage gets its own `ContentStageRun` row with input, output and duration — and what stops a
 * single failing stage from throwing away an hour of upstream work.
 *
 * The machine deliberately stops at `READY_FOR_APPROVAL`. Publishing is a separate, explicitly
 * authorised job: no autonomy level lets a draft walk itself onto a live site from here.
 */

import {
  ActionStatus,
  ActionType,
  ApprovalStatus,
  ContentStage,
  ContentStageStatus,
  ExperimentStatus,
  NotificationSeverity,
  OpportunityStatus,
  OpportunityType,
  type Prisma,
  json,
  prisma,
} from '@seo/db';
import { enqueue, type JobHandler } from '@seo/queue';
import {
  clamp,
  createLogger,
  errorMessage,
  lastNDays,
  logNormalize,
  round,
  truncate,
} from '@seo/shared';
import { applyChange, summariseChanges } from '@seo/integrations';
import {
  calculatePriority,
  findDecayingPages,
  riskBandForActionType,
  riskLevelForActionType,
} from '@seo/seo-engine';
import { loadWebsite } from '../lib/website';
import { loadPeriodComparison } from '../lib/gsc';
import { dispatchAgent } from '../lib/agent-runtime';
import { skip } from '../lib/result';

const log = createLogger('worker:content');

/** The stage order the writer agent walks. Publication is not part of it, by design. */
const PIPELINE: ContentStage[] = [
  ContentStage.RESEARCH,
  ContentStage.INTENT_ANALYSIS,
  ContentStage.CANNIBALISATION_CHECK,
  ContentStage.COMPETITOR_ANALYSIS,
  ContentStage.BRIEF,
  ContentStage.OUTLINE,
  ContentStage.DRAFT,
  ContentStage.FACT_CHECK,
  ContentStage.SEO_OPTIMISATION,
  ContentStage.BRAND_REVIEW,
  ContentStage.INTERNAL_LINKING,
  ContentStage.STRUCTURED_DATA,
  ContentStage.QUALITY_REVIEW,
  ContentStage.READY_FOR_APPROVAL,
];

function nextStage(stage: ContentStage): ContentStage | null {
  const index = PIPELINE.indexOf(stage);
  if (index === -1 || index >= PIPELINE.length - 1) return null;
  return PIPELINE[index + 1];
}

// ─────────────────────────────────────────────────────────────
// content.pipeline-stage
// ─────────────────────────────────────────────────────────────

export interface PipelineStageResult {
  status: 'completed';
  draftId: string;
  stage: ContentStage;
  stageRunId: string;
  agentRunId: string | null;
  summary: string;
  nextStage: ContentStage | null;
  nextEnqueued: boolean;
}

export const contentPipelineStage: JobHandler<'content.pipeline-stage'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const draft = await prisma.contentDraft.findFirst({
    where: { id: payload.draftId, websiteId: website.id },
    select: { id: true, title: true, stage: true, currentStageStatus: true },
  });
  if (!draft) return skip(`Content draft ${payload.draftId} does not exist for this website.`);

  const stage = payload.stage;
  const already = await prisma.contentStageRun.findFirst({
    where: { draftId: draft.id, stage, status: ContentStageStatus.COMPLETED },
    select: { id: true },
  });
  if (already && !payload.force) {
    return skip(`Stage ${stage} already completed for this draft; pass force to re-run it.`);
  }

  const attempt =
    (await prisma.contentStageRun.count({ where: { draftId: draft.id, stage } })) + 1;
  const stageRun = await prisma.contentStageRun.create({
    data: {
      draftId: draft.id,
      stage,
      status: ContentStageStatus.RUNNING,
      attempt,
      input: json({ draftId: draft.id, stage, force: payload.force ?? false }),
      startedAt: new Date(),
    },
    select: { id: true, startedAt: true },
  });

  await prisma.contentDraft.update({
    where: { id: draft.id },
    data: { stage, currentStageStatus: ContentStageStatus.RUNNING },
  });

  await ctx.updateProgress(20, `Running ${stage}`);

  const dispatch = await dispatchAgent({
    agent: 'ContentWriterAgent',
    websiteId: website.id,
    trigger: 'workflow',
    input: { draftId: draft.id, stage, force: payload.force ?? false },
  });

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - (stageRun.startedAt?.getTime() ?? finishedAt.getTime());

  if (!dispatch.available) {
    await prisma.contentStageRun.update({
      where: { id: stageRun.id },
      data: {
        status: ContentStageStatus.SKIPPED,
        notes: dispatch.reason,
        finishedAt,
        durationMs,
      },
    });
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { currentStageStatus: ContentStageStatus.SKIPPED },
    });
    return skip(dispatch.reason, ['Install the agents package on the worker']);
  }

  const outcome = dispatch.outcome;

  if (outcome.skipped) {
    const reason = outcome.skipReason ?? 'The content agent could not run this stage.';
    await prisma.contentStageRun.update({
      where: { id: stageRun.id },
      data: {
        status: ContentStageStatus.SKIPPED,
        agentRunId: outcome.runId,
        notes: truncate(reason, 1_000),
        finishedAt,
        durationMs,
      },
    });
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { currentStageStatus: ContentStageStatus.SKIPPED },
    });
    return skip(reason, ['Configure an AI provider (OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY)']);
  }

  if (!outcome.ok) {
    const message = outcome.error ?? `Stage ${stage} failed.`;
    await prisma.contentStageRun.update({
      where: { id: stageRun.id },
      data: {
        status: ContentStageStatus.FAILED,
        agentRunId: outcome.runId,
        error: truncate(message, 2_000),
        finishedAt,
        durationMs,
      },
    });
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { currentStageStatus: ContentStageStatus.FAILED },
    });
    // Only a retryable failure is worth another attempt; a rejected input never improves.
    if (outcome.retryable) throw new Error(message);
    return skip(`Stage ${stage} could not complete: ${message}`);
  }

  await prisma.contentStageRun.update({
    where: { id: stageRun.id },
    data: {
      status: ContentStageStatus.COMPLETED,
      agentRunId: outcome.runId,
      output: json(outcome.result?.data ?? {}),
      notes: truncate(outcome.result?.summary ?? '', 1_000),
      finishedAt,
      durationMs,
    },
  });

  const following = nextStage(stage);
  if (following) {
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { stage: following, currentStageStatus: ContentStageStatus.PENDING },
    });
  } else {
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { stage, currentStageStatus: ContentStageStatus.COMPLETED },
    });
  }

  const enqueued = following
    ? await enqueue(
        'content.pipeline-stage',
        { websiteId: website.id, draftId: draft.id, stage: following },
        { trigger: 'chain', dedupeKey: `stage:${draft.id}:${following}` },
      )
    : { enqueued: false as const };

  await ctx.updateProgress(100, following ? `Queued ${following}` : 'Draft ready for approval');

  const result: PipelineStageResult = {
    status: 'completed',
    draftId: draft.id,
    stage,
    stageRunId: stageRun.id,
    agentRunId: outcome.runId,
    summary: outcome.result?.summary ?? `Stage ${stage} completed.`,
    nextStage: following,
    nextEnqueued: enqueued.enqueued,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// content.detect-decay
// ─────────────────────────────────────────────────────────────

export interface DecayResult {
  status: 'completed';
  lookbackDays: number;
  decayingPages: number;
  opportunitiesCreated: number;
  opportunitiesUpdated: number;
  highSeverity: number;
}

export const contentDetectDecay: JobHandler<'content.detect-decay'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const lookbackDays = payload.lookbackDays ?? 28;
  const minImpressions = payload.minImpressions ?? 0;

  await ctx.updateProgress(10, 'Comparing the last two periods');
  const { comparison } = await loadPeriodComparison(website.id, lookbackDays);

  if (comparison.previous.length === 0) {
    return skip(
      `There is no Search Console history before the last ${lookbackDays} days for ${website.domain}, so decay cannot be measured yet.`,
      ['Connect Search Console and let it backfill'],
    );
  }

  const filtered = {
    current: comparison.current.filter((row) => row.impressions >= minImpressions),
    previous: comparison.previous.filter((row) => row.impressions >= minImpressions),
  };

  const decaying = findDecayingPages(filtered);
  if (decaying.length === 0) {
    const result: DecayResult = {
      status: 'completed',
      lookbackDays,
      decayingPages: 0,
      opportunitiesCreated: 0,
      opportunitiesUpdated: 0,
      highSeverity: 0,
    };
    return result;
  }

  await ctx.updateProgress(40, `Recording ${decaying.length} decaying page(s)`);

  const urls = decaying.map((page) => page.page);
  const pages = await prisma.page.findMany({
    where: { websiteId: website.id, OR: [{ url: { in: urls } }, { normalizedUrl: { in: urls } }] },
    select: { id: true, url: true, normalizedUrl: true, clicks28d: true },
  });
  const pageByUrl = new Map<string, { id: string; clicks28d: number }>();
  for (const page of pages) {
    pageByUrl.set(page.url, { id: page.id, clicks28d: page.clicks28d });
    pageByUrl.set(page.normalizedUrl, { id: page.id, clicks28d: page.clicks28d });
  }

  const maxClicks = Math.max(1, ...decaying.map((page) => page.clicksBefore));
  let created = 0;
  let updated = 0;
  let highSeverity = 0;

  for (const page of decaying) {
    if (page.severity === 'high') highSeverity += 1;
    const match = pageByUrl.get(page.page) ?? null;

    const priority = calculatePriority({
      // Everything below is measured from the two windows, not assumed.
      impact: clamp(Math.abs(page.clicksChangePct) / 100),
      confidence: clamp(logNormalize(page.impressionsBefore, 10_000)),
      businessValue: clamp(page.clicksBefore / maxClicks),
      effort: 2,
      risk: riskLevelForActionType(ActionType.REFRESH_CONTENT),
    });

    const evidence = {
      clicksBefore: page.clicksBefore,
      clicksAfter: page.clicksAfter,
      clicksChangePct: page.clicksChangePct,
      impressionsBefore: page.impressionsBefore,
      impressionsAfter: page.impressionsAfter,
      impressionsChangePct: page.impressionsChangePct,
      positionBefore: page.positionBefore,
      positionAfter: page.positionAfter,
      positionChange: page.positionChange,
      lostQueries: page.lostQueries,
      severity: page.severity,
      lookbackDays,
    };

    const existing = await prisma.contentOpportunity.findFirst({
      where: {
        websiteId: website.id,
        type: OpportunityType.CONTENT_REFRESH,
        status: { in: [OpportunityStatus.IDENTIFIED, OpportunityStatus.ACCEPTED, OpportunityStatus.IN_PROGRESS] },
        ...(match ? { pageId: match.id } : { suggestedUrl: page.page }),
      },
      select: { id: true },
    });

    const data = {
      title: `Refresh ${truncate(page.page, 120)}`,
      reasoning: truncate(page.reason, 2_000),
      evidence: json(evidence),
      impactScore: round(clamp(Math.abs(page.clicksChangePct) / 100) * 100, 1),
      effortScore: 2,
      confidenceScore: round(clamp(logNormalize(page.impressionsBefore, 10_000)), 3),
      priorityScore: priority.score,
      estimatedTrafficGain: Math.max(0, page.clicksBefore - page.clicksAfter),
    };

    if (existing) {
      await prisma.contentOpportunity.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.contentOpportunity.create({
        data: {
          websiteId: website.id,
          pageId: match?.id ?? null,
          type: OpportunityType.CONTENT_REFRESH,
          status: OpportunityStatus.IDENTIFIED,
          suggestedUrl: page.page,
          ...data,
        },
      });
      created += 1;
    }
  }

  if (highSeverity > 0) {
    await prisma.notification
      .create({
        data: {
          websiteId: website.id,
          type: 'content-decay',
          severity: NotificationSeverity.WARNING,
          title: `${highSeverity} page(s) are losing traffic fast`,
          message: `Comparing the last ${lookbackDays} days with the period before, ${highSeverity} page(s) lost more than 60% of their clicks.`,
          link: '/content/opportunities',
          data: json({ highSeverity, decayingPages: decaying.length }),
          dedupeKey: `content-decay:${website.id}:${new Date().toISOString().slice(0, 10)}`,
        },
      })
      .catch(() => undefined);
  }

  await ctx.updateProgress(100, 'Decay analysis complete');
  const result: DecayResult = {
    status: 'completed',
    lookbackDays,
    decayingPages: decaying.length,
    opportunitiesCreated: created,
    opportunitiesUpdated: updated,
    highSeverity,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// content.publish
// ─────────────────────────────────────────────────────────────

export interface PublishResult {
  status: 'completed';
  draftId: string;
  dryRun: boolean;
  published: boolean;
  url: string | null;
  externalId: string | null;
  adapter: string | null;
  actionId: string;
  changeLogId: string | null;
  experimentId: string | null;
  changes: Array<{ field: string; before: string | null; after: string | null }>;
  warnings: string[];
}

/**
 * Pushes an approved draft to the live site through the adapter layer.
 *
 * Publishing always requires explicit authorisation: either the draft has been moved to
 * `APPROVED`, or the job carries a `SeoAction` whose `Approval` is approved. The adapter layer
 * enforces its own approval gate on top of this one — both have to agree.
 */
export const contentPublish: JobHandler<'content.publish'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const draft = await prisma.contentDraft.findFirst({
    where: { id: payload.draftId, websiteId: website.id },
  });
  if (!draft) return skip(`Content draft ${payload.draftId} does not exist for this website.`);

  const dryRun = payload.dryRun ?? false;

  const action = payload.actionId
    ? await prisma.seoAction.findFirst({ where: { id: payload.actionId, websiteId: website.id } })
    : null;

  const approval = action
    ? await prisma.approval.findFirst({
        where: { actionId: action.id, status: ApprovalStatus.APPROVED },
        orderBy: { decidedAt: 'desc' },
        select: { id: true, userId: true },
      })
    : null;

  const draftApproved =
    draft.stage === ContentStage.APPROVED || draft.stage === ContentStage.PUBLISHED;

  if (!dryRun && !draftApproved && !approval) {
    return skip(
      `Draft "${draft.title}" has not been approved for publication (stage ${draft.stage}).`,
      ['Approve the draft, or approve the publishing action in the Approvals queue'],
    );
  }

  await ctx.updateProgress(25, dryRun ? 'Previewing the publish' : 'Publishing');

  const startedAt = new Date();
  const applied = await applyChange({
    websiteId: website.id,
    actionType: ActionType.PUBLISH_CONTENT,
    dryRun,
    approvedByUserId: approval?.userId ?? null,
    payload: {
      ...(draft.externalId ? { externalId: draft.externalId } : {}),
      title: draft.title,
      ...(draft.metaTitle ? { metaTitle: draft.metaTitle } : {}),
      ...(draft.metaDescription ? { metaDescription: draft.metaDescription } : {}),
      ...(draft.slug ? { slug: draft.slug } : {}),
      ...(draft.excerpt ? { excerpt: draft.excerpt } : {}),
      ...(draft.bodyHtml ? { bodyHtml: draft.bodyHtml } : {}),
      bodyMarkdown: draft.bodyMarkdown,
      status: 'publish',
    },
  });

  // Every publish gets an action row, so the change, its approval and its measurement hang off
  // one id even when the publish was triggered directly from the drafts screen.
  const publishAction =
    action ??
    (await prisma.seoAction.create({
      data: {
        websiteId: website.id,
        type: ActionType.PUBLISH_CONTENT,
        title: truncate(`Publish: ${draft.title}`, 200),
        status: dryRun ? ActionStatus.PROPOSED : ActionStatus.EXECUTING,
        risk: riskBandForActionType(ActionType.PUBLISH_CONTENT),
        reasoning: `Publishing content draft ${draft.id} for ${website.domain}.`,
        sourceType: 'content-draft',
        sourceId: draft.id,
        affectedUrls: draft.publishedUrl ? [draft.publishedUrl] : [],
        payload: json({ draftId: draft.id }),
        executedAt: dryRun ? null : new Date(),
      },
    }));

  await prisma.actionExecution.create({
    data: {
      actionId: publishAction.id,
      attempt: (await prisma.actionExecution.count({ where: { actionId: publishAction.id } })) + 1,
      status: applied.ok ? (dryRun ? 'DRY_RUN' : 'COMPLETED') : 'FAILED',
      adapter: applied.adapter ?? null,
      request: json({ draftId: draft.id, dryRun }),
      response: json({ ok: applied.ok, url: applied.url ?? null, externalId: applied.externalId ?? null }),
      beforeState: json(applied.before ?? {}),
      afterState: json(applied.after ?? {}),
      rollbackData: json({ before: applied.before ?? null, changes: applied.changes }),
      error: applied.ok ? null : truncate(applied.error ?? 'Publish failed', 2_000),
      startedAt,
      finishedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
    },
  });

  if (!applied.ok) {
    await prisma.seoAction.update({
      where: { id: publishAction.id },
      data: {
        status: dryRun ? ActionStatus.PROPOSED : ActionStatus.FAILED,
        error: truncate(applied.error ?? 'Publish failed', 2_000),
      },
    });
    const message = applied.error ?? 'The adapter refused to publish this draft.';
    if (applied.errorCode === 'NO_ADAPTER') {
      return skip(message, ['Connect a publishing integration for this website']);
    }
    throw new Error(message);
  }

  if (dryRun) {
    const preview: PublishResult = {
      status: 'completed',
      draftId: draft.id,
      dryRun: true,
      published: false,
      url: applied.url ?? null,
      externalId: applied.externalId ?? null,
      adapter: applied.adapter ?? null,
      actionId: publishAction.id,
      changeLogId: null,
      experimentId: null,
      changes: applied.changes,
      warnings: applied.warnings,
    };
    await ctx.updateProgress(100, 'Dry run complete');
    return preview;
  }

  await ctx.updateProgress(70, 'Recording the publication');

  const publishedAt = new Date();
  const changeLog = await prisma.changeLog.create({
    data: {
      websiteId: website.id,
      actionId: publishAction.id,
      userId: approval?.userId ?? null,
      actor: approval ? 'user-approved' : 'platform',
      agent: 'ContentWriterAgent',
      changeType: ActionType.PUBLISH_CONTENT,
      targetUrl: applied.url ?? draft.publishedUrl,
      summary: summariseChanges(applied.changes) || `Published "${draft.title}"`,
      beforeState: json(applied.before ?? {}),
      afterState: json(applied.after ?? {}),
      reason: `Content draft ${draft.id} reached ${draft.stage} and was published.`,
      approved: Boolean(approval) || draftApproved,
      rollbackable: applied.before !== null,
    },
    select: { id: true },
  });

  const baseline = lastNDays(28, 3, publishedAt);
  const experiment = await prisma.experiment.upsert({
    where: { actionId: publishAction.id },
    create: {
      websiteId: website.id,
      actionId: publishAction.id,
      pageId: draft.pageId,
      name: truncate(`Publish: ${draft.title}`, 200),
      hypothesis: 'New or updated content earns organic clicks it did not have before.',
      metric: 'clicks',
      status: ExperimentStatus.RUNNING,
      changeSummary: summariseChanges(applied.changes) || `Published "${draft.title}"`,
      beforeState: json(applied.before ?? {}),
      afterState: json(applied.after ?? {}),
      baselineStart: baseline.start,
      baselineEnd: baseline.end,
      measureStart: publishedAt,
      minDays: 28,
    },
    update: { status: ExperimentStatus.RUNNING, measureStart: publishedAt, measureEnd: null },
    select: { id: true },
  });

  await prisma.seoAction.update({
    where: { id: publishAction.id },
    data: {
      status: ActionStatus.COMPLETED,
      completedAt: publishedAt,
      // 7 settling days + 28 observed days, the same window every other action uses.
      measureAfter: new Date(publishedAt.getTime() + 35 * 86_400_000),
      ...(applied.url ? { affectedUrls: [applied.url] } : {}),
    },
  });

  await prisma.contentDraft.update({
    where: { id: draft.id },
    data: {
      stage: ContentStage.PUBLISHED,
      currentStageStatus: ContentStageStatus.COMPLETED,
      publishedAt,
      publishedUrl: applied.url ?? draft.publishedUrl,
      externalId: applied.externalId ?? draft.externalId,
    },
  });

  log.info('draft published', {
    websiteId: website.id,
    draftId: draft.id,
    url: applied.url,
    adapter: applied.adapter,
  });

  await ctx.updateProgress(100, 'Published');
  const result: PublishResult = {
    status: 'completed',
    draftId: draft.id,
    dryRun: false,
    published: true,
    url: applied.url ?? null,
    externalId: applied.externalId ?? null,
    adapter: applied.adapter ?? null,
    actionId: publishAction.id,
    changeLogId: changeLog.id,
    experimentId: experiment.id,
    changes: applied.changes,
    warnings: applied.warnings,
  };
  return result;
};

/** Exposed for the maintenance digest, which counts drafts waiting on a human. */
export async function countDraftsAwaitingApproval(websiteId: string): Promise<number> {
  return prisma.contentDraft.count({
    where: { websiteId, stage: ContentStage.READY_FOR_APPROVAL },
  });
}

/** Narrow helper so a stage name coming from a payload is always a real pipeline stage. */
export function isPipelineStage(value: string): value is ContentStage {
  return (PIPELINE as string[]).includes(value);
}
