'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Check, ListFilter, Search, X, type LucideIcon } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatCompact } from '@/lib/utils';
import type { ActiveFilterPill } from './data-table-toolbar';
import { useDebouncedParam, useTableParams } from './use-table-params';

/**
 * Filters are URL state, not component state: every control here reads and writes
 * `useTableParams`, so a filtered view is a link and the server can honour the same params.
 */

export interface FilterBarProps {
  children: ReactNode;
  className?: string;
}

export function FilterBar({ children, className }: FilterBarProps): React.JSX.Element {
  return <div className={cn('flex flex-wrap items-center gap-1.5', className)}>{children}</div>;
}

const TRIGGER_CLASS = 'h-8 border-dashed text-xs font-normal';

// ---------------------------------------------------------------------------
// Facet (multi-select)
// ---------------------------------------------------------------------------

export interface FacetOption {
  value: string;
  label: string;
  /** Matching row count from the server. Omitted when the count is unknown — never invented. */
  count?: number;
  icon?: LucideIcon;
}

export interface FacetFilterProps {
  paramKey: string;
  label: string;
  options: readonly FacetOption[];
  icon?: LucideIcon;
  /** Show a search box inside the popover once the list gets long. */
  searchable?: boolean;
  className?: string;
}

/** Multi-select facet: several values of the same param OR together, as in `severity=HIGH&severity=LOW`. */
export function FacetFilter({
  paramKey,
  label,
  options,
  icon: Icon = ListFilter,
  searchable,
  className,
}: FacetFilterProps): React.JSX.Element {
  const { getParamList, toggleFilterValue, clearFilter } = useTableParams();
  const selected = getParamList(paramKey);
  const [query, setQuery] = useState('');

  const showSearch = searchable ?? options.length > 8;
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term.length === 0) return options;
    return options.filter((option) => option.label.toLowerCase().includes(term));
  }, [options, query]);

  // A value in the URL with no matching option (a hand-edited link, an option list that has since
  // changed) still counts as an active filter — the trigger must never show an empty separator.
  const selectedLabels = options
    .filter((option) => selected.includes(option.value))
    .map((option) => option.label);
  const summarise = selectedLabels.length > 2 || selectedLabels.length !== selected.length;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(TRIGGER_CLASS, className)}>
          <Icon aria-hidden="true" />
          {label}
          {selected.length > 0 ? (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              {summarise ? (
                <Badge variant="secondary">{selected.length} selected</Badge>
              ) : (
                selectedLabels.map((text) => (
                  <Badge key={text} variant="secondary">
                    {text}
                  </Badge>
                ))
              )}
            </>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-60 p-0">
        <fieldset className="p-1">
          <legend className="sr-only">{label}</legend>

          {showSearch ? (
            <div className="relative border-b border-border p-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                aria-label={`Search ${label}`}
                className="h-7 border-0 pl-7 shadow-none focus-visible:ring-0"
              />
            </div>
          ) : null}

          <div className="max-h-64 overflow-y-auto py-1">
            {visibleOptions.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">No matches</p>
            ) : (
              visibleOptions.map((option) => {
                const OptionIcon = option.icon;
                const checked = selected.includes(option.value);
                return (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleFilterValue(paramKey, option.value)}
                    />
                    {OptionIcon ? <OptionIcon className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
                    <span className="flex-1 truncate">{option.label}</span>
                    {option.count === undefined ? null : (
                      <span className="tabular text-2xs text-muted-foreground">{formatCompact(option.count)}</span>
                    )}
                  </label>
                );
              })
            )}
          </div>

          {selected.length > 0 ? (
            <div className="border-t border-border p-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full text-xs"
                onClick={() => clearFilter(paramKey)}
              >
                Clear {label.toLowerCase()}
              </Button>
            </div>
          ) : null}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

export interface TextFilterProps {
  paramKey: string;
  label: string;
  placeholder?: string;
  /** Debounce before the value reaches the URL. */
  delay?: number;
  className?: string;
}

/** Free-text filter bound to one param, debounced so typing does not fire a query per keystroke. */
export function TextFilter({
  paramKey,
  label,
  placeholder,
  delay = 300,
  className,
}: TextFilterProps): React.JSX.Element {
  const [value, setValue] = useDebouncedParam(paramKey, delay);

  return (
    <div className={cn('relative w-44', className)}>
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={placeholder ?? label}
        aria-label={label}
        className="h-8 pr-7 text-xs"
      />
      {value.length > 0 ? (
        <button
          type="button"
          onClick={() => setValue('')}
          aria-label={`Clear ${label}`}
          className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Number range
// ---------------------------------------------------------------------------

export interface NumberRange {
  min: number | null;
  max: number | null;
}

/**
 * `10..90`, `10..`, `..90`. One param per range keeps it removable as a single pill, and `..`
 * (rather than `-`) survives negative bounds such as a position delta.
 */
export function parseNumberRange(raw: string | null): NumberRange {
  if (!raw) return { min: null, max: null };
  const [rawMin = '', rawMax = ''] = raw.split('..');
  const min = rawMin.trim() === '' ? null : Number(rawMin);
  const max = rawMax.trim() === '' ? null : Number(rawMax);
  return {
    min: min !== null && Number.isFinite(min) ? min : null,
    max: max !== null && Number.isFinite(max) ? max : null,
  };
}

export function formatNumberRange(range: NumberRange): string | null {
  if (range.min === null && range.max === null) return null;
  return `${range.min ?? ''}..${range.max ?? ''}`;
}

/** Human label for a pill: `10–90`, `≥ 10`, `≤ 90`. */
export function describeNumberRange(range: NumberRange): string {
  if (range.min !== null && range.max !== null) return `${range.min}–${range.max}`;
  if (range.min !== null) return `≥ ${range.min}`;
  if (range.max !== null) return `≤ ${range.max}`;
  return 'Any';
}

export interface NumberRangeFilterProps {
  paramKey: string;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** Appended to the trigger label, e.g. `%` or `ms`. */
  unit?: string;
  className?: string;
}

export function NumberRangeFilter({
  paramKey,
  label,
  min,
  max,
  step,
  unit,
  className,
}: NumberRangeFilterProps): React.JSX.Element {
  const { getParam, setFilter } = useTableParams();
  const committed = parseNumberRange(getParam(paramKey));

  const [draftMin, setDraftMin] = useState(committed.min === null ? '' : String(committed.min));
  const [draftMax, setDraftMax] = useState(committed.max === null ? '' : String(committed.max));
  const [open, setOpen] = useState(false);

  const active = committed.min !== null || committed.max !== null;

  const apply = (): void => {
    const parsed = parseNumberRange(`${draftMin}..${draftMax}`);
    // A range entered back to front (min 90, max 10) matches nothing at all; the user meant the
    // span between the two numbers, so order them rather than returning a silently empty table.
    const next =
      parsed.min !== null && parsed.max !== null && parsed.min > parsed.max
        ? { min: parsed.max, max: parsed.min }
        : parsed;
    setFilter(paramKey, formatNumberRange(next));
    setOpen(false);
  };

  const clear = (): void => {
    setDraftMin('');
    setDraftMax('');
    setFilter(paramKey, null);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Re-seed the draft from the URL each time it opens, so an external reset is reflected.
        if (next) {
          setDraftMin(committed.min === null ? '' : String(committed.min));
          setDraftMax(committed.max === null ? '' : String(committed.max));
        }
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className={cn(TRIGGER_CLASS, className)}>
          {label}
          {active ? (
            <>
              <Separator orientation="vertical" className="mx-0.5 h-4" />
              <Badge variant="secondary">
                {describeNumberRange(committed)}
                {unit ?? ''}
              </Badge>
            </>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-56 space-y-3 p-3">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            inputMode="numeric"
            value={draftMin}
            min={min}
            max={max}
            step={step}
            onChange={(event) => setDraftMin(event.target.value)}
            placeholder="Min"
            aria-label={`${label} minimum`}
            className="h-8 text-xs"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="number"
            inputMode="numeric"
            value={draftMax}
            min={min}
            max={max}
            step={step}
            onChange={(event) => setDraftMax(event.target.value)}
            placeholder="Max"
            aria-label={`${label} maximum`}
            className="h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" className="h-7 flex-1 text-xs" onClick={apply}>
            Apply
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={clear} disabled={!active}>
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Enum (single select)
// ---------------------------------------------------------------------------

/** Radix Select forbids an empty item value, so "no filter" needs its own sentinel. */
const ALL_VALUE = '__all__';

export interface EnumFilterProps {
  paramKey: string;
  label: string;
  options: readonly FacetOption[];
  /** Label for the "no filter" entry. */
  allLabel?: string;
  className?: string;
}

export function EnumFilter({
  paramKey,
  label,
  options,
  allLabel = 'All',
  className,
}: EnumFilterProps): React.JSX.Element {
  const { getParam, setFilter } = useTableParams();
  const value = getParam(paramKey) ?? ALL_VALUE;

  return (
    <Select
      value={value}
      onValueChange={(next) => setFilter(paramKey, next === ALL_VALUE ? null : next)}
    >
      <SelectTrigger className={cn('h-8 w-auto min-w-[8rem] gap-1.5 text-xs', className)} aria-label={label}>
        <span className="text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_VALUE} className="text-xs">
          {allLabel}
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="text-xs">
            {option.label}
            {option.count === undefined ? null : (
              <span className="tabular ml-2 text-2xs text-muted-foreground">{formatCompact(option.count)}</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

export interface BooleanFilterProps {
  paramKey: string;
  label: string;
  /** Value written when the chip is on. `true` covers the common `where: { flag: true }` case. */
  onValue?: string;
  icon?: LucideIcon;
  className?: string;
}

/** A single on/off chip; off removes the param entirely rather than writing `false`. */
export function BooleanFilter({
  paramKey,
  label,
  onValue = 'true',
  icon: Icon,
  className,
}: BooleanFilterProps): React.JSX.Element {
  const { getParam, setFilter } = useTableParams();
  const active = getParam(paramKey) === onValue;

  return (
    <Button
      variant="outline"
      size="sm"
      aria-pressed={active}
      onClick={() => setFilter(paramKey, active ? null : onValue)}
      className={cn(TRIGGER_CLASS, active && 'border-solid border-primary/40 bg-primary/10 text-foreground', className)}
    >
      {active ? <Check aria-hidden="true" /> : Icon ? <Icon aria-hidden="true" /> : null}
      {label}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Pills
// ---------------------------------------------------------------------------

export interface FilterLabelConfig {
  /** Display name of the param, e.g. `severity` → "Severity". */
  label: string;
  /** Humanises one value, e.g. `HIGH` → "High". */
  formatValue?: (value: string) => string;
}

/**
 * Turns the URL's filter params into removable pills for `DataTableToolbar`.
 * Params with no entry in `config` still show, keyed by their raw name — a filter must never be
 * invisible just because someone forgot to register a label.
 */
/** Shared empty default: a fresh `{}` per call would invalidate the memo on every render. */
const NO_FILTER_LABELS: Readonly<Record<string, FilterLabelConfig>> = {};

export function useFilterPills(
  config: Readonly<Record<string, FilterLabelConfig>> = NO_FILTER_LABELS,
): ActiveFilterPill[] {
  const { activeFilters, toggleFilterValue } = useTableParams();

  return useMemo(
    () =>
      activeFilters.flatMap(({ key, values }) =>
        values.map((value) => {
          const entry = config[key];
          return {
            id: `${key}:${value}`,
            label: entry?.label ?? key,
            value: entry?.formatValue ? entry.formatValue(value) : value,
            onRemove: () => toggleFilterValue(key, value),
          } satisfies ActiveFilterPill;
        }),
      ),
    [activeFilters, config, toggleFilterValue],
  );
}

/** `IN_PROGRESS` → `In progress`. Convenient default for `formatValue`. */
export function humanizeFilterValue(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
