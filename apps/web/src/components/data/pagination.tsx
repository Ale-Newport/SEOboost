'use client';

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, formatNumber } from '@/lib/utils';

export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200] as const;

export interface PaginationProps {
  page: number;
  pageSize: number;
  /** Total rows across every page. `0` renders the range as "0 of 0". */
  total: number;
  onPageChange: (page: number) => void;
  /** Omit to hide the page-size control entirely. */
  onPageSizeChange?: (pageSize: number) => void;
  pageSizeOptions?: readonly number[];
  /** Plural noun for the range summary, e.g. "keywords". */
  itemLabel?: string;
  /** Blocks every control while a fetch is in flight. */
  disabled?: boolean;
  className?: string;
}

/** Total page count, never below 1 so the label reads "Page 1 of 1" on an empty list. */
export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Server-driven pager. It owns no state: the caller keeps `page` in the URL (see
 * `useTableParams`) so the position survives a refresh and can be shared.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  itemLabel = 'results',
  disabled = false,
  className,
}: PaginationProps): React.JSX.Element {
  const pages = pageCount(total, pageSize);
  const current = Math.min(Math.max(1, page), pages);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = total === 0 ? 0 : Math.min(current * pageSize, total);

  const atStart = disabled || current <= 1;
  const atEnd = disabled || current >= pages;

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-3 py-2.5',
        className,
      )}
    >
      <p className="tabular text-xs text-muted-foreground" aria-live="polite">
        {total === 0 ? (
          <>No {itemLabel}</>
        ) : (
          <>
            <span className="font-medium text-foreground">
              {formatNumber(first)}–{formatNumber(last)}
            </span>{' '}
            of <span className="font-medium text-foreground">{formatNumber(total)}</span> {itemLabel}
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        {onPageSizeChange ? (
          <div className="flex items-center gap-1.5">
            <label htmlFor="pagination-page-size" className="text-xs text-muted-foreground">
              Rows
            </label>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => onPageSizeChange(Number(value))}
              disabled={disabled}
            >
              <SelectTrigger id="pagination-page-size" className="h-8 w-[4.5rem] text-xs" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((option) => (
                  <SelectItem key={option} value={String(option)} className="text-xs">
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <p className="tabular whitespace-nowrap text-xs text-muted-foreground">
          Page <span className="font-medium text-foreground">{formatNumber(current)}</span> of{' '}
          {formatNumber(pages)}
        </p>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="First page"
            disabled={atStart}
            onClick={() => onPageChange(1)}
          >
            <ChevronsLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Previous page"
            disabled={atStart}
            onClick={() => onPageChange(current - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Next page"
            disabled={atEnd}
            onClick={() => onPageChange(current + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            aria-label="Last page"
            disabled={atEnd}
            onClick={() => onPageChange(pages)}
          >
            <ChevronsRight aria-hidden="true" />
          </Button>
        </div>
      </div>
    </nav>
  );
}
