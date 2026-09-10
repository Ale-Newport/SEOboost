import { z } from 'zod';
import { JobStatus, type Prisma, buildPaginated, paginate, prisma } from '@seo/db';
import { ValidationError, paginationSchema } from '@seo/shared';
import { QUEUE_NAMES, isQueueName } from '@seo/queue';
import { readQuery, route } from '@/lib/api';
import {
  multiValueParam,
  parseEnumList,
  resolveScope,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `GET /api/jobs` — job history from Postgres.
 *
 * Reads `JobRecord`, never Redis, so the screen keeps working during a broker outage. Jobs with
 * no website (portfolio reports, maintenance) are included by default because they are part of
 * the same operational picture; `scope=site` drops them.
 */

const querySchema = websiteScopeSchema.merge(paginationSchema).extend({
  status: multiValueParam,
  queue: z.string().trim().max(40).optional(),
  jobName: z.string().trim().max(120).optional(),
  /** `all` (default) includes install-wide jobs that belong to no site; `site` excludes them. */
  scope: z.enum(['all', 'site']).default('all'),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const scope = await resolveScope(user, query.websiteId);

  if (query.queue && !isQueueName(query.queue)) {
    throw new ValidationError(
      `Unknown queue "${query.queue}". Valid lanes: ${QUEUE_NAMES.join(', ')}.`,
    );
  }

  const statuses = parseEnumList(query.status, Object.values(JobStatus));
  const search = query.search?.trim();

  // Ownership is expressed as an explicit id list plus (optionally) the null-website rows;
  // there is no "all jobs" branch, so a missing filter can never widen the result set.
  const ownership: Prisma.JobRecordWhereInput[] = [{ websiteId: { in: scope.websiteIds } }];
  if (query.scope === 'all' && !query.websiteId) ownership.push({ websiteId: null });

  const where: Prisma.JobRecordWhereInput = {
    OR: ownership,
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(query.queue ? { queue: query.queue } : {}),
    ...(query.jobName ? { jobName: query.jobName } : {}),
    ...(search
      ? {
          AND: [
            {
              OR: [
                { jobName: { contains: search, mode: 'insensitive' } },
                { jobId: { contains: search, mode: 'insensitive' } },
                { error: { contains: search, mode: 'insensitive' } },
              ],
            },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.jobRecord.findMany({
      where,
      orderBy: { createdAt: query.order },
      ...paginate(query.page, query.pageSize),
    }),
    prisma.jobRecord.count({ where }),
  ]);

  return {
    ...buildPaginated(items, total, query.page, query.pageSize),
    queues: [...QUEUE_NAMES],
    statuses: Object.values(JobStatus),
  };
});
