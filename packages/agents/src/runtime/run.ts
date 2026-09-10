import { json, prisma } from '@seo/db';
import type { ActionRisk, ActionStatus, ActionType, AgentRunStatus, Prisma } from '@seo/db';
import { isAiAvailable } from '@seo/ai';
import {
  calculatePriority,
  canAutoExecute,
  riskBandForActionType,
  riskLevelForActionType,
  summariseActionOutcomes,
} from '@seo/seo-engine';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  addDays,
  createLogger,
  errorMessage,
  round,
  toAppError,
  truncate,
  type ExplainableScore,
} from '@seo/shared';
import type { AgentContext, AgentResult } from '../types';
import { bindRunToAgent, findAgent, resolveCallingAgent, unbindRun } from './registry';

const log = createLogger('agents:run');

/**
 * Hard cap on the run transcript. A long-running agent that calls a tool in a loop must not be
 * able to grow one JSON column without bound — the transcript exists for the UI, not for storage.
 */
const MAX_TOOL_CALLS = 200;
/** Per-value budget inside the transcript; larger payloads are stored as a truncated preview. */
const MAX_RECORDED_VALUE_CHARS = 1500;

export interface ToolCallRecord {
  name: string;
  args: unknown;
  result: unknown;
  durationMs: number;
  at: string;
}

export interface AgentRunUsage {
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  calls: number;
}

export interface AgentRunOutcome {
  /** Null only when the run row itself could not be created (e.g. unknown website). */
  runId: string | null;
  agent: string;
  status: AgentRunStatus;
  ok: boolean;
  skipped: boolean;
  skipReason: string | null;
  result: AgentResult | null;
  error: string | null;
  errorCode: string | null;
  /** Whether a queue processor should retry. Mirrors AppError.retryable. */
  retryable: boolean;
  durationMs: number;
  toolCalls: ToolCallRecord[];
  usage: AgentRunUsage;
}

export interface RunAgentOptions {
  websiteId: string;
  userId?: string | null;
  trigger?: AgentContext['trigger'];
  input?: Record<string, unknown>;
  signal?: AbortSignal;
}

const EMPTY_USAGE: AgentRunUsage = {
  provider: null,
  model: null,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  calls: 0,
};

/** Keep the transcript small without lying about what was there. */
function compactValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return value.length > MAX_RECORDED_VALUE_CHARS ? truncate(value, MAX_RECORDED_VALUE_CHARS) : value;
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(value) ?? String(value);
  } catch {
    return { unserialisable: true };
  }
  if (serialised.length <= MAX_RECORDED_VALUE_CHARS) return value;
  return {
    truncated: true,
    bytes: serialised.length,
    preview: serialised.slice(0, MAX_RECORDED_VALUE_CHARS),
  };
}

/**
 * Cost attribution for a run.
 *
 * Reads back the `AiUsage` rows written while the run was in flight — the accounting already
 * happens inside `@seo/ai`, so re-deriving totals here would risk disagreeing with the cost
 * dashboard. Rows are matched on the agent label, which is why agents must pass
 * `agent: <AgentName>` to `ai.generate`; unattributed spend stays out rather than being guessed
 * onto whichever run happened to be open.
 *
 * Known limit: `AiUsage` has no run id, so two runs of the same agent on the same site that
 * overlap in time each report the other's spend as well. Site-level cost totals stay correct —
 * they come from `AiUsage` itself — and the per-run figure is deliberately an over-estimate
 * rather than a silent zero.
 */
async function collectUsage(
  websiteId: string,
  agent: string,
  since: Date,
  until: Date,
): Promise<AgentRunUsage> {
  // Grouped rather than row-by-row: an agent that makes thousands of small calls would otherwise
  // pull every one of them back just to add up five numbers.
  const groups = await prisma.aiUsage.groupBy({
    by: ['provider', 'model'],
    where: { websiteId, agent, createdAt: { gte: since, lte: until } },
    _sum: { tokensIn: true, tokensOut: true, costUsd: true },
    _count: { _all: true },
  });
  if (!groups.length) return { ...EMPTY_USAGE };

  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let calls = 0;
  // Report the model that did most of the work rather than an arbitrary one.
  let dominant: { provider: string; model: string } | null = null;
  let best = -1;

  for (const group of groups) {
    tokensIn += group._sum.tokensIn ?? 0;
    tokensOut += group._sum.tokensOut ?? 0;
    costUsd += group._sum.costUsd ?? 0;
    calls += group._count._all;
    if (group._count._all > best) {
      best = group._count._all;
      dominant = { provider: group.provider, model: group.model };
    }
  }

  return {
    provider: dominant?.provider ?? null,
    model: dominant?.model ?? null,
    tokensIn,
    tokensOut,
    costUsd: round(costUsd, 6),
    calls,
  };
}

function failure(
  agent: string,
  runId: string | null,
  error: unknown,
  durationMs: number,
  toolCalls: ToolCallRecord[] = [],
  usage: AgentRunUsage = { ...EMPTY_USAGE },
): AgentRunOutcome {
  const appError = toAppError(error);
  return {
    runId,
    agent,
    status: 'FAILED',
    ok: false,
    skipped: false,
    skipReason: null,
    result: null,
    error: appError.message,
    errorCode: appError.code,
    retryable: appError.retryable,
    durationMs,
    toolCalls,
    usage,
  };
}

/**
 * Execute one agent end to end and persist the run.
 *
 * Never throws. A queue processor needs to distinguish "the site has no crawl yet" (skipped, do
 * not retry), "the provider rate-limited us" (failed, retryable) and "the agent has a bug"
 * (failed, not retryable) — an exception thrown across that boundary erases the distinction, so
 * every path here returns a typed outcome instead.
 */
export async function runAgent(name: string, options: RunAgentOptions): Promise<AgentRunOutcome> {
  const startedAtMs = Date.now();
  const trigger = options.trigger ?? 'manual';
  const input = options.input ?? {};

  const definition = findAgent(name);
  if (!definition) {
    return failure(
      name,
      null,
      new ForbiddenError(
        `No agent named "${name}" is registered. Import the agent module so it self-registers before running it.`,
      ),
      Date.now() - startedAtMs,
    );
  }

  let run: { id: string; startedAt: Date };
  try {
    run = await prisma.agentRun.create({
      data: {
        websiteId: options.websiteId,
        agent: definition.name,
        trigger,
        status: 'RUNNING',
        input: json(input),
      },
      select: { id: true, startedAt: true },
    });
  } catch (err) {
    log.error('could not create the agent run row', {
      agent: definition.name,
      websiteId: options.websiteId,
      error: errorMessage(err),
    });
    // The caller only ever sees this message (runAgent never throws), so an unknown site should
    // say so rather than surfacing a raw foreign-key violation.
    const website = await prisma.website
      .findUnique({ where: { id: options.websiteId }, select: { id: true } })
      .catch(() => null);
    return failure(
      definition.name,
      null,
      website ? err : new NotFoundError(`Website ${options.websiteId}`),
      Date.now() - startedAtMs,
    );
  }

  const toolCalls: ToolCallRecord[] = [];
  let droppedToolCalls = 0;
  const runLog = log.child({ agent: definition.name, runId: run.id, websiteId: options.websiteId });

  const context: AgentContext = {
    websiteId: options.websiteId,
    userId: options.userId ?? null,
    trigger,
    runId: run.id,
    ...(options.signal ? { signal: options.signal } : {}),
    input,
    recordToolCall(toolName, args, result, durationMs) {
      if (toolCalls.length >= MAX_TOOL_CALLS) {
        droppedToolCalls += 1;
        return;
      }
      toolCalls.push({
        name: toolName,
        args: compactValue(args),
        result: compactValue(result),
        durationMs,
        at: new Date().toISOString(),
      });
    },
    log(message, meta) {
      runLog.info(message, meta);
    },
  };

  bindRunToAgent(run.id, definition.name);

  let status: AgentRunStatus = 'FAILED';
  let result: AgentResult | null = null;
  let caught: unknown = null;

  try {
    if (options.signal?.aborted) {
      status = 'CANCELLED';
    } else if (definition.inputSchema) {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        throw new ValidationError(
          `Input rejected by ${definition.name}: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
            .join('; ')}`,
          parsed.error.issues,
        );
      }
      context.input = parsed.data;
    }

    if (status !== 'CANCELLED' && definition.requiresAi && !isAiAvailable()) {
      // A missing provider key is a configuration state, not a failure: say exactly what to set.
      result = {
        summary: `${definition.label} needs an AI provider and none is configured.`,
        confidence: 0,
        actionsCreated: [],
        approvalsCreated: [],
        findings: [],
        data: {},
        skipped: true,
        skipReason:
          'No AI provider is configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY and run again.',
      };
      status = 'COMPLETED';
    } else if (status !== 'CANCELLED') {
      result = await definition.run(context);
      status = options.signal?.aborted ? 'CANCELLED' : 'COMPLETED';
    }
  } catch (err) {
    caught = err;
    status = options.signal?.aborted ? 'CANCELLED' : 'FAILED';
    runLog.error('agent run failed', { error: errorMessage(err) });
  } finally {
    unbindRun(run.id);
  }

  const finishedAt = new Date();
  const durationMs = Date.now() - startedAtMs;
  const usage = await collectUsage(
    options.websiteId,
    definition.name,
    run.startedAt,
    finishedAt,
  ).catch((err) => {
    runLog.warn('could not read AI usage for this run', { error: errorMessage(err) });
    return { ...EMPTY_USAGE };
  });

  const output: Record<string, unknown> = result
    ? {
        data: result.data,
        findings: result.findings,
        actionsCreated: result.actionsCreated,
        approvalsCreated: result.approvalsCreated,
        ...(result.skipped ? { skipped: true, skipReason: result.skipReason ?? null } : {}),
      }
    : {};
  if (droppedToolCalls > 0) output.droppedToolCalls = droppedToolCalls;

  const summary =
    result?.summary ??
    (status === 'CANCELLED'
      ? 'Run cancelled before completion.'
      : caught
        ? truncate(errorMessage(caught), 500)
        : 'Run finished with no summary.');

  try {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status,
        output: json(output),
        summary,
        toolCalls: json(toolCalls),
        confidence: result?.confidence ?? null,
        actionsCreated: result?.actionsCreated.length ?? 0,
        error: caught ? truncate(errorMessage(caught), 2000) : null,
        provider: usage.provider,
        model: usage.model,
        tokensIn: usage.calls ? usage.tokensIn : null,
        tokensOut: usage.calls ? usage.tokensOut : null,
        costUsd: usage.calls ? usage.costUsd : null,
        finishedAt,
        durationMs,
      },
    });
  } catch (err) {
    runLog.error('could not persist the agent run result', { error: errorMessage(err) });
  }

  if (status === 'FAILED') {
    return failure(definition.name, run.id, caught ?? new Error(summary), durationMs, toolCalls, usage);
  }

  return {
    runId: run.id,
    agent: definition.name,
    status,
    ok: status === 'COMPLETED',
    skipped: result?.skipped ?? false,
    skipReason: result?.skipReason ?? null,
    result,
    error: null,
    errorCode: null,
    retryable: false,
    durationMs,
    toolCalls,
    usage,
  };
}

// ─────────────────────────────────────────────────────────────
// Action creation
// ─────────────────────────────────────────────────────────────

/** Statuses that mean "this proposal is still live", used for de-duplication. */
const OPEN_ACTION_STATUSES: ActionStatus[] = [
  'PROPOSED',
  'QUEUED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'MEASURING',
];

/**
 * How long a human "no" keeps a finding off the queue.
 *
 * Only applied when the proposal carries a source (`sourceType` + `sourceId`), so this matches
 * the *same finding* being re-proposed — not merely another action of the same type. Without it
 * a scheduled agent re-proposes what the operator declined the moment the rejected row falls out
 * of the open-status dedupe, which is precisely the behaviour the memory module exists to stop.
 */
const REJECTION_COOLDOWN_DAYS = 90;

export interface CreateActionInput {
  type: ActionType;
  title: string;
  /** Why this is being proposed, in plain English. Shown to the operator verbatim. */
  reasoning: string;
  evidence?: Record<string, unknown>;
  affectedUrls?: string[];
  payload?: Record<string, unknown>;
  /** 0-1 expected benefit if it works. */
  impact: number;
  /** 0-1 confidence in the diagnosis and the fix. */
  confidence: number;
  /** 0-1 relevance to the site's stated conversion goal. */
  businessValue: number;
  /** 1-5, where 1 is trivial. */
  effort: number;
  /** Where the proposal came from, e.g. `technical-issue` + the issue id. Also the dedupe key. */
  sourceType?: string | null;
  sourceId?: string | null;
  /** Agent that will execute it. Defaults to the proposing agent. */
  requiredAgent?: string | null;
  /** Days to wait before measuring the effect. Defaults to a full 28-day Search Console window. */
  measureAfterDays?: number;
}

export interface CreatedActionResult {
  actionId: string;
  approvalId: string | null;
  status: ActionStatus;
  risk: ActionRisk;
  autoExecutable: boolean;
  priority: ExplainableScore;
  /** False when an equivalent open proposal already existed and was returned instead. */
  created: boolean;
  reason: string;
}

/**
 * The single path by which an agent turns a finding into a persisted `SeoAction`.
 *
 * Everything that makes an action safe happens here, once, rather than in thirteen agents:
 * the type is checked against the calling agent's declared `allowedActionTypes`, priority is
 * scored with the site's own measured history, the risk band comes from the shared table, and
 * `canAutoExecute` — not the agent — decides whether a human has to sign off. An agent cannot
 * grant itself permission by writing to `prisma.seoAction` directly, because the write tools
 * route through here and the allow-list is enforced before any row is touched.
 */
export async function createActionFromAgent(
  context: AgentContext,
  input: CreateActionInput,
): Promise<CreatedActionResult> {
  const agent = await resolveCallingAgent(context);

  if (!agent.allowedActionTypes.includes(input.type)) {
    throw new ForbiddenError(
      `${agent.name} is not allowed to create ${input.type} actions. Allowed: ${
        agent.allowedActionTypes.join(', ') || 'none'
      }.`,
    );
  }

  const affectedUrls = (input.affectedUrls ?? []).filter((url) => typeof url === 'string' && url.length > 0);
  const targetUrl = affectedUrls[0] ?? null;
  // Truncated once, then used for both the dedupe probe and the insert: matching on the raw title
  // while storing a shortened one would make every long-titled proposal a fresh duplicate.
  const title = truncate(input.title, 300);

  // De-duplicate before doing any work: agents re-run on a schedule over the same findings.
  // A proposal with a source is matched on that source; anything else on type plus target.
  const identity: Prisma.SeoActionWhereInput =
    input.sourceType && input.sourceId
      ? {
          websiteId: context.websiteId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        }
      : {
          websiteId: context.websiteId,
          type: input.type,
          ...(targetUrl ? { affectedUrls: { has: targetUrl } } : { title }),
        };

  const hasSource = Boolean(input.sourceType && input.sourceId);
  const [existing, rejected] = await Promise.all([
    prisma.seoAction.findFirst({
      where: { ...identity, status: { in: OPEN_ACTION_STATUSES } },
      orderBy: { proposedAt: 'desc' },
      select: {
        id: true,
        status: true,
        risk: true,
        autoExecutable: true,
        priorityScore: true,
        approvals: { where: { status: 'PENDING' }, select: { id: true }, take: 1 },
      },
    }),
    // Only for sourced proposals: matching a rejection on type + URL alone would silence every
    // future idea about a page because one idea about it was declined.
    hasSource
      ? prisma.seoAction.findFirst({
          where: {
            ...identity,
            status: 'REJECTED',
            proposedAt: { gte: addDays(new Date(), -REJECTION_COOLDOWN_DAYS) },
          },
          orderBy: { proposedAt: 'desc' },
          select: { id: true, status: true, risk: true, priorityScore: true },
        })
      : Promise.resolve(null),
  ]);

  if (existing) {
    return {
      actionId: existing.id,
      approvalId: existing.approvals[0]?.id ?? null,
      status: existing.status,
      risk: existing.risk,
      autoExecutable: existing.autoExecutable,
      priority: {
        score: existing.priorityScore,
        factors: [],
        summary: 'Existing proposal — priority was scored when it was first created.',
      },
      created: false,
      reason: 'An equivalent proposal is already open for this site; returned it instead of duplicating.',
    };
  }

  if (rejected) {
    log.info('proposal suppressed by an earlier rejection', {
      agent: agent.name,
      websiteId: context.websiteId,
      type: input.type,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    return {
      actionId: rejected.id,
      approvalId: null,
      status: rejected.status,
      risk: rejected.risk,
      autoExecutable: false,
      priority: {
        score: rejected.priorityScore,
        factors: [],
        summary: 'Previously rejected proposal — not re-scored.',
      },
      created: false,
      reason:
        `A human rejected this exact finding within the last ${REJECTION_COOLDOWN_DAYS} days, so it was not ` +
        're-proposed. Read the rejection note before raising it again.',
    };
  }

  const [settings, experiments] = await Promise.all([
    prisma.websiteSettings.findUnique({
      where: { websiteId: context.websiteId },
      select: { autonomyLevel: true, autoApproveSafe: true },
    }),
    prisma.experiment.findMany({
      where: { websiteId: context.websiteId, action: { type: input.type } },
      // Newest first: when a site has more history than the cap, the recent behaviour of this
      // action type is what should steer prioritisation, not an arbitrary slice of it.
      orderBy: { createdAt: 'desc' },
      select: { outcome: true, deltaPct: true, action: { select: { type: true } } },
      take: 200,
    }),
  ]);

  const history = summariseActionOutcomes(
    experiments
      .filter((row) => row.action !== null)
      .map((row) => ({
        actionType: row.action?.type ?? input.type,
        outcome: row.outcome,
        deltaPct: row.deltaPct,
      })),
  ).find((row) => row.actionType === input.type);

  const riskBand = riskBandForActionType(input.type);
  const priority = calculatePriority({
    impact: input.impact,
    confidence: input.confidence,
    businessValue: input.businessValue,
    effort: input.effort,
    risk: riskLevelForActionType(input.type),
    historicalSuccessRate: history?.successRate ?? null,
    historicalSampleSize: history?.total ?? 0,
  });

  const autonomyLevel = settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY';
  const autoApproveSafe = settings?.autoApproveSafe ?? false;
  const guard = canAutoExecute({ actionType: input.type, autonomyLevel, autoApproveSafe });
  const status: ActionStatus = guard.allowed ? 'QUEUED' : 'AWAITING_APPROVAL';
  const measureAfterDays = input.measureAfterDays ?? 28;

  const created = await prisma.$transaction(async (tx) => {
    const action = await tx.seoAction.create({
      data: {
        websiteId: context.websiteId,
        type: input.type,
        title,
        status,
        risk: riskBand,
        reasoning: input.reasoning,
        evidence: json(input.evidence ?? {}),
        affectedUrls,
        requiredAgent: input.requiredAgent ?? agent.name,
        payload: json(input.payload ?? {}),
        impactScore: input.impact,
        effortScore: input.effort,
        confidenceScore: input.confidence,
        businessValue: input.businessValue,
        riskScore: riskLevelForActionType(input.type),
        priorityScore: priority.score,
        priorityFactors: json(priority),
        ...(input.sourceType ? { sourceType: input.sourceType } : {}),
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        autoExecutable: guard.allowed,
        measureAfter: addDays(new Date(), measureAfterDays),
      },
      select: { id: true },
    });

    let approvalId: string | null = null;
    if (!guard.allowed) {
      const approval = await tx.approval.create({
        data: {
          websiteId: context.websiteId,
          actionId: action.id,
          ...(context.userId ? { userId: context.userId } : {}),
          kind: 'ACTION',
          title,
          description: input.reasoning,
          risk: riskBand,
          status: 'PENDING',
          payload: json({
            type: input.type,
            affectedUrls,
            payload: input.payload ?? {},
            priorityScore: priority.score,
            guard: guard.reason,
          }),
        },
        select: { id: true },
      });
      approvalId = approval.id;
    }

    await tx.changeLog.create({
      data: {
        websiteId: context.websiteId,
        actionId: action.id,
        ...(context.userId ? { userId: context.userId } : {}),
        actor: 'agent',
        agent: agent.name,
        changeType: 'ACTION_PROPOSED',
        ...(targetUrl ? { targetUrl } : {}),
        summary: `${agent.label} proposed ${input.type}: ${truncate(input.title, 200)}`,
        afterState: json({ status, risk: riskBand, priorityScore: priority.score }),
        reason: input.reasoning,
        approved: guard.allowed,
        // The proposal itself changes nothing on the site, so there is nothing to roll back yet.
        rollbackable: false,
      },
    });

    return { actionId: action.id, approvalId };
  });

  log.info('action proposed', {
    agent: agent.name,
    websiteId: context.websiteId,
    type: input.type,
    status,
    priority: priority.score,
  });

  return {
    actionId: created.actionId,
    approvalId: created.approvalId,
    status,
    risk: riskBand,
    autoExecutable: guard.allowed,
    priority,
    created: true,
    reason: guard.reason,
  };
}
