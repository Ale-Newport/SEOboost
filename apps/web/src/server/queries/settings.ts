import 'server-only';
import { getAvailableProviders, getMonthlySpend, getUsageSummary, resolveModel } from '@seo/ai';
import { checkDatabaseConnection, prisma } from '@seo/db';
import { checkRedisConnection, getJobStats, getQueueHealth, redisStatus } from '@seo/queue';
import { addDays, env, formatDateKey, isConfigured, round, startOfMonth, toUtcDate } from '@seo/shared';
import {
  MODEL_ROLE_KEYS,
  type AiBudget,
  type AiDefaults,
  type AiProviderInfo,
  type AiUsage,
  type EnvironmentKeyRow,
  type IntegrationRow,
  type ModelRoleKey,
  type SystemInfo,
  type UsageBreakdownEntry,
} from '@/components/settings/types';
import { PROVIDER_LABELS, describeEnvironmentIntegrations } from './integrations';

const APP_SETTING_PROVIDER_KEY = 'ai.provider';
const APP_SETTING_MODEL_KEYS: Record<ModelRoleKey, string> = {
  reasoning: 'ai.model.reasoning',
  fast: 'ai.model.fast',
  writing: 'ai.model.writing',
  embedding: 'ai.model.embedding',
};
const READ_ONLY_SETTING_KEY = 'app.readOnly';
const USAGE_TREND_DAYS = 30;
const JOB_RETENTION_DAYS = 30;

/**
 * The global Settings screen.
 *
 * Rule enforced throughout: this never returns a credential. Providers are described by whether
 * their key is *present* and by the name of the variable that sets it, so the operator can fix a
 * misconfiguration without the app ever echoing a secret back to the browser.
 */
export async function getGlobalSettings(user: { id: string; role: string }) {
  const canAdminister = user.role === 'OWNER' || user.role === 'ADMIN';
  const monthStart = startOfMonth(new Date());
  const trendStart = addDays(toUtcDate(new Date()), -(USAGE_TREND_DAYS - 1));

  const [
    settingRows,
    usageSummary,
    todaySummary,
    trendRows,
    budget,
    database,
    redis,
    queueHealth,
    jobStats,
    integrationRows,
    jobCounts,
  ] = await Promise.all([
    prisma.appSetting.findMany({
      where: {
        key: { in: [APP_SETTING_PROVIDER_KEY, READ_ONLY_SETTING_KEY, ...Object.values(APP_SETTING_MODEL_KEYS)] },
      },
    }),
    getUsageSummary({ from: monthStart, to: new Date() }),
    getUsageSummary({ from: toUtcDate(new Date()), to: new Date() }),
    prisma.aiUsage.groupBy({
      by: ['createdAt'],
      where: { createdAt: { gte: trendStart } },
      _sum: { costUsd: true },
      _count: { _all: true },
      orderBy: { createdAt: 'asc' },
    }),
    getMonthlySpend(null),
    checkDatabaseConnection(),
    checkRedisConnection(),
    getQueueHealth(),
    getJobStats(),
    prisma.integration.findMany({
      include: { website: { select: { id: true, name: true } } },
      orderBy: [{ website: { name: 'asc' } }, { provider: 'asc' }],
    }),
    prisma.$transaction([
      prisma.jobRecord.count({ where: { status: { in: ['QUEUED', 'DELAYED'] } } }),
      prisma.jobRecord.count(),
      prisma.jobRecord.count({
        where: {
          status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] },
          finishedAt: { lt: addDays(new Date(), -JOB_RETENTION_DAYS) },
        },
      }),
      prisma.jobRecord.findFirst({
        where: { startedAt: { not: null } },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
    ]),
  ]);

  const setting = (key: string): string | null => {
    const row = settingRows.find((r) => r.key === key);
    if (!row || row.value === null) return null;
    return typeof row.value === 'string' ? row.value : null;
  };

  const availability = getAvailableProviders();
  const providers: AiProviderInfo[] = await Promise.all(
    availability.map(async (provider) => ({
      name: provider.name,
      label: PROVIDER_LABEL_BY_AI_NAME[provider.name] ?? provider.name,
      configured: provider.configured,
      envVar: provider.envVar,
      supportsEmbeddings: provider.supportsEmbeddings,
      models: provider.models.map((model) => ({
        id: model.id,
        label: model.label,
        roles: model.roles.filter((role): role is ModelRoleKey =>
          (MODEL_ROLE_KEYS as readonly string[]).includes(role),
        ),
      })),
      builtIn: await builtInModels(provider.name),
    })),
  );

  const chosenProvider = setting(APP_SETTING_PROVIDER_KEY);
  const defaults: AiDefaults = {
    provider: chosenProvider,
    envProvider: env.defaultAiProvider ?? null,
    models: {
      reasoning: setting(APP_SETTING_MODEL_KEYS.reasoning),
      fast: setting(APP_SETTING_MODEL_KEYS.fast),
      writing: setting(APP_SETTING_MODEL_KEYS.writing),
      embedding: setting(APP_SETTING_MODEL_KEYS.embedding),
    },
    effectiveProvider: providers.find((p) => p.configured && (!chosenProvider || p.name === chosenProvider))?.name
      ?? providers.find((p) => p.configured)?.name
      ?? null,
  };

  const aiBudget: AiBudget = {
    monthlyBudgetUsd: budget.budgetUsd,
    envVar: 'AI_MONTHLY_BUDGET_USD',
    spendThisMonthUsd: round(usageSummary.totals.costUsd, 4),
    spendTodayUsd: round(todaySummary.totals.costUsd, 4),
    percentUsed:
      budget.budgetUsd && budget.budgetUsd > 0
        ? round((usageSummary.totals.costUsd / budget.budgetUsd) * 100, 1)
        : null,
    monthStart: monthStart.toISOString(),
  };

  const trendByDay = new Map<string, { cost: number; calls: number }>();
  for (const row of trendRows) {
    const key = formatDateKey(row.createdAt);
    const entry = trendByDay.get(key) ?? { cost: 0, calls: 0 };
    entry.cost += row._sum.costUsd ?? 0;
    entry.calls += row._count._all;
    trendByDay.set(key, entry);
  }
  const trend = Array.from({ length: USAGE_TREND_DAYS }, (_, i) => {
    const date = formatDateKey(addDays(trendStart, i));
    const entry = trendByDay.get(date);
    return { date, cost: round(entry?.cost ?? 0, 4), calls: entry?.calls ?? 0 };
  });

  const siteNames = new Map(integrationRows.map((row) => [row.website.id, row.website.name]));
  const toEntries = (rows: typeof usageSummary.byProvider, labeller?: (key: string) => string): UsageBreakdownEntry[] =>
    rows.map((row) => ({
      key: row.key,
      label: labeller?.(row.key) ?? row.key,
      calls: row.calls,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: round(row.costUsd, 4),
    }));

  const usage: AiUsage = {
    todayCostUsd: round(todaySummary.totals.costUsd, 4),
    todayCalls: todaySummary.totals.calls,
    monthCostUsd: round(usageSummary.totals.costUsd, 4),
    monthCalls: usageSummary.totals.calls,
    monthTokensIn: usageSummary.totals.tokensIn,
    monthTokensOut: usageSummary.totals.tokensOut,
    monthFailures: usageSummary.totals.failures,
    byProvider: toEntries(usageSummary.byProvider, (k) => PROVIDER_LABEL_BY_AI_NAME[k] ?? k),
    byModel: toEntries(usageSummary.byModel),
    byTask: toEntries(usageSummary.byTask),
    bySite: toEntries(usageSummary.byWebsite, (k) => siteNames.get(k) ?? k),
    trend,
    trendDays: USAGE_TREND_DAYS,
  };

  const environmentKeys: EnvironmentKeyRow[] = describeEnvironmentIntegrations().map((health) => ({
    provider: health.provider,
    label: health.label,
    status: health.status,
    detail: health.detail ?? null,
    requiredEnv: health.requiredEnv ?? [],
  }));
  const envReady = new Map(environmentKeys.map((row) => [row.provider, row.status !== 'NOT_CONFIGURED']));

  const integrations: IntegrationRow[] = integrationRows.map((row) => ({
    websiteId: row.website.id,
    websiteName: row.website.name,
    provider: row.provider,
    label: PROVIDER_LABELS[row.provider] ?? row.provider,
    status: row.status,
    accountEmail: row.accountEmail,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastError: row.lastError,
    envReady: envReady.get(providerEnvKey(row.provider)) ?? true,
    requiredEnv: environmentKeys.find((k) => k.provider === providerEnvKey(row.provider))?.requiredEnv ?? [],
  }));

  const [queuedJobs, jobHistoryCount, prunableJobs, lastStarted] = jobCounts;

  const system: SystemInfo = {
    appVersion: process.env.npm_package_version ?? '1.0.0',
    environment: env.nodeEnv,
    demoMode: env.demoMode,
    databaseOk: database.ok,
    databaseError: database.error ?? null,
    redisConfigured: isConfigured.redis(),
    redisOk: redis.ok,
    redisStatus: redisStatus(),
    redisError: redis.error ?? null,
    // BullMQ's per-queue counts do not include an attached-worker count, so infer liveness from
    // the broker instead of reporting a number we cannot actually observe.
    workers: null,
    workerConcurrency: env.workerConcurrency,
    schedulerEnabled: env.enableScheduler,
    jsRenderingEnabled: env.enableJsRendering,
    lastJobStartedAt: lastStarted?.startedAt?.toISOString() ?? null,
    queuedJobs,
    jobHistoryCount,
    prunableJobs,
    retentionDays: JOB_RETENTION_DAYS,
    canAdminister,
    readOnly: settingRows.find((r) => r.key === READ_ONLY_SETTING_KEY)?.value === true,
  };

  return {
    providers,
    defaults,
    budget: aiBudget,
    usage,
    integrations,
    environmentKeys,
    system,
    jobStats,
    resolved: await resolveRoutes(defaults),
  };
}

export type GlobalSettings = Awaited<ReturnType<typeof getGlobalSettings>>;

const PROVIDER_LABEL_BY_AI_NAME: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google AI',
};

/** Which env-level provider health row corresponds to a per-site integration provider. */
function providerEnvKey(provider: string): string {
  if (provider === 'GOOGLE_SEARCH_CONSOLE' || provider === 'GOOGLE_ANALYTICS_4') return 'google-oauth';
  if (provider === 'BING_WEBMASTER') return 'bing';
  return provider.toLowerCase();
}

async function builtInModels(provider: string): Promise<Record<ModelRoleKey, string | null>> {
  const out = {} as Record<ModelRoleKey, string | null>;
  for (const role of MODEL_ROLE_KEYS) {
    try {
      out[role] = (await resolveModel(role, { provider })).model;
    } catch {
      // Anthropic has no embedding model; that is a capability gap, not an error.
      out[role] = null;
    }
  }
  return out;
}

/** What each role resolves to right now, given the operator's overrides and what is configured. */
async function resolveRoutes(
  defaults: AiDefaults,
): Promise<Record<ModelRoleKey, { provider: string | null; model: string | null }>> {
  const out = {} as Record<ModelRoleKey, { provider: string | null; model: string | null }>;
  for (const role of MODEL_ROLE_KEYS) {
    try {
      const resolved = await resolveModel(role, {
        provider: defaults.provider,
        model: defaults.models[role],
      });
      out[role] = { provider: resolved.providerName, model: resolved.model };
    } catch {
      // No configured provider for this role — the UI renders it as unavailable.
      out[role] = { provider: null, model: null };
    }
  }
  return out;
}
