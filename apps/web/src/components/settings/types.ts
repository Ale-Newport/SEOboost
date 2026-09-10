/**
 * Server → client shapes for the global settings screen.
 *
 * Nothing here ever carries a secret: providers are described by *whether* their key is present
 * and by the name of the variable that sets it, never by its value.
 */

export type ModelRoleKey = 'reasoning' | 'fast' | 'writing' | 'embedding';

export const MODEL_ROLE_KEYS: readonly ModelRoleKey[] = ['reasoning', 'fast', 'writing', 'embedding'];

export const MODEL_ROLE_COPY: Record<ModelRoleKey, { label: string; description: string }> = {
  reasoning: {
    label: 'Reasoning',
    description: 'Strategy, prioritisation and anything an agent has to think hard about.',
  },
  fast: {
    label: 'Fast',
    description: 'High-volume classification and extraction where latency and cost dominate.',
  },
  writing: {
    label: 'Writing',
    description: 'Briefs, drafts, titles and meta descriptions — quality of prose matters most.',
  },
  embedding: {
    label: 'Embedding',
    description: 'Vectors for clustering, internal links and semantic search.',
  },
};

export interface ProviderModelOption {
  id: string;
  label: string;
  roles: ModelRoleKey[];
}

export interface AiProviderInfo {
  name: string;
  label: string;
  configured: boolean;
  /** The exact environment variable that enables this provider. */
  envVar: string;
  supportsEmbeddings: boolean;
  models: ProviderModelOption[];
  /** Built-in model per role, used when neither the site nor the operator has chosen one. */
  builtIn: Record<ModelRoleKey, string | null>;
}

export interface AiDefaults {
  /** Operator-chosen provider (`ai.provider` app setting), or null to auto-select. */
  provider: string | null;
  /** `DEFAULT_AI_PROVIDER`, which the app setting overrides. */
  envProvider: string | null;
  /** Operator-chosen model per role; null means "use the provider's built-in". */
  models: Record<ModelRoleKey, string | null>;
  /** The provider that actually serves calls right now, given what is configured. */
  effectiveProvider: string | null;
}

export interface AiBudget {
  /** Install-wide cap in USD, or null when uncapped. Set through the environment only. */
  monthlyBudgetUsd: number | null;
  envVar: string;
  spendThisMonthUsd: number;
  spendTodayUsd: number;
  /** 0-100, or null when there is no cap to measure against. */
  percentUsed: number | null;
  monthStart: string;
}

export interface UsageBreakdownEntry {
  key: string;
  label: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface UsageTrendPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  cost: number;
  calls: number;
}

export interface AiUsage {
  todayCostUsd: number;
  todayCalls: number;
  monthCostUsd: number;
  monthCalls: number;
  monthTokensIn: number;
  monthTokensOut: number;
  monthFailures: number;
  byProvider: UsageBreakdownEntry[];
  byModel: UsageBreakdownEntry[];
  byTask: UsageBreakdownEntry[];
  bySite: UsageBreakdownEntry[];
  trend: UsageTrendPoint[];
  trendDays: number;
}

export interface IntegrationRow {
  websiteId: string;
  websiteName: string;
  provider: string;
  label: string;
  status: string;
  accountEmail: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** True when the environment can support this provider at all. */
  envReady: boolean;
  requiredEnv: string[];
}

export interface EnvironmentKeyRow {
  provider: string;
  label: string;
  status: string;
  detail: string | null;
  requiredEnv: string[];
}

export interface SystemInfo {
  appVersion: string;
  environment: string;
  demoMode: boolean;
  databaseOk: boolean;
  databaseError: string | null;
  redisConfigured: boolean;
  redisOk: boolean;
  redisStatus: string;
  redisError: string | null;
  /** Workers attached to the busiest lane, or null when the broker could not be read. */
  workers: number | null;
  workerConcurrency: number;
  schedulerEnabled: boolean;
  jsRenderingEnabled: boolean;
  lastJobStartedAt: string | null;
  queuedJobs: number;
  jobHistoryCount: number;
  /** Terminal job rows older than the default retention window — what a cleanup would remove. */
  prunableJobs: number;
  retentionDays: number;
  /** Only OWNER/ADMIN may run maintenance or change global defaults. */
  canAdminister: boolean;
  readOnly: boolean;
}

export interface AccountSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  expiresAt: string;
  /** True for the session this page was rendered for. */
  current: boolean;
}
