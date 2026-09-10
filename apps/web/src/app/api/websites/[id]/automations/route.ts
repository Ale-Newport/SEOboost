import { z } from 'zod';
import {
  ForbiddenError,
  IntegrationNotConfiguredError,
  NotFoundError,
  ValidationError,
  createLogger,
  isConfigured,
} from '@seo/shared';
import {
  getSchedule,
  isValidCron,
  runScheduleNow,
  setScheduleEnabled,
  updateSchedule,
} from '@seo/queue';
import { enqueue } from '@seo/queue';
import { readBody, requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly, enqueueSummary } from '@/app/api/_lib/common';
import { AGENT_KEYS, findAgent } from '@/app/api/_lib/agents';

const log = createLogger('api:site-automations');

type Params = { id: string };

/**
 * `POST /api/websites/[id]/automations` — the site's automation control surface.
 *
 * Autonomy level, auto-approve and the AI budget are plain settings and go through
 * `PATCH /api/websites/[id]/settings`. What lives here is everything that *starts or changes
 * work*: running an agent now, and enabling, retiming or running one of the site's schedules.
 * Keeping those in one website-scoped route means the ownership check happens once, and a
 * schedule id belonging to another site can never be driven from here.
 */

const bodySchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('run-agent'),
    agent: z.string().trim().min(1).max(60),
  }),
  z.object({
    op: z.literal('run-schedule'),
    scheduleId: z.string().trim().min(1),
  }),
  z.object({
    op: z.literal('toggle-schedule'),
    scheduleId: z.string().trim().min(1),
    enabled: z.boolean(),
  }),
  z.object({
    op: z.literal('update-schedule'),
    scheduleId: z.string().trim().min(1),
    cron: z.string().trim().min(1).max(60),
  }),
]);

/** Loads a schedule and refuses one that belongs to another website. */
async function requireOwnedSchedule(websiteId: string, scheduleId: string) {
  const schedule = await getSchedule(scheduleId);
  if (!schedule) throw new NotFoundError('Schedule');
  if (schedule.websiteId !== websiteId) {
    throw new ForbiddenError('That schedule belongs to a different website.');
  }
  return schedule;
}

export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  await assertNotReadOnly();
  const body = await readBody(request, bodySchema);

  if (body.op === 'run-agent') {
    const agent = findAgent(body.agent);
    if (!agent) {
      throw new ValidationError(
        `Unknown agent "${body.agent}". Valid keys: ${AGENT_KEYS.join(', ')}.`,
      );
    }
    if (agent.requiresAi && !isConfigured.anyAi()) {
      throw new IntegrationNotConfiguredError(
        'AI provider',
        `${agent.label} needs a language model. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_AI_API_KEY.`,
      );
    }

    const result = await enqueue(
      'agents.run',
      { websiteId: website.id, agent: agent.key, trigger: 'api' },
      { dedupeKey: `agent:${website.id}:${agent.key}`, trigger: 'api' },
    );

    log.info('agent run requested', { websiteId: website.id, agent: agent.key });
    return { agent: agent.key, ...enqueueSummary(result) };
  }

  const schedule = await requireOwnedSchedule(website.id, body.scheduleId);

  if (body.op === 'run-schedule') {
    const result = await runScheduleNow(schedule.id);
    log.info('schedule run now', { websiteId: website.id, name: schedule.name });
    return { scheduleId: schedule.id, ...enqueueSummary(result.enqueue) };
  }

  if (body.op === 'toggle-schedule') {
    const updated = await setScheduleEnabled(schedule.id, body.enabled);
    log.info('schedule toggled', {
      websiteId: website.id,
      name: schedule.name,
      enabled: body.enabled,
    });
    return {
      schedule: updated,
      queueConfigured: isConfigured.redis(),
      message: body.enabled
        ? `${updated.label} is on.`
        : `${updated.label} is off; it will not run until you turn it back on.`,
    };
  }

  if (!isValidCron(body.cron)) {
    throw new ValidationError(
      `"${body.cron}" is not a valid cron expression. Use five fields — minute hour day month weekday.`,
      { cron: body.cron },
    );
  }
  const updated = await updateSchedule(schedule.id, { cron: body.cron });
  log.info('schedule retimed', { websiteId: website.id, name: schedule.name, cron: body.cron });
  return { schedule: updated, message: `${updated.label} rescheduled.` };
});
