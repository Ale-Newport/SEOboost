import { prisma, readJson } from '@seo/db';
import { isJobName, queueForJob } from '@seo/queue';
import { route } from '@/lib/api';
import { requireJobAccess } from '@/app/api/_lib/jobs';

/** `GET /api/jobs/[id]` — one job with its payload, result and (when it has one) its website. */
export const GET = route<{ id: string }>(async ({ user, params }) => {
  const job = await requireJobAccess(user, params.id);

  const website = job.websiteId
    ? await prisma.website.findUnique({
        where: { id: job.websiteId },
        select: { id: true, name: true, domain: true },
      })
    : null;

  return {
    ...job,
    payload: readJson<Record<string, unknown>>(job.payload, {}),
    result: readJson<Record<string, unknown>>(job.result, {}),
    website,
    // The catalogue is the source of truth for the lane; the stored column can be stale.
    lane: isJobName(job.jobName) ? queueForJob(job.jobName) : job.queue,
    retryable: isJobName(job.jobName),
  };
});
