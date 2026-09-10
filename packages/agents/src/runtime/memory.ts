import { json, prisma } from '@seo/db';
import type { ActionType, Prisma } from '@seo/db';
import { summariseActionOutcomes } from '@seo/seo-engine';
import type { ActionOutcomeSummary } from '@seo/seo-engine';
import { NotFoundError, ValidationError, addDays, createLogger, truncate } from '@seo/shared';

const log = createLogger('agents:memory');

/**
 * Explicit, database-backed agent memory.
 *
 * This is deliberately NOT model conversation memory. Nothing here depends on a provider's
 * context window or on a transcript surviving between runs: everything an agent "remembers" is a
 * row someone can inspect, correct or delete — previous proposals, what the user rejected and
 * why, and what actually moved the numbers. That is what makes the platform's behaviour
 * explainable and what stops it re-proposing something the operator already declined.
 */

/** How many rows of each kind to carry into a reasoning prompt. Memory must stay small. */
const RECENT_LIMIT = 25;
/** Upper bound on experiments rolled up per site — enough history, bounded query cost. */
const EXPERIMENT_LIMIT = 500;

export interface PreviousRecommendation {
  actionId: string;
  type: string;
  title: string;
  status: string;
  targetUrls: string[];
  priorityScore: number;
  proposedAt: Date;
  /** Experiment verdict when the change was executed and measured. */
  outcome: string | null;
  deltaPct: number | null;
}

export interface RejectedRecommendation {
  approvalId: string;
  actionId: string | null;
  actionType: string | null;
  agent: string | null;
  title: string;
  targetUrls: string[];
  /** The operator's own words. The single most valuable thing in this whole structure. */
  note: string | null;
  rejectedAt: Date | null;
}

export interface SitePreferences {
  autonomyLevel: string;
  autoApproveSafe: boolean;
  brandName: string | null;
  businessCategory: string | null;
  targetAudience: string | null;
  conversionGoal: string | null;
  primaryLanguage: string;
  toneOfVoice: string | null;
  preferredCta: string | null;
  prohibitedClaims: string[];
  writingGuidelines: string | null;
  thinContentWords: number;
  strikingDistance: { min: number; max: number };
}

export interface AgentMemory {
  websiteId: string;
  agent: string;
  previousRecommendations: PreviousRecommendation[];
  measuredOutcomes: ActionOutcomeSummary[];
  rejectedRecommendations: RejectedRecommendation[];
  preferences: SitePreferences;
  generatedAt: Date;
}

/**
 * Load everything an agent is allowed to remember about a site.
 *
 * `previousRecommendations` is scoped to this agent (its own track record), while
 * `measuredOutcomes` and `rejectedRecommendations` are site-wide on purpose: "title rewrites do
 * nothing here" and "the operator refuses comparison pages" are facts about the site, not about
 * whichever agent happened to propose them.
 */
export async function getAgentMemory(websiteId: string, agent: string): Promise<AgentMemory> {
  const [website, settings, knowledge, actions, experiments, rejections] = await Promise.all([
    prisma.website.findUnique({
      where: { id: websiteId },
      select: {
        brandName: true,
        businessCategory: true,
        targetAudience: true,
        conversionGoal: true,
        primaryLanguage: true,
      },
    }),
    prisma.websiteSettings.findUnique({
      where: { websiteId },
      select: {
        autonomyLevel: true,
        autoApproveSafe: true,
        thinContentWords: true,
        strikingDistanceMin: true,
        strikingDistanceMax: true,
      },
    }),
    prisma.knowledgeBase.findUnique({
      where: { websiteId },
      select: {
        toneOfVoice: true,
        preferredCta: true,
        prohibitedClaims: true,
        writingGuidelines: true,
      },
    }),
    prisma.seoAction.findMany({
      where: { websiteId, requiredAgent: agent },
      orderBy: { proposedAt: 'desc' },
      take: RECENT_LIMIT,
      select: {
        id: true,
        type: true,
        title: true,
        status: true,
        affectedUrls: true,
        priorityScore: true,
        proposedAt: true,
        experiment: { select: { outcome: true, deltaPct: true } },
      },
    }),
    prisma.experiment.findMany({
      where: { websiteId, actionId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: EXPERIMENT_LIMIT,
      select: { outcome: true, deltaPct: true, action: { select: { type: true } } },
    }),
    prisma.approval.findMany({
      where: { websiteId, status: 'REJECTED' },
      orderBy: { decidedAt: 'desc' },
      take: RECENT_LIMIT,
      select: {
        id: true,
        title: true,
        decisionNote: true,
        decidedAt: true,
        actionId: true,
        action: { select: { type: true, affectedUrls: true, requiredAgent: true } },
      },
    }),
  ]);

  if (!website) throw new NotFoundError('Website');

  const measuredOutcomes = summariseActionOutcomes(
    experiments
      .filter((row) => row.action !== null)
      .map((row) => ({
        actionType: row.action?.type ?? 'CUSTOM',
        outcome: row.outcome,
        deltaPct: row.deltaPct,
      })),
  );

  return {
    websiteId,
    agent,
    previousRecommendations: actions.map((action) => ({
      actionId: action.id,
      type: action.type,
      title: action.title,
      status: action.status,
      targetUrls: action.affectedUrls,
      priorityScore: action.priorityScore,
      proposedAt: action.proposedAt,
      outcome: action.experiment?.outcome ?? null,
      deltaPct: action.experiment?.deltaPct ?? null,
    })),
    measuredOutcomes,
    rejectedRecommendations: rejections.map((approval) => ({
      approvalId: approval.id,
      actionId: approval.actionId,
      actionType: approval.action?.type ?? null,
      agent: approval.action?.requiredAgent ?? null,
      title: approval.title,
      targetUrls: approval.action?.affectedUrls ?? [],
      note: approval.decisionNote,
      rejectedAt: approval.decidedAt,
    })),
    preferences: {
      autonomyLevel: settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
      autoApproveSafe: settings?.autoApproveSafe ?? false,
      brandName: website.brandName,
      businessCategory: website.businessCategory,
      targetAudience: website.targetAudience,
      conversionGoal: website.conversionGoal,
      primaryLanguage: website.primaryLanguage,
      toneOfVoice: knowledge?.toneOfVoice ?? null,
      preferredCta: knowledge?.preferredCta ?? null,
      prohibitedClaims: knowledge?.prohibitedClaims ?? [],
      writingGuidelines: knowledge?.writingGuidelines ?? null,
      thinContentWords: settings?.thinContentWords ?? 300,
      strikingDistance: {
        min: settings?.strikingDistanceMin ?? 8,
        max: settings?.strikingDistanceMax ?? 20,
      },
    },
    generatedAt: new Date(),
  };
}

export interface RecordRejectionInput {
  websiteId: string;
  /** The approval the operator declined. Either this or `actionId` must be supplied. */
  approvalId?: string | null;
  actionId?: string | null;
  /** Why it was declined, in the operator's words. Fed back into future prompts verbatim. */
  reason: string;
  userId?: string | null;
}

/**
 * Persist a rejection so no agent proposes the same thing again.
 *
 * Writes three things: the approval decision, the action's terminal status, and an immutable
 * ChangeLog entry. The reason text is the part that matters — `buildMemoryPromptBlock` quotes it
 * back to the model, which is how "stop suggesting this" actually sticks.
 */
export async function recordRejection(input: RecordRejectionInput): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ValidationError('A rejection needs a reason — it is what stops the agent re-proposing it.');
  }
  if (!input.approvalId && !input.actionId) {
    throw new ValidationError('recordRejection needs either an approvalId or an actionId.');
  }

  let actionId = input.actionId ?? null;
  let approvalId: string | null = null;

  // Ownership is resolved first, outside the transaction, so a mis-scoped id fails before any
  // row is touched rather than half-way through.
  if (input.approvalId) {
    const approval = await prisma.approval.findFirst({
      where: { id: input.approvalId, websiteId: input.websiteId },
      select: { id: true, actionId: true },
    });
    if (!approval) throw new NotFoundError('Approval');
    approvalId = approval.id;
    actionId = actionId ?? approval.actionId;
  }

  let targetUrl: string | null = null;
  let agent: string | null = null;
  let summary = 'Recommendation rejected';

  if (actionId) {
    const action = await prisma.seoAction.findFirst({
      where: { id: actionId, websiteId: input.websiteId },
      select: { id: true, title: true, affectedUrls: true, requiredAgent: true },
    });
    if (!action) throw new NotFoundError('SeoAction');
    targetUrl = action.affectedUrls[0] ?? null;
    agent = action.requiredAgent;
    summary = `Rejected: ${action.title}`;
  }

  // One transaction: an approval marked REJECTED whose action is still QUEUED would be executed
  // by the worker despite the operator having declined it.
  const decidedAt = new Date();
  await prisma.$transaction(async (tx) => {
    if (approvalId) {
      await tx.approval.update({
        where: { id: approvalId },
        data: {
          status: 'REJECTED',
          decidedAt,
          decisionNote: reason,
          ...(input.userId ? { userId: input.userId } : {}),
        },
      });
    }

    if (actionId) {
      await tx.seoAction.update({
        where: { id: actionId },
        data: { status: 'REJECTED', error: null },
      });
    }

    await tx.changeLog.create({
      data: {
        websiteId: input.websiteId,
        ...(actionId ? { actionId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        actor: input.userId ? 'user' : 'system',
        ...(agent ? { agent } : {}),
        changeType: 'ACTION_REJECTED',
        ...(targetUrl ? { targetUrl } : {}),
        summary,
        reason,
        approved: false,
        rollbackable: false,
      },
    });
  });

  log.info('recorded rejection', { websiteId: input.websiteId, actionId });
}

/**
 * Has this exact proposal already been made recently?
 *
 * Counts proposals of any status on purpose: a pending action is noise if re-proposed, an
 * executed one is already done, and a rejected one is the case this exists to prevent. Agents
 * call this before spending an LLM call on a recommendation nobody wants to see again.
 */
export async function hasRecentlyProposed(
  websiteId: string,
  type: ActionType,
  targetUrl?: string | null,
  withinDays = 30,
): Promise<boolean> {
  const since = addDays(new Date(), -Math.max(1, withinDays));
  const where: Prisma.SeoActionWhereInput = {
    websiteId,
    type,
    proposedAt: { gte: since },
    ...(targetUrl ? { affectedUrls: { has: targetUrl } } : {}),
  };
  const count = await prisma.seoAction.count({ where });
  return count > 0;
}

/** Was an equivalent proposal explicitly declined by a human in the window? */
export async function hasRecentlyRejected(
  websiteId: string,
  type: ActionType,
  targetUrl?: string | null,
  withinDays = 90,
): Promise<{ rejected: boolean; reason: string | null }> {
  const since = addDays(new Date(), -Math.max(1, withinDays));
  const approval = await prisma.approval.findFirst({
    where: {
      websiteId,
      status: 'REJECTED',
      decidedAt: { gte: since },
      action: {
        type,
        ...(targetUrl ? { affectedUrls: { has: targetUrl } } : {}),
      },
    },
    orderBy: { decidedAt: 'desc' },
    select: { decisionNote: true },
  });
  return { rejected: Boolean(approval), reason: approval?.decisionNote ?? null };
}

/**
 * Render memory as a compact block for a reasoning prompt.
 *
 * Kept terse and factual: a prompt that carries a hundred rows of history stops being memory and
 * starts being a distraction (and a cost). Only the parts that should change the next decision
 * make it in — what was rejected and why, and what has actually been measured.
 */
export function buildMemoryPromptBlock(memory: AgentMemory): string {
  const lines: string[] = [];

  const rejected = memory.rejectedRecommendations.slice(0, 8);
  if (rejected.length) {
    lines.push('Rejected before — do not propose these again unless the situation has changed:');
    for (const item of rejected) {
      const where = item.targetUrls[0] ? ` for ${item.targetUrls[0]}` : '';
      const because = item.note ? ` because "${truncate(item.note, 180)}"` : ' (no reason given)';
      lines.push(`- ${item.actionType ?? 'proposal'}${where} was rejected${because}.`);
    }
  }

  const measured = memory.measuredOutcomes.filter((row) => row.total > 0).slice(0, 6);
  if (measured.length) {
    lines.push('', 'Measured results on this site:');
    for (const row of measured) {
      const rate =
        row.successRate === null
          ? 'not enough data'
          : `helped in ${row.positive} of ${row.total} measured cases`;
      const delta = row.avgDeltaPct === null ? '' : ` (avg ${row.avgDeltaPct >= 0 ? '+' : ''}${row.avgDeltaPct}%)`;
      lines.push(`- ${row.actionType}: ${rate}${delta}. ${row.learning}`);
    }
  }

  const open = memory.previousRecommendations.filter(
    (item) => item.status === 'PROPOSED' || item.status === 'QUEUED' || item.status === 'AWAITING_APPROVAL',
  );
  if (open.length) {
    lines.push('', 'Already proposed and still open — do not duplicate:');
    for (const item of open.slice(0, 10)) {
      lines.push(`- ${item.type}: ${truncate(item.title, 120)}${item.targetUrls[0] ? ` (${item.targetUrls[0]})` : ''}`);
    }
  }

  const prefs = memory.preferences;
  const prefLines: string[] = [];
  if (prefs.conversionGoal) prefLines.push(`conversion goal: ${prefs.conversionGoal}`);
  if (prefs.targetAudience) prefLines.push(`audience: ${prefs.targetAudience}`);
  if (prefs.toneOfVoice) prefLines.push(`tone: ${prefs.toneOfVoice}`);
  if (prefs.preferredCta) prefLines.push(`preferred CTA: ${prefs.preferredCta}`);
  if (prefs.prohibitedClaims.length) {
    prefLines.push(`never claim: ${prefs.prohibitedClaims.slice(0, 6).join('; ')}`);
  }
  prefLines.push(`autonomy: ${prefs.autonomyLevel}`);
  lines.push('', `Site preferences — ${prefLines.join(', ')}.`);

  if (!rejected.length && !measured.length && !open.length) {
    lines.unshift('No prior recommendations, rejections or measured results for this site yet.');
  }

  return lines.join('\n').trim();
}

/** Store a memory snapshot on the run row's output for later inspection. Small on purpose. */
export function memoryToJson(memory: AgentMemory): Prisma.InputJsonValue {
  return json({
    agent: memory.agent,
    previousRecommendations: memory.previousRecommendations.length,
    rejectedRecommendations: memory.rejectedRecommendations.length,
    measuredOutcomes: memory.measuredOutcomes.map((row) => ({
      actionType: row.actionType,
      total: row.total,
      successRate: row.successRate,
    })),
  });
}
