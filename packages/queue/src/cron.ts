/**
 * A small, dependency-free cron evaluator.
 *
 * BullMQ owns the real scheduling; this module only exists so the app can *display* the next
 * run of a schedule (`ScheduledJob.nextRunAt`, the Jobs screen) and reject a malformed cron
 * before it reaches Redis. It deliberately does not pull in `cron-parser`: that package is a
 * transitive dependency of BullMQ, not a declared dependency of this one, and importing it
 * directly would break the moment hoisting changes.
 *
 * Supported syntax is standard 5-field cron (`m h dom mon dow`), an optional leading seconds
 * field (6 fields), `*`, `a-b`, `*\/n`, `a-b/n`, comma lists, three-letter month and weekday
 * names, `0`/`7` for Sunday, and the `@hourly`/`@daily`/`@weekly`/`@monthly`/`@yearly` macros.
 *
 * Nothing here throws: `parseCron` returns a result object so callers decide how to surface a
 * bad expression.
 */

export interface CronSchedule {
  seconds: number[];
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** Standard cron: when both day fields are restricted, a match on *either* fires the job. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type ParseCronResult =
  | { ok: true; schedule: CronSchedule }
  | { ok: false; error: string };

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  /** Offset added to a name index to reach the numeric value (months are 1-based). */
  nameOffset?: number;
}

const SECOND_SPEC: FieldSpec = { min: 0, max: 59 };
const MINUTE_SPEC: FieldSpec = { min: 0, max: 59 };
const HOUR_SPEC: FieldSpec = { min: 0, max: 23 };
const DOM_SPEC: FieldSpec = { min: 1, max: 31 };
const MONTH_SPEC: FieldSpec = { min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 };
const DOW_SPEC: FieldSpec = { min: 0, max: 7, names: DAY_NAMES, nameOffset: 0 };

function resolveToken(token: string, spec: FieldSpec): number | null {
  const trimmed = token.trim().toLowerCase();
  if (trimmed === '') return null;
  if (spec.names) {
    const index = spec.names.indexOf(trimmed.slice(0, 3));
    if (index >= 0) return index + (spec.nameOffset ?? 0);
  }
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) return null;
  return value;
}

/** Expands one cron field (`*`, `5`, `1-5`, `*\/2`, `mon-fri`, or a comma list of those). */
function parseField(raw: string, spec: FieldSpec): number[] | null {
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (piece === '') return null;

    const [rangePart, stepPart, ...rest] = piece.split('/');
    if (rest.length > 0 || rangePart === undefined) return null;

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }

    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [lowRaw, highRaw, ...extra] = rangePart.split('-');
      if (extra.length > 0 || lowRaw === undefined || highRaw === undefined) return null;
      const low = resolveToken(lowRaw, spec);
      const high = resolveToken(highRaw, spec);
      if (low === null || high === null) return null;
      start = low;
      end = high;
    } else {
      const single = resolveToken(rangePart, spec);
      if (single === null) return null;
      start = single;
      // `5/10` means "from 5 to the end of the range in steps of 10", as in Vixie cron.
      end = stepPart === undefined ? single : spec.max;
    }

    if (start > end) {
      // Wrapping ranges such as `fri-mon` / `22-2`.
      for (let v = start; v <= spec.max; v += step) values.add(v);
      const consumed = spec.max - start;
      const offset = step === 1 ? 0 : (step - ((consumed + 1) % step)) % step;
      for (let v = spec.min + offset; v <= end; v += step) values.add(v);
    } else {
      for (let v = start; v <= end; v += step) values.add(v);
    }
  }

  if (values.size === 0) return null;
  return [...values].sort((a, b) => a - b);
}

/** Parses a cron expression without throwing. */
export function parseCron(expression: string): ParseCronResult {
  const raw = expression?.trim();
  if (!raw) return { ok: false, error: 'Cron expression is empty' };

  const expanded = MACROS[raw.toLowerCase()] ?? raw;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) {
    return {
      ok: false,
      error: `Expected 5 or 6 cron fields, received ${fields.length}: "${expression}"`,
    };
  }

  const hasSeconds = fields.length === 6;
  const [secondField, minuteField, hourField, domField, monthField, dowField] = hasSeconds
    ? fields
    : ['0', ...fields];

  const seconds = parseField(secondField ?? '0', SECOND_SPEC);
  const minutes = parseField(minuteField ?? '', MINUTE_SPEC);
  const hours = parseField(hourField ?? '', HOUR_SPEC);
  const daysOfMonth = parseField(domField ?? '', DOM_SPEC);
  const months = parseField(monthField ?? '', MONTH_SPEC);
  const daysOfWeekRaw = parseField(dowField ?? '', DOW_SPEC);

  const failed = [
    seconds === null ? 'second' : null,
    minutes === null ? 'minute' : null,
    hours === null ? 'hour' : null,
    daysOfMonth === null ? 'day-of-month' : null,
    months === null ? 'month' : null,
    daysOfWeekRaw === null ? 'day-of-week' : null,
  ].filter((f): f is string => f !== null);

  if (
    failed.length > 0 ||
    seconds === null ||
    minutes === null ||
    hours === null ||
    daysOfMonth === null ||
    months === null ||
    daysOfWeekRaw === null
  ) {
    return { ok: false, error: `Invalid ${failed.join(', ')} field in "${expression}"` };
  }

  // Cron accepts both 0 and 7 for Sunday; normalise to 0 so weekday lookups are direct.
  const daysOfWeek = [...new Set(daysOfWeekRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);

  return {
    ok: true,
    schedule: {
      seconds,
      minutes,
      hours,
      daysOfMonth,
      months,
      daysOfWeek,
      domRestricted: (domField ?? '').trim() !== '*',
      dowRestricted: (dowField ?? '').trim() !== '*',
    },
  };
}

export function isValidCron(expression: string): boolean {
  return parseCron(expression).ok;
}

// ─────────────────────────────────────────────────────────────
// Timezone helpers
// ─────────────────────────────────────────────────────────────

interface WallClock {
  year: number;
  /** 1-12. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
    return formatter;
  } catch {
    // Unknown IANA zone — callers fall back to UTC rather than failing a schedule sync.
    return null;
  }
}

/** Wall-clock fields of an instant in the given zone. */
function zoneWallClock(ts: number, formatter: Intl.DateTimeFormat | null): WallClock {
  const date = new Date(ts);
  if (!formatter) {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
    };
  }
  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };
  const hour = get('hour');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some engines still report midnight as "24" under h23; normalise so hour sets match.
    hour: hour === 24 ? 0 : hour,
    minute: get('minute'),
  };
}

/** Milliseconds the zone is ahead of UTC at the given instant. */
function zoneOffsetMs(ts: number, formatter: Intl.DateTimeFormat | null): number {
  if (!formatter) return 0;
  const wc = zoneWallClock(ts, formatter);
  const seconds = new Date(ts).getUTCSeconds();
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, seconds, 0);
  // Round to the minute: formatToParts drops sub-second precision, which would otherwise
  // leak into the offset.
  return asUtc - (Math.floor(ts / 1000) * 1000);
}

/** The instant at which the given wall clock (plus `second`) occurs in the zone. */
function instantOf(wc: WallClock, second: number, formatter: Intl.DateTimeFormat | null): number {
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, second, 0);
  if (!formatter) return asUtc;
  // Two passes: the first guess uses the offset at the *UTC* reading of the wall clock, the
  // second corrects it using the offset actually in force at that instant (DST boundaries).
  let ts = asUtc - zoneOffsetMs(asUtc, formatter);
  ts = asUtc - zoneOffsetMs(ts, formatter);
  return ts;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Day of week (0 = Sunday) for a wall-clock date, computed as pure calendar arithmetic. */
function weekdayOf(wc: WallClock): number {
  return new Date(Date.UTC(wc.year, wc.month - 1, wc.day)).getUTCDay();
}

function startOfNextMonth(wc: WallClock): WallClock {
  const month = wc.month === 12 ? 1 : wc.month + 1;
  const year = wc.month === 12 ? wc.year + 1 : wc.year;
  return { year, month, day: 1, hour: 0, minute: 0 };
}

function startOfNextDay(wc: WallClock): WallClock {
  if (wc.day >= daysInMonth(wc.year, wc.month)) return startOfNextMonth(wc);
  return { ...wc, day: wc.day + 1, hour: 0, minute: 0 };
}

function startOfNextHour(wc: WallClock): WallClock {
  if (wc.hour >= 23) return startOfNextDay(wc);
  return { ...wc, hour: wc.hour + 1, minute: 0 };
}

function nextMinute(wc: WallClock): WallClock {
  if (wc.minute >= 59) return startOfNextHour(wc);
  return { ...wc, minute: wc.minute + 1 };
}

function dayMatches(wc: WallClock, schedule: CronSchedule): boolean {
  const domHit = schedule.daysOfMonth.includes(wc.day);
  const dowHit = schedule.daysOfWeek.includes(weekdayOf(wc));
  if (schedule.domRestricted && schedule.dowRestricted) return domHit || dowHit;
  if (schedule.domRestricted) return domHit;
  if (schedule.dowRestricted) return dowHit;
  return true;
}

export interface NextRunOptions {
  /** IANA zone the cron fields are expressed in. Defaults to UTC. */
  timeZone?: string;
  /** How far ahead to search before giving up. Guards against `0 0 30 2 *` and friends. */
  horizonDays?: number;
}

/** Calendar iterations before we declare the expression unsatisfiable. */
const MAX_STEPS = 200_000;

/**
 * The first instant strictly after `from` at which the expression fires, or `null` when the
 * expression is invalid or has no occurrence inside the search horizon.
 */
export function computeNextRun(
  expression: string,
  from: Date = new Date(),
  options: NextRunOptions = {},
): Date | null {
  const parsed = parseCron(expression);
  if (!parsed.ok) return null;

  const schedule = parsed.schedule;
  const timeZone = options.timeZone ?? 'UTC';
  const formatter = timeZone === 'UTC' ? null : formatterFor(timeZone);
  const fromTs = from.getTime();
  if (!Number.isFinite(fromTs)) return null;

  const horizonMs = (options.horizonDays ?? 366 * 5) * 86_400_000;
  const deadline = fromTs + horizonMs;

  let wc = zoneWallClock(fromTs, formatter);

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (instantOf(wc, 0, formatter) > deadline) return null;

    if (!schedule.months.includes(wc.month)) {
      wc = startOfNextMonth(wc);
      continue;
    }
    if (!dayMatches(wc, schedule)) {
      wc = startOfNextDay(wc);
      continue;
    }
    if (!schedule.hours.includes(wc.hour)) {
      wc = startOfNextHour(wc);
      continue;
    }
    if (!schedule.minutes.includes(wc.minute)) {
      wc = nextMinute(wc);
      continue;
    }

    for (const second of schedule.seconds) {
      const ts = instantOf(wc, second, formatter);
      if (ts > fromTs && ts <= deadline) return new Date(ts);
    }
    wc = nextMinute(wc);
  }

  return null;
}

/** Upper bound on a preview, so a caller's bad `count` cannot spin the calendar walk forever. */
const MAX_PREVIEW_RUNS = 500;

/**
 * Convenience for previews: the next `count` runs of an expression. `count` is clamped to a
 * sane preview size — each run is a fresh calendar walk, so an unbounded count is a hang.
 */
export function computeNextRuns(
  expression: string,
  count: number,
  from: Date = new Date(),
  options: NextRunOptions = {},
): Date[] {
  const wanted = Number.isFinite(count) ? Math.min(Math.floor(count), MAX_PREVIEW_RUNS) : 0;
  const runs: Date[] = [];
  let cursor = from;
  for (let i = 0; i < wanted; i += 1) {
    const next = computeNextRun(expression, cursor, options);
    if (!next) break;
    runs.push(next);
    cursor = next;
  }
  return runs;
}
