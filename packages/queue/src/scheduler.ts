/**
 * Recurring schedules, backed by the `ScheduledJob` table.
 *
 * Two stores have to agree: Postgres holds the schedules an operator can see and edit, Redis
 * holds the BullMQ repeatables that actually fire. Postgres is the source of truth and
 * `syncSchedules()` is the one-way reconciler that makes Redis match it — never the reverse.
 * That ordering is what lets the app run (and be configured) with no broker at all: the rows
 * are still there, they simply do not fire until Redis comes back and a sync runs.
 *
 * The five *managed* schedules are additionally mirrored into `WebsiteSettings`, because the
 * Settings screen already exposes those cron fields. Mirroring in both directions keeps the two
 * screens honest: a change made on either one survives the next sync.
 *
 * Cron expressions are interpreted in UTC — `ScheduledJob` carries no timezone column, and
 * BullMQ likewise defaults to UTC — so the previews this module computes match what fires.
 */

import {
  type Prisma,
  type ScheduledJob,
  WebsiteStatus,
  isNotFound,
  isUniqueViolation,
  json,
  prisma,
  readJson,
} from '@seo/db';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  createLogger,
  errorMessage,
  withTimeout,
} from '@seo/shared';
import { computeNextRun, isValidCron } from './cron';
import {
  SCHEDULER_PREFIX,
  type EnqueueResult,
  enqueue,
  getQueue,
  removeRepeatable,
  upsertRepeatable,
} from './queue';
import {
  QUEUE_NAMES,
  type AnyJobPayload,
  type JobName,
  type JobPayloads,
  type QueueName,
  isJobName,
  isQueueName,
  queueForJob,
} from './types';

const log = createLogger('queue:scheduler');

/** Bounds a Redis read during a sync so an unreachable broker cannot stall the caller. */
const BROKER_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────
// The managed defaults
// ─────────────────────────────────────────────────────────────

/** The `WebsiteSettings` columns that hold a cron expression (null → schedule off). */
export type ScheduleSettingKey =
  | 'scheduleCrawl'
  | 'scheduleGscSync'
  | 'scheduleAnalysis'
  | 'scheduleAiVisibility'
  | 'scheduleReport';

interface DefaultScheduleSpec<K extends JobName = JobName> {
  /** `ScheduledJob.name`; unique per website and the key `ensureDefaultSchedules` upserts on. */
  name: string;
  label: string;
  jobName: K;
  settingKey: ScheduleSettingKey;
  /**
   * Payload for a freshly created row. Deliberately minimal: every optional field is left out
   * so the processor falls back to the site's own settings rather than to a value invented here.
   */
  payload: (websiteId: string) => JobPayloads[K];
}

/** Correlated union so each spec's `payload` is checked against its own `jobName`. */
type AnyDefaultScheduleSpec = { [K in JobName]: DefaultScheduleSpec<K> }[JobName];

/**
 * The schedules every site gets. The set is closed on purpose — these are the five the
 * Settings screen exposes; anything else is a custom row created through `createSchedule`.
 */
export const DEFAULT_SCHEDULES: readonly AnyDefaultScheduleSpec[] = [
  {
    name: 'crawl',
    label: 'Site crawl',
    jobName: 'crawl.site',
    settingKey: 'scheduleCrawl',
    payload: (websiteId) => ({ websiteId, trigger: 'schedule' }),
  },
  {
    name: 'gsc-sync',
    label: 'Search Console sync',
    jobName: 'gsc.sync',
    settingKey: 'scheduleGscSync',
    payload: (websiteId) => ({ websiteId }),
  },
  {
    name: 'analysis',
    label: 'Full analysis',
    jobName: 'analysis.full',
    settingKey: 'scheduleAnalysis',
    payload: (websiteId) => ({ websiteId, trigger: 'schedule' }),
  },
  {
    name: 'ai-visibility',
    label: 'AI visibility run',
    jobName: 'aivis.run-prompts',
    settingKey: 'scheduleAiVisibility',
    payload: (websiteId) => ({ websiteId }),
  },
  {
    name: 'report',
    label: 'Weekly report',
    jobName: 'reports.generate',
    // The shipped default for this column is a Monday cron, so weekly is the matching period.
    settingKey: 'scheduleReport',
    payload: (websiteId) => ({ websiteId, type: 'weekly' }),
  },
];

const MANAGED_BY_NAME = new Map<string, AnyDefaultScheduleSpec>(
  DEFAULT_SCHEDULES.map((spec) => [spec.name, spec]),
);

const SCHEDULE_SETTINGS_SELECT = {
  scheduleCrawl: true,
  scheduleGscSync: true,
  scheduleAnalysis: true,
  scheduleAiVisibility: true,
  scheduleReport: true,
} satisfies Prisma.WebsiteSettingsSelect;

type ScheduleSettings = { [K in ScheduleSettingKey]: string | null };

/** Explicit per-column patch: a computed key would widen to an index signature Prisma rejects. */
function settingsPatch(
  key: ScheduleSettingKey,
  cron: string | null,
): Prisma.WebsiteSettingsUpdateInput {
  switch (key) {
    case 'scheduleCrawl':
      return { scheduleCrawl: cron };
    case 'scheduleGscSync':
      return { scheduleGscSync: cron };
    case 'scheduleAnalysis':
      return { scheduleAnalysis: cron };
    case 'scheduleAiVisibility':
      return { scheduleAiVisibility: cron };
    case 'scheduleReport':
      return { scheduleReport: cron };
  }
}

/**
 * Writes a managed schedule's cron back to its `WebsiteSettings` column.
 *
 * Without this, `syncSchedules()` — which treats the settings column as authoritative for
 * managed rows — would silently revert any edit made from the Schedules screen.
 */
async function mirrorToSettings(
  row: Pick<ScheduledJob, 'websiteId' | 'name'>,
  cron: string | null,
): Promise<void> {
  if (!row.websiteId) return;
  const spec = MANAGED_BY_NAME.get(row.name);
  if (!spec) return;
  try {
    await prisma.websiteSettings.update({
      where: { websiteId: row.websiteId },
      data: settingsPatch(spec.settingKey, cron),
    });
  } catch (err) {
    // A site with no settings row has nothing to mirror into; anything else is worth knowing
    // about but must not fail the schedule edit that triggered it.
    if (!isNotFound(err)) {
      log.warn('failed to mirror schedule into website settings', {
        websiteId: row.websiteId,
        name: row.name,
        error: errorMessage(err),
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Read model
// ─────────────────────────────────────────────────────────────

export interface ScheduleSummary {
  id: string;
  websiteId: string | null;
  name: string;
  /** Human label for the managed defaults; the raw name for custom rows. */
  label: string;
  queue: string;
  jobName: string;
  cron: string;
  /** False when the stored expression no longer parses; such a row is never registered. */
  cronValid: boolean;
  payload: Record<string, unknown>;
  isEnabled: boolean;
  /** True for the five rows mirrored to `WebsiteSettings`. */
  managed: boolean;
  lastRunAt: Date | null;
  lastStatus: string | null;
  /** Recomputed on read, so a stale column never shows a "next run" that is already past. */
  nextRunAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toSummary(row: ScheduledJob): ScheduleSummary {
  const cronValid = isValidCron(row.cron);
  return {
    id: row.id,
    websiteId: row.websiteId,
    name: row.name,
    label: MANAGED_BY_NAME.get(row.name)?.label ?? row.name,
    queue: row.queue,
    jobName: row.jobName,
    cron: row.cron,
    cronValid,
    payload: readJson<Record<string, unknown>>(row.payload, {}),
    isEnabled: row.isEnabled,
    managed: MANAGED_BY_NAME.has(row.name),
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    nextRunAt: cronValid && row.isEnabled ? computeNextRun(row.cron) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Schedules for one site, or every schedule (including global ones) when no site is given. */
export async function listSchedules(websiteId?: string): Promise<ScheduleSummary[]> {
  const rows = await prisma.scheduledJob.findMany({
    where: websiteId === undefined ? {} : { websiteId },
    orderBy: [{ websiteId: 'asc' }, { name: 'asc' }],
  });
  return rows.map(toSummary);
}

export async function getSchedule(id: string): Promise<ScheduleSummary | null> {
  const row = await prisma.scheduledJob.findUnique({ where: { id } });
  return row ? toSummary(row) : null;
}

// ─────────────────────────────────────────────────────────────
// Redis projection
// ─────────────────────────────────────────────────────────────

/**
 * Scheduler id for a row.
 *
 * Keyed by row id rather than by job name: `[websiteId, name]` is the table's unique key, so
 * two rows on one site may legitimately share a `jobName`, and a name-keyed id would silently
 * collapse them into one repeatable.
 */
export function schedulerIdForSchedule(scheduledJobId: string): string {
  return `${SCHEDULER_PREFIX}:schedule:${scheduledJobId}`;
}

interface DesiredRepeatable {
  scheduledJobId: string;
  schedulerId: string;
  queue: QueueName;
  jobName: JobName;
  payload: AnyJobPayload;
  cron: string;
  websiteId: string | null;
}

/**
 * `ScheduledJob.payload` is a free-form JSON column, so the catalogue's payload types cannot be
 * proven at runtime. We widen once here and let the processor's own validation reject a payload
 * a hand-edited row got wrong; `websiteId` is re-asserted from the row so the two cannot drift.
 */
function schedulePayload(row: Pick<ScheduledJob, 'payload' | 'websiteId'>): AnyJobPayload {
  const raw = readJson<Record<string, unknown>>(row.payload, {});
  const merged = { ...raw, ...(row.websiteId ? { websiteId: row.websiteId } : {}) };
  return merged as AnyJobPayload;
}

/** The repeatable a row asks for, or `null` when the row cannot be registered as written. */
function toDesired(row: ScheduledJob): DesiredRepeatable | null {
  if (!isJobName(row.jobName)) {
    log.warn('schedule references an unknown job name', {
      scheduleId: row.id,
      jobName: row.jobName,
    });
    return null;
  }
  if (!isValidCron(row.cron)) {
    log.warn('schedule has an invalid cron expression', { scheduleId: row.id, cron: row.cron });
    return null;
  }
  return {
    scheduledJobId: row.id,
    schedulerId: schedulerIdForSchedule(row.id),
    queue: queueForJob(row.jobName),
    jobName: row.jobName,
    payload: schedulePayload(row),
    cron: row.cron,
    websiteId: row.websiteId,
  };
}

async function registerRepeatable(desired: DesiredRepeatable): Promise<EnqueueResult> {
  return upsertRepeatable(
    desired.jobName,
    desired.payload,
    { pattern: desired.cron },
    {
      websiteId: desired.websiteId,
      schedulerId: desired.schedulerId,
      scheduledJobId: desired.scheduledJobId,
      trigger: 'schedule',
    },
  );
}

/**
 * True when the row's website is gone or not ACTIVE. Such a row keeps its configuration but
 * must not fire — the same rule `syncSchedules()` applies, checked here so an edit made while a
 * site is paused does not register a repeatable that the next sync would immediately reap.
 */
async function isWebsiteInactive(websiteId: string | null): Promise<boolean> {
  if (!websiteId) return false;
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { status: true },
  });
  return website === null || website.status !== WebsiteStatus.ACTIVE;
}

/**
 * Projects a single row onto Redis: registered when it is enabled and valid, removed otherwise.
 * Returns false when the broker is unreachable — the row stands, the sync will catch up.
 */
async function applyScheduleToRedis(row: ScheduledJob): Promise<boolean> {
  const suppressed = row.isEnabled ? await isWebsiteInactive(row.websiteId) : false;
  const desired = row.isEnabled && !suppressed ? toDesired(row) : null;
  if (desired) {
    const result = await registerRepeatable(desired);
    return result.enqueued;
  }

  // Disabled, suppressed by a paused site, invalid, or pointing at an unknown job: make sure
  // nothing is left firing. The lane comes from the catalogue when possible, since the stored
  // column can be stale.
  const lane = isJobName(row.jobName) ? queueForJob(row.jobName) : row.queue;
  const schedulerId = schedulerIdForSchedule(row.id);
  if (isQueueName(lane)) return removeRepeatable(lane, schedulerId);

  // Unknown lane: sweep every queue so the registration cannot survive somewhere unexpected.
  const removals = await Promise.all(
    QUEUE_NAMES.map((name) => removeRepeatable(name, schedulerId)),
  );
  return removals.some(Boolean);
}

// ─────────────────────────────────────────────────────────────
// ensureDefaultSchedules
// ─────────────────────────────────────────────────────────────

/**
 * Creates the default `ScheduledJob` rows for a site from its `WebsiteSettings` cron fields.
 *
 * Idempotent, and deliberately non-destructive on re-run: an existing row keeps the operator's
 * cron, payload and enabled flag, and only the columns derived from the catalogue (`queue`,
 * `jobName`) are refreshed. Reconciling cron changes is `syncSchedules()`'s job.
 */
export async function ensureDefaultSchedules(websiteId: string): Promise<ScheduleSummary[]> {
  const settings = await prisma.websiteSettings.findUnique({
    where: { websiteId },
    select: SCHEDULE_SETTINGS_SELECT,
  });

  if (!settings) {
    // No settings row means no cron fields to read. Inventing defaults here would put a site
    // on a schedule its own configuration never asked for.
    log.warn('cannot create default schedules: website has no settings row', { websiteId });
    return [];
  }

  const created: ScheduleSummary[] = [];

  for (const spec of DEFAULT_SCHEDULES) {
    const cron = settings[spec.settingKey];
    if (!cron) continue;
    if (!isValidCron(cron)) {
      log.warn('skipping default schedule with an invalid cron expression', {
        websiteId,
        name: spec.name,
        cron,
      });
      continue;
    }

    const queue = queueForJob(spec.jobName);
    const row = await prisma.scheduledJob.upsert({
      where: { websiteId_name: { websiteId, name: spec.name } },
      create: {
        websiteId,
        name: spec.name,
        queue,
        jobName: spec.jobName,
        cron,
        payload: json(spec.payload(websiteId)),
        isEnabled: true,
        nextRunAt: computeNextRun(cron),
      },
      update: { queue, jobName: spec.jobName },
    });
    created.push(toSummary(row));
  }

  return created;
}

// ─────────────────────────────────────────────────────────────
// syncSchedules
// ─────────────────────────────────────────────────────────────

export interface SyncSchedulesResult {
  /** Default rows created from `WebsiteSettings` during the reconcile pass. */
  rowsCreated: number;
  /** Managed rows whose cron was pulled forward from `WebsiteSettings`, or re-enabled by it. */
  rowsUpdated: number;
  /** Managed rows disabled because their settings column was cleared. */
  rowsDisabled: number;
  /** Repeatables written to Redis (upserts, so this is the size of the desired set). */
  registered: number;
  /** Prefixed repeatables removed because no enabled row asks for them any more. */
  removed: number;
  /** Rows skipped: unknown job name, unparseable cron, or a non-active website. */
  skipped: number;
  redis: { ok: boolean; error?: string };
}

/**
 * Makes Redis match the database exactly.
 *
 * Runs in two passes. First Postgres is reconciled against `WebsiteSettings` (the authority for
 * the five managed schedules). Then every enabled row is projected onto BullMQ and every
 * `seo:`-prefixed repeatable without a matching row is removed — including ad-hoc repeatables
 * registered outside this table, which is intentional: the table is the whole picture.
 *
 * Safe to call on a timer and safe to call with no broker: a missing or unreachable Redis logs
 * a warning and returns `redis.ok === false` rather than throwing.
 */
export async function syncSchedules(): Promise<SyncSchedulesResult> {
  const result: SyncSchedulesResult = {
    rowsCreated: 0,
    rowsUpdated: 0,
    rowsDisabled: 0,
    registered: 0,
    removed: 0,
    skipped: 0,
    redis: { ok: true },
  };

  const websites = await prisma.website.findMany({
    select: { id: true, status: true, settings: { select: SCHEDULE_SETTINGS_SELECT } },
  });

  const existing = await prisma.scheduledJob.findMany();
  const byWebsiteAndName = new Map<string, ScheduledJob>();
  for (const row of existing) {
    byWebsiteAndName.set(`${row.websiteId ?? ''}::${row.name}`, row);
  }

  // ── pass 1: settings → rows ───────────────────────────────
  const touched = new Map<string, ScheduledJob>();
  for (const website of websites) {
    if (!website.settings) continue;
    const settings: ScheduleSettings = website.settings;

    for (const spec of DEFAULT_SCHEDULES) {
      const cron = settings[spec.settingKey];
      const row = byWebsiteAndName.get(`${website.id}::${spec.name}`);

      if (cron && !isValidCron(cron)) {
        log.warn('website settings hold an invalid cron expression', {
          websiteId: website.id,
          setting: spec.settingKey,
          cron,
        });
        result.skipped += 1;
        continue;
      }

      if (!cron) {
        // Cleared in Settings means "off". The row is kept so the expression can be restored.
        if (row?.isEnabled) {
          const updated = await prisma.scheduledJob.update({
            where: { id: row.id },
            data: { isEnabled: false, nextRunAt: null },
          });
          touched.set(updated.id, updated);
          result.rowsDisabled += 1;
        }
        continue;
      }

      if (!row) {
        const createdRow = await prisma.scheduledJob.create({
          data: {
            websiteId: website.id,
            name: spec.name,
            queue: queueForJob(spec.jobName),
            jobName: spec.jobName,
            cron,
            payload: json(spec.payload(website.id)),
            isEnabled: true,
            nextRunAt: computeNextRun(cron),
          },
        });
        touched.set(createdRow.id, createdRow);
        result.rowsCreated += 1;
        continue;
      }

      // Settings is the authority for managed rows, and a cron in the column means "on". A row
      // that an earlier clear disabled is therefore switched back on when the value returns —
      // without this the Settings screen would show a schedule that never fires.
      if (row.cron !== cron || !row.isEnabled) {
        const updated = await prisma.scheduledJob.update({
          where: { id: row.id },
          data: { cron, isEnabled: true, nextRunAt: computeNextRun(cron) },
        });
        touched.set(updated.id, updated);
        result.rowsUpdated += 1;
      }
    }
  }

  // ── pass 2: rows → Redis ──────────────────────────────────
  const activeWebsiteIds = new Set(
    websites.filter((w) => w.status === WebsiteStatus.ACTIVE).map((w) => w.id),
  );

  // Pass 1 may have created rows that were not in `existing`; fold both sets by id so each row
  // is projected exactly once, in its post-update shape.
  const byId = new Map<string, ScheduledJob>(existing.map((row) => [row.id, row]));
  for (const [id, row] of touched) byId.set(id, row);
  const rows = [...byId.values()];

  const desiredByQueue = new Map<QueueName, Map<string, DesiredRepeatable>>();
  for (const row of rows) {
    if (!row.isEnabled) continue;
    // A paused or archived site keeps its rows but must stop firing.
    if (row.websiteId !== null && !activeWebsiteIds.has(row.websiteId)) {
      result.skipped += 1;
      continue;
    }
    const desired = toDesired(row);
    if (!desired) {
      result.skipped += 1;
      continue;
    }
    const lane = desiredByQueue.get(desired.queue) ?? new Map<string, DesiredRepeatable>();
    lane.set(desired.schedulerId, desired);
    desiredByQueue.set(desired.queue, lane);
  }

  const redis = await syncRedis(desiredByQueue);
  result.registered = redis.registered;
  result.removed = redis.removed;
  result.redis = redis.redis;

  log.info('schedule sync finished', { ...result, redis: result.redis.ok });
  return result;
}

/** The Redis half of a sync. Never throws; reports what it could not do. */
async function syncRedis(
  desiredByQueue: Map<QueueName, Map<string, DesiredRepeatable>>,
): Promise<{ registered: number; removed: number; redis: { ok: boolean; error?: string } }> {
  let registered = 0;
  let removed = 0;

  for (const queueName of QUEUE_NAMES) {
    const desired = desiredByQueue.get(queueName) ?? new Map<string, DesiredRepeatable>();
    const queueInstance = getQueue(queueName);

    if (!queueInstance) {
      log.warn('schedule sync skipped: Redis is unavailable', {
        queue: queueName,
        pending: desired.size,
      });
      return {
        registered,
        removed,
        redis: { ok: false, error: 'Redis is not configured or could not be reached' },
      };
    }

    for (const entry of desired.values()) {
      const outcome = await registerRepeatable(entry);
      if (outcome.enqueued) {
        registered += 1;
      } else {
        log.warn('failed to register schedule', {
          scheduleId: entry.scheduledJobId,
          reason: outcome.reason,
        });
      }
    }

    let installed: { key: string }[];
    try {
      installed = await withTimeout(
        queueInstance.getJobSchedulers(),
        BROKER_TIMEOUT_MS,
        `list schedulers on ${queueName}`,
      );
    } catch (err) {
      log.warn('could not list repeatables; leaving them in place', {
        queue: queueName,
        error: errorMessage(err),
      });
      continue;
    }

    for (const scheduler of installed) {
      const key = scheduler.key;
      // Only ever touch keys this package owns; a foreign repeatable is none of our business.
      if (!key.startsWith(`${SCHEDULER_PREFIX}:`)) continue;
      if (desired.has(key)) continue;
      if (await removeRepeatable(queueName, key)) {
        removed += 1;
        log.info('removed orphaned repeatable', { queue: queueName, schedulerId: key });
      }
    }
  }

  return { registered, removed, redis: { ok: true } };
}

// ─────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────

async function requireSchedule(id: string): Promise<ScheduledJob> {
  const row = await prisma.scheduledJob.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('Schedule');
  return row;
}

/**
 * Enables or disables a schedule and projects the change onto Redis immediately, so the
 * operator does not have to wait for the next sync.
 */
export async function setScheduleEnabled(id: string, enabled: boolean): Promise<ScheduleSummary> {
  const row = await requireSchedule(id);

  // Enabling a row whose cron does not parse would leave a schedule that looks on but can never
  // fire — and, for a managed row, would mirror the unparseable expression into Settings.
  if (enabled && !isValidCron(row.cron)) {
    throw new ValidationError(
      `Schedule "${row.name}" has an invalid cron expression ("${row.cron}"); fix it before enabling`,
      { cron: row.cron },
    );
  }

  const updated = await prisma.scheduledJob.update({
    where: { id },
    data: {
      isEnabled: enabled,
      nextRunAt: enabled && isValidCron(row.cron) ? computeNextRun(row.cron) : null,
    },
  });

  // Managed rows mirror their on/off state into Settings; clearing the column is how that
  // screen represents "off", and keeping the row's cron means enabling restores it verbatim.
  await mirrorToSettings(updated, enabled ? updated.cron : null);
  await applyScheduleToRedis(updated);

  return toSummary(updated);
}

export interface CreateScheduleInput {
  /** `null` (or omitted) for a portfolio-wide schedule that belongs to no single site. */
  websiteId?: string | null;
  /** Unique per website. The five managed names are reserved for the Settings screen. */
  name: string;
  jobName: JobName;
  cron: string;
  payload?: Record<string, unknown>;
  isEnabled?: boolean;
}

/**
 * Creates a custom schedule — the rows that are not mirrored into `WebsiteSettings`.
 *
 * The managed names are refused rather than merged: `syncSchedules()` treats those five as owned
 * by the settings columns and would overwrite whatever was created here on its next pass.
 */
export async function createSchedule(input: CreateScheduleInput): Promise<ScheduleSummary> {
  const name = input.name.trim();
  if (!name) throw new ValidationError('A schedule needs a name');
  if (MANAGED_BY_NAME.has(name)) {
    throw new ValidationError(
      `"${name}" is a managed schedule; change it from the website's settings instead`,
      { name },
    );
  }
  if (!isJobName(input.jobName)) {
    throw new ValidationError(`"${String(input.jobName)}" is not a known job`, {
      jobName: input.jobName,
    });
  }
  if (!isValidCron(input.cron)) {
    throw new ValidationError(`"${input.cron}" is not a valid cron expression`, { cron: input.cron });
  }

  const websiteId = input.websiteId ?? null;
  const isEnabled = input.isEnabled ?? true;
  // The row's own websiteId wins, exactly as it does on read, so the two cannot drift.
  const payload = { ...(input.payload ?? {}), ...(websiteId ? { websiteId } : {}) };

  let row: ScheduledJob;
  try {
    row = await prisma.scheduledJob.create({
      data: {
        websiteId,
        name,
        queue: queueForJob(input.jobName),
        jobName: input.jobName,
        cron: input.cron,
        payload: json(payload),
        isEnabled,
        nextRunAt: isEnabled ? computeNextRun(input.cron) : null,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`A schedule named "${name}" already exists for this website`);
    }
    throw err;
  }

  await applyScheduleToRedis(row);
  return toSummary(row);
}

export interface DeleteScheduleResult {
  id: string;
  /**
   * True when a live repeatable was unregistered. False means there was nothing to remove, or
   * Redis was unreachable — in the latter case the next sync reaps the orphan.
   */
  removedFromBroker: boolean;
}

/**
 * Deletes a schedule, unregistering it from Redis first.
 *
 * Order matters: a row deleted while its repeatable is still installed keeps firing until the
 * next sync sweeps it, and those runs would stamp a schedule that no longer exists. Deleting a
 * managed row also clears its `WebsiteSettings` column, otherwise the next sync recreates it.
 */
export async function deleteSchedule(id: string): Promise<DeleteScheduleResult> {
  const row = await requireSchedule(id);

  const removedFromBroker = await applyScheduleToRedis({ ...row, isEnabled: false });
  await mirrorToSettings(row, null);
  await prisma.scheduledJob.delete({ where: { id } });

  log.info('schedule deleted', { scheduleId: id, name: row.name, removedFromBroker });
  return { id, removedFromBroker };
}

export interface UpdateScheduleInput {
  cron?: string;
  payload?: Record<string, unknown>;
}

/**
 * Edits a schedule's cron and/or payload. A malformed cron is rejected before it can reach
 * Redis, where it would fail silently at registration time.
 */
export async function updateSchedule(
  id: string,
  input: UpdateScheduleInput,
): Promise<ScheduleSummary> {
  const row = await requireSchedule(id);

  if (input.cron !== undefined && !isValidCron(input.cron)) {
    throw new ValidationError(`"${input.cron}" is not a valid cron expression`, { cron: input.cron });
  }

  const cron = input.cron ?? row.cron;
  const updated = await prisma.scheduledJob.update({
    where: { id },
    data: {
      ...(input.cron === undefined ? {} : { cron: input.cron }),
      ...(input.payload === undefined ? {} : { payload: json(input.payload) }),
      nextRunAt: row.isEnabled && isValidCron(cron) ? computeNextRun(cron) : null,
    },
  });

  if (input.cron !== undefined && updated.isEnabled) {
    await mirrorToSettings(updated, input.cron);
  }
  await applyScheduleToRedis(updated);

  return toSummary(updated);
}

export interface RunScheduleNowResult {
  scheduleId: string;
  /** Outcome of the enqueue — `enqueued: false` when Redis is unreachable or a run is in flight. */
  enqueue: EnqueueResult;
}

/**
 * Runs a schedule immediately, outside its cron.
 *
 * Deduplicated on the schedule id: a second click while the previous run is still queued or
 * running is a no-op rather than a second crawl. `lastRunAt`/`lastStatus` are stamped either
 * way so the Schedules screen reflects the attempt; the worker overwrites `lastStatus` with
 * the real outcome when the job finishes.
 */
export async function runScheduleNow(id: string): Promise<RunScheduleNowResult> {
  const row = await requireSchedule(id);

  if (!isJobName(row.jobName)) {
    throw new ValidationError(`Schedule "${row.name}" references unknown job "${row.jobName}"`);
  }

  const result = await enqueue(row.jobName, schedulePayload(row), {
    websiteId: row.websiteId,
    trigger: 'schedule',
    scheduledJobId: row.id,
    dedupeKey: `schedule:${row.id}`,
  });

  const now = new Date();
  await prisma.scheduledJob.update({
    where: { id },
    data: {
      lastRunAt: now,
      lastStatus: result.enqueued ? 'QUEUED' : `NOT_QUEUED:${result.reason}`,
      nextRunAt: row.isEnabled && isValidCron(row.cron) ? computeNextRun(row.cron, now) : null,
    },
  });

  return { scheduleId: id, enqueue: result };
}

/**
 * Recomputes `nextRunAt` for every enabled schedule.
 *
 * The column is only a display convenience — BullMQ owns the real timing — so this exists to
 * stop the Schedules screen showing a "next run" that has already gone by, and writes only the
 * rows whose value actually moved.
 */
export async function refreshNextRunTimes(): Promise<number> {
  const rows = await prisma.scheduledJob.findMany({
    where: { isEnabled: true },
    select: { id: true, cron: true, nextRunAt: true },
  });

  const now = new Date();
  let updated = 0;

  for (const row of rows) {
    const next = computeNextRun(row.cron, now);
    const current = row.nextRunAt;
    const unchanged =
      (next === null && current === null) ||
      (next !== null && current !== null && next.getTime() === current.getTime());
    if (unchanged) continue;

    await prisma.scheduledJob.update({ where: { id: row.id }, data: { nextRunAt: next } });
    updated += 1;
  }

  return updated;
}
