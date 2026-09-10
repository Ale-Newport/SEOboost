'use client';

import * as React from 'react';
import { FileJson } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { ExportButton } from '@/components/data/export-button';
import type { CsvRow } from '@/components/data/csv';
import { reportExportRows, type ParsedReport } from './report-data';

export interface ReportExportBarProps {
  reportId: string;
  filename: string;
  parsed: ParsedReport;
  /** The stored payload plus the report header — exactly what the JSON download contains. */
  payload: unknown;
}

/**
 * Downloads for one report.
 *
 * CSV and JSON are produced in the browser from the data already on the page, so no round trip
 * is needed for the common case. The "stored payload" link goes to the existing server export
 * route instead, which streams the `data` column verbatim — useful when the reader wants the
 * untouched generator output rather than this screen's flattening of it.
 */
export function ReportExportBar({
  reportId,
  filename,
  parsed,
  payload,
}: ReportExportBarProps): React.JSX.Element {
  const rows = React.useCallback((): readonly CsvRow[] => reportExportRows(parsed), [parsed]);
  const json = React.useCallback((): unknown => payload, [payload]);

  return (
    <div className="flex items-center gap-2">
      <SimpleTooltip content="The generator's raw payload, straight from the database.">
        <Button asChild variant="ghost" size="sm">
          <a href={`/api/reports/${reportId}/export?format=json`} download>
            <FileJson aria-hidden="true" />
            Stored payload
          </a>
        </Button>
      </SimpleTooltip>
      <ExportButton rows={rows} json={json} filename={filename} label="Export" />
    </div>
  );
}
