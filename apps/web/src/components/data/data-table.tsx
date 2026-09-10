'use client';

import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDown, ArrowUp, ChevronsUpDown, Inbox } from 'lucide-react';

import { DEFAULT_PAGE_SIZE } from '@seo/shared/constants';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatNumber } from '@/lib/utils';
import { coerceCsvCell, type CsvRow } from './csv';
import {
  DataTableToolbar,
  type ActiveFilterPill,
  type ColumnVisibilityOption,
  type Density,
} from './data-table-toolbar';
import { Pagination, pageCount } from './pagination';
import type { SortOrder } from './use-table-params';

export type ColumnAlign = 'left' | 'center' | 'right';

export interface ColumnDef<T> {
  /** Stable id — used for sort params, column visibility and CSV headers. */
  id: string;
  header: ReactNode;
  /** The raw value: drives sorting, client-side search and the CSV fallback. */
  accessor: (row: T) => unknown;
  /** Rendered output. Defaults to the accessor value as text. */
  cell?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: ColumnAlign;
  /** Number = px. Also used to offset the next sticky column. */
  width?: number | string;
  defaultHidden?: boolean;
  /** Export override when the cell renders something a spreadsheet cannot hold. */
  exportValue?: (row: T) => string | number | null;
  /** Freeze the column against horizontal scroll. Give sticky columns a numeric `width`. */
  sticky?: boolean;
  /** Plain-text label for the column menu and CSV header when `header` is not a string. */
  headerLabel?: string;
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<T> {
  data: readonly T[];
  columns: ReadonlyArray<ColumnDef<T>>;
  /** Must be stable across renders — it keys rows and drives selection. */
  getRowId: (row: T, index: number) => string;

  loading?: boolean;
  skeletonRows?: number;

  /** Accessible description of the table. Rendered as a visually hidden `<caption>`. */
  caption?: string;

  // Search ------------------------------------------------------------------
  searchable?: boolean;
  /** Controlled search term. Pair with `onSearchChange` to keep it in the URL. */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  /** Restrict client-side matching to these column ids. Defaults to every visible column. */
  searchKeys?: readonly string[];
  /** The rows already arrive filtered from the server — skip client-side matching. */
  manualSearch?: boolean;

  // Sorting -----------------------------------------------------------------
  /** Providing `onSortChange` switches sorting to server-side; `sort`/`order` then drive it. */
  sort?: string | null;
  order?: SortOrder;
  onSortChange?: (id: string, order: SortOrder) => void;
  defaultSort?: string | null;
  defaultOrder?: SortOrder;

  // Selection ---------------------------------------------------------------
  selectable?: boolean;
  selectedIds?: readonly string[];
  onSelectionChange?: (ids: string[]) => void;
  /**
   * Rendered in the selection strip. `rows` holds the selected rows present on this page — the
   * only ones that can be materialised when the server owns pagination — while `ids` holds the
   * whole selection, including rows selected on pages that are no longer mounted. An action that
   * mutates every selected record must use `ids`; one that needs the row objects must use `rows`
   * and say so.
   */
  bulkActions?: (selected: readonly T[], selectedIds: readonly string[]) => ReactNode;

  // Pagination --------------------------------------------------------------
  /** With `onPageChange` the table shows the rows as given; without it, it paginates locally. */
  page?: number;
  pageSize?: number;
  total?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  itemLabel?: string;

  // Interaction -------------------------------------------------------------
  onRowClick?: (row: T) => void;
  /** Turns rows into navigation targets; modifier-click opens a new tab. */
  rowHref?: (row: T) => string | null;
  rowClassName?: (row: T) => string | undefined;

  // Chrome ------------------------------------------------------------------
  /** Page-specific filter controls, rendered inside the toolbar. */
  toolbar?: ReactNode;
  /** Right-aligned toolbar extras (refresh, primary action…). */
  toolbarActions?: ReactNode;
  filterPills?: readonly ActiveFilterPill[];
  onClearFilters?: () => void;
  hideToolbar?: boolean;
  density?: Density;
  onDensityChange?: (density: Density) => void;
  defaultDensity?: Density;
  stickyHeader?: boolean;
  /** Constrains the scroll container — required for `stickyHeader` to have anything to stick to. */
  maxHeight?: number | string;
  emptyState?: ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  exportable?: boolean;
  exportFilename?: string;
  /** Export these rows instead of what is on screen — e.g. the full server-side result set. */
  exportRows?: readonly T[];
  className?: string;
}

const ALIGN_CLASS: Record<ColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

const SELECT_COLUMN_WIDTH = 40;

/** Sorts nulls, undefined and empty strings to the bottom in both directions. */
function compareValues(a: unknown, b: unknown, direction: 1 | -1): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction;
  if (a instanceof Date && b instanceof Date) return (a.getTime() - b.getTime()) * direction;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (Number(a) - Number(b)) * direction;

  return collator.compare(String(a), String(b)) * direction;
}

/** `numeric` so `page-2` sorts before `page-10`, which is what a person expects of URL paths. */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function columnLabel<T>(column: ColumnDef<T>): string {
  if (column.headerLabel !== undefined) return column.headerLabel;
  return typeof column.header === 'string' ? column.header : column.id;
}

function defaultCellText(value: unknown): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'number') return <span className="tabular">{formatNumber(value)}</span>;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value instanceof Date) return value.toLocaleDateString();
  return String(value);
}

/** Ignore row activation that started on a control the row happens to contain. */
function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('a, button, input, select, textarea, label, [role="checkbox"], [data-row-ignore]') !== null
  );
}

/**
 * The list surface for every screen in the product.
 *
 * Sorting, searching and pagination are local by default so a simple table needs no wiring, and
 * each of them hands over to the server the moment the corresponding callback is supplied —
 * large tables page and sort in the database while small ones stay instant.
 */
export function DataTable<T>({
  data,
  columns,
  getRowId,
  loading = false,
  skeletonRows = 8,
  caption,
  searchable = false,
  search,
  onSearchChange,
  searchPlaceholder = 'Search…',
  searchKeys,
  manualSearch = false,
  sort,
  order,
  onSortChange,
  defaultSort = null,
  defaultOrder = 'desc',
  selectable = false,
  selectedIds,
  onSelectionChange,
  bulkActions,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions,
  itemLabel = 'results',
  onRowClick,
  rowHref,
  rowClassName,
  toolbar,
  toolbarActions,
  filterPills,
  onClearFilters,
  hideToolbar = false,
  density,
  onDensityChange,
  defaultDensity = 'comfortable',
  stickyHeader = true,
  maxHeight,
  emptyState,
  emptyTitle = 'Nothing to show',
  emptyDescription,
  exportable = true,
  exportFilename = 'export',
  exportRows,
  className,
}: DataTableProps<T>): React.JSX.Element {
  const router = useRouter();

  // Column visibility -------------------------------------------------------
  const defaultHiddenIds = useMemo(
    () => columns.filter((column) => column.defaultHidden).map((column) => column.id),
    [columns],
  );
  const [hiddenIds, setHiddenIds] = useState<readonly string[]>(defaultHiddenIds);
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const visibleColumns = useMemo(
    () => columns.filter((column) => !hidden.has(column.id)),
    [columns, hidden],
  );

  const columnOptions = useMemo<ColumnVisibilityOption[]>(
    () =>
      columns.map((column, index) => ({
        id: column.id,
        label: columnLabel(column),
        visible: !hidden.has(column.id),
        // The first column identifies the row; hiding it would leave an anonymous table.
        canHide: index > 0 && !column.sticky,
      })),
    [columns, hidden],
  );

  const handleColumnVisibility = useCallback((id: string, visible: boolean) => {
    setHiddenIds((current) => (visible ? current.filter((entry) => entry !== id) : [...current, id]));
  }, []);

  // Density -----------------------------------------------------------------
  const [internalDensity, setInternalDensity] = useState<Density>(defaultDensity);
  const activeDensity = density ?? internalDensity;
  const handleDensityChange = useCallback(
    (next: Density) => {
      if (density === undefined) setInternalDensity(next);
      onDensityChange?.(next);
    },
    [density, onDensityChange],
  );

  // Search ------------------------------------------------------------------
  const [internalSearch, setInternalSearch] = useState('');
  const [internalPage, setInternalPage] = useState(1);
  const searchValue = search ?? internalSearch;

  const handleSearchChange = useCallback(
    (value: string) => {
      if (search === undefined) setInternalSearch(value);
      setInternalPage(1);
      onSearchChange?.(value);
    },
    [search, onSearchChange],
  );

  const filteredData = useMemo(() => {
    const term = searchValue.trim().toLowerCase();
    if (manualSearch || term.length === 0) return data;

    const searchColumns =
      searchKeys === undefined ? visibleColumns : columns.filter((column) => searchKeys.includes(column.id));

    return data.filter((row) =>
      searchColumns.some((column) => {
        const value = column.accessor(row);
        if (value === null || value === undefined) return false;
        return String(value).toLowerCase().includes(term);
      }),
    );
  }, [data, searchValue, manualSearch, searchKeys, visibleColumns, columns]);

  // Sorting -----------------------------------------------------------------
  const serverSorted = onSortChange !== undefined;
  const [internalSort, setInternalSort] = useState<{ id: string | null; order: SortOrder }>({
    id: defaultSort,
    order: defaultOrder,
  });
  const activeSortId = serverSorted ? (sort ?? null) : internalSort.id;
  const activeOrder: SortOrder = serverSorted ? (order ?? defaultOrder) : internalSort.order;

  const sortedData = useMemo(() => {
    if (serverSorted || activeSortId === null) return filteredData;
    const column = columns.find((entry) => entry.id === activeSortId);
    if (!column) return filteredData;

    const direction: 1 | -1 = activeOrder === 'asc' ? 1 : -1;
    // `accessor` may be non-trivial, so copy first and let sort call it directly rather than
    // building a decorated array — tables here top out in the low thousands of rows.
    return [...filteredData].sort((a, b) => compareValues(column.accessor(a), column.accessor(b), direction));
  }, [filteredData, serverSorted, activeSortId, activeOrder, columns]);

  const handleSort = useCallback(
    (column: ColumnDef<T>) => {
      // Numbers are almost always most interesting at the top, text at 'A'.
      const firstRow = data[0];
      const initial: SortOrder =
        firstRow !== undefined && typeof column.accessor(firstRow) === 'number' ? 'desc' : 'asc';
      const next: SortOrder =
        activeSortId === column.id ? (activeOrder === 'asc' ? 'desc' : 'asc') : initial;

      if (onSortChange) onSortChange(column.id, next);
      else setInternalSort({ id: column.id, order: next });
    },
    [activeOrder, activeSortId, data, onSortChange],
  );

  // Pagination --------------------------------------------------------------
  const serverPaginated = onPageChange !== undefined;
  const [internalPageSize, setInternalPageSize] = useState(pageSize ?? DEFAULT_PAGE_SIZE);
  const activePageSize = pageSize ?? internalPageSize;
  /**
   * Page locally as soon as the caller asks for it *or* the list outgrows a page. Without the
   * second condition a table handed a few thousand rows renders every one of them into the DOM,
   * which is what the local pager exists to prevent.
   *
   * The threshold is the fixed default, not `activePageSize`: measuring against the live page size
   * would make the pager remove itself the moment a user picked a size larger than the row count,
   * leaving no way to pick a smaller one. Unfiltered `data`, likewise, so the pager does not
   * appear and disappear while someone types in the search box.
   */
  const paginated = serverPaginated || pageSize !== undefined || data.length > DEFAULT_PAGE_SIZE;
  const totalRows = serverPaginated ? (total ?? data.length) : sortedData.length;
  const activePage = serverPaginated
    ? (page ?? 1)
    : Math.min(internalPage, pageCount(totalRows, activePageSize));

  const rows = useMemo(() => {
    if (serverPaginated || !paginated) return sortedData;
    const start = (activePage - 1) * activePageSize;
    return sortedData.slice(start, start + activePageSize);
  }, [sortedData, serverPaginated, paginated, activePage, activePageSize]);

  const handlePageChange = useCallback(
    (next: number) => {
      if (onPageChange) onPageChange(next);
      else setInternalPage(next);
    },
    [onPageChange],
  );

  const handlePageSizeChange = useCallback(
    (next: number) => {
      if (onPageSizeChange) onPageSizeChange(next);
      else setInternalPageSize(next);
      setInternalPage(1);
    },
    [onPageSizeChange],
  );

  // Selection ---------------------------------------------------------------
  const [internalSelection, setInternalSelection] = useState<readonly string[]>([]);
  const selection = useMemo(() => new Set(selectedIds ?? internalSelection), [selectedIds, internalSelection]);

  const updateSelection = useCallback(
    (next: string[]) => {
      if (selectedIds === undefined) setInternalSelection(next);
      onSelectionChange?.(next);
    },
    [selectedIds, onSelectionChange],
  );

  const rowIds = useMemo(() => rows.map((row, index) => getRowId(row, index)), [rows, getRowId]);
  const selectedOnPage = rowIds.filter((id) => selection.has(id));
  const allSelected = rowIds.length > 0 && selectedOnPage.length === rowIds.length;
  const someSelected = selectedOnPage.length > 0 && !allSelected;

  const toggleAll = useCallback(
    (checked: boolean) => {
      const current = new Set(selection);
      for (const id of rowIds) {
        if (checked) current.add(id);
        else current.delete(id);
      }
      updateSelection([...current]);
    },
    [rowIds, selection, updateSelection],
  );

  const toggleRow = useCallback(
    (id: string) => {
      const current = new Set(selection);
      if (current.has(id)) current.delete(id);
      else current.add(id);
      updateSelection([...current]);
    },
    [selection, updateSelection],
  );

  const selectedRows = useMemo(
    () => rows.filter((row, index) => selection.has(getRowId(row, index))),
    [rows, selection, getRowId],
  );
  /** The whole selection, including ids from pages that are no longer mounted. */
  const selectedIdList = useMemo(() => [...selection], [selection]);

  // Row activation ----------------------------------------------------------
  const interactive = onRowClick !== undefined || rowHref !== undefined;

  const activateRow = useCallback(
    (row: T, event?: MouseEvent | KeyboardEvent) => {
      const href = rowHref?.(row) ?? null;
      if (href !== null && href !== '') {
        const newTab = event !== undefined && (event.metaKey || event.ctrlKey);
        if (newTab) window.open(href, '_blank', 'noopener,noreferrer');
        else router.push(href);
        return;
      }
      onRowClick?.(row);
    },
    [onRowClick, rowHref, router],
  );

  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  // Drop refs for rows that no longer exist, so keyboard navigation cannot focus a dead node.
  rowRefs.current.length = rows.length;
  const [focusedIndex, setFocusedIndex] = useState(0);
  const keyboardNavigable = interactive || selectable;

  const handleRowKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number) => {
      const focusRow = (next: number): void => {
        const clamped = Math.max(0, Math.min(next, rowRefs.current.length - 1));
        setFocusedIndex(clamped);
        rowRefs.current[clamped]?.focus();
      };

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focusRow(index + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusRow(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusRow(0);
          break;
        case 'End':
          event.preventDefault();
          focusRow(rowRefs.current.length - 1);
          break;
        case 'Enter':
          if (interactive) {
            event.preventDefault();
            activateRow(row, event);
          }
          break;
        case ' ':
          if (selectable) {
            event.preventDefault();
            toggleRow(getRowId(row, index));
          }
          break;
        default:
          break;
      }
    },
    [activateRow, getRowId, interactive, selectable, toggleRow],
  );

  // Sticky columns ----------------------------------------------------------
  const stickyOffsets = useMemo(() => {
    const offsets = new Map<string, number>();
    let offset = selectable ? SELECT_COLUMN_WIDTH : 0;
    for (const column of visibleColumns) {
      if (!column.sticky) continue;
      offsets.set(column.id, offset);
      offset += typeof column.width === 'number' ? column.width : 0;
    }
    return offsets;
  }, [visibleColumns, selectable]);

  // Export ------------------------------------------------------------------
  const exportSource = exportRows ?? rows;

  /**
   * CSV rows are keyed by header text, so two columns sharing a label (two "Score" columns, say)
   * would collapse into one and silently drop a column from every export. Disambiguate up front.
   */
  const exportHeaders = useMemo(() => {
    const used = new Set<string>();
    return visibleColumns.map((column) => {
      const base = columnLabel(column);
      let header = base;
      let suffix = 2;
      while (used.has(header)) header = `${base} (${suffix++})`;
      used.add(header);
      return { column, header };
    });
  }, [visibleColumns]);

  const buildExportRows = useCallback(
    (): CsvRow[] =>
      exportSource.map((row) => {
        const output: CsvRow = {};
        for (const { column, header } of exportHeaders) {
          output[header] = column.exportValue ? column.exportValue(row) : coerceCsvCell(column.accessor(row));
        }
        return output;
      }),
    [exportSource, exportHeaders],
  );

  // Rendering ---------------------------------------------------------------
  const columnCount = visibleColumns.length + (selectable ? 1 : 0);
  const cellPadding = activeDensity === 'compact' ? 'px-3 py-1.5' : 'px-3 py-2.5';
  const showToolbar =
    !hideToolbar &&
    (searchable || exportable || toolbar !== undefined || toolbarActions !== undefined || columns.length > 1);

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border border-border bg-card', className)}>
      {showToolbar ? (
        <DataTableToolbar
          search={searchable ? searchValue : undefined}
          onSearchChange={searchable ? handleSearchChange : undefined}
          searchPlaceholder={searchPlaceholder}
          resultCount={loading ? undefined : totalRows}
          columns={columnOptions}
          onColumnVisibilityChange={handleColumnVisibility}
          onResetColumns={() => setHiddenIds(defaultHiddenIds)}
          filters={filterPills}
          onClearFilters={onClearFilters}
          density={activeDensity}
          onDensityChange={handleDensityChange}
          exportConfig={
            exportable
              ? {
                  rows: buildExportRows,
                  filename: exportFilename,
                  // Gate on what would actually be written, not on what happens to be on screen —
                  // `exportRows` may hold the full result set while this page renders none.
                  disabled: loading || exportSource.length === 0,
                }
              : undefined
          }
          actions={toolbarActions}
        >
          {toolbar}
        </DataTableToolbar>
      ) : null}

      {selectable && selectedOnPage.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-y border-border bg-primary/5 px-3 py-2">
          <span className="tabular text-xs font-medium text-foreground">
            {formatNumber(selection.size)} selected
          </span>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => updateSelection([])}>
            Clear
          </Button>
          <div className="ml-auto flex items-center gap-1.5">{bulkActions?.(selectedRows, selectedIdList)}</div>
        </div>
      ) : null}

      <div
        className="relative w-full overflow-auto"
        style={maxHeight === undefined ? undefined : { maxHeight }}
      >
        <table className="w-full border-separate border-spacing-0 text-left text-sm" aria-busy={loading || undefined}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}

          <thead>
            <tr>
              {selectable ? (
                <th
                  scope="col"
                  style={{ width: SELECT_COLUMN_WIDTH, left: 0 }}
                  className={cn(
                    'sticky left-0 z-30 border-b border-border bg-muted/60 px-3 py-2',
                    stickyHeader && 'top-0',
                  )}
                >
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(checked) => toggleAll(checked === true)}
                    aria-label={allSelected ? 'Deselect all rows' : 'Select all rows on this page'}
                    disabled={rows.length === 0}
                  />
                </th>
              ) : null}

              {visibleColumns.map((column) => {
                const isSorted = activeSortId === column.id;
                const offset = stickyOffsets.get(column.id);
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      column.sortable ? (isSorted ? (activeOrder === 'asc' ? 'ascending' : 'descending') : 'none') : undefined
                    }
                    style={{ width: column.width, left: offset }}
                    className={cn(
                      'whitespace-nowrap border-b border-border bg-muted/60 text-2xs font-semibold uppercase tracking-wide text-muted-foreground',
                      activeDensity === 'compact' ? 'px-3 py-1.5' : 'px-3 py-2',
                      stickyHeader && 'sticky top-0 z-20',
                      offset !== undefined && 'sticky z-30',
                      ALIGN_CLASS[column.align ?? 'left'],
                      column.headerClassName,
                    )}
                  >
                    {column.sortable ? (
                      <button
                        type="button"
                        onClick={() => handleSort(column)}
                        className={cn(
                          'group -mx-1 inline-flex max-w-full items-center gap-1 rounded-sm px-1 py-0.5 text-2xs font-semibold uppercase tracking-wide transition-colors hover:text-foreground',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isSorted && 'text-foreground',
                          column.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        <span className="truncate">{column.header}</span>
                        {isSorted ? (
                          activeOrder === 'asc' ? (
                            <ArrowUp className="size-3 shrink-0" aria-hidden="true" />
                          ) : (
                            <ArrowDown className="size-3 shrink-0" aria-hidden="true" />
                          )
                        ) : (
                          <ChevronsUpDown
                            className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60"
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }, (_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`}>
                    {selectable ? (
                      <td className={cn('border-b border-border/60', cellPadding)}>
                        <Skeleton className="size-4 rounded-[4px]" />
                      </td>
                    ) : null}
                    {visibleColumns.map((column, columnIndex) => (
                      <td key={column.id} className={cn('border-b border-border/60', cellPadding)}>
                        <Skeleton className={cn('h-3.5', columnIndex === 0 ? 'w-3/4' : 'w-1/2')} />
                      </td>
                    ))}
                  </tr>
                ))
              : null}

            {!loading && rows.length === 0 ? (
              <tr>
                <td colSpan={columnCount} className="px-3">
                  {emptyState ?? (
                    <EmptyState
                      icon={Inbox}
                      size="sm"
                      title={emptyTitle}
                      description={
                        emptyDescription ??
                        (searchValue.length > 0 ? `No rows match “${searchValue}”.` : undefined)
                      }
                    />
                  )}
                </td>
              </tr>
            ) : null}

            {!loading
              ? rows.map((row, index) => {
                  const id = rowIds[index] ?? String(index);
                  const isSelected = selection.has(id);
                  return (
                    <tr
                      key={id}
                      ref={(element) => {
                        rowRefs.current[index] = element;
                      }}
                      tabIndex={keyboardNavigable ? (index === Math.min(focusedIndex, rows.length - 1) ? 0 : -1) : undefined}
                      onFocus={keyboardNavigable ? () => setFocusedIndex(index) : undefined}
                      onKeyDown={keyboardNavigable ? (event) => handleRowKeyDown(event, row, index) : undefined}
                      onClick={
                        interactive
                          ? (event) => {
                              if (isInteractiveTarget(event.target)) return;
                              activateRow(row, event);
                            }
                          : undefined
                      }
                      aria-selected={selectable ? isSelected : undefined}
                      className={cn(
                        'group transition-colors',
                        'hover:bg-muted/40',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                        interactive && 'cursor-pointer',
                        isSelected && 'bg-primary/5',
                        rowClassName?.(row),
                      )}
                    >
                      {selectable ? (
                        <td
                          style={{ left: 0 }}
                          className={cn(
                            'sticky left-0 z-10 border-b border-border/60 bg-card px-3',
                            activeDensity === 'compact' ? 'py-1.5' : 'py-2.5',
                            isSelected && 'bg-primary/5',
                          )}
                        >
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleRow(id)}
                            aria-label={`Select row ${index + 1}`}
                          />
                        </td>
                      ) : null}

                      {visibleColumns.map((column) => {
                        const offset = stickyOffsets.get(column.id);
                        return (
                          <td
                            key={column.id}
                            style={{ width: column.width, left: offset }}
                            className={cn(
                              'border-b border-border/60 align-middle',
                              cellPadding,
                              ALIGN_CLASS[column.align ?? 'left'],
                              offset !== undefined && 'sticky z-10 bg-card',
                              offset !== undefined && isSelected && 'bg-primary/5',
                              column.className,
                            )}
                          >
                            {column.cell ? column.cell(row) : defaultCellText(column.accessor(row))}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })
              : null}
          </tbody>
        </table>
      </div>

      {paginated ? (
        // Kept mounted (just inert) while a page loads: unmounting it collapses the footer and
        // shifts the whole table up on every server-side page change.
        <Pagination
          page={activePage}
          pageSize={activePageSize}
          total={totalRows}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
          pageSizeOptions={pageSizeOptions}
          itemLabel={itemLabel}
          disabled={loading}
        />
      ) : null}
    </div>
  );
}
