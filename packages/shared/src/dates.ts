export const DAY_MS = 86_400_000;

/** Midnight UTC for a date — every date column in the schema is stored this way. */
export function toUtcDate(input: Date | string): Date {
  const d = typeof input === 'string' ? new Date(input) : input;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function formatDateKey(input: Date | string): string {
  return toUtcDate(input).toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((toUtcDate(b).getTime() - toUtcDate(a).getTime()) / DAY_MS);
}

export interface DateRange {
  start: Date;
  end: Date;
}

/** The last `days` complete days ending `lagDays` before today (GSC data lags ~2-3 days). */
export function lastNDays(days: number, lagDays = 0, now = new Date()): DateRange {
  const end = addDays(toUtcDate(now), -lagDays);
  return { start: addDays(end, -(days - 1)), end };
}

/** The equal-length window immediately before `range`, for period-over-period comparisons. */
export function previousPeriod(range: DateRange): DateRange {
  const length = daysBetween(range.start, range.end) + 1;
  const end = addDays(range.start, -1);
  return { start: addDays(end, -(length - 1)), end };
}

export function eachDay(range: DateRange): Date[] {
  const out: Date[] = [];
  for (let d = toUtcDate(range.start); d <= toUtcDate(range.end); d = addDays(d, 1)) out.push(d);
  return out;
}

export function isWithin(date: Date, range: DateRange): boolean {
  const t = toUtcDate(date).getTime();
  return t >= toUtcDate(range.start).getTime() && t <= toUtcDate(range.end).getTime();
}

export function startOfMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function startOfWeek(date = new Date()): Date {
  const d = toUtcDate(date);
  const day = d.getUTCDay();
  return addDays(d, day === 0 ? -6 : 1 - day); // ISO weeks start Monday
}

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
