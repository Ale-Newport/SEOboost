import 'server-only';
import { type JobRecord, prisma } from '@seo/db';
import { ForbiddenError, NotFoundError } from '@seo/shared';
import type { SessionUser } from '@/lib/auth';

/**
 * Ownership for job rows.
 *
 * A `JobRecord` may belong to no website at all — portfolio reports, maintenance sweeps — so
 * ownership cannot be expressed as "the website is mine". Site jobs are checked against the
 * website's owner; install-wide jobs are visible to any signed-in operator, which is the
 * correct model for a single-installation product where those jobs are shared infrastructure.
 */
export async function requireJobAccess(user: SessionUser, jobId: string): Promise<JobRecord> {
  const job = await prisma.jobRecord.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundError('Job');

  if (job.websiteId) {
    const website = await prisma.website.findUnique({
      where: { id: job.websiteId },
      select: { userId: true },
    });
    if (!website) throw new NotFoundError('Job');
    if (website.userId !== user.id) throw new ForbiddenError('You do not have access to this job.');
  }
  return job;
}
