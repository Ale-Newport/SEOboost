import { NextResponse } from 'next/server';
import { checkDatabaseConnection, prisma } from '@seo/db';
import { type IntegrationHealth, env, errorMessage, isConfigured } from '@seo/shared';
import { checkRedisConnection, redisStatus } from '@seo/queue';
import { route } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth';

/**
 * Liveness + configuration report.
 *
 * Two rules shape this response. First, it is reachable without a session (the middleware lets
 * `/api/health` through so a load balancer can poll it), so the anonymous body carries only
 * booleans and status words — never a connection string, an account email, a customer domain or
 * a provider error message, all of which can name infrastructure. The richer detail is added
 * only once `getCurrentUser()` returns someone.
 *
 * Second, it never throws: an unreachable database is a *state to report*, not a 500. The HTTP
 * status still degrades to 503 so an orchestrator restarts the container.
 */

interface CheckResult {
  ok: boolean;
  status: string;
  detail?: string;
}

/**
 * Env-level provider availability.
 *
 * Never reports a value, and reports the variable *names* only to a signed-in operator. To an
 * anonymous caller a provider is just a status word: "which credentials is this deployment
 * missing" is reconnaissance, and `tests/e2e/health.spec.ts` scans the anonymous body for
 * exactly these substrings (`password`, `client_secret`, …) for that reason.
 */
function providerHealth(includeSetupHints: boolean): IntegrationHealth[] {
  const entry = (
    provider: string,
    label: string,
    configured: boolean,
    requiredEnv: string[],
  ): IntegrationHealth => ({
    provider,
    label,
    status: configured ? 'CONNECTED' : 'NOT_CONFIGURED',
    ...(includeSetupHints
      ? {
          ...(configured ? {} : { detail: `Set ${requiredEnv.join(' or ')} to enable ${label}.` }),
          requiredEnv,
        }
      : {}),
  });

  return [
    entry('openai', 'OpenAI', isConfigured.openai(), ['OPENAI_API_KEY']),
    entry('anthropic', 'Anthropic', isConfigured.anthropic(), ['ANTHROPIC_API_KEY']),
    entry('gemini', 'Google AI', isConfigured.gemini(), ['GOOGLE_AI_API_KEY']),
    entry('google-oauth', 'Google Search Console / GA4', isConfigured.googleOAuth(), [
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
    ]),
    entry('bing', 'Bing Webmaster Tools', isConfigured.bing(), ['BING_API_KEY']),
    entry('dataforseo', 'DataForSEO', isConfigured.dataForSeo(), [
      'DATAFORSEO_LOGIN',
      'DATAFORSEO_PASSWORD',
    ]),
    entry('serpapi', 'SerpApi', isConfigured.serpApi(), ['SERPAPI_KEY']),
    entry('serper', 'Serper', isConfigured.serper(), ['SERPER_API_KEY']),
  ];
}

export const GET = route(
  async () => {
    const [database, redis, user] = await Promise.all([
      checkDatabaseConnection().catch((err: unknown) => ({ ok: false, error: errorMessage(err) })),
      checkRedisConnection().catch((err: unknown) => ({ ok: false, error: errorMessage(err) })),
      getCurrentUser().catch(() => null),
    ]);

    const databaseCheck: CheckResult = {
      ok: database.ok,
      status: database.ok ? 'connected' : 'unreachable',
      ...(user && !database.ok && database.error ? { detail: database.error } : {}),
    };

    // Redis is optional: without it the app still serves every screen, jobs just queue in
    // Postgres and wait for a broker. That is "degraded", not "down".
    const redisCheck: CheckResult = {
      ok: redis.ok,
      status: isConfigured.redis() ? redisStatus() : 'not-configured',
      ...(user && !redis.ok && redis.error ? { detail: redis.error } : {}),
    };

    const status = !database.ok ? 'down' : redis.ok ? 'ok' : 'degraded';

    const body: Record<string, unknown> = {
      status,
      time: new Date().toISOString(),
      environment: env.nodeEnv,
      demoMode: env.demoMode,
      // Top level rather than nested under `checks`: the container healthcheck and
      // `tests/e2e/health.spec.ts` both read `database` straight off the body.
      database: databaseCheck,
      redis: redisCheck,
      features: {
        ai: isConfigured.anyAi(),
        serp: isConfigured.anySerp(),
        googleOAuth: isConfigured.googleOAuth(),
        bing: isConfigured.bing(),
        backgroundJobs: redis.ok,
        jsRendering: env.enableJsRendering,
        scheduler: env.enableScheduler,
      },
      providers: providerHealth(user !== null),
    };

    // Per-site integration state names customer properties, so it stays behind a session. Even
    // then it is a status roll-up: `Integration.credentials` is never selected anywhere here.
    if (user && database.ok) {
      const rows = await prisma.integration
        .groupBy({
          by: ['provider', 'status'],
          where: { website: { userId: user.id } },
          _count: { _all: true },
        })
        .catch(() => []);

      body.integrations = rows.map((row) => ({
        provider: row.provider,
        status: row.status,
        count: row._count._all,
      }));
    }

    return NextResponse.json(body, { status: database.ok ? 200 : 503 });
  },
  { public: true },
);
