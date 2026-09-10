import { retryJob } from '@seo/queue';
import { route } from '@/lib/api';
import { requireJobAccess } from '@/app/api/_lib/jobs';
import { assertNotReadOnly, enqueueSummary } from '@/app/api/_lib/common';

/**
 * `POST /api/jobs/[id]/retry`.
 *
 * A retry creates a *new* JobRecord from the stored name and payload rather than resetting the
 * old one, so the original failure stays in the history and the two runs are linked.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  const job = await requireJobAccess(user, params.id);
  await assertNotReadOnly();

  const result = await retryJob(job.id);
  return {
    sourceJobRecordId: result.sourceJobRecordId,
    newJobRecordId: result.newJobRecordId,
    job: enqueueSummary(result.enqueue),
  };
});
