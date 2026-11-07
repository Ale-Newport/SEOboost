import { z } from 'zod';
import {
  type JobName,
  type ScheduleSummary,
  createSchedule,
  listSchedules,
  setScheduleEnabled,
  syncSchedules,
} from '@seo/queue';
import { createLogger, errorMessage } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly, requireScopedWebsite } from '@/app/api/_lib/common';

const log = createLogger('api:social-automation');

/**
 * `POST /api/social/automation` — switch the site's social schedules on or off as a set.
 *
 * Five ordinary custom schedules, so they show up (and can be re-timed) on the Automations
 * screen like any other. Turning automation off disables them rather than deleting them, which
 * keeps any cron the operator edited. What runs unattended is still bounded by the guardrails:
 * replies are only ever drafted, never posted, and own-channel posts publish on their own only
 * at autonomy level 4.
 */

const SPECS: ReadonlyArray<{ name: string; jobName: JobName; cron: string; payload: Record<string, unknown> }> = [
  { name: 'social-listening', jobName: 'agents.run', cron: '15 */4 * * *', payload: { agent: 'social-listening', trigger: 'schedule' } },
  { name: 'social-engagement', jobName: 'agents.run', cron: '45 */4 * * *', payload: { agent: 'social-engagement', trigger: 'schedule' } },
  { name: 'social-content', jobName: 'agents.run', cron: '0 7 * * *', payload: { agent: 'social-content', trigger: 'schedule' } },
  { name: 'social-dispatch', jobName: 'social.dispatch', cron: '*/15 * * * *', payload: {} },
  { name: 'social-metrics', jobName: 'social.metrics', cron: '0 */12 * * *', payload: {} },
];

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  enabled: z.boolean(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, body.websiteId);

  const existing = await listSchedules(website.id);
  const byName = new Map(existing.map((schedule) => [schedule.name, schedule]));
  const result: ScheduleSummary[] = [];

  for (const spec of SPECS) {
    const current = byName.get(spec.name);
    if (current) {
      result.push(current.isEnabled === body.enabled ? current : await setScheduleEnabled(current.id, body.enabled));
    } else if (body.enabled) {
      result.push(
        await createSchedule({
          websiteId: website.id,
          name: spec.name,
          jobName: spec.jobName,
          cron: spec.cron,
          payload: spec.payload,
          isEnabled: true,
        }),
      );
    }
  }

  // Each change above already projected itself onto Redis; the full sync is a belt-and-braces
  // pass and must not turn a saved change into an error when the broker is down.
  let synced = true;
  try {
    await syncSchedules();
  } catch (err) {
    synced = false;
    log.warn('schedule sync after social automation change failed', { websiteId: website.id, error: errorMessage(err) });
  }

  return {
    enabled: body.enabled,
    synced,
    schedules: result.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      jobName: schedule.jobName,
      cron: schedule.cron,
      isEnabled: schedule.isEnabled,
      lastRunAt: schedule.lastRunAt,
      lastStatus: schedule.lastStatus,
      nextRunAt: schedule.nextRunAt,
    })),
  };
});
