/**
 * The worker process.
 *
 * Boot order is deliberate:
 *   1. Load `.env` (repo root first, then the app directory) before anything reads `env`.
 *   2. Prove the database is reachable — it is the one hard dependency, and a worker that
 *      cannot write a `JobRecord` cannot honestly report on anything it does.
 *   3. Warn *loudly* about Redis rather than exiting. With no broker the process still boots,
 *      still holds the schedule reconciler, and the Jobs screen still works from Postgres; it
 *      simply has nothing to consume. Exiting would turn a degraded install into a crash loop.
 *   4. Print what is configured, so the operator can see at a glance which lanes will actually
 *      do work and which will report "not configured" on every job.
 *
 * Shutdown is cooperative: workers stop accepting jobs and are given time to finish what they
 * are running (a crawl checkpoints and returns), then queues and connections close in order.
 */

import { config as loadEnvFile } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Root first so a repo-level .env is the base, then the app directory may override it.
loadEnvFile({ path: resolve(here, '../../../.env') });
loadEnvFile({ path: resolve(here, '../.env') });
loadEnvFile();

const { checkDatabaseConnection, disconnectPrisma } = await import('@seo/db');
const { createLogger, env, errorMessage, humanDuration, isConfigured } = await import('@seo/shared');
const {
  checkRedisConnection,
  closeQueues,
  closeRedisConnection,
  concurrencyFor,
  redisStatus,
  refreshNextRunTimes,
  syncSchedules,
  QUEUE_NAMES,
} = await import('@seo/queue');
const { handledJobNames, registerAllWorkers } = await import('./processors/index');

const log = createLogger('worker');

/** How long a shutdown may take before the process stops waiting for in-flight jobs. */
const SHUTDOWN_GRACE_MS = 30_000;

/** How often Postgres schedules are reconciled onto the broker. */
const SCHEDULE_SYNC_INTERVAL_MS = 5 * 60_000;

/** Database connection attempts at boot — a container often starts before Postgres is ready. */
const DB_ATTEMPTS = 5;
const DB_RETRY_MS = 3_000;

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= DB_ATTEMPTS; attempt += 1) {
    const result = await checkDatabaseConnection();
    if (result.ok) {
      log.info('database connected');
      return;
    }
    log.warn('database is not reachable yet', {
      attempt,
      of: DB_ATTEMPTS,
      error: result.error,
    });
    if (attempt < DB_ATTEMPTS) await new Promise((done) => setTimeout(done, DB_RETRY_MS));
  }

  log.error(
    'the worker cannot start without a database. Check DATABASE_URL and that migrations have been applied.',
  );
  process.exit(1);
}

interface BannerLine {
  label: string;
  state: string;
  detail?: string;
}

/** What will and will not run, decided purely from configuration. */
function integrationBanner(): BannerLine[] {
  const serpProviders = [
    isConfigured.dataForSeo() ? 'DataForSEO' : null,
    isConfigured.serpApi() ? 'SerpApi' : null,
    isConfigured.serper() ? 'Serper' : null,
  ].filter((name): name is string => name !== null);

  const aiProviders = [
    isConfigured.openai() ? 'OpenAI' : null,
    isConfigured.anthropic() ? 'Anthropic' : null,
    isConfigured.gemini() ? 'Gemini' : null,
  ].filter((name): name is string => name !== null);

  return [
    {
      label: 'Redis / queues',
      state: isConfigured.redis() ? 'configured' : 'MISSING',
      detail: isConfigured.redis()
        ? redisStatus()
        : 'set REDIS_URL — without it no queued job will ever run',
    },
    {
      label: 'AI providers',
      state: aiProviders.length ? 'configured' : 'not configured',
      detail: aiProviders.length
        ? aiProviders.join(', ')
        : 'agents, content and AI-visibility jobs will report as skipped',
    },
    {
      label: 'Google (Search Console / GA4)',
      state: isConfigured.googleOAuth() ? 'configured' : 'not configured',
      detail: isConfigured.googleOAuth()
        ? 'per-website connection still required'
        : 'set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
    },
    {
      label: 'Bing Webmaster',
      state: isConfigured.bing() ? 'configured' : 'not configured',
      detail: isConfigured.bing() ? undefined : 'set BING_API_KEY',
    },
    {
      label: 'SERP providers',
      state: serpProviders.length ? 'configured' : 'not configured',
      detail: serpProviders.length
        ? serpProviders.join(', ')
        : 'rankings fall back to Search Console positions; volume/CPC stay empty',
    },
    {
      label: 'JS rendering',
      state: env.enableJsRendering ? 'enabled' : 'disabled',
      detail: env.enableJsRendering ? undefined : 'set ENABLE_JS_RENDERING=true for SPA sites',
    },
    {
      label: 'Scheduler',
      state: env.enableScheduler ? 'enabled' : 'disabled',
      detail: env.enableScheduler ? undefined : 'set ENABLE_SCHEDULER=true to run cron schedules',
    },
  ];
}

function printBanner(): void {
  const lines = integrationBanner();
  log.info('SEO OS worker starting', {
    nodeEnv: env.nodeEnv,
    concurrency: env.workerConcurrency,
    lanes: QUEUE_NAMES.map((queue) => `${queue}:${concurrencyFor(queue)}`).join(' '),
    jobs: handledJobNames().length,
  });
  for (const line of lines) {
    const message = `  ${line.label.padEnd(32)} ${line.state}${line.detail ? ` — ${line.detail}` : ''}`;
    if (line.state === 'MISSING') log.warn(message);
    else log.info(message);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  printBanner();

  await waitForDatabase();

  const redis = await checkRedisConnection();
  if (!redis.ok) {
    log.warn(
      '───────────────────────────────────────────────────────────────────────────────',
    );
    log.warn('REDIS IS UNAVAILABLE — this worker will not process any job.');
    log.warn(`Reason: ${redis.error ?? 'unknown'}`);
    log.warn(
      'Jobs enqueued by the app are still recorded in Postgres and will show as queued; they ' +
        'will only run once a broker is reachable and they are retried.',
    );
    log.warn(
      '───────────────────────────────────────────────────────────────────────────────',
    );
  }

  const { workers, unstarted } = registerAllWorkers();
  if (unstarted.length) {
    log.warn('some lanes have no worker', { lanes: unstarted });
  }

  let scheduleTimer: ReturnType<typeof setInterval> | null = null;
  if (env.enableScheduler) {
    const reconcile = async (): Promise<void> => {
      try {
        const result = await syncSchedules();
        const refreshed = await refreshNextRunTimes();
        log.info('schedules reconciled', { ...result, refreshed });
      } catch (err) {
        log.error('schedule reconciliation failed', { error: errorMessage(err) });
      }
    };
    await reconcile();
    scheduleTimer = setInterval(() => void reconcile(), SCHEDULE_SYNC_INTERVAL_MS);
    // Never let the reconciler alone keep the process alive during shutdown.
    scheduleTimer.unref();
  } else {
    log.info('scheduler disabled; no cron schedules will be registered by this process');
  }

  log.info('worker ready', {
    startupMs: Date.now() - startedAt,
    lanes: workers.length,
    broker: redis.ok ? 'connected' : 'unavailable',
  });

  // ── graceful shutdown ──────────────────────────────────────
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      log.warn('second shutdown signal; exiting immediately', { signal });
      process.exit(1);
    }
    shuttingDown = true;
    const began = Date.now();
    log.info('shutting down', { signal, inFlightGraceMs: SHUTDOWN_GRACE_MS });

    if (scheduleTimer) clearInterval(scheduleTimer);

    // Hard stop if a job refuses to finish; the JobRecord row stays RUNNING and the stalled
    // -job handling in BullMQ re-queues it on the next boot.
    const guard = setTimeout(() => {
      log.error('shutdown timed out; forcing exit', { afterMs: Date.now() - began });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    guard.unref();

    try {
      // `close()` stops the worker taking new jobs and resolves once the active ones finish.
      await Promise.all(
        workers.map(async (worker) => {
          try {
            await worker.close();
          } catch (err) {
            log.warn('worker did not close cleanly', { error: errorMessage(err) });
          }
        }),
      );
      await closeQueues();
      await closeRedisConnection();
      await disconnectPrisma();
      clearTimeout(guard);
      log.info('shutdown complete', { took: humanDuration(Date.now() - began) });
      process.exit(0);
    } catch (err) {
      log.error('shutdown failed', { error: errorMessage(err) });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal: one job's stray promise must not take down the whole worker.
    log.error('unhandled promise rejection', { error: errorMessage(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { error: errorMessage(err) });
    void shutdown('uncaughtException');
  });
}

await main();
