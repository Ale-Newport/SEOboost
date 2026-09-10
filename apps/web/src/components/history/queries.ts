import 'server-only';
import { type Prisma, prisma, readJson } from '@seo/db';
import { ForbiddenError, NotFoundError } from '@seo/shared';

/**
 * Read model for the per-site History screen.
 *
 * `ChangeLog` is the immutable audit trail: one row per thing the platform (or a person) did to
 * the site. Three rules shape this file:
 *
 *  - **Nothing is inferred.** A row's before/after snapshot is rendered exactly as it was
 *    recorded. An entry with no snapshot says so; it does not get an empty diff that reads as
 *    "nothing changed".
 *  - **Measured outcomes come from the experiment, not from the log.** Where an action has an
 *    `Experiment`, its evaluated delta and significance are the measurement. The log's own
 *    `resultMetrics` is the fallback for rows recorded without one.
 *  - **Facets are counted over the whole site**, not the current page, so the filter always
 *    offers every actor and change type that exists rather than only what survived the filter.
 */

/** Longest snapshot value carried to the client. Whole page bodies live in `ChangeLog`. */
const MAX_FIELD_CHARS = 4000;

export interface HistoryDiffField {
  field: string;
  before: string | null;
  after: string | null;
  /** The stored value was longer than the render budget and is shown cut short. */
  truncated: boolean;
}

export interface HistoryOutcomeMetric {
  label: string;
  value: string;
}

export interface HistoryOutcome {
  /** Where the numbers came from, so the screen can say which. */
  source: 'experiment' | 'changelog';
  metric: string | null;
  deltaPct: number | null;
  /** Experiment outcome enum (`IMPROVED`, `NO_CHANGE`…), or null when not evaluated. */
  status: string | null;
  significance: number | null;
  interpretation: string | null;
  measuredAt: Date | null;
  /** Anything else the row recorded, rendered as plain label/value pairs. */
  extra: HistoryOutcomeMetric[];
}

export interface HistoryEntry {
  id: string;
  createdAt: Date;
  /** Raw actor as recorded: `user`, `agent`, `system`, or whatever a caller wrote. */
  actor: string;
  /** Who to show: the person's name, the agent's name, or the raw actor. */
  actorLabel: string;
  agent: string | null;
  changeType: string;
  targetUrl: string | null;
  summary: string;
  reason: string | null;
  approved: boolean;
  rollbackable: boolean;
  rolledBackAt: Date | null;
  actionId: string | null;
  /** Fields that actually differ between the recorded before and after states. */
  diff: HistoryDiffField[];
  /** True when a before/after snapshot was recorded at all. */
  hasSnapshot: boolean;
  outcome: HistoryOutcome | null;
}

export interface HistoryFacet {
  value: string;
  count: number;
}

export interface HistoryFilterInput {
  actors?: string[];
  changeTypes?: string[];
  /** `yyyy-MM-dd`, inclusive. */
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface HistoryData {
  website: { id: string; name: string; domain: string };
  entries: HistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Rows for this site regardless of the current filter — the denominator for "0 of N". */
  totalUnfiltered: number;
  actorFacets: HistoryFacet[];
  changeTypeFacets: HistoryFacet[];
  /** Timestamp of the very first recorded change, or null when nothing has happened yet. */
  firstChangeAt: Date | null;
}

/** `yyyy-MM-dd` → the first instant of that day, or null when the string is not a date. */
function startOfDay(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `yyyy-MM-dd` → the last instant of that day, so `to` is inclusive. */
function endOfDay(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A snapshot value as text.
 *
 * Strings are used as-is so the word diff sees real prose; everything else is JSON so a number,
 * a boolean or a nested object is still comparable rather than rendered as `[object Object]`.
 */
function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function clamp(value: string | null): { text: string | null; truncated: boolean } {
  if (value === null) return { text: null, truncated: false };
  if (value.length <= MAX_FIELD_CHARS) return { text: value, truncated: false };
  return { text: `${value.slice(0, MAX_FIELD_CHARS)}…`, truncated: true };
}

/** Keys that describe the record rather than the content, so they are not shown as edits. */
const IGNORED_SNAPSHOT_KEYS = new Set(['id', 'externalId', 'updatedAt', 'createdAt', 'revision']);

function buildDiff(before: unknown, after: unknown): { diff: HistoryDiffField[]; hasSnapshot: boolean } {
  const beforeObject = readJson<Record<string, unknown>>(before, {});
  const afterObject = readJson<Record<string, unknown>>(after, {});
  const beforeKeys = Object.keys(beforeObject);
  const afterKeys = Object.keys(afterObject);
  const hasSnapshot = beforeKeys.length > 0 || afterKeys.length > 0;
  if (!hasSnapshot) return { diff: [], hasSnapshot: false };

  const diff: HistoryDiffField[] = [];
  for (const key of new Set([...beforeKeys, ...afterKeys])) {
    if (IGNORED_SNAPSHOT_KEYS.has(key)) continue;
    const beforeText = clamp(toText(beforeObject[key]));
    const afterText = clamp(toText(afterObject[key]));
    if (beforeText.text === afterText.text) continue;
    diff.push({
      field: key,
      before: beforeText.text,
      after: afterText.text,
      truncated: beforeText.truncated || afterText.truncated,
    });
  }

  // Stable order: the fields a reader scans for first, then the rest alphabetically.
  const PRIORITY = ['title', 'metaTitle', 'metaDescription', 'slug', 'canonicalUrl', 'excerpt'];
  diff.sort((a, b) => {
    const rankA = PRIORITY.indexOf(a.field);
    const rankB = PRIORITY.indexOf(b.field);
    if (rankA !== rankB) return (rankA < 0 ? PRIORITY.length : rankA) - (rankB < 0 ? PRIORITY.length : rankB);
    return a.field.localeCompare(b.field);
  });

  return { diff, hasSnapshot };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** `deltaPct` → `+12.4%`, `0.031` → `0.031`; anything already a string is left alone. */
function describeMetricValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return null;
}

const KNOWN_METRIC_KEYS = new Set(['deltaPct', 'outcome', 'pValue', 'significance', 'metric', 'interpretation']);

/** `pValue` → `P value`; used for whatever extra keys a caller recorded. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The measured result recorded on the log row itself, when there is no experiment. */
function outcomeFromChangeLog(value: unknown): HistoryOutcome | null {
  const record = readJson<Record<string, unknown>>(value, {});
  const keys = Object.keys(record);
  if (keys.length === 0) return null;

  const extra: HistoryOutcomeMetric[] = [];
  for (const key of keys) {
    if (KNOWN_METRIC_KEYS.has(key)) continue;
    const text = describeMetricValue(record[key]);
    if (text !== null) extra.push({ label: humanizeKey(key), value: text });
  }

  const deltaPct = numberOrNull(record.deltaPct);
  const status = stringOrNull(record.outcome);
  const significance = numberOrNull(record.pValue) ?? numberOrNull(record.significance);

  if (deltaPct === null && status === null && significance === null && extra.length === 0) return null;

  return {
    source: 'changelog',
    metric: stringOrNull(record.metric),
    deltaPct,
    status,
    significance,
    interpretation: stringOrNull(record.interpretation),
    measuredAt: null,
    extra,
  };
}

export async function getHistory(
  userId: string,
  websiteId: string,
  filters: HistoryFilterInput,
): Promise<HistoryData> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, userId: true, name: true, domain: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const where: Prisma.ChangeLogWhereInput = { websiteId: website.id };
  if (filters.actors && filters.actors.length > 0) where.actor = { in: filters.actors };
  if (filters.changeTypes && filters.changeTypes.length > 0) where.changeType = { in: filters.changeTypes };

  const from = startOfDay(filters.from);
  const to = endOfDay(filters.to);
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const [rows, total, totalUnfiltered, actorGroups, typeGroups, earliest] = await Promise.all([
    prisma.changeLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      select: {
        id: true,
        createdAt: true,
        actor: true,
        agent: true,
        changeType: true,
        targetUrl: true,
        summary: true,
        reason: true,
        approved: true,
        rollbackable: true,
        rolledBackAt: true,
        actionId: true,
        beforeState: true,
        afterState: true,
        resultMetrics: true,
        user: { select: { name: true, email: true } },
      },
    }),
    prisma.changeLog.count({ where }),
    prisma.changeLog.count({ where: { websiteId: website.id } }),
    prisma.changeLog.groupBy({
      by: ['actor'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.changeLog.groupBy({
      by: ['changeType'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    prisma.changeLog.findFirst({
      where: { websiteId: website.id },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  // One extra query rather than a join per row: the experiment holds the *measured* result, and
  // only rows tied to an action can have one.
  const actionIds = rows.map((row) => row.actionId).filter((id): id is string => id !== null);
  const experiments =
    actionIds.length === 0
      ? []
      : await prisma.experiment.findMany({
          where: { websiteId: website.id, actionId: { in: actionIds } },
          select: {
            actionId: true,
            metric: true,
            outcome: true,
            deltaPct: true,
            significance: true,
            interpretation: true,
            evaluatedAt: true,
          },
        });
  const experimentByAction = new Map(
    experiments.flatMap((experiment) => (experiment.actionId ? [[experiment.actionId, experiment]] : [])),
  );

  const entries: HistoryEntry[] = rows.map((row) => {
    const { diff, hasSnapshot } = buildDiff(row.beforeState, row.afterState);
    const experiment = row.actionId ? experimentByAction.get(row.actionId) : undefined;

    // An experiment that has not been evaluated yet has no measurement to show; fall through to
    // whatever the log recorded rather than rendering an empty "outcome" block.
    const outcome: HistoryOutcome | null =
      experiment && experiment.evaluatedAt !== null
        ? {
            source: 'experiment',
            metric: experiment.metric,
            deltaPct: experiment.deltaPct,
            status: experiment.outcome,
            significance: experiment.significance,
            interpretation: experiment.interpretation,
            measuredAt: experiment.evaluatedAt,
            extra: [],
          }
        : outcomeFromChangeLog(row.resultMetrics);

    const actorLabel =
      row.actor === 'agent'
        ? (row.agent ?? 'Agent')
        : row.actor === 'user'
          ? (row.user?.name ?? row.user?.email ?? 'You')
          : row.actor === 'system'
            ? 'System'
            : row.actor;

    return {
      id: row.id,
      createdAt: row.createdAt,
      actor: row.actor,
      actorLabel,
      agent: row.agent,
      changeType: row.changeType,
      targetUrl: row.targetUrl,
      summary: row.summary,
      reason: row.reason,
      approved: row.approved,
      rollbackable: row.rollbackable,
      rolledBackAt: row.rolledBackAt,
      actionId: row.actionId,
      diff,
      hasSnapshot,
      outcome,
    };
  });

  return {
    website: { id: website.id, name: website.name, domain: website.domain },
    entries,
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalUnfiltered,
    actorFacets: actorGroups
      .map((group) => ({ value: group.actor, count: group._count._all }))
      .sort((a, b) => b.count - a.count),
    changeTypeFacets: typeGroups
      .map((group) => ({ value: group.changeType, count: group._count._all }))
      .sort((a, b) => b.count - a.count),
    firstChangeAt: earliest?.createdAt ?? null,
  };
}
