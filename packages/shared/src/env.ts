/**
 * Central environment access.
 *
 * Rule: the base product must boot with only DATABASE_URL + AUTH_SECRET + ENCRYPTION_KEY.
 * Every integration key is optional; callers ask `isConfigured()` and degrade gracefully.
 */

function str(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v;
}

function req(name: string, fallback?: string): string {
  const v = str(name, fallback);
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return v;
}

function bool(name: string, fallback = false): boolean {
  const v = str(name);
  if (v === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function num(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  get nodeEnv(): string {
    return str('NODE_ENV', 'development')!;
  },
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },
  get isTest(): boolean {
    return this.nodeEnv === 'test';
  },
  get databaseUrl(): string {
    return req('DATABASE_URL');
  },
  get redisUrl(): string | undefined {
    return str('REDIS_URL');
  },
  get authSecret(): string {
    return req('AUTH_SECRET', this.nodeEnv === 'production' ? undefined : 'dev-insecure-auth-secret-change-me');
  },
  get encryptionKey(): string {
    return req(
      'ENCRYPTION_KEY',
      this.nodeEnv === 'production' ? undefined : 'ZGV2LWluc2VjdXJlLWtleS0zMi1ieXRlcy1sb25nISE=',
    );
  },
  get appUrl(): string {
    return str('APP_URL', 'http://localhost:3000')!;
  },
  get demoMode(): boolean {
    return bool('DEMO_MODE', false);
  },
  get logLevel(): string {
    return str('LOG_LEVEL', 'info')!;
  },
  get allowSignup(): boolean {
    return bool('ALLOW_SIGNUP', true);
  },

  // ── AI providers ──────────────────────────────────────────
  get openaiApiKey(): string | undefined {
    return str('OPENAI_API_KEY');
  },
  get anthropicApiKey(): string | undefined {
    return str('ANTHROPIC_API_KEY');
  },
  get googleAiApiKey(): string | undefined {
    return str('GOOGLE_AI_API_KEY');
  },
  get defaultAiProvider(): string | undefined {
    return str('DEFAULT_AI_PROVIDER');
  },
  get aiMonthlyBudgetUsd(): number {
    return num('AI_MONTHLY_BUDGET_USD', 0);
  },

  // ── Google OAuth (Search Console / GA4) ───────────────────
  get googleClientId(): string | undefined {
    return str('GOOGLE_CLIENT_ID');
  },
  get googleClientSecret(): string | undefined {
    return str('GOOGLE_CLIENT_SECRET');
  },
  get googleRedirectUri(): string {
    return str('GOOGLE_REDIRECT_URI', `${this.appUrl}/api/integrations/google/callback`)!;
  },

  // ── Bing ──────────────────────────────────────────────────
  get bingApiKey(): string | undefined {
    return str('BING_API_KEY');
  },

  // ── SERP providers ────────────────────────────────────────
  get dataForSeoLogin(): string | undefined {
    return str('DATAFORSEO_LOGIN');
  },
  get dataForSeoPassword(): string | undefined {
    return str('DATAFORSEO_PASSWORD');
  },
  get serpApiKey(): string | undefined {
    return str('SERPAPI_KEY');
  },
  get serperApiKey(): string | undefined {
    return str('SERPER_API_KEY');
  },

  // ── Crawler ───────────────────────────────────────────────
  get crawlerUserAgent(): string {
    return str('CRAWLER_USER_AGENT', 'SEO-OS-Bot/1.0 (+https://github.com/seo-os)')!;
  },
  get crawlerMaxConcurrency(): number {
    return num('CRAWLER_MAX_CONCURRENCY', 6);
  },
  get enableJsRendering(): boolean {
    return bool('ENABLE_JS_RENDERING', false);
  },
  get sampleCrawlUrl(): string | undefined {
    return str('SAMPLE_CRAWL_URL');
  },

  // ── Social listening & publishing ─────────────────────────
  /** agent-reach CLI (https://github.com/Panniantong/agent-reach). Read-only; absent → native readers only. */
  get agentReachBin(): string {
    return str('AGENT_REACH_BIN', 'agent-reach')!;
  },
  get agentReachTimeoutMs(): number {
    return num('AGENT_REACH_TIMEOUT_MS', 90_000);
  },
  /** Comma-separated agent-reach channels the platform may call; empty → every supported one. */
  get agentReachChannels(): string[] {
    return (str('AGENT_REACH_CHANNELS') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  },
  /** Reddit's API terms require a descriptive user agent; the default names this installation. */
  get socialUserAgent(): string {
    return str('SOCIAL_USER_AGENT', `seo-os:social-listening:1.0 (+${this.appUrl})`)!;
  },
  /**
   * One-time developer apps for one-click account connection. Optional: they can also be entered
   * in the UI (Social → Accounts), which stores them encrypted and wins over these.
   */
  get redditClientId(): string | undefined {
    return str('REDDIT_CLIENT_ID');
  },
  get redditClientSecret(): string | undefined {
    return str('REDDIT_CLIENT_SECRET');
  },
  get xClientId(): string | undefined {
    return str('X_CLIENT_ID');
  },
  get xClientSecret(): string | undefined {
    return str('X_CLIENT_SECRET');
  },
  get linkedinClientId(): string | undefined {
    return str('LINKEDIN_CLIENT_ID');
  },
  get linkedinClientSecret(): string | undefined {
    return str('LINKEDIN_CLIENT_SECRET');
  },
  get discordClientId(): string | undefined {
    return str('DISCORD_CLIENT_ID');
  },
  get discordClientSecret(): string | undefined {
    return str('DISCORD_CLIENT_SECRET');
  },

  // ── Worker ────────────────────────────────────────────────
  get workerConcurrency(): number {
    return num('WORKER_CONCURRENCY', 4);
  },
  get enableScheduler(): boolean {
    return bool('ENABLE_SCHEDULER', true);
  },
} as const;

export const isConfigured = {
  redis: () => Boolean(env.redisUrl),
  openai: () => Boolean(env.openaiApiKey),
  anthropic: () => Boolean(env.anthropicApiKey),
  gemini: () => Boolean(env.googleAiApiKey),
  anyAi: () => Boolean(env.openaiApiKey || env.anthropicApiKey || env.googleAiApiKey),
  googleOAuth: () => Boolean(env.googleClientId && env.googleClientSecret),
  bing: () => Boolean(env.bingApiKey),
  dataForSeo: () => Boolean(env.dataForSeoLogin && env.dataForSeoPassword),
  serpApi: () => Boolean(env.serpApiKey),
  serper: () => Boolean(env.serperApiKey),
  anySerp: () =>
    Boolean(
      (env.dataForSeoLogin && env.dataForSeoPassword) || env.serpApiKey || env.serperApiKey,
    ),
};
