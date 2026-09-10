/**
 * UTC month arithmetic for the content calendar.
 *
 * Every date the pipeline stores is a UTC instant and the read model keys entries by
 * `YYYY-MM-DD` in UTC, so the grid is built in UTC too. Doing it in local time would slide
 * entries a day either way for anyone west of Greenwich and — worse — render differently on the
 * server and in the browser, which React would flag as a hydration mismatch.
 *
 * Deliberately dependency-free: `@seo/shared` cannot be imported from a client component.
 */

export interface MonthRef {
  year: number;
  /** 0-indexed, matching `Date.prototype.getUTCMonth`. */
  month: number;
}

const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/** `2026-09` → `{ year: 2026, month: 8 }`. Anything unparseable falls back to `reference`. */
export function parseMonthKey(value: string | undefined, reference: Date): MonthRef {
  const match = value === undefined ? null : MONTH_KEY.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    if (Number.isFinite(year) && year >= 1970 && year <= 9999 && month >= 0 && month <= 11) {
      return { year, month };
    }
  }
  return { year: reference.getUTCFullYear(), month: reference.getUTCMonth() };
}

export function monthKey({ year, month }: MonthRef): string {
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

export function monthStart({ year, month }: MonthRef): Date {
  return new Date(Date.UTC(year, month, 1));
}

/** Last instant of the month, so a `lte` filter includes everything on the final day. */
export function monthEnd({ year, month }: MonthRef): Date {
  return new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
}

export function shiftMonth({ year, month }: MonthRef, delta: number): MonthRef {
  const shifted = new Date(Date.UTC(year, month + delta, 1));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() };
}

export function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const MONTH_LABEL = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const SHORT_DAY_LABEL = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export function monthLabel(ref: MonthRef): string {
  return MONTH_LABEL.format(monthStart(ref));
}

/** `2026-09-14` → `Monday, 14 September`. */
export function dayLabel(key: string): string {
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? key : DAY_LABEL.format(parsed);
}

/** `2026-09-14` → `Mon, 14 Sep`. */
export function shortDayLabel(key: string): string {
  const parsed = new Date(`${key}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? key : SHORT_DAY_LABEL.format(parsed);
}

/** Weeks start on Monday, matching the `en-GB` formatting used across the product. */
export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export interface GridDay {
  key: string;
  dayOfMonth: number;
  /** False for the leading and trailing days borrowed from the adjacent months. */
  inMonth: boolean;
}

/** Six weeks at most, always whole weeks, so the grid never reflows between months. */
export function buildMonthGrid(ref: MonthRef): GridDay[][] {
  const first = monthStart(ref);
  // `getUTCDay()` is 0 for Sunday; shift so Monday is 0.
  const leading = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(ref.year, ref.month, 1 - leading));

  const weeks: GridDay[][] = [];
  const cursor = new Date(start.getTime());
  while (weeks.length < 6) {
    const week: GridDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      week.push({
        key: dateKey(cursor),
        dayOfMonth: cursor.getUTCDate(),
        inMonth: cursor.getUTCMonth() === ref.month && cursor.getUTCFullYear() === ref.year,
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    weeks.push(week);
    // Stop as soon as the month is fully covered rather than always padding to six rows.
    if (cursor.getUTCMonth() !== ref.month || cursor.getUTCFullYear() !== ref.year) break;
  }
  return weeks;
}
