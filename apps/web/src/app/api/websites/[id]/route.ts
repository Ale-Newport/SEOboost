import { z } from 'zod';
import { isUniqueViolation, prisma } from '@seo/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  createLogger,
  updateWebsiteSchema,
} from '@seo/shared';
import { deleteSchedule, listSchedules, syncSchedules } from '@seo/queue';
import { readBody, readQuery, requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { getWebsiteDetail } from '@/server/queries/websites';

const log = createLogger('api:website');

type Params = { id: string };

/** The site overview: profile, scores, rollups, integration status and the latest crawl. */
export const GET = route<Params>(async ({ user, params }) => {
  await requireWebsite(user.id, params.id);
  const detail = await getWebsiteDetail(params.id);
  if (!detail) throw new NotFoundError('Website');
  return { website: detail };
});

/** Empty strings from optional form inputs mean "clear this field". */
function nullable(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export const PATCH = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const input = await readBody(request, updateWebsiteSchema);

  let updated;
  try {
    updated = await prisma.website.update({
      where: { id: website.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.domain === undefined ? {} : { domain: input.domain }),
        ...(input.protocol === undefined ? {} : { protocol: input.protocol }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.cmsType === undefined ? {} : { cmsType: input.cmsType }),
        ...(input.primaryLanguage === undefined ? {} : { primaryLanguage: input.primaryLanguage }),
        ...(input.targetLocales === undefined ? {} : { targetLocales: input.targetLocales }),
        ...(input.targetCountry === undefined ? {} : { targetCountry: input.targetCountry }),
        description: nullable(input.description),
        businessCategory: nullable(input.businessCategory),
        targetAudience: nullable(input.targetAudience),
        conversionGoal: nullable(input.conversionGoal),
        brandName: nullable(input.brandName),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`You already track ${input.domain ?? website.domain}.`);
    }
    throw err;
  }

  // Repeatables are only registered for ACTIVE sites, so pausing or archiving one has to be
  // projected onto Redis — otherwise a paused site keeps crawling on its old schedule.
  const statusChanged = input.status !== undefined && input.status !== website.status;
  if (statusChanged) await syncSchedules();

  log.info('website updated', { websiteId: website.id, statusChanged });
  return { website: updated };
});

const deleteQuerySchema = z.object({
  confirm: z.string().trim().min(1).optional(),
});

/**
 * Permanently delete a website and everything hanging off it.
 *
 * The cascade reaches every crawl, page, keyword, issue, draft and action for the site, so the
 * caller has to type the domain back: `?confirm=example.com`. A boolean flag would be one
 * mis-wired button away from destroying a customer's entire history.
 */
export const DELETE = route<Params>(async ({ user, request, params }) => {
  // The one irreversible operation in this file. A demo install must not be able to delete its
  // own demo data, and an operator-set read-only flag has to hold here as well as in the UI.
  await assertNotReadOnly();
  const website = await requireWebsite(user.id, params.id);
  const query = readQuery(request, deleteQuerySchema);

  if (query.confirm !== website.domain) {
    throw new ValidationError(
      `This permanently deletes every crawl, page, keyword and action for ${website.domain}. Pass ?confirm=${website.domain} to proceed.`,
      { expected: website.domain, received: query.confirm ?? null },
    );
  }

  // Unregister the site's repeatables before the rows cascade away: a deleted ScheduledJob row
  // whose BullMQ repeatable is still installed would keep firing jobs for a site that is gone.
  const schedules = await listSchedules(website.id);
  for (const schedule of schedules) {
    await deleteSchedule(schedule.id).catch((err: unknown) => {
      log.warn('failed to unregister schedule during website deletion', {
        websiteId: website.id,
        scheduleId: schedule.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  await prisma.website.delete({ where: { id: website.id } });

  log.info('website deleted', { websiteId: website.id, domain: website.domain });
  return { deleted: true, websiteId: website.id, domain: website.domain };
});
