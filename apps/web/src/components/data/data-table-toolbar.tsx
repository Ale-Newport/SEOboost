'use client';

import { type ReactNode } from 'react';
import { AlignJustify, Columns3, Rows3, Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ExportButton, type ExportRows } from './export-button';

/** Row height. Compact fits ~40% more rows on a laptop; comfortable is easier to scan. */
export type Density = 'compact' | 'comfortable';

export interface ColumnVisibilityOption {
  id: string;
  label: string;
  visible: boolean;
  /** Identity columns (the URL, the keyword) stay pinned so a row can never become anonymous. */
  canHide: boolean;
}

export interface ActiveFilterPill {
  /** Stable key for React and for the remove handler. */
  id: string;
  /** What the filter is, e.g. "Severity". */
  label: string;
  /** The chosen value, already humanised. */
  value: string;
  onRemove: () => void;
}

export interface ToolbarExportConfig {
  rows: ExportRows;
  filename: string;
  json?: () => unknown;
  disabled?: boolean;
}

export interface DataTableToolbarProps {
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Announced count of matching rows, for screen readers after a search. */
  resultCount?: number;

  columns?: readonly ColumnVisibilityOption[];
  onColumnVisibilityChange?: (id: string, visible: boolean) => void;
  onResetColumns?: () => void;

  filters?: readonly ActiveFilterPill[];
  onClearFilters?: () => void;

  density?: Density;
  onDensityChange?: (density: Density) => void;

  exportConfig?: ToolbarExportConfig;

  /** Page-specific filter controls — usually a `<FilterBar>`. */
  children?: ReactNode;
  /** Right-aligned extras: primary actions, refresh, bulk-action slot. */
  actions?: ReactNode;
  className?: string;
}

/**
 * The control strip above a table: search, page-specific filters, active-filter pills, and the
 * view controls (columns, density, export). Usable on its own for list surfaces that are not
 * `DataTable` — a card grid gets the same affordances for free.
 */
export function DataTableToolbar({
  search,
  onSearchChange,
  searchPlaceholder = 'Search…',
  resultCount,
  columns,
  onColumnVisibilityChange,
  onResetColumns,
  filters,
  onClearFilters,
  density,
  onDensityChange,
  exportConfig,
  children,
  actions,
  className,
}: DataTableToolbarProps): React.JSX.Element {
  const searchable = onSearchChange !== undefined;
  const hideableColumns = columns?.filter((column) => column.canHide) ?? [];
  const showColumnMenu = hideableColumns.length > 0 && onColumnVisibilityChange !== undefined;
  const activeFilters = filters ?? [];

  return (
    <div className={cn('flex flex-col gap-2 px-3 py-2.5', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {searchable ? (
          <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search ?? ''}
              onChange={(event) => onSearchChange?.(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-8 pl-8 pr-8 text-sm"
            />
            {search ? (
              <button
                type="button"
                onClick={() => onSearchChange?.('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        ) : null}

        {children}

        <div className="ml-auto flex items-center gap-1.5">
          {actions}

          {onDensityChange && density ? (
            <SimpleTooltip content={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}>
              <Button
                variant="outline"
                size="icon"
                className="size-8"
                aria-pressed={density === 'compact'}
                aria-label={density === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}
                onClick={() => onDensityChange(density === 'compact' ? 'comfortable' : 'compact')}
              >
                {density === 'compact' ? (
                  <AlignJustify aria-hidden="true" />
                ) : (
                  <Rows3 aria-hidden="true" />
                )}
              </Button>
            </SimpleTooltip>
          ) : null}

          {showColumnMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8">
                  <Columns3 aria-hidden="true" />
                  Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 min-w-[12rem] overflow-y-auto">
                <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {hideableColumns.map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={column.visible}
                    // Radix closes on select by default; keep the menu open for multi-toggling.
                    onSelect={(event) => event.preventDefault()}
                    onCheckedChange={(checked) => onColumnVisibilityChange?.(column.id, checked === true)}
                  >
                    {column.label}
                  </DropdownMenuCheckboxItem>
                ))}
                {onResetColumns ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={onResetColumns}>Reset to default</DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

          {exportConfig ? (
            <ExportButton
              rows={exportConfig.rows}
              filename={exportConfig.filename}
              json={exportConfig.json}
              disabled={exportConfig.disabled}
            />
          ) : null}
        </div>
      </div>

      {activeFilters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Filters</span>
          {activeFilters.map((filter) => (
            <span
              key={filter.id}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 py-0.5 pl-2 pr-1 text-2xs leading-4 text-foreground"
            >
              <span className="text-muted-foreground">{filter.label}</span>
              <span className="font-medium">{filter.value}</span>
              <button
                type="button"
                onClick={filter.onRemove}
                aria-label={`Remove filter ${filter.label}: ${filter.value}`}
                className="flex size-4 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            </span>
          ))}
          {onClearFilters ? (
            <Button variant="ghost" size="sm" className="h-6 px-1.5 text-2xs" onClick={onClearFilters}>
              Clear all
            </Button>
          ) : null}
        </div>
      ) : null}

      {resultCount === undefined ? null : (
        <span className="sr-only" role="status" aria-live="polite">
          {resultCount} {resultCount === 1 ? 'result' : 'results'}
        </span>
      )}
    </div>
  );
}
