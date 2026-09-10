/**
 * Plain-English rendering of the cron expressions this product actually uses.
 *
 * Deliberately narrow: it recognises the shapes the schedule presets produce and returns `null`
 * for anything else, so the UI falls back to showing the raw expression instead of describing it
 * wrongly. A confident but incorrect "every Monday" is worse than five cron fields.
 *
 * BullMQ and the scheduler both interpret these in UTC, so every description says so.
 */

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const MACROS: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

function isNumber(value: string): boolean {
  return /^\d+$/.test(value);
}

function clock(hour: string, minute: string): string {
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')} UTC`;
}

function ordinal(day: number): string {
  const suffix =
    day % 100 >= 11 && day % 100 <= 13
      ? 'th'
      : day % 10 === 1
        ? 'st'
        : day % 10 === 2
          ? 'nd'
          : day % 10 === 3
            ? 'rd'
            : 'th';
  return `${day}${suffix}`;
}

/** A sentence for the expression, or `null` when the shape is not one we can describe honestly. */
export function describeCron(expression: string): string | null {
  const raw = expression.trim();
  if (!raw) return null;

  const expanded = MACROS[raw.toLowerCase()] ?? raw;
  const fields = expanded.split(/\s+/);
  // Only 5-field crons are described; a 6-field (seconds) expression falls back to the raw text.
  if (fields.length !== 5) return null;

  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  if (month !== '*') return null;

  // Every N minutes / every minute.
  if (dom === '*' && dow === '*' && hour === '*') {
    if (minute === '*') return 'Every minute (UTC)';
    const step = /^\*\/(\d+)$/.exec(minute);
    if (step?.[1]) return `Every ${step[1]} minutes (UTC)`;
    if (isNumber(minute)) return `Every hour at :${minute.padStart(2, '0')} (UTC)`;
    return null;
  }

  // Every N hours at a fixed minute.
  if (dom === '*' && dow === '*' && isNumber(minute)) {
    const step = /^\*\/(\d+)$/.exec(hour);
    if (step?.[1]) return `Every ${step[1]} hours, at :${minute.padStart(2, '0')} (UTC)`;
  }

  if (!isNumber(minute) || !isNumber(hour)) return null;
  const at = clock(hour, minute);

  // Daily.
  if (dom === '*' && dow === '*') return `Every day at ${at}`;

  // Weekly on one or more weekdays.
  if (dom === '*' && dow !== '*') {
    const days = dow.split(',').map((part) => part.trim());
    if (!days.every(isNumber)) return null;
    const names = days
      .map((part) => DAY_NAMES[Number(part) === 7 ? 0 : Number(part)])
      .filter((name): name is (typeof DAY_NAMES)[number] => name !== undefined);
    if (names.length !== days.length) return null;
    if (names.length === 1) return `Every ${names[0]} at ${at}`;
    return `Every ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} at ${at}`;
  }

  // Monthly on a day of the month.
  if (dow === '*' && isNumber(dom)) {
    return `On the ${ordinal(Number(dom))} of each month at ${at}`;
  }

  return null;
}

export interface CronPreset {
  value: string;
  label: string;
}

/** The choices offered in the schedule editor; a custom expression is always allowed too. */
export const CRON_PRESETS: readonly CronPreset[] = [
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 3 * * *', label: 'Daily at 03:00 UTC' },
  { value: '0 5 * * *', label: 'Daily at 05:00 UTC' },
  { value: '0 3 * * 1', label: 'Weekly, Monday 03:00 UTC' },
  { value: '0 8 * * 1', label: 'Weekly, Monday 08:00 UTC' },
  { value: '0 4 1 * *', label: 'Monthly, 1st at 04:00 UTC' },
];
