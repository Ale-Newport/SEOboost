'use client';

import { useId, useMemo } from 'react';
import { Bot, CalendarRange, Tag } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  DataTableToolbar,
  FacetFilter,
  FilterBar,
  humanizeFilterValue,
  useFilterPills,
  useTableParams,
} from '@/components/data';
import type { HistoryFacet } from '@/components/history/queries';

/**
 * Filters for the change timeline: who did it, what kind of change it was, and when.
 *
 * All three live in the URL, so a filtered view is a shareable link and the server reads exactly
 * what the controls wrote. The date control writes plain `from`/`to` days rather than a rolling
 * window: history is an audit trail, and its natural default is "everything", not "last 28 days".
 */

const ACTOR_LABEL: Record<string, string> = {
  user: 'You',
  agent: 'An agent',
  system: 'System',
};

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function labelForActor(value: string): string {
  return ACTOR_LABEL[value] ?? humanizeFilterValue(value);
}

/** `yyyy-MM-dd` for a day offset from today, in the same UTC frame the server filters on. */
function dayKey(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - offsetDays);
  return date.toISOString().slice(0, 10);
}

function describeWindow(from: string | null, to: string | null): string {
  if (from && to) return `${DATE.format(new Date(from))} – ${DATE.format(new Date(to))}`;
  if (from) return `Since ${DATE.format(new Date(from))}`;
  if (to) return `Until ${DATE.format(new Date(to))}`;
  return 'All time';
}

const PRESETS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: 'All time', days: null },
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

function DateWindowFilter(): React.JSX.Element {
  const { getParam, setFilters } = useTableParams();
  const fromId = useId();
  const toId = useId();

  const from = getParam('from');
  const to = getParam('to');
  const active = from !== null || to !== null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 border-dashed text-xs font-normal"
          aria-label={`Date range: ${describeWindow(from, to)}`}
        >
          <CalendarRange aria-hidden="true" />
          {describeWindow(from, to)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-3">
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <Button
              key={preset.label}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs font-normal"
              onClick={() =>
                setFilters({
                  from: preset.days === null ? null : dayKey(preset.days - 1),
                  to: null,
                })
              }
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor={fromId} className="text-2xs">
              From
            </Label>
            <Input
              id={fromId}
              type="date"
              value={from ?? ''}
              max={to ?? undefined}
              className="h-8 text-xs"
              onChange={(event) => setFilters({ from: event.target.value || null })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={toId} className="text-2xs">
              To
            </Label>
            <Input
              id={toId}
              type="date"
              value={to ?? ''}
              min={from ?? undefined}
              className="h-8 text-xs"
              onChange={(event) => setFilters({ to: event.target.value || null })}
            />
          </div>
        </div>

        <p className="text-2xs leading-relaxed text-muted-foreground">
          Both ends are inclusive and read in UTC, the clock the audit trail is stamped in.
        </p>

        {active ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-full text-xs"
            onClick={() => setFilters({ from: null, to: null })}
          >
            Clear dates
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export interface HistoryFiltersProps {
  actorFacets: readonly HistoryFacet[];
  changeTypeFacets: readonly HistoryFacet[];
  /** Rows matching the current filter — announced after a change. */
  resultCount: number;
}

export function HistoryFilters({
  actorFacets,
  changeTypeFacets,
  resultCount,
}: HistoryFiltersProps): React.JSX.Element {
  const { clearFilters, setFilters, getParam } = useTableParams();

  const actorOptions = useMemo(
    () =>
      actorFacets.map((facet) => ({
        value: facet.value,
        label: labelForActor(facet.value),
        count: facet.count,
      })),
    [actorFacets],
  );

  const typeOptions = useMemo(
    () =>
      changeTypeFacets.map((facet) => ({
        value: facet.value,
        label: humanizeFilterValue(facet.value),
        count: facet.count,
      })),
    [changeTypeFacets],
  );

  const pills = useFilterPills(
    useMemo(
      () => ({
        actor: { label: 'Actor', formatValue: labelForActor },
        changeType: { label: 'Change', formatValue: humanizeFilterValue },
      }),
      [],
    ),
  );

  const datesActive = getParam('from') !== null || getParam('to') !== null;

  return (
    <DataTableToolbar
      resultCount={resultCount}
      filters={pills}
      onClearFilters={() => {
        clearFilters();
        if (datesActive) setFilters({ from: null, to: null });
      }}
    >
      <FilterBar>
        <FacetFilter paramKey="actor" label="Actor" options={actorOptions} icon={Bot} />
        <FacetFilter paramKey="changeType" label="Change" options={typeOptions} icon={Tag} searchable />
        <DateWindowFilter />
      </FilterBar>
    </DataTableToolbar>
  );
}
