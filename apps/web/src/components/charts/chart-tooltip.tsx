'use client';

import type { ReactNode } from 'react';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition } from '@/lib/utils';

export type ChartValueFormat = 'number' | 'compact' | 'percent' | 'position' | 'seconds' | 'raw';

/** One place that knows how each metric family is rendered, so axis/label/tooltip never disagree. */
export function formatChartValue(
  value: number | string | null | undefined,
  format: ChartValueFormat = 'number',
): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (Number.isNaN(value)) return '—';
  switch (format) {
    case 'compact':
      return formatCompact(value);
    case 'percent':
      return formatPercent(value);
    case 'position':
      return formatPosition(value);
    case 'seconds':
      return value >= 1 ? `${value.toFixed(2)}s` : `${Math.round(value * 1000)}ms`;
    case 'raw':
      return String(value);
    case 'number':
    default:
      return formatNumber(value);
  }
}

/** Subset of the recharts payload entry we actually consume — keeps the surface `any`-free. */
export interface ChartTooltipEntry {
  name?: string | number;
  dataKey?: string | number;
  value?: number | string | null;
  color?: string;
  stroke?: string;
  fill?: string;
  unit?: string;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipProps {
  /** Injected by recharts when it clones the element passed to `<Tooltip content={…} />`. */
  active?: boolean;
  payload?: ChartTooltipEntry[];
  label?: string | number;
  /** Format the header. Defaults to showing the raw label. */
  labelFormatter?: (label: string | number) => ReactNode;
  /** Per-entry value formatting; falls back to `format`. */
  valueFormatter?: (value: number | string | null | undefined, entry: ChartTooltipEntry) => string;
  format?: ChartValueFormat;
  /** Rename a series for display (dataKey -> label). */
  nameFormatter?: (name: string, entry: ChartTooltipEntry) => string;
  hideLabel?: boolean;
  /**
   * Replaces the header entirely. Receives the payload, so charts whose header is not a
   * category label (scatter points, for example) can title the tooltip from the row.
   */
  header?: ReactNode | ((rows: ChartTooltipEntry[]) => ReactNode);
  /** Append a "Total" row — useful for stacked series. */
  showTotal?: boolean;
  totalLabel?: string;
  /**
   * Extra content under the rows (e.g. the comparison period's own date). Given the payload so
   * it can read fields the chart stashed on the row.
   */
  footer?: ReactNode | ((rows: ChartTooltipEntry[]) => ReactNode);
  /** Hide entries whose value is null/undefined instead of rendering an em dash. */
  hideEmpty?: boolean;
  className?: string;
}

function entryColor(entry: ChartTooltipEntry): string {
  return entry.color ?? entry.stroke ?? entry.fill ?? 'currentColor';
}

/**
 * Custom recharts tooltip matching our popover styling.
 *
 * Rendered as an element (`content={<ChartTooltip … />}`) rather than a render function so recharts
 * can clone it with `active`/`payload`/`label` while our own props stay type-checked.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  format = 'number',
  nameFormatter,
  hideLabel = false,
  header,
  showTotal = false,
  totalLabel = 'Total',
  footer,
  hideEmpty = false,
  className,
}: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  const rows = hideEmpty
    ? payload.filter((e) => e.value !== null && e.value !== undefined && e.value !== '')
    : payload;
  if (rows.length === 0) return null;

  const total = rows.reduce<number>((acc, e) => (typeof e.value === 'number' ? acc + e.value : acc), 0);
  const footerContent = typeof footer === 'function' ? footer(rows) : footer;

  const headerContent = header
    ? typeof header === 'function'
      ? header(rows)
      : header
    : hideLabel || label === undefined || label === null
      ? null
      : labelFormatter
        ? labelFormatter(label)
        : String(label);

  return (
    <div
      className={cn(
        'pointer-events-none min-w-[10rem] max-w-[18rem] rounded-md border border-border bg-popover px-2.5 py-2 text-popover-foreground shadow-popover',
        className,
      )}
    >
      {headerContent !== null && headerContent !== undefined ? (
        <div className="mb-1.5 border-b border-border/60 pb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
          {headerContent}
        </div>
      ) : null}

      <ul className="space-y-1">
        {rows.map((entry, i) => {
          const rawName = String(entry.name ?? entry.dataKey ?? '');
          const name = nameFormatter ? nameFormatter(rawName, entry) : rawName;
          const value = valueFormatter
            ? valueFormatter(entry.value, entry)
            : formatChartValue(entry.value, format);
          return (
            <li key={`${rawName}-${i}`} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full ring-1 ring-inset ring-black/5"
                style={{ backgroundColor: entryColor(entry) }}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{name}</span>
              <span className="tabular shrink-0 font-medium">
                {value}
                {entry.unit ? <span className="text-muted-foreground">{entry.unit}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>

      {showTotal ? (
        <div className="mt-1.5 flex items-center gap-2 border-t border-border/60 pt-1.5 text-xs">
          <span className="h-2 w-2 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{totalLabel}</span>
          <span className="tabular shrink-0 font-semibold">{formatChartValue(total, format)}</span>
        </div>
      ) : null}

      {footerContent ? (
        <div className="mt-1.5 text-2xs text-muted-foreground">{footerContent}</div>
      ) : null}
    </div>
  );
}
