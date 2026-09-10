'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isSameDay,
  isSameMonth,
  isValid,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
} from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useTableParams } from './use-table-params';

/**
 * The range lives in the URL in one of two shapes:
 *
 *   `days=28`                       rolling window, re-evaluated on every visit
 *   `from=2026-08-01&to=2026-08-31` fixed window, stable when shared
 *
 * plus `compare=1` for period-over-period. Dates are calendar strings, never instants: the API
 * turns `yyyy-MM-dd` into UTC midnight (`toUtcDate` in @seo/shared), so no timezone shifts the
 * day a user picked.
 */
export const DATE_RANGE_PARAM_KEYS = {
  from: 'from',
  to: 'to',
  days: 'days',
  compare: 'compare',
} as const;

export const DEFAULT_RANGE_DAYS = 28;

/**
 * Upper bound on a window read from the URL. `?days=999999` is one keystroke away and would turn
 * into an unbounded scan on every date-filtered query, so the param is clamped rather than trusted.
 * Three years comfortably covers the longest preset (12 months) and any year-over-year comparison.
 */
export const MAX_RANGE_DAYS = 1095;

export interface DateRangePreset {
  id: string;
  label: string;
  /** Rolling window length. Presets without `days` resolve to a fixed from/to pair. */
  days?: number;
}

export const DATE_RANGE_PRESETS: readonly DateRangePreset[] = [
  { id: '7', label: 'Last 7 days', days: 7 },
  { id: '28', label: 'Last 28 days', days: 28 },
  { id: '90', label: 'Last 90 days', days: 90 },
  { id: '180', label: 'Last 180 days', days: 180 },
  { id: '365', label: 'Last 12 months', days: 365 },
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
];

export interface ResolvedDateRange {
  /** Inclusive start of the window. */
  start: Date;
  /** Inclusive end of the window. */
  end: Date;
  /** `yyyy-MM-dd`, ready for an API query string. */
  startKey: string;
  endKey: string;
  days: number;
}

export interface DateRangeValue extends ResolvedDateRange {
  /** True when the window is a rolling `days=N` rather than a pinned from/to. */
  rolling: boolean;
  compare: boolean;
  /** The equal-length window immediately before this one, when compare is on. */
  previous: ResolvedDateRange | null;
  label: string;
}

const DATE_KEY_FORMAT = 'yyyy-MM-dd';

function toKey(date: Date): string {
  return format(date, DATE_KEY_FORMAT);
}

/** Parses `yyyy-MM-dd`; anything else (including a full ISO instant) is rejected as ambiguous. */
function parseKey(raw: string | null): Date | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = parseISO(raw);
  return isValid(parsed) ? startOfDay(parsed) : null;
}

function describeRange(start: Date, end: Date): string {
  const sameYear = start.getFullYear() === end.getFullYear();
  const left = format(start, sameYear ? 'MMM d' : 'MMM d, yyyy');
  const right = format(end, 'MMM d, yyyy');
  return `${left} – ${right}`;
}

function buildRange(start: Date, end: Date): ResolvedDateRange {
  return {
    start,
    end,
    startKey: toKey(start),
    endKey: toKey(end),
    days: differenceInCalendarDays(end, start) + 1,
  };
}

/** The equal-length window ending the day before `range` starts. */
export function previousRange(range: ResolvedDateRange): ResolvedDateRange {
  const end = subDays(range.start, 1);
  return buildRange(subDays(end, range.days - 1), end);
}

function resolvePresetRange(preset: DateRangePreset, today: Date): ResolvedDateRange {
  if (preset.days !== undefined) return buildRange(subDays(today, preset.days - 1), today);
  if (preset.id === 'this-month') return buildRange(startOfMonth(today), today);
  const lastMonth = subMonths(today, 1);
  return buildRange(startOfMonth(lastMonth), endOfMonth(lastMonth));
}

/**
 * Reads the active range out of the URL. Every screen that queries by date should call this
 * rather than re-deriving dates, so the picker and the data can never disagree.
 */
export function useDateRange(defaultDays: number = DEFAULT_RANGE_DAYS): DateRangeValue {
  const { getParam } = useTableParams();

  const fromParam = getParam(DATE_RANGE_PARAM_KEYS.from);
  const toParam = getParam(DATE_RANGE_PARAM_KEYS.to);
  const daysParam = getParam(DATE_RANGE_PARAM_KEYS.days);
  const compare = getParam(DATE_RANGE_PARAM_KEYS.compare) === '1';

  return useMemo(() => {
    const today = startOfDay(new Date());

    const from = parseKey(fromParam);
    const to = parseKey(toParam);
    // A lone endpoint is still an explicit choice — anchoring the other end beats silently
    // discarding the param and showing a window the user did not ask for.
    const start = from ?? (to === null ? null : subDays(to, defaultDays - 1));
    const end = to ?? (from === null ? null : (isAfter(from, today) ? from : today));

    let base: ResolvedDateRange;
    let rolling: boolean;

    if (start !== null && end !== null && !isAfter(start, end)) {
      // Clamp the span for the same reason `days` is clamped below.
      const clampedStart =
        differenceInCalendarDays(end, start) + 1 > MAX_RANGE_DAYS ? subDays(end, MAX_RANGE_DAYS - 1) : start;
      base = buildRange(clampedStart, end);
      rolling = false;
    } else {
      const parsedDays = Number(daysParam);
      const days =
        Number.isFinite(parsedDays) && parsedDays >= 1
          ? Math.min(Math.floor(parsedDays), MAX_RANGE_DAYS)
          : defaultDays;
      base = buildRange(subDays(today, days - 1), today);
      rolling = true;
    }

    return {
      ...base,
      rolling,
      compare,
      previous: compare ? previousRange(base) : null,
      label: rolling ? `Last ${base.days} days` : describeRange(base.start, base.end),
    };
  }, [fromParam, toParam, daysParam, compare, defaultDays]);
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

interface MonthGridProps {
  month: Date;
  start: Date | null;
  end: Date | null;
  hovered: Date | null;
  today: Date;
  maxDate: Date;
  onSelect: (date: Date) => void;
  onHover: (date: Date | null) => void;
}

/** One month of day buttons. Weeks start Monday, matching how search data is reported. */
function MonthGrid({
  month,
  start,
  end,
  hovered,
  today,
  maxDate,
  onSelect,
  onHover,
}: MonthGridProps): React.JSX.Element {
  const weeks = useMemo(() => {
    const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
    const rows: Date[][] = [];
    let cursor = gridStart;
    while (!isAfter(cursor, gridEnd)) {
      const row: Date[] = [];
      for (let i = 0; i < 7; i++) {
        row.push(cursor);
        cursor = addDays(cursor, 1);
      }
      rows.push(row);
    }
    return rows;
  }, [month]);

  // While picking the second date, preview the range under the cursor.
  const previewEnd = end ?? (start && hovered && isAfter(hovered, start) ? hovered : null);

  return (
    <table className="w-full border-collapse" aria-label={format(month, 'MMMM yyyy')}>
      <thead>
        <tr>
          {WEEKDAY_LABELS.map((day) => (
            <th
              key={day}
              scope="col"
              abbr={day}
              className="pb-1 text-center text-2xs font-medium text-muted-foreground"
            >
              {day}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week) => (
          <tr key={week[0].toISOString()}>
            {week.map((day) => {
              const outside = !isSameMonth(day, month);
              const disabled = isAfter(day, maxDate);
              const isStart = start !== null && isSameDay(day, start);
              const isEnd = previewEnd !== null && isSameDay(day, previewEnd);
              const inRange =
                start !== null &&
                previewEnd !== null &&
                !isBefore(day, start) &&
                !isAfter(day, previewEnd);

              return (
                <td key={day.toISOString()} className="p-0">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onSelect(day)}
                    onMouseEnter={() => onHover(day)}
                    onMouseLeave={() => onHover(null)}
                    aria-label={format(day, 'EEEE d MMMM yyyy')}
                    aria-current={isSameDay(day, today) ? 'date' : undefined}
                    aria-pressed={isStart || isEnd}
                    className={cn(
                      'tabular relative flex size-8 items-center justify-center rounded-md text-xs transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      'disabled:cursor-not-allowed disabled:opacity-30',
                      outside ? 'text-muted-foreground' : 'text-foreground',
                      inRange && !isStart && !isEnd && 'rounded-none bg-primary/10',
                      (isStart || isEnd) && 'bg-primary font-medium text-primary-foreground',
                      !inRange && !isStart && !isEnd && !disabled && 'hover:bg-accent',
                      isSameDay(day, today) && !isStart && !isEnd && 'ring-1 ring-inset ring-border',
                    )}
                  >
                    {format(day, 'd')}
                  </button>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

export interface DateRangePickerProps {
  presets?: readonly DateRangePreset[];
  /** Hide the period-over-period toggle on screens that cannot compare. */
  allowCompare?: boolean;
  /** Latest selectable day. Defaults to today — future data does not exist. */
  maxDate?: Date;
  defaultDays?: number;
  className?: string;
  align?: 'start' | 'center' | 'end';
}

export function DateRangePicker({
  presets = DATE_RANGE_PRESETS,
  allowCompare = true,
  maxDate,
  defaultDays = DEFAULT_RANGE_DAYS,
  className,
  align = 'end',
}: DateRangePickerProps): React.JSX.Element {
  // `setFilters`, not `setParams`: a new window is a different result set, so page 7 of the old one
  // is meaningless (and usually past the end).
  const { setFilters } = useTableParams();
  const range = useDateRange(defaultDays);

  // Pinned at mount: a stable "today" keeps the preset comparison memo from recomputing on every
  // render, and the authoritative window is resolved server-side from the URL params anyway.
  const today = useMemo(() => startOfDay(new Date()), []);
  const limit = maxDate ?? today;

  const [open, setOpen] = useState(false);
  const [customStart, setCustomStart] = useState<Date | null>(null);
  const [customEnd, setCustomEnd] = useState<Date | null>(null);
  const [hovered, setHovered] = useState<Date | null>(null);
  const [viewMonth, setViewMonth] = useState<Date>(() => startOfMonth(range.end));
  // `addMonths` returns a fresh Date every render, which would defeat `MonthGrid`'s week memo.
  const nextViewMonth = useMemo(() => addMonths(viewMonth, 1), [viewMonth]);

  const activePresetId = useMemo(() => {
    if (!range.rolling) {
      const match = presets.find((preset) => {
        if (preset.days !== undefined) return false;
        const resolved = resolvePresetRange(preset, today);
        return resolved.startKey === range.startKey && resolved.endKey === range.endKey;
      });
      return match?.id ?? 'custom';
    }
    return presets.find((preset) => preset.days === range.days)?.id ?? 'custom';
    // `today` changes identity every render but only its calendar day matters.
  }, [presets, range.rolling, range.days, range.startKey, range.endKey, today]);

  const applyPreset = useCallback(
    (preset: DateRangePreset) => {
      if (preset.days !== undefined) {
        setFilters({
          [DATE_RANGE_PARAM_KEYS.days]: preset.days === defaultDays ? null : preset.days,
          [DATE_RANGE_PARAM_KEYS.from]: null,
          [DATE_RANGE_PARAM_KEYS.to]: null,
        });
      } else {
        const resolved = resolvePresetRange(preset, today);
        setFilters({
          [DATE_RANGE_PARAM_KEYS.days]: null,
          [DATE_RANGE_PARAM_KEYS.from]: resolved.startKey,
          [DATE_RANGE_PARAM_KEYS.to]: resolved.endKey,
        });
      }
      setCustomStart(null);
      setCustomEnd(null);
      setOpen(false);
    },
    [defaultDays, setFilters, today],
  );

  /**
   * Click one: start a new range. Click two: close it. A click before the start, or on an already
   * complete range (the popover opens pre-seeded with the current one), starts over.
   *
   * Both pieces of state are set from the handler rather than from inside a `setState` updater —
   * updaters must be pure, and React invokes them twice in development StrictMode.
   */
  const handleDaySelect = useCallback(
    (day: Date) => {
      if (customStart === null || customEnd !== null || isBefore(day, customStart)) {
        setCustomStart(day);
        setCustomEnd(null);
        return;
      }
      setCustomEnd(day);
    },
    [customEnd, customStart],
  );

  const applyCustom = useCallback(() => {
    if (customStart === null) return;
    const end = customEnd ?? customStart;
    setFilters({
      [DATE_RANGE_PARAM_KEYS.days]: null,
      [DATE_RANGE_PARAM_KEYS.from]: toKey(customStart),
      [DATE_RANGE_PARAM_KEYS.to]: toKey(end),
    });
    setOpen(false);
  }, [customEnd, customStart, setFilters]);

  const toggleCompare = useCallback(
    (checked: boolean) => setFilters({ [DATE_RANGE_PARAM_KEYS.compare]: checked ? '1' : null }),
    [setFilters],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          // Re-open on the month the current range ends in, with the range pre-selected.
          setViewMonth(startOfMonth(range.end));
          setCustomStart(range.rolling ? null : range.start);
          setCustomEnd(range.rolling ? null : range.end);
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn('h-8 gap-1.5 text-xs', className)}>
          <CalendarDays aria-hidden="true" />
          {/* The rolling label depends on today's date, which the server may compute in another
              timezone — let the client win rather than blocking hydration. */}
          <span suppressHydrationWarning>{range.label}</span>
          {range.compare ? <span className="text-muted-foreground">vs previous</span> : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align={align} className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <ul className="flex shrink-0 flex-row flex-wrap gap-1 border-b border-border p-2 sm:w-40 sm:flex-col sm:flex-nowrap sm:border-b-0 sm:border-r">
            {presets.map((preset) => (
              <li key={preset.id}>
                <Button
                  variant={activePresetId === preset.id ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 w-full justify-start px-2 text-xs font-normal"
                  aria-pressed={activePresetId === preset.id}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </Button>
              </li>
            ))}
            {activePresetId === 'custom' ? (
              <li>
                <span className="flex h-7 items-center rounded-md bg-secondary px-2 text-xs text-secondary-foreground">
                  Custom
                </span>
              </li>
            ) : null}
          </ul>

          <div className="p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Previous month"
                onClick={() => setViewMonth((current) => subMonths(current, 1))}
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <div className="flex flex-1 justify-around text-xs font-medium">
                <span>{format(viewMonth, 'MMMM yyyy')}</span>
                <span className="hidden sm:inline">{format(nextViewMonth, 'MMMM yyyy')}</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Next month"
                disabled={!isBefore(endOfMonth(viewMonth), startOfMonth(limit))}
                onClick={() => setViewMonth((current) => addMonths(current, 1))}
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>

            <div className="flex gap-4" onMouseLeave={() => setHovered(null)}>
              <MonthGrid
                month={viewMonth}
                start={customStart}
                end={customEnd}
                hovered={hovered}
                today={today}
                maxDate={limit}
                onSelect={handleDaySelect}
                onHover={setHovered}
              />
              <div className="hidden sm:block">
                <MonthGrid
                  month={nextViewMonth}
                  start={customStart}
                  end={customEnd}
                  hovered={hovered}
                  today={today}
                  maxDate={limit}
                  onSelect={handleDaySelect}
                  onHover={setHovered}
                />
              </div>
            </div>

            <Separator className="my-3" />

            <div className="flex flex-wrap items-center justify-between gap-2">
              {allowCompare ? (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
                  <Checkbox checked={range.compare} onCheckedChange={(checked) => toggleCompare(checked === true)} />
                  Compare to previous period
                </label>
              ) : (
                <span />
              )}

              <div className="flex items-center gap-2">
                <span className="tabular text-2xs text-muted-foreground">
                  {customStart
                    ? describeRange(customStart, customEnd ?? customStart)
                    : 'Pick a start and end day'}
                </span>
                <Button size="sm" className="h-7 text-xs" disabled={customStart === null} onClick={applyCustom}>
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
