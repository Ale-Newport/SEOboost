'use client';

import { useCallback, useId } from 'react';

import { DATE_RANGE_PARAM_KEYS, DateRangePicker } from '@/components/data/date-range-picker';
import { useTableParams } from '@/components/data/use-table-params';
import { Switch } from '@/components/ui/switch';
import { TooltipInfo } from '@/components/ui/tooltip-info';

export interface PerformanceToolbarProps {
  /** The window the server actually resolved, already formatted. */
  windowLabel: string;
  /** The comparison window, when the compare toggle is on. */
  comparisonLabel: string | null;
  /** How far behind today the default window ends, in days. */
  lagDays: number;
}

/**
 * Window controls for the whole screen.
 *
 * Both the range and the comparison live in the URL, so any view of this page — a fixed month, a
 * rolling 90 days, with or without the previous period — is a link. The switch duplicates the one
 * inside the picker on purpose: comparing is the single most-used control here and it should not
 * take two clicks and a popover.
 */
export function PerformanceToolbar({
  windowLabel,
  comparisonLabel,
  lagDays,
}: PerformanceToolbarProps): React.JSX.Element {
  const { getParam, setFilters } = useTableParams();
  const compare = getParam(DATE_RANGE_PARAM_KEYS.compare) === '1';
  const switchId = useId();

  const toggleCompare = useCallback(
    (checked: boolean) => setFilters({ [DATE_RANGE_PARAM_KEYS.compare]: checked ? '1' : null }),
    [setFilters],
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <DateRangePicker align="start" />

      <div className="flex items-center gap-2">
        <Switch id={switchId} checked={compare} onCheckedChange={toggleCompare} />
        <label htmlFor={switchId} className="cursor-pointer text-xs text-foreground">
          Compare to previous period
        </label>
      </div>

      <p className="text-2xs text-muted-foreground">
        <span className="tabular">{windowLabel}</span>
        {comparisonLabel ? (
          <>
            {' '}
            vs <span className="tabular">{comparisonLabel}</span>
          </>
        ) : null}
      </p>

      <TooltipInfo
        label="Why the window ends a few days ago"
        content={
          <>
            Search Console publishes data on a delay, so rolling windows end {lagDays} days before
            today. Charting a partial final day makes every site look like it fell off a cliff this
            morning.
          </>
        }
      />
    </div>
  );
}
