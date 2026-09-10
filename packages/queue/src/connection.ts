/**
 * Shared ioredis connection for every BullMQ queue and worker in the process.
 *
 * Redis is optional in this product: with no `REDIS_URL` the app still boots, still records
 * jobs in Postgres, and simply tells the operator that nothing will execute. Nothing in this
 * module throws at import time, and nothing throws when Redis is missing.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { createLogger, env, errorMessage, isConfigured, withTimeout } from '@seo/shared';

const log = createLogger('queue:redis');

/** Reuse one client across Next.js dev module reloads, exactly as the Prisma client does. */
const globalForRedis = globalThis as unknown as { __seoOsRedis?: Redis };

let client: Redis | null = globalForRedis.__seoOsRedis ?? null;

/** Set when the client could not even be constructed (bad URL); stops us retrying forever. */
let constructionError: string | null = null;

/** ioredis emits `error` on every reconnect attempt; log at most this often to avoid a flood. */
const ERROR_LOG_INTERVAL_MS = 30_000;
let lastErrorLogAt = 0;

const PING_TIMEOUT_MS = 2_000;

function buildOptions(): RedisOptions {
  return {
    // BullMQ requires this: its blocking commands must never be aborted by ioredis' own
    // per-command retry budget.
    maxRetriesPerRequest: null,

    // Connect on first use rather than at import, so importing this module from a Next.js
    // route never opens a socket the request does not need.
    lazyConnect: true,

    connectTimeout: 10_000,
    // Keep the offline queue on: a short Redis blip should buffer rather than fail the
    // enqueue outright. `enqueue()` bounds how long it is willing to wait for the buffer
    // to drain, and uses a deterministic job id so a late-landing command cannot duplicate.
    enableOfflineQueue: true,
    enableReadyCheck: true,
    keepAlive: 30_000,

    /** Capped exponential reconnect: fast enough for a restart, gentle on a long outage. */
    retryStrategy: (times: number) => Math.min(1_000 * 2 ** Math.min(times, 5), 30_000),

    /**
     * After a failover the old primary answers READONLY; forcing a reconnect makes ioredis
     * resolve the new primary instead of failing every write.
     */
    reconnectOnError: (err: Error) => err.message.includes('READONLY'),
  };
}

/**
 * The shared client, or `null` when Redis is not configured or cannot be constructed.
 * Callers must treat `null` as "no worker will pick this up", never as an error.
 */
export function getRedisConnection(): Redis | null {
  if (!isConfigured.redis()) return null;
  if (client) return client;
  if (constructionError) return null;

  const url = env.redisUrl;
  if (!url) return null;

  try {
    const instance = new Redis(url, buildOptions());

    // Without an `error` listener Node turns ioredis' reconnect errors into an unhandled
    // exception and kills the web or worker process. This listener is what makes a Redis
    // outage degrade instead of crash.
    instance.on('error', (err: Error) => {
      const now = Date.now();
      if (now - lastErrorLogAt < ERROR_LOG_INTERVAL_MS) return;
      lastErrorLogAt = now;
      log.warn('redis connection error', { error: errorMessage(err), status: instance.status });
    });
    instance.on('ready', () => log.info('redis ready'));
    instance.on('end', () => log.warn('redis connection closed'));

    client = instance;
    globalForRedis.__seoOsRedis = instance;
    return client;
  } catch (err) {
    constructionError = errorMessage(err);
    log.error('failed to construct redis client', { error: constructionError });
    return null;
  }
}

/** True when a client exists and is currently usable for commands. */
export function isRedisReady(): boolean {
  return client !== null && (client.status === 'ready' || client.status === 'connect');
}

/** ioredis connection status, or `'not-configured'`. Surfaced on the health screen. */
export function redisStatus(): string {
  if (!isConfigured.redis()) return 'not-configured';
  return client?.status ?? 'idle';
}

/**
 * Round-trips a PING so the health endpoint reports real reachability rather than
 * "REDIS_URL is set". Never throws.
 */
export async function checkRedisConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!isConfigured.redis()) return { ok: false, error: 'REDIS_URL is not set' };

  const connection = getRedisConnection();
  if (!connection) {
    return { ok: false, error: constructionError ?? 'Redis client could not be created' };
  }

  try {
    const reply = await withTimeout(connection.ping(), PING_TIMEOUT_MS, 'redis ping');
    if (reply !== 'PONG') return { ok: false, error: `Unexpected PING reply: ${String(reply)}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Graceful shutdown. Safe to call when Redis was never configured. */
export async function closeRedisConnection(): Promise<void> {
  const instance = client;
  if (!instance) return;
  client = null;
  delete globalForRedis.__seoOsRedis;
  try {
    // `quit` waits for in-flight replies; if the socket is already gone it rejects, and a
    // hard disconnect is the only thing left to do.
    await withTimeout(instance.quit(), 5_000, 'redis quit');
  } catch {
    instance.disconnect();
  }
}
