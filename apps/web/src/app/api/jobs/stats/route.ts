import { JobStatus, type Prisma, prisma } from '@seo/db';
import { QUEUE_NAMES, type JobQueueStats, type JobStats, isQueueName } from '@seo/queue';
import { readQuery, route } from '@/lib/api';
import { resolveScope, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/jobs/stats` — status and per-lane counts over the last seven days.
 *
 * The queue package ships the same roll-up, but only for a single website or for *every* job
 * in the install. The portfolio view has to be scoped to the websites the caller owns, so the
 * aggregate is built here from the same single `(queue, status)` groupBy and returned in the
 * package's `JobStats` shape so both callers render identically.
 */

const STATS_WINDOW_DAYS = 7;

function emptyLane(queue: string): JobQueueStats {
  return { queue, total: 0, running: 0, queued: 0, completed: 0, failed: 0 };
}

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, websiteScopeSchema);
  const scope = await resolveScope(user, query.websiteId);

  const since = new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000);
  const ownership: Prisma.JobRecordWhereInput[] = [{ websiteId: { in: scope.websiteIds } }];
  if (!query.websiteId) ownership.push({ websiteId: null });

  const groups = await prisma.jobRecord.groupBy({
    by: ['queue', 'status'],
    where: { createdAt: { gte: since }, OR: ownership },
    _count: { _all: true },
  });

  const byStatus = Object.values(JobStatus).reduce<Record<JobStatus, number>>(
    (acc, status) => {
      acc[status] = 0;
      return acc;
    },
    {} as Record<JobStatus, number>,
  );

  const lanes = new Map<string, JobQueueStats>();
  let total = 0;

  for (const group of groups) {
    const count = group._count._all;
    total += count;
    byStatus[group.status] += count;

    const lane = lanes.get(group.queue) ?? emptyLane(group.queue);
    lane.total += count;
    if (group.status === JobStatus.RUNNING) lane.running += count;
    if (group.status === JobStatus.QUEUED || group.status === JobStatus.DELAYED) lane.queued += count;
    if (group.status === JobStatus.COMPLETED) lane.completed += count;
    if (group.status === JobStatus.FAILED) lane.failed += count;
    lanes.set(group.queue, lane);
  }

  // Known lanes always present and in a fixed order so rows do not jump around between polls.
  const byQueue: JobQueueStats[] = QUEUE_NAMES.map((name) => lanes.get(name) ?? emptyLane(name));
  for (const [name, lane] of lanes) {
    if (!isQueueName(name)) byQueue.push(lane);
  }

  const stats: JobStats = { since, total, byStatus, byQueue };
  return stats;
});
