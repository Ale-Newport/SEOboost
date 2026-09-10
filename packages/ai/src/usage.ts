import { prisma } from '@seo/db';
import type { Prisma } from '@seo/db';
import {
  AppError,
  createLogger,
  env,
  errorMessage,
  round,
  startOfMonth,
} from '@seo/shared';

const log = createLogger('ai:usage');

/**
 * Cost tracking and the monthly budget guard.
 *
 * Every priced call lands in `AiUsage`, and every call passes `assertWithinBudget` first.
 * That pairing is what stops an agent loop from spending an unbounded amount of money: the
 * guard reads the same table the recorder writes, so a runaway loop throttles itself within
 * one call of crossing the cap.
 */

export interface RecordUsageInput {
  websiteId?: string | null;
  provider: string;
  model: string;
  /** Coarse label for what the call was for (`content-draft`, `embedding`, `geo-audit`, …). */
  task: string;
  agent?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  latencyMs?: number | null;
  success?: boolean;
}

function safeInt(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function safeCost(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return round(value, 6);
}

/**
 * Append one usage row. Deliberately swallows every error: losing a telemetry row is a much
 * smaller problem than failing a generation the user already paid for, and the caller has no
 * useful recovery. Failures are logged so a broken table is still visible.
 */
export async function recordUsage(input: RecordUsageInput): Promise<void> {
  try {
    await prisma.aiUsage.create({
      data: {
        websiteId: input.websiteId ?? null,
        provider: input.provider,
        model: input.model,
        task: input.task,
        agent: input.agent ?? null,
        tokensIn: safeInt(input.tokensIn),
        tokensOut: safeInt(input.tokensOut),
        costUsd: safeCost(input.costUsd),
        latencyMs: input.latencyMs === null || input.latencyMs === undefined ? null : safeInt(input.latencyMs),
        success: input.success ?? true,
      },
    });
  } catch (err) {
    log.warn('failed to record AI usage', {
      error: errorMessage(err),
      provider: input.provider,
      model: input.model,
      task: input.task,
    });
  }
}

export interface UsageBreakdownRow {
  key: string;
  label: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface UsageTotals {
  calls: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Null when no row in the window carried a latency (streaming calls do not). */
  avgLatencyMs: number | null;
}

export interface UsageSummary {
  from: string;
  to: string;
  websiteId: string | null;
  totals: UsageTotals;
  byProvider: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byTask: UsageBreakdownRow[];
  /** Empty when the summary is already scoped to a single site. */
  byWebsite: UsageBreakdownRow[];
}

export interface UsageSummaryFilter {
  websiteId?: string | null;
  from: Date;
  to: Date;
}

function usageWhere(filter: {
  websiteId?: string | null;
  from?: Date;
  to?: Date;
}): Prisma.AiUsageWhereInput {
  return {
    ...(filter.websiteId ? { websiteId: filter.websiteId } : {}),
    ...(filter.from || filter.to
      ? {
          createdAt: {
            ...(filter.from ? { gte: filter.from } : {}),
            ...(filter.to ? { lte: filter.to } : {}),
          },
        }
      : {}),
  };
}

interface GroupedRow {
  _count: { _all: number };
  _sum: { tokensIn: number | null; tokensOut: number | null; costUsd: number | null };
}

function toRow(key: string, label: string, row: GroupedRow): UsageBreakdownRow {
  return {
    key,
    label,
    calls: row._count._all,
    tokensIn: row._sum.tokensIn ?? 0,
    tokensOut: row._sum.tokensOut ?? 0,
    costUsd: round(row._sum.costUsd ?? 0, 6),
  };
}

const byCostDesc = (a: UsageBreakdownRow, b: UsageBreakdownRow): number => b.costUsd - a.costUsd;

/**
 * Spend and token totals for a window, plus the four breakdowns the cost dashboard renders.
 * Aggregation happens in Postgres — `AiUsage` grows by one row per model call and is far too
 * large to pull into the process.
 */
export async function getUsageSummary(filter: UsageSummaryFilter): Promise<UsageSummary> {
  const where = usageWhere(filter);

  const [totals, failures, providers, models, tasks, websites] = await Promise.all([
    prisma.aiUsage.aggregate({
      where,
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costUsd: true },
      _avg: { latencyMs: true },
    }),
    prisma.aiUsage.count({ where: { ...where, success: false } }),
    prisma.aiUsage.groupBy({
      by: ['provider'],
      where,
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costUsd: true },
    }),
    prisma.aiUsage.groupBy({
      by: ['model'],
      where,
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costUsd: true },
    }),
    prisma.aiUsage.groupBy({
      by: ['task'],
      where,
      _count: { _all: true },
      _sum: { tokensIn: true, tokensOut: true, costUsd: true },
    }),
    filter.websiteId
      ? Promise.resolve([])
      : prisma.aiUsage.groupBy({
          by: ['websiteId'],
          where,
          _count: { _all: true },
          _sum: { tokensIn: true, tokensOut: true, costUsd: true },
        }),
  ]);

  // Resolve site names in one query so the dashboard shows "Acme blog", not a cuid.
  const siteIds = websites
    .map((row) => row.websiteId)
    .filter((id): id is string => typeof id === 'string');
  const siteNames = new Map<string, string>();
  if (siteIds.length) {
    const rows = await prisma.website.findMany({
      where: { id: { in: siteIds } },
      select: { id: true, name: true },
    });
    for (const row of rows) siteNames.set(row.id, row.name);
  }

  return {
    from: filter.from.toISOString(),
    to: filter.to.toISOString(),
    websiteId: filter.websiteId ?? null,
    totals: {
      calls: totals._count._all,
      failures,
      tokensIn: totals._sum.tokensIn ?? 0,
      tokensOut: totals._sum.tokensOut ?? 0,
      costUsd: round(totals._sum.costUsd ?? 0, 6),
      avgLatencyMs: totals._avg.latencyMs === null ? null : Math.round(totals._avg.latencyMs),
    },
    byProvider: providers.map((row) => toRow(row.provider, row.provider, row)).sort(byCostDesc),
    byModel: models.map((row) => toRow(row.model, row.model, row)).sort(byCostDesc),
    byTask: tasks.map((row) => toRow(row.task, row.task, row)).sort(byCostDesc),
    byWebsite: websites
      .map((row) => {
        const key = row.websiteId ?? 'unassigned';
        const label = row.websiteId
          ? (siteNames.get(row.websiteId) ?? row.websiteId)
          : 'Portfolio-wide';
        return toRow(key, label, row);
      })
      .sort(byCostDesc),
  };
}

export interface BudgetStatus {
  websiteId: string | null;
  /** First instant of the current calendar month, UTC. */
  monthStart: string;
  spendUsd: number;
  /**
   * The cap that applies at this scope, or null when this scope is uncapped: no
   * `monthlyAiBudgetUsd` for a site, `AI_MONTHLY_BUDGET_USD` unset or 0 for the portfolio.
   * A site with no cap of its own is still bounded by the install-wide budget — see
   * `assertWithinBudget`.
   */
  budgetUsd: number | null;
  remainingUsd: number | null;
  /** 0-100, null when unlimited. */
  percentUsed: number | null;
  exceeded: boolean;
  budgetSource: 'website' | 'global' | 'none';
}

/**
 * The install-wide cap, or null for unlimited. 0 (the env default) means "no cap" — an
 * explicit unlimited, not a zero budget.
 */
function globalBudgetUsd(): number | null {
  const global = env.aiMonthlyBudgetUsd;
  return Number.isFinite(global) && global > 0 ? global : null;
}

/**
 * Budget that applies *at one scope*, measured against that scope's spend.
 *
 * A site is bounded by its own `monthlyAiBudgetUsd`; the portfolio is bounded by
 * `AI_MONTHLY_BUDGET_USD`. The two are deliberately not mixed: measuring the install-wide cap
 * against a single site's spend would let N sites each spend the whole cap. `assertWithinBudget`
 * enforces both scopes.
 */
async function resolveBudget(
  websiteId: string | null,
): Promise<{ budgetUsd: number | null; source: BudgetStatus['budgetSource'] }> {
  if (websiteId) {
    const settings = await prisma.websiteSettings.findUnique({
      where: { websiteId },
      select: { monthlyAiBudgetUsd: true },
    });
    const perSite = settings?.monthlyAiBudgetUsd;
    if (typeof perSite === 'number' && Number.isFinite(perSite) && perSite > 0) {
      return { budgetUsd: perSite, source: 'website' };
    }
    // No per-site cap: this site is bounded only by the install-wide budget, which is
    // reported (and enforced) at portfolio scope.
    return { budgetUsd: null, source: 'none' };
  }
  const global = globalBudgetUsd();
  return global === null ? { budgetUsd: null, source: 'none' } : { budgetUsd: global, source: 'global' };
}

/**
 * Spend so far this calendar month, with the budget that applies at the same scope.
 * Pass no `websiteId` for the portfolio total measured against `AI_MONTHLY_BUDGET_USD`.
 */
export async function getMonthlySpend(websiteId?: string | null): Promise<BudgetStatus> {
  const scope = websiteId ?? null;
  const monthStart = startOfMonth(new Date());

  const [spend, budget] = await Promise.all([
    // One aggregate over the `[websiteId, createdAt]` / `[createdAt]` index — this runs on the
    // hot path of every generation, so it must stay a single indexed sum.
    prisma.aiUsage.aggregate({
      where: usageWhere({ websiteId: scope, from: monthStart }),
      _sum: { costUsd: true },
    }),
    resolveBudget(scope),
  ]);

  const spendUsd = round(spend._sum.costUsd ?? 0, 6);
  const budgetUsd = budget.budgetUsd;

  return {
    websiteId: scope,
    monthStart: monthStart.toISOString(),
    spendUsd,
    budgetUsd,
    remainingUsd: budgetUsd === null ? null : round(Math.max(0, budgetUsd - spendUsd), 6),
    percentUsed: budgetUsd === null ? null : round((spendUsd / budgetUsd) * 100, 1),
    exceeded: budgetUsd !== null && spendUsd >= budgetUsd,
    budgetSource: budget.source,
  };
}

/** Fraction of the budget at which the guard starts warning in the log. */
const BUDGET_WARN_RATIO = 0.8;

function budgetExceededError(status: BudgetStatus): AppError {
  const scope = status.budgetSource === 'global' ? 'install-wide' : 'site';
  return new AppError(
    `Monthly AI budget exhausted (${scope}): $${status.spendUsd.toFixed(2)} of $${(status.budgetUsd ?? 0).toFixed(2)} spent this month.`,
    {
      code: 'AI_BUDGET_EXCEEDED',
      status: 429,
      retryable: false,
      details: {
        websiteId: status.websiteId,
        spendUsd: status.spendUsd,
        budgetUsd: status.budgetUsd,
        budgetSource: status.budgetSource,
        monthStart: status.monthStart,
      },
    },
  );
}

function warnIfApproaching(status: BudgetStatus): void {
  if (status.budgetUsd === null) return;
  if (status.spendUsd < status.budgetUsd * BUDGET_WARN_RATIO) return;
  log.warn('AI spend is approaching the monthly budget', {
    websiteId: status.websiteId,
    spendUsd: status.spendUsd,
    budgetUsd: status.budgetUsd,
    budgetSource: status.budgetSource,
    percentUsed: status.percentUsed,
  });
}

/**
 * The runaway-loop guard. Called before every model invocation; throws
 * `AppError { code: 'AI_BUDGET_EXCEEDED' }` once this month's spend reaches a cap.
 *
 * Both scopes are enforced: the site's own `monthlyAiBudgetUsd` against that site's spend, and
 * `AI_MONTHLY_BUDGET_USD` against portfolio-wide spend. Checking only the site scope would let
 * an install with N sites spend N times the install-wide cap, which is exactly the runaway this
 * guard exists to stop. Each check is a single indexed aggregate and the two run in parallel,
 * so the hot path still costs one round trip.
 *
 * Returns the most constraining status so a caller that already needs the numbers (the cost
 * banner, a scheduler deciding whether to queue more work) does not have to query twice.
 */
export async function assertWithinBudget(websiteId?: string | null): Promise<BudgetStatus> {
  const scope = websiteId ?? null;
  // When the call is unscoped, the scoped status already *is* the portfolio status.
  const needsPortfolioCheck = scope !== null && globalBudgetUsd() !== null;

  const [scoped, portfolio] = await Promise.all([
    getMonthlySpend(scope),
    needsPortfolioCheck ? getMonthlySpend(null) : Promise.resolve(null),
  ]);

  // Install-wide first: it is the harder stop, and naming it in the error tells the operator
  // which number to raise.
  if (portfolio?.exceeded) throw budgetExceededError(portfolio);
  if (scoped.exceeded) throw budgetExceededError(scoped);

  if (portfolio) warnIfApproaching(portfolio);
  warnIfApproaching(scoped);

  // Prefer the site view when the site has its own cap; otherwise the portfolio view carries
  // the budget that actually constrains this call.
  if (scoped.budgetUsd !== null) return scoped;
  return portfolio ?? scoped;
}
