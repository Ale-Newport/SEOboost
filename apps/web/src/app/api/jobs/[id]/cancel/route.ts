import { cancelJob } from '@seo/queue';
import { route } from '@/lib/api';
import { requireJobAccess } from '@/app/api/_lib/jobs';

/**
 * `POST /api/jobs/[id]/cancel`.
 *
 * `cancelJob` writes the durable CANCELLED flag before it touches Redis, so cancelling works
 * with the broker down and a job that is already running stops at its next checkpoint.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  const job = await requireJobAccess(user, params.id);
  return cancelJob(job.id);
});
