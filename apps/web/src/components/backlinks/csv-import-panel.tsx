'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileUp, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';

/**
 * CSV ingestion — the reason this feature has no hard dependency on a paid backlink API.
 *
 * Every analysis in the product runs off stored rows, so a vendor export dropped in here produces
 * exactly the same profile, velocity and suspicious-link findings a provider integration would.
 * The importer detects the column mapping and reports it back, so the operator can see what was
 * understood rather than trusting a silent parse.
 */

interface ImportResponse {
  totalRows: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: string[];
  detectedColumns: Record<string, string>;
}

/** Columns the parser recognises, named so an operator can fix a file before uploading it. */
const RECOGNISED = [
  'referring domain',
  'source URL',
  'target URL',
  'anchor text',
  'first seen',
  'last seen',
  'dofollow / nofollow / link type',
  'lost',
  'domain authority',
];

export function CsvImportPanel({
  websiteId,
  maxCsvRows,
  anyProviderConfigured,
}: {
  websiteId: string;
  maxCsvRows: number;
  anyProviderConfigured: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);

  const send = useCallback(
    async (text: string) => {
      if (!text.trim()) {
        setError('Choose a file or paste the export first.');
        return;
      }
      setPending(true);
      setError(null);
      try {
        const response = await apiPost<ImportResponse>('/api/integrations/backlinks/import', {
          websiteId,
          csv: text,
        });
        setResult(response);
        toast.success(
          `${formatNumber(response.inserted)} new, ${formatNumber(response.updated)} updated`,
          {
            description:
              response.skipped > 0
                ? `${formatNumber(response.skipped)} row(s) were dropped in validation — see the detail below.`
                : `${formatNumber(response.totalRows)} data row(s) read from the file.`,
            duration: 8_000,
          },
        );
        setCsv('');
        if (fileInput.current) fileInput.current.value = '';
        router.refresh();
      } catch (cause) {
        setError(cause instanceof ApiError ? cause.message : 'Could not import that file.');
      } finally {
        setPending(false);
      }
    },
    [router, websiteId],
  );

  const onFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        await send(await file.text());
      } catch {
        setError('That file could not be read as text.');
      }
    },
    [send],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileUp aria-hidden="true" className="size-4 text-muted-foreground" />
          Import a backlink export
        </CardTitle>
        <CardDescription>
          {anyProviderConfigured
            ? 'Works alongside your configured provider — an import tops up the same table the provider writes to, and duplicates are merged on the source/target pair.'
            : 'No backlink provider is configured, and none is required. Everything on this screen is computed from stored rows, so a CSV from any vendor gives you the full profile.'}{' '}
          Up to {formatNumber(maxCsvRows)} rows per file.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInput.current?.click()}
            disabled={pending}
          >
            <Upload aria-hidden="true" />
            Choose a CSV file
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            aria-label="Backlink export CSV file"
            onChange={(event) => void onFile(event)}
          />
          <p className="text-2xs text-muted-foreground">
            Recognised columns: {RECOGNISED.join(', ')}. Header order does not matter.
          </p>
        </div>

        <FormField
          label="Or paste the export"
          description="Header row plus data rows. Useful for a quick check before wiring up a scheduled export."
          {...(error ? { error } : {})}
        >
          <Textarea
            value={csv}
            onChange={(event) => setCsv(event.target.value)}
            rows={4}
            placeholder="referring domain,source url,target url,anchor,first seen,dofollow"
            className="font-mono text-2xs"
          />
        </FormField>

        <div className="flex justify-end">
          <Button size="sm" loading={pending} loadingText="Importing" onClick={() => void send(csv)}>
            Import rows
          </Button>
        </div>

        {result ? (
          <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground">
              {formatNumber(result.totalRows)} data row(s) read · {formatNumber(result.inserted)} inserted ·{' '}
              {formatNumber(result.updated)} updated · {formatNumber(result.unchanged)} unchanged ·{' '}
              {formatNumber(result.skipped)} skipped
            </p>
            <p className="text-2xs text-muted-foreground">
              Columns understood:{' '}
              {Object.entries(result.detectedColumns).length === 0
                ? 'none — check the header row.'
                : Object.entries(result.detectedColumns)
                    .map(([header, field]) => `${header} → ${field}`)
                    .join(', ')}
            </p>
            {result.errors.length > 0 ? (
              <ul className="space-y-0.5 text-2xs text-warning">
                {result.errors.slice(0, 5).map((message) => (
                  <li key={message}>{message}</li>
                ))}
                {result.errors.length > 5 ? (
                  <li className="text-muted-foreground">
                    +{formatNumber(result.errors.length - 5)} more validation message(s)
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
