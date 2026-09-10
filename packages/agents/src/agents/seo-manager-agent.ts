import { ai, isAiAvailable, seoManagerStrategyPrompt } from '@seo/ai';
import { type ActionType, json, prisma } from '@seo/db';
import { clamp, normalizeKeyword, percentChange, round, truncate, type Paginated } from '@seo/shared';
import { z } from 'zod';
import { getAgentMemory, type AgentMemory } from '../runtime/memory';
import { registerAgent } from '../runtime/registry';
import { runTool } from '../tools/index';
import type {
  GetAiVisibilitySummaryResult,
  GetCompetitorGapsResult,
  GetExperimentOutcomesResult,
  GetGeoAuditResult,
  GetRecentActionsResult,
  GetSearchConsoleDataResult,
  GetTechnicalIssuesResult,
  GetWebsiteResult,
  GscAggregateRow,
  PageSummary,
} from '../tools/read';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  autonomyOf,
  buildStrategyConstraints,
  comparisonWindows,
  loadSite,
  loadVerifiedFacts,
  pluralise,
  propose,
  result,
  skipped,
  step,
  toPromptKnowledgeBase,
} from './shared';

const AGENT = 'SEOManagerAgent' as const;

/**
 * What the manager may put on the plan.
 *
 * Deliberately narrower than the full `ActionType` enum: publishing, redirects and outreach are
 * decisions a strategy document should *recommend*, not silently queue.
 */
const ALLOWED_ACTION_TYPES = [
  'FIX_TECHNICAL_ISSUE',
  'UPDATE_TITLE',
  'UPDATE_META_DESCRIPTION',
  'UPDATE_CONTENT',
  'CREATE_CONTENT_BRIEF',
  'ADD_INTERNAL_LINKS',
  'ADD_STRUCTURED_DATA',
  'REFRESH_CONTENT',
  'CONSOLIDATE_PAGES',
  'SUBMIT_URL_INDEXING',
  'GEO_IMPROVEMENT',
] as const;

const NO_AI =
  'The SEO manager writes the strategy with a language model. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or ' +
  'GOOGLE_AI_API_KEY (Settings → AI). Every other agent keeps working without one.';

const MAX_ACTIONS = 12;

// ── Plan → actions (pure, unit-tested) ────────────────────────────────────────

export type PlanHorizon = 'today' | 'thisWeek' | 'thisMonth';

export interface PlanItem {
  title: string;
  actionType: string;
  rationale: string;
  expectedOutcome: string;
  effort: 'LOW' | 'MEDIUM' | 'HIGH';
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
  owner: 'AUTOMATED' | 'HUMAN_REVIEW' | 'HUMAN_ONLY';
  targetUrls: string[];
  dependsOn: string | null;
}

export interface ConvertedAction {
  horizon: PlanHorizon;
  type: ActionType;
  title: string;
  reasoning: string;
  impact: number;
  confidence: number;
  effort: number;
  affectedUrls: string[];
  executable: boolean;
  dependsOn: string | null;
}

export interface ConversionResult {
  accepted: ConvertedAction[];
  rejected: Array<{ title: string; reason: string }>;
}

const EFFORT_SCALE: Record<PlanItem['effort'], number> = { LOW: 1, MEDIUM: 3, HIGH: 5 };
const IMPACT_SCALE: Record<PlanItem['impact'], number> = { HIGH: 0.75, MEDIUM: 0.5, LOW: 0.3 };
/** Confidence decays with the horizon: a plan for next month rests on more assumptions. */
const HORIZON_CONFIDENCE: Record<PlanHorizon, number> = { today: 0.75, thisWeek: 0.65, thisMonth: 0.55 };

/**
 * Turn the strategy plan into action proposals.
 *
 * Every rejection is reported rather than silently dropped: if the model recommended something
 * the platform will not queue, the user needs to see that it was recommended and why it was not
 * created — otherwise the plan and the action list disagree with no explanation.
 */
export function planActionsToProposals(
  plan: Record<PlanHorizon, readonly PlanItem[]>,
  options: { allowedActionTypes: readonly string[]; maxActions?: number } = { allowedActionTypes: ALLOWED_ACTION_TYPES },
): ConversionResult {
  const allowed = new Set(options.allowedActionTypes);
  const maxActions = options.maxActions ?? MAX_ACTIONS;
  const accepted: ConvertedAction[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];
  const seen = new Set<string>();

  const horizons: PlanHorizon[] = ['today', 'thisWeek', 'thisMonth'];
  for (const horizon of horizons) {
    for (const item of plan[horizon] ?? []) {
      const title = item.title.trim();
      if (!title) {
        rejected.push({ title: '(untitled)', reason: 'The plan item had no title.' });
        continue;
      }
      if (!allowed.has(item.actionType)) {
        rejected.push({
          title,
          reason: `"${item.actionType}" is not an action type the SEO manager may queue. It stays on the plan as a recommendation.`,
        });
        continue;
      }
      const key = `${item.actionType}|${normalizeKeyword(title)}`;
      if (seen.has(key)) {
        rejected.push({ title, reason: 'Duplicate of an earlier item in the same plan.' });
        continue;
      }
      if (accepted.length >= maxActions) {
        rejected.push({ title, reason: `Beyond the ${maxActions}-action cap for one planning run.` });
        continue;
      }
      seen.add(key);

      accepted.push({
        horizon,
        type: item.actionType as ActionType,
        title: truncate(title, 160, '…'),
        reasoning: `${item.rationale} Expected outcome: ${item.expectedOutcome}`,
        impact: IMPACT_SCALE[item.impact] ?? 0.5,
        confidence: HORIZON_CONFIDENCE[horizon],
        effort: EFFORT_SCALE[item.effort] ?? 3,
        affectedUrls: item.targetUrls.slice(0, 20),
        // A human-only item is a recommendation the platform records; it never marks it runnable.
        executable: item.owner === 'AUTOMATED',
        dependsOn: item.dependsOn,
      });
    }
  }

  return { accepted, rejected };
}

// ── Strategy schema ───────────────────────────────────────────────────────────

const planItemSchema = z.object({
  title: z.string(),
  actionType: z.enum([
    'FIX_TECHNICAL_ISSUE',
    'UPDATE_TITLE',
    'UPDATE_META_DESCRIPTION',
    'UPDATE_CONTENT',
    'CREATE_CONTENT_BRIEF',
    'ADD_INTERNAL_LINKS',
    'ADD_STRUCTURED_DATA',
    'REFRESH_CONTENT',
    'CONSOLIDATE_PAGES',
    'SUBMIT_URL_INDEXING',
    'GEO_IMPROVEMENT',
    'PUBLISH_CONTENT',
    'CREATE_REDIRECT',
    'OUTREACH_DRAFT',
    'OTHER',
  ]),
  rationale: z.string(),
  expectedOutcome: z.string(),
  effort: z.enum(['LOW', 'MEDIUM', 'HIGH']),
  impact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  owner: z.enum(['AUTOMATED', 'HUMAN_REVIEW', 'HUMAN_ONLY']),
  targetUrls: z.array(z.string()),
  dependsOn: z.string().nullable(),
});

const strategySchema = z.object({
  situationAssessment: z.string(),
  biggestProblems: z.array(z.object({ problem: z.string(), evidence: z.string(), consequence: z.string() })),
  biggestOpportunities: z.array(z.object({ opportunity: z.string(), evidence: z.string(), expectedOutcome: z.string() })),
  strategicFocus: z.string(),
  notDoing: z.array(z.string()),
  today: z.array(planItemSchema),
  thisWeek: z.array(planItemSchema),
  thisMonth: z.array(planItemSchema),
  observedResultsReferenced: z.array(z.string()),
  risks: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

// ── Site picture (read layer) ─────────────────────────────────────────────────

interface SitePicture {
  performance: Record<string, number | null>;
  issueCounts: Record<string, number>;
  issueHeadlines: string[];
  opportunities: string[];
  competitorGaps: string[];
  pagePerformance: { top: string[]; declining: string[] };
  scores: Record<string, number | null>;
  aiVisibility: { score: number | null; mentionRate: number | null; citationRate: number | null; promptsTracked: number };
  geo: { score: number | null; summary: string | null; weakestPages: string[] };
  memory: AgentMemory;
  observedResults: string[];
  recentActions: string[];
  gaps: { available: boolean; reason: string | null };
}

/** Window totals from daily Search Console rows, weighted by impressions where it matters. */
interface WindowTotals {
  clicks: number;
  impressions: number;
  position: number | null;
}

function foldDailyRows(
  rows: readonly GscAggregateRow[],
  isCurrent: (dateKey: string) => boolean,
): { current: WindowTotals; previous: WindowTotals } {
  const acc = { current: { clicks: 0, impressions: 0, weighted: 0 }, previous: { clicks: 0, impressions: 0, weighted: 0 } };
  for (const row of rows) {
    const bucket = isCurrent(row.key) ? acc.current : acc.previous;
    bucket.clicks += row.clicks;
    bucket.impressions += row.impressions;
    bucket.weighted += row.position * row.impressions;
  }
  const shape = (bucket: { clicks: number; impressions: number; weighted: number }): WindowTotals => ({
    clicks: bucket.clicks,
    impressions: bucket.impressions,
    position: bucket.impressions > 0 ? round(bucket.weighted / bucket.impressions, 2) : null,
  });
  return { current: shape(acc.current), previous: shape(acc.previous) };
}

/**
 * Assemble what a competent SEO lead would ask for before deciding anything.
 *
 * Deliberately built from the read *tools* rather than raw queries: each one returns a narrow,
 * named, already-summarised view (with its own `available: false` when a prerequisite is missing),
 * so the model receives the dozen numbers that matter with their units instead of thousands of
 * rows it would average badly. It also means every read lands in the run transcript.
 */
async function gatherSitePicture(ctx: AgentContext): Promise<SitePicture> {
  const windows = comparisonWindows();

  const [website, performance, issues, gaps, geo, aiVisibility, pages, recent, experiments] = await Promise.all([
    runTool<GetWebsiteResult>('getWebsite', {}, ctx),
    runTool<GetSearchConsoleDataResult>('getSearchConsoleData', { dimension: 'date', days: 56, limit: 60 }, ctx),
    runTool<GetTechnicalIssuesResult>('getTechnicalIssues', { limit: 200 }, ctx),
    runTool<GetCompetitorGapsResult>('getCompetitorGaps', { limit: 20 }, ctx),
    runTool<GetGeoAuditResult>('getGeoAudit', { pageLimit: 5 }, ctx),
    runTool<GetAiVisibilitySummaryResult>('getAiVisibilitySummary', { days: 30 }, ctx),
    runTool<Paginated<PageSummary>>('listPages', { pageSize: 25, sortBy: 'clicks28d', order: 'desc' }, ctx),
    runTool<GetRecentActionsResult>('getRecentActions', { limit: 25 }, ctx),
    runTool<GetExperimentOutcomesResult>('getExperimentOutcomes', { limit: 100 }, ctx),
  ]);

  const memory = await step(ctx, 'getAgentMemory', { agent: AGENT }, () => getAgentMemory(ctx.websiteId, AGENT));

  // The one read with no tool behind it: content opportunities are produced by another agent and
  // read straight from the table.
  const opportunities = await step(
    ctx,
    'readContentOpportunities',
    { status: 'IDENTIFIED' },
    () =>
      prisma.contentOpportunity.findMany({
        where: { websiteId: ctx.websiteId, status: 'IDENTIFIED' },
        orderBy: { priorityScore: 'desc' },
        take: 15,
        select: { type: true, title: true, targetKeyword: true, priorityScore: true },
      }),
    (rows) => ({ opportunities: rows.length }),
  );

  const currentStartKey = windows.current.start.toISOString().slice(0, 10);
  const totals = performance.available
    ? foldDailyRows(performance.rows, (key) => key >= currentStartKey)
    : { current: { clicks: 0, impressions: 0, position: null }, previous: { clicks: 0, impressions: 0, position: null } };

  const issueHeadlines = Object.entries(issues.bySeverity)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity} issues`)
    .concat(
      issues.issues
        .slice(0, 8)
        .map((issue) => `${issue.severity}: ${issue.title}${issue.url ? ` (${issue.url})` : ''}`),
    );

  return {
    performance: {
      clicks28d: totals.current.clicks,
      clicksPrev28d: totals.previous.clicks,
      clicksChangePct: percentChange(totals.previous.clicks, totals.current.clicks),
      impressions28d: totals.current.impressions,
      impressionsChangePct: percentChange(totals.previous.impressions, totals.current.impressions),
      avgPosition: totals.current.position,
      avgPositionPrev: totals.previous.position,
    },
    issueCounts: issues.bySeverity,
    issueHeadlines,
    opportunities: opportunities.map(
      (entry) =>
        `[${entry.type}, priority ${entry.priorityScore}] ${entry.title}${entry.targetKeyword ? ` — "${entry.targetKeyword}"` : ''}`,
    ),
    competitorGaps: gaps.available
      ? gaps.gaps
          .slice(0, 15)
          .map(
            (gap) =>
              `"${gap.keyword}": ${gap.competitorDomains.join(', ')} at ${gap.bestCompetitorPosition}, us at ` +
              `${gap.ourPosition ?? 'not ranking'} (gap score ${gap.gapScore})`,
          )
      : [],
    gaps: { available: gaps.available, reason: gaps.available ? null : gaps.reason },
    pagePerformance: {
      top: pages.items
        .slice(0, 10)
        .map((page) => `${page.url} — ${page.clicks28d} clicks, position ${page.position28d ?? '?'}`),
      declining: pages.items
        .filter((page) => page.impressions28d > 0 && page.clicks28d === 0)
        .slice(0, 10)
        .map((page) => `${page.url} — ${page.impressions28d} impressions, no clicks, position ${page.position28d ?? '?'}`),
    },
    scores: {
      health: website.website.healthScore,
      geo: website.website.geoScore,
      aiVisibility: website.website.aiVisibilityScore,
      content: website.website.contentScore,
    },
    aiVisibility: {
      score: website.website.aiVisibilityScore,
      mentionRate: aiVisibility.available ? aiVisibility.mentionRate : null,
      citationRate: aiVisibility.available ? aiVisibility.citationRate : null,
      promptsTracked: aiVisibility.available ? aiVisibility.promptsTracked : 0,
    },
    geo: {
      score: geo.available ? geo.overallScore : null,
      summary: geo.available ? geo.summary : null,
      weakestPages: geo.available ? geo.weakestPages.map((page) => `${page.url} (${page.score})`) : [],
    },
    memory,
    // The feedback loop: what previous changes on this site actually did, not what we hoped.
    observedResults: experiments.summaries
      .filter((summary) => summary.total > 0)
      .map(
        (summary) =>
          `${summary.actionType}: helped in ${summary.positive} of ${summary.total} measured cases` +
          (summary.avgDeltaPct === null ? '' : `, average ${summary.avgDeltaPct >= 0 ? '+' : ''}${summary.avgDeltaPct}%`) +
          `. ${summary.learning}`,
      ),
    recentActions: recent.actions.map(
      (action) => `${action.type} (${action.status}, priority ${action.priorityScore}): ${action.title}`,
    ),
  };
}

// ── Agent ─────────────────────────────────────────────────────────────────────

async function run(ctx: AgentContext): Promise<AgentResult> {
  if (!isAiAvailable()) return skipped('No AI provider configured.', NO_AI);

  const site = await loadSite(ctx.websiteId);
  const picture = await gatherSitePicture(ctx);
  const facts = await loadVerifiedFacts(ctx.websiteId);
  const autonomy = autonomyOf(site);

  const constraints = buildStrategyConstraints(autonomy.level, picture.observedResults.length);

  const answer = await step(
    ctx,
    'write_strategy',
    { website: site.domain },
    () =>
      ai.generateStructured({
        task: seoManagerStrategyPrompt.id,
        websiteId: ctx.websiteId,
        agent: AGENT,
        role: seoManagerStrategyPrompt.defaultRole ?? 'reasoning',
        system: seoManagerStrategyPrompt.system,
        prompt: seoManagerStrategyPrompt.render({
          siteName: site.name,
          domain: site.domain,
          businessCategory: site.businessCategory,
          conversionGoal: site.conversionGoal,
          scores: { ...picture.scores, aiVisibilityMentionRate: picture.aiVisibility.mentionRate },
          issueCounts: picture.issueCounts,
          performanceDeltas: picture.performance,
          topOpportunities: [
            ...picture.issueHeadlines.map((headline) => `TECHNICAL: ${headline}`),
            ...picture.opportunities.map((entry) => `CONTENT: ${entry}`),
            ...picture.competitorGaps.map((gap) => `COMPETITOR GAP: ${gap}`),
            ...picture.pagePerformance.declining.map((page) => `DECLINING: ${page}`),
          ].slice(0, 40),
          // Observed results first: this is the history the plan is required to reason from.
          recentActions: [
            ...picture.observedResults.map((line) => `OBSERVED RESULT — ${line}`),
            ...buildMemoryLines(picture.memory),
            ...picture.recentActions.map((line) => `PROPOSED — ${line}`),
          ].slice(0, 45),
          autonomyLevel: autonomy.level,
          constraints,
          horizonWeeks: 4,
          knowledgeBase: toPromptKnowledgeBase(site.knowledgeBase),
          brandFacts: facts,
        }),
        schema: strategySchema,
        schemaName: 'seo_manager_strategy',
        settings: site.settings,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    (value) => ({
      today: value.data.today.length,
      thisWeek: value.data.thisWeek.length,
      thisMonth: value.data.thisMonth.length,
    }),
  );

  const plan = answer.data;

  // ── Persist the plan ───────────────────────────────────────────────────────
  await prisma.strategyPlan.updateMany({
    where: { websiteId: ctx.websiteId, isCurrent: true },
    data: { isCurrent: false },
  });

  const strategyPlan = await prisma.strategyPlan.create({
    data: {
      websiteId: ctx.websiteId,
      periodLabel: `${new Date().toISOString().slice(0, 10)} · 4 weeks`,
      situation: plan.situationAssessment,
      biggestProblems: json(plan.biggestProblems),
      biggestOpportunities: json(plan.biggestOpportunities),
      strategy: `${plan.strategicFocus}${plan.notDoing.length ? `\n\nExplicitly not doing: ${plan.notDoing.join('; ')}` : ''}`,
      today: json(plan.today),
      thisWeek: json(plan.thisWeek),
      thisMonth: json(plan.thisMonth),
      observedResults: json({
        referenced: plan.observedResultsReferenced,
        measured: picture.observedResults,
        rejectedBefore: picture.memory.rejectedRecommendations.map((entry) => ({
          title: entry.title,
          note: entry.note,
        })),
        actionsReviewed: picture.recentActions.length,
      }),
      confidence: clamp(plan.confidence),
      agentRunId: ctx.runId,
      isCurrent: true,
    },
    select: { id: true },
  });

  // ── Convert the plan into actions ──────────────────────────────────────────
  const conversion = planActionsToProposals(
    { today: plan.today, thisWeek: plan.thisWeek, thisMonth: plan.thisMonth },
    { allowedActionTypes: ALLOWED_ACTION_TYPES, maxActions: MAX_ACTIONS },
  );

  const actions = new ActionCollector();
  for (const action of conversion.accepted) {
    await propose(ctx, actions, {
      type: action.type,
      title: action.title,
      reasoning: action.reasoning,
      evidence: {
        horizon: action.horizon,
        strategyPlanId: strategyPlan.id,
        strategicFocus: plan.strategicFocus,
        dependsOn: action.dependsOn,
        sitePerformance: picture.performance,
        pastResultsConsidered: picture.observedResults,
      },
      affectedUrls: action.affectedUrls,
      payload: { strategyPlanId: strategyPlan.id, horizon: action.horizon, dependsOn: action.dependsOn },
      impact: action.impact,
      confidence: action.confidence,
      effort: action.effort,
      sourceType: 'StrategyPlan',
      sourceId: `${strategyPlan.id}:${action.horizon}:${normalizeKeyword(action.title)}`,
      ...(action.executable
        ? {}
        : { advisory: 'The plan assigns this to a person, so the platform records it rather than running it.' }),
    });
  }

  const referencedObserved = plan.observedResultsReferenced.length > 0;

  return result({
    summary:
      `${plan.strategicFocus} ${plan.today.length} ${pluralise(plan.today.length, 'action')} today, ` +
      `${plan.thisWeek.length} this week, ${plan.thisMonth.length} this month. ` +
      `Queued ${actions.actionsCreated.length}${conversion.rejected.length ? `, kept ${conversion.rejected.length} as recommendations only` : ''}.`,
    confidence: clamp(plan.confidence),
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings: [
      { kind: 'situation', assessment: plan.situationAssessment },
      ...plan.biggestProblems.map((entry) => ({ kind: 'problem', ...entry })),
      ...plan.biggestOpportunities.map((entry) => ({ kind: 'opportunity', ...entry })),
      ...plan.risks.map((risk) => ({ kind: 'risk', risk })),
      ...conversion.rejected.map((entry) => ({ kind: 'not-queued', ...entry })),
    ],
    data: {
      strategyPlanId: strategyPlan.id,
      strategicFocus: plan.strategicFocus,
      notDoing: plan.notDoing,
      today: plan.today,
      thisWeek: plan.thisWeek,
      thisMonth: plan.thisMonth,
      observedResults: {
        referenced: plan.observedResultsReferenced,
        available: picture.observedResults,
        note: referencedObserved
          ? 'The plan cites measured outcomes of previous actions on this site.'
          : picture.observedResults.length > 0
            ? 'Measured outcomes existed but the plan did not cite them — treat its confidence with more caution.'
            : 'No action on this site has been measured yet, so the plan has no outcome history to learn from.',
      },
      sitePicture: {
        performance: picture.performance,
        issueCounts: picture.issueCounts,
        scores: picture.scores,
        aiVisibility: picture.aiVisibility,
        geo: picture.geo,
        competitorGaps: picture.gaps,
      },
    },
  });
}

/**
 * Turn the agent's database-backed memory into prompt lines.
 *
 * Rejections come first and carry the operator's own note verbatim: "the operator refused a
 * comparison page here because X" is the single most useful thing the planner can know, and it is
 * the difference between a plan that adapts and one that re-proposes the same rejected idea every
 * week. Measured outcomes follow, then this agent's own recent track record.
 */
function buildMemoryLines(memory: AgentMemory): string[] {
  const lines: string[] = [];

  for (const rejection of memory.rejectedRecommendations.slice(0, 8)) {
    const target = rejection.targetUrls[0] ? ` (${rejection.targetUrls[0]})` : '';
    lines.push(
      rejection.note
        ? `REJECTED BY OPERATOR — "${rejection.title}"${target}: "${rejection.note}". Do not propose this again unless the situation has demonstrably changed.`
        : `REJECTED BY OPERATOR — "${rejection.title}"${target} (no reason given). Treat as unwanted.`,
    );
  }

  for (const outcome of memory.measuredOutcomes.slice(0, 8)) {
    lines.push(`MEASURED — ${outcome.learning}`);
  }

  for (const previous of memory.previousRecommendations.slice(0, 8)) {
    const verdict =
      previous.outcome && previous.outcome !== 'PENDING'
        ? `${previous.outcome.replace(/_/g, ' ').toLowerCase()}${previous.deltaPct === null ? '' : ` (${previous.deltaPct > 0 ? '+' : ''}${previous.deltaPct.toFixed(1)}%)`}`
        : previous.status.replace(/_/g, ' ').toLowerCase();
    lines.push(`PREVIOUSLY PROPOSED — "${previous.title}" → ${verdict}`);
  }

  return lines;
}

export const seoManagerAgent: AgentDefinition = {
  name: AGENT,
  label: 'SEO manager',
  description:
    'Reads the whole site picture, writes the strategy and the today/this week/this month plan, and turns it into prioritised actions.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: [
    'getWebsite',
    'getSearchConsoleData',
    'getTechnicalIssues',
    'getCompetitorGaps',
    'getGeoAudit',
    'getAiVisibilitySummary',
    'listPages',
    'getRecentActions',
    'getExperimentOutcomes',
  ],
  requiresAi: true,
  run,
};

registerAgent(seoManagerAgent);
