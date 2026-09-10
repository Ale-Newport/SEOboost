import { checkDatabaseConnection } from '@seo/db';
import { getQueueHealth } from '@seo/queue';
import { isConfigured } from '@seo/shared';
import { route } from '@/lib/api';

/**
 * `GET /api/jobs/health` — live broker state for the operations screen.
 *
 * Never fails because Redis is down: an unreachable broker is reported as data
 * (`redis.ok === false`, empty lanes) because that is precisely the state the operator needs
 * to see. Queue depth is install-wide and carries no per-site data, so it is not scoped.
 */
export const GET = route(async () => {
  const [queue, database] = await Promise.all([getQueueHealth(), checkDatabaseConnection()]);

  return {
    ...queue,
    database,
    redisConfigured: isConfigured.redis(),
    ...(isConfigured.redis()
      ? {}
      : {
          hint:
            'REDIS_URL is not set. Jobs are still recorded in the database, but no worker will ' +
            'pick them up until a broker is configured and the worker process is running.',
        }),
  };
});
