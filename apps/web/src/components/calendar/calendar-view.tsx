'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, Globe, List, Rocket, Sparkles } from 'lucide-react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { DataTableToolbar } from '@/components/data/data-table-toolbar';
import { FacetFilter, FilterBar, useFilterPills } from '@/components/data/filter-bar';
import type { FacetOption } from '@/components/data/filter-bar';
import { useTableParams } from '@/components/data/use-table-params';
import { cn, formatNumber } from '@/lib/utils';

import { monthKey, monthLabel, shiftMonth, type MonthRef } from './dates';
import { EntryList } from './entry-list';
import { MonthGrid } from './month-grid';
import {
  CALENDAR_PHASES,
  PHASE_META,
  isCalendarPhase,
  phaseOf,
  type CalendarEntryView,
  type CalendarPhase,
} from './types';

/**
 * The cross-site content calendar.
 *
 * Two views over one month of entries, toggled through `?view=`. The month itself is a URL param
 * too, so a link to a particular month in a particular view survives a refresh and can be sent
 * to someone else.
 *
 * The site filter is applied on the server (it changes which drafts are read); the phase filter
 * is applied here, because a phase is derived from the stage and the publish date rather than
 * stored — filtering it in SQL would mean duplicating that rule in two places.
 */

export type CalendarViewMode = 'month' | 'list';

export interface CalendarViewProps {
  /** Entries whose day falls inside `month`, already scoped to the sites the user owns. */
  entries: CalendarEntryView[];
  month: MonthRef;
  view: CalendarViewMode;
  /** `YYYY-MM-DD` for today, computed on the server so both renders agree. */
  todayKey: string;
  /** `YYYY-MM` for the month containing today, for the "This month" jump. */
  currentMonthKey: string;
  siteOptions: FacetOption[];
  hasWebsites: boolean;
  /** Whether any draft exists at all — separates "quiet month" from "nothing set up yet". */
  hasAnyDrafts: boolean;
  /** The read model hit its row cap, so this month may be showing a partial picture. */
  truncated: boolean;
}

export function CalendarView({
  entries,
  month,
  view,
  todayKey,
  currentMonthKey,
  siteOptions,
  hasWebsites,
  hasAnyDrafts,
  truncated,
}: CalendarViewProps): React.JSX.Element {
  const { getParamList, setParams, hasActiveFilters, clearFilters } = useTableParams({
    reservedKeys: ['month'],
  });

  const filterLabels = React.useMemo(
    () => ({
      site: {
        label: 'Website',
        formatValue: (value: string) =>
          siteOptions.find((option) => option.value === value)?.label ?? value,
      },
      phase: {
        label: 'Stage',
        formatValue: (value: string) =>
          isCalendarPhase(value) ? PHASE_META[value].label : value,
      },
    }),
    [siteOptions],
  );
  const pills = useFilterPills(filterLabels);

  const selectedPhases = React.useMemo(
    () => new Set(getParamList('phase').filter(isCalendarPhase)),
    [getParamList],
  );

  /** Counts over everything in the month, so a facet's number does not move when it is ticked. */
  const phaseCounts = React.useMemo(() => {
    const counts = new Map<CalendarPhase, number>();
    for (const entry of entries) {
      const phase = phaseOf(entry);
      counts.set(phase, (counts.get(phase) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const visible = React.useMemo(
    () =>
      selectedPhases.size === 0
        ? entries
        : entries.filter((entry) => selectedPhases.has(phaseOf(entry))),
    [entries, selectedPhases],
  );

  const byDate = React.useMemo(() => {
    const map = new Map<string, CalendarEntryView[]>();
    for (const entry of visible) {
      const list = map.get(entry.date);
      if (list) list.push(entry);
      else map.set(entry.date, [entry]);
    }
    for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title));
    return map;
  }, [visible]);

  const days = React.useMemo(
    () =>
      [...byDate.entries()]
        .map(([date, dayEntries]) => ({ date, entries: dayEntries }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    [byDate],
  );

  const phaseOptions: FacetOption[] = React.useMemo(
    () =>
      CALENDAR_PHASES.map((phase) => ({
        value: phase,
        label: PHASE_META[phase].label,
        icon: PHASE_META[phase].icon,
        count: phaseCounts.get(phase) ?? 0,
      })),
    [phaseCounts],
  );

  const scheduled = phaseCounts.get('scheduled') ?? 0;
  const published = phaseCounts.get('published') ?? 0;
  const undated = React.useMemo(
    () => entries.filter((entry) => entry.dateKind === 'updated').length,
    [entries],
  );

  const label = monthLabel(month);
  const isCurrentMonth = monthKey(month) === currentMonthKey;

  const goToMonth = (next: MonthRef): void => {
    setParams({ month: monthKey(next) === currentMonthKey ? null : monthKey(next) });
  };

  return (
    <div className="space-y-4 px-4 py-6 md:px-6">
      <PageHeader
        title="Content calendar"
        description="Every draft across every website you own, on the day it publishes, is scheduled for, or last moved. Clicking an entry opens its draft."
        actions={
          <Tabs
            value={view}
            onValueChange={(value) => setParams({ view: value === 'month' ? null : value })}
          >
            <TabsList variant="pill" aria-label="Calendar layout">
              <TabsTrigger value="month">
                <CalendarDays aria-hidden="true" />
                Month
              </TabsTrigger>
              <TabsTrigger value="list">
                <List aria-hidden="true" />
                List
              </TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Entries in view"
          value={formatNumber(visible.length)}
          icon={CalendarRange}
          footer={`${label}${selectedPhases.size > 0 ? ', filtered' : ''}`}
        />
        <MetricCard
          label="Scheduled"
          value={formatNumber(scheduled)}
          icon={CalendarDays}
          info="Drafts with a publish date set inside this month. They sit on that day."
          footer="Has a publish date"
        />
        <MetricCard
          label="Published"
          value={formatNumber(published)}
          icon={Rocket}
          info="Drafts that went live inside this month, placed on the day they were published."
          footer="Live on a site"
        />
        <MetricCard
          label="No publish date"
          value={formatNumber(undated)}
          icon={Sparkles}
          info="In-flight drafts with neither a publish nor a schedule date. They are placed on the day they last moved, which is a record of activity — not a plan."
          footer="Placed on their last activity"
        />
      </div>

      {truncated ? (
        <Alert variant="warning">
          <AlertDescription>
            This month has more drafts than the calendar reads in one pass, so some entries are not
            shown. Filter to a single website to see the full picture for it.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="rounded-lg border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              aria-label={`Go to ${monthLabel(shiftMonth(month, -1))}`}
              onClick={() => goToMonth(shiftMonth(month, -1))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-8"
              aria-label={`Go to ${monthLabel(shiftMonth(month, 1))}`}
              onClick={() => goToMonth(shiftMonth(month, 1))}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>

          <h2 aria-live="polite" className="text-sm font-semibold tracking-tight text-foreground">
            {label}
          </h2>

          {!isCurrentMonth ? (
            <Button variant="ghost" size="sm" onClick={() => setParams({ month: null })}>
              This month
            </Button>
          ) : null}

          <ul className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
            {CALENDAR_PHASES.map((phase) => {
              const meta = PHASE_META[phase];
              const count = phaseCounts.get(phase) ?? 0;
              return (
                <li key={phase} className={cn('flex items-center gap-1.5', count === 0 && 'opacity-45')}>
                  <span aria-hidden="true" className={cn('size-1.5 rounded-full', meta.dotClass)} />
                  <span className="text-2xs text-muted-foreground">{meta.label}</span>
                  <span className="tabular text-2xs font-medium text-foreground">{count}</span>
                  <TooltipInfo label={`What "${meta.label}" means`} content={meta.description} />
                </li>
              );
            })}
          </ul>
        </div>

        <DataTableToolbar
          resultCount={visible.length}
          filters={pills}
          onClearFilters={clearFilters}
        >
          <FilterBar>
            <FacetFilter paramKey="site" label="Website" options={siteOptions} icon={Globe} searchable />
            <FacetFilter paramKey="phase" label="Stage" options={phaseOptions} />
          </FilterBar>
        </DataTableToolbar>

        <div className="border-t border-border">
          {visible.length === 0 ? (
            <div className="p-3">
              <EmptyState
                icon={CalendarDays}
                title={
                  !hasWebsites
                    ? 'No websites yet'
                    : hasActiveFilters
                      ? `Nothing matches these filters in ${label}`
                      : hasAnyDrafts
                        ? `Nothing on the calendar for ${label}`
                        : 'No content drafts yet'
                }
                description={
                  !hasWebsites
                    ? 'Add a website first. The calendar is built from the content drafts belonging to the sites you own.'
                    : hasActiveFilters
                      ? 'Clear the filters, or step to another month.'
                      : hasAnyDrafts
                        ? 'Drafts appear on the day they publish, are scheduled for, or last moved. Step to another month to find the ones you have.'
                        : 'Drafts come from accepted content opportunities: accept one, create a brief, then run the content pipeline on it. Nothing is put on this calendar until a draft exists.'
                }
                action={
                  !hasWebsites ? (
                    <Button asChild size="sm">
                      <Link href="/sites/new">Add a website</Link>
                    </Button>
                  ) : hasActiveFilters ? (
                    <Button variant="outline" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  ) : (
                    <Button asChild size="sm">
                      <Link href="/opportunities">
                        <Sparkles aria-hidden="true" />
                        Review content opportunities
                      </Link>
                    </Button>
                  )
                }
                secondaryAction={
                  hasWebsites && !hasActiveFilters && hasAnyDrafts ? (
                    <Button variant="outline" size="sm" onClick={() => goToMonth(shiftMonth(month, -1))}>
                      <ChevronLeft aria-hidden="true" />
                      {monthLabel(shiftMonth(month, -1))}
                    </Button>
                  ) : null
                }
              />
            </div>
          ) : view === 'month' ? (
            <MonthGrid month={month} byDate={byDate} todayKey={todayKey} />
          ) : (
            <EntryList days={days} todayKey={todayKey} />
          )}
        </div>
      </div>
    </div>
  );
}
