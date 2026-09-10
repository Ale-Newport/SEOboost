import { type Prisma, prisma } from '@seo/db';
import { AUTONOMY_DESCRIPTIONS, ValidationError, createLogger, websiteSettingsSchema } from '@seo/shared';
import { ensureDefaultSchedules, syncSchedules } from '@seo/queue';
import { readBody, requireWebsite, route } from '@/lib/api';

const log = createLogger('api:website-settings');

type Params = { id: string };

/** The five columns that are mirrored into `ScheduledJob` rows by the scheduler. */
const SCHEDULE_KEYS = [
  'scheduleCrawl',
  'scheduleGscSync',
  'scheduleAnalysis',
  'scheduleAiVisibility',
  'scheduleReport',
] as const;

/**
 * A settings row is created with every website, but a site restored from an older export may
 * not have one. Creating it with schema defaults is safe — those defaults are the shipped
 * behaviour, not invented values.
 */
async function loadSettings(websiteId: string) {
  // Upsert rather than find-then-create: `websiteId` is unique, so two concurrent requests to
  // this route (the Settings form autosaves) would race and one would die on P2002.
  return prisma.websiteSettings.upsert({
    where: { websiteId },
    create: { websiteId },
    update: {},
  });
}

export const GET = route<Params>(async ({ user, params }) => {
  await requireWebsite(user.id, params.id);
  const settings = await loadSettings(params.id);
  return { settings, autonomyDescriptions: AUTONOMY_DESCRIPTIONS };
});

/**
 * Update crawl, automation, model-routing, budget, schedule and threshold settings.
 *
 * Cron changes are reconciled through `syncSchedules()` rather than written straight to Redis:
 * these columns are the authority for the five managed schedules, and the reconciler is the one
 * path that keeps the `ScheduledJob` rows and the BullMQ repeatables in step with them.
 */
export const PATCH = route<Params>(async ({ user, request, params }) => {
  await requireWebsite(user.id, params.id);
  const input = await readBody(request, websiteSettingsSchema);
  const current = await loadSettings(params.id);

  const strikingMin = input.strikingDistanceMin ?? current.strikingDistanceMin;
  const strikingMax = input.strikingDistanceMax ?? current.strikingDistanceMax;
  if (strikingMin >= strikingMax) {
    throw new ValidationError(
      'The striking-distance window must start before it ends (min < max).',
      { strikingDistanceMin: strikingMin, strikingDistanceMax: strikingMax },
    );
  }

  // Only the keys actually present in the request are written, so a partial form submit cannot
  // silently reset a field the operator did not touch.
  const data: Prisma.WebsiteSettingsUpdateInput = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    Object.assign(data, { [key]: value });
  }

  const settings = await prisma.websiteSettings.update({ where: { websiteId: params.id }, data });

  const scheduleChanged = SCHEDULE_KEYS.some(
    (key) => input[key] !== undefined && input[key] !== current[key],
  );
  if (scheduleChanged) {
    // A cron that was cleared has no row to create; ensure-then-sync covers both directions.
    await ensureDefaultSchedules(params.id);
    await syncSchedules();
  }

  log.info('website settings updated', {
    websiteId: params.id,
    fields: Object.keys(data),
    scheduleChanged,
  });

  return { settings, scheduleChanged };
});
