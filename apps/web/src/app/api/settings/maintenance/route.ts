import { z } from 'zod';
import { cleanupOldJobs } from '@seo/queue';
import { createLogger, ForbiddenError } from '@seo/shared';
import { pruneExpiredSessions } from '@/lib/auth';
import { readBody, route } from '@/lib/api';

const log = createLogger('api:maintenance');

const bodySchema = z.object({
  action: z.enum(['cleanup-jobs', 'prune-sessions']),
  /** Terminal job rows finished longer ago than this are removed. */
  olderThanDays: z.coerce.number().int().min(1).max(365).default(30),
});

/**
 * Operator maintenance. Deliberately narrow: it only removes rows the system itself created and
 * no longer needs (finished job records, expired sessions). Nothing here can touch a website,
 * its pages or its history — destructive site operations live behind the approval flow.
 */
export const POST = route(async ({ request, user }) => {
  if (user.role !== 'OWNER' && user.role !== 'ADMIN') {
    throw new ForbiddenError('Only the owner or an admin can run maintenance.');
  }

  const body = await readBody(request, bodySchema);

  if (body.action === 'prune-sessions') {
    const deleted = await pruneExpiredSessions();
    log.info('expired sessions pruned', { userId: user.id, deleted });
    return { action: body.action, deleted };
  }

  const deleted = await cleanupOldJobs(body.olderThanDays);
  log.info('old job records removed', { userId: user.id, deleted, olderThanDays: body.olderThanDays });
  return { action: body.action, deleted, olderThanDays: body.olderThanDays };
});
