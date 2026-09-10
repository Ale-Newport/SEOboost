'use client';

import * as React from 'react';
import Link from 'next/link';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

import { buildMonthGrid, dayLabel, WEEKDAY_LABELS, type MonthRef } from './dates';
import { DATE_KIND_LABEL, PHASE_META, phaseOf, type CalendarEntryView } from './types';

/**
 * The month grid.
 *
 * A day cell only ever shows entries that genuinely belong to that day: an entry with a publish
 * date sits on it, and an entry with neither a publish nor a schedule date sits on the day it
 * last moved — drawn muted and labelled, because "we last touched this on the 4th" is not a
 * plan and must not look like one.
 */

const MAX_VISIBLE = 3;

function draftHref(entry: CalendarEntryView): string {
  return `/sites/${entry.websiteId}/content/${entry.id}`;
}

function EntryChip({ entry }: { entry: CalendarEntryView }): React.JSX.Element {
  const phase = phaseOf(entry);
  const meta = PHASE_META[phase];
  const provisional = entry.dateKind === 'updated';

  return (
    <Link
      href={draftHref(entry)}
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-2xs leading-tight transition-colors',
        'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        provisional && 'opacity-70',
      )}
      title={`${entry.title} — ${meta.label}, ${DATE_KIND_LABEL[entry.dateKind].toLowerCase()} ${entry.date} · ${entry.websiteName}`}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full', meta.dotClass, provisional && 'opacity-60')}
      />
      <span className="min-w-0 flex-1 truncate text-foreground">{entry.title}</span>
      <span className="sr-only">
        {' '}
        — {meta.label}, {DATE_KIND_LABEL[entry.dateKind]} {entry.date}, on {entry.websiteName}
      </span>
    </Link>
  );
}

function DayCell({
  day,
  entries,
  isToday,
}: {
  day: { key: string; dayOfMonth: number; inMonth: boolean };
  entries: CalendarEntryView[];
  isToday: boolean;
}): React.JSX.Element {
  const visible = entries.slice(0, MAX_VISIBLE);
  const overflow = entries.slice(MAX_VISIBLE);

  return (
    <td
      className={cn(
        'h-28 min-w-[6.5rem] border-b border-r border-border align-top last:border-r-0',
        !day.inMonth && 'bg-muted/30',
      )}
    >
      <div className="flex h-full flex-col gap-0.5 p-1">
        <div className="flex items-center justify-between px-1">
          <span
            className={cn(
              'tabular text-2xs font-medium',
              day.inMonth ? 'text-muted-foreground' : 'text-muted-foreground',
              isToday &&
                'flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground',
            )}
          >
            {day.dayOfMonth}
            {isToday ? <span className="sr-only"> (today)</span> : null}
          </span>
          {entries.length > 0 ? (
            <span className="tabular text-2xs text-muted-foreground">{entries.length}</span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden">
          {visible.map((entry) => (
            <EntryChip key={entry.id} entry={entry} />
          ))}
        </div>

        {overflow.length > 0 ? (
          <Popover>
            <PopoverTrigger className="rounded px-1 text-left text-2xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              +{overflow.length} more
              <span className="sr-only"> on {dayLabel(day.key)}</span>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-2">
              <p className="px-1 pb-1.5 text-xs font-medium text-foreground">{dayLabel(day.key)}</p>
              <ul className="space-y-0.5">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <EntryChip entry={entry} />
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
    </td>
  );
}

export interface MonthGridProps {
  month: MonthRef;
  /** Entries already filtered to this month, keyed by `YYYY-MM-DD`. */
  byDate: ReadonlyMap<string, CalendarEntryView[]>;
  /** Computed on the server so the "today" ring renders identically on both sides. */
  todayKey: string;
}

export function MonthGrid({ month, byDate, todayKey }: MonthGridProps): React.JSX.Element {
  const weeks = React.useMemo(() => buildMonthGrid(month), [month]);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] border-collapse">
        <caption className="sr-only">
          Content calendar, one cell per day. Each entry links to its draft.
        </caption>
        <thead>
          <tr>
            {WEEKDAY_LABELS.map((label) => (
              <th
                key={label}
                scope="col"
                className="border-b border-r border-border px-2 py-1.5 text-left text-2xs font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]?.key ?? 'week'}>
              {week.map((day) => (
                <DayCell
                  key={day.key}
                  day={day}
                  entries={byDate.get(day.key) ?? []}
                  isToday={day.key === todayKey}
                />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
