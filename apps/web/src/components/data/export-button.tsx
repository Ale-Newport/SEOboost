'use client';

import { useCallback, type ReactNode } from 'react';
import { ChevronDown, Download, FileJson, FileSpreadsheet } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { downloadCsv, downloadJson, timestampedFilename, type CsvRow } from './csv';

/** Rows either materialised up front, or produced on demand when the user actually exports. */
export type ExportRows = readonly CsvRow[] | (() => readonly CsvRow[]);

export interface ExportButtonProps {
  /**
   * The dataset to write out. Prefer the function form: serialising a few thousand rows on every
   * render of a table just in case someone clicks export is pure waste.
   */
  rows: ExportRows;
  /** Base filename without extension; a local date is appended (`top-pages-2026-09-09.csv`). */
  filename: string;
  /** Builds the JSON payload. Defaults to the same rows the CSV uses. */
  json?: () => unknown;
  disabled?: boolean;
  label?: ReactNode;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  /** Show only the icon; the label stays available to assistive tech. */
  iconOnly?: boolean;
  className?: string;
}

function resolveRows(rows: ExportRows): readonly CsvRow[] {
  return typeof rows === 'function' ? rows() : rows;
}

/** Download the current dataset as CSV (spreadsheets) or JSON (scripts and re-import). */
export function ExportButton({
  rows,
  filename,
  json,
  disabled = false,
  label = 'Export',
  variant = 'outline',
  size = 'sm',
  iconOnly = false,
  className,
}: ExportButtonProps): React.JSX.Element {
  const handleCsv = useCallback(() => {
    downloadCsv(timestampedFilename(filename), resolveRows(rows));
  }, [filename, rows]);

  const handleJson = useCallback(() => {
    const payload = json === undefined ? resolveRows(rows) : json();
    downloadJson(timestampedFilename(filename), payload);
  }, [filename, json, rows]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size={iconOnly ? 'icon' : size}
          disabled={disabled}
          className={cn(iconOnly && 'size-8', className)}
          aria-label={iconOnly ? 'Export data' : undefined}
        >
          <Download aria-hidden="true" />
          {iconOnly ? null : (
            <>
              {label}
              <ChevronDown className="text-muted-foreground" aria-hidden="true" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[11rem]">
        <DropdownMenuLabel>Download</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={handleCsv}>
          <FileSpreadsheet aria-hidden="true" />
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleJson}>
          <FileJson aria-hidden="true" />
          JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
