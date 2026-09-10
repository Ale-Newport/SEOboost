'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { KeyRound, Layers, Plug, Sparkles, Upload } from 'lucide-react';
import { toast } from 'sonner';
import type { Paginated } from '@seo/shared';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useTableParams } from '@/components/data/use-table-params';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';
import type { KeywordFacets, KeywordListItem } from '@/server/queries/keywords';

import { KeywordClustersPanel } from './keyword-clusters-panel';
import { KeywordDetailSheet } from './keyword-detail-sheet';
import { KeywordFilters } from './keyword-filters';
import { KeywordKpis } from './keyword-kpis';
import { KeywordTable } from './keyword-table';
import {
  KEYWORD_IMPORT_MAX_BYTES,
  KEYWORD_IMPORT_MAX_ROWS,
  parseKeywordImport,
  type ParsedImport,
} from './keyword-csv';
import type { KeywordClusterRow, KeywordProfile } from './types';

/**
 * The Keywords screen.
 *
 * Everything that decides which rows are on screen — filters, sort, page, the open keyword and
 * the active tab — lives in the URL, so this component holds no list state of its own and the
 * server query beside it reads exactly what the user sees. The only local state is the import
 * dialog, which is a draft that has not been committed anywhere yet.
 */

export interface KeywordsViewProps {
  website: { id: string; name: string; domain: string; url: string };
  keywords: Paginated<KeywordListItem>;
  facets: KeywordFacets;
  clusters: KeywordClusterRow[];
  /** Resolved from `?id=` on the server, so an opened keyword survives a refresh. */
  selected: KeywordProfile | null;
  searchConsoleConnected: boolean;
  /** Applied to imported rows that do not carry a locale of their own. */
  defaultLocale: string;
}

interface ImportResponse {
  received: number;
  created: number;
  updated: number;
  duplicatesInFile: number;
  invalid: number;
  locale: string;
}

const TABS = ['keywords', 'clusters'] as const;
type TabValue = (typeof TABS)[number];

function isTab(value: string | null): value is TabValue {
  return value !== null && (TABS as readonly string[]).includes(value);
}

const PREVIEW_ROWS = 5;

export function KeywordsView({
  website,
  keywords,
  facets,
  clusters,
  selected,
  searchConsoleConnected,
  defaultLocale,
}: KeywordsViewProps): React.JSX.Element {
  const router = useRouter();
  const { getParam, setParams, setFilters } = useTableParams({ defaultSort: 'opportunityScore' });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [researching, setResearching] = useState(false);

  const tabParam = getParam('tab');
  const tab: TabValue = isTab(tabParam) ? tabParam : 'keywords';

  const parsed: ParsedImport | null = useMemo(
    () => (importText.trim() === '' ? null : parseKeywordImport(importText)),
    [importText],
  );

  const openKeyword = useCallback((keywordId: string) => setParams({ id: keywordId }), [setParams]);

  const filterToCluster = useCallback(
    (clusterId: string) => setFilters({ tab: null, clusterId }),
    [setFilters],
  );

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (file.size > KEYWORD_IMPORT_MAX_BYTES) {
      toast.error('That file is too large', {
        description: `The importer accepts up to ${formatNumber(Math.round(KEYWORD_IMPORT_MAX_BYTES / 1_000_000))} MB. Split it and import in parts.`,
      });
      return;
    }
    try {
      setImportText(await file.text());
    } catch {
      toast.error('Could not read that file', { description: 'Try pasting its contents instead.' });
    }
  }, []);

  const submitImport = useCallback(async () => {
    if (!parsed || parsed.rows.length === 0) return;
    setImporting(true);
    try {
      const result = await apiPost<ImportResponse>(`/api/websites/${website.id}/keywords/import`, {
        keywords: parsed.rows,
        source: 'CSV_IMPORT',
        locale: defaultLocale,
      });
      toast.success(`${formatNumber(result.created)} keyword${result.created === 1 ? '' : 's'} added`, {
        description:
          `${formatNumber(result.updated)} existing row${result.updated === 1 ? ' was' : 's were'} updated. ` +
          `Positions and traffic fill in from Search Console; volume and difficulty only from what the file carried.`,
      });
      setImportOpen(false);
      setImportText('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'The import failed');
    } finally {
      setImporting(false);
    }
  }, [defaultLocale, parsed, router, website.id]);

  const runResearch = useCallback(async () => {
    setResearching(true);
    try {
      const result = await apiPost<{ job?: { enqueued: boolean; message: string }; status?: string; reason?: string }>(
        '/api/agents/keyword/run',
        { websiteId: website.id },
      );
      if (result.status === 'skipped') {
        toast.warning('The agent did not run', { description: result.reason ?? 'Nothing to work from.' });
      } else if (result.job && !result.job.enqueued) {
        toast.warning('Queued, but no worker picked it up', { description: result.job.message });
      } else {
        toast.success('Keyword research is running', {
          description:
            'It reads Search Console and the crawl to find striking-distance queries, content gaps and cannibalisation, then scores each one. Refresh in a moment.',
        });
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the agent');
    } finally {
      setResearching(false);
    }
  }, [router, website.id]);

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Keywords"
        description={`Every query ${website.domain} is known to compete for, with the opportunity behind each one.`}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <Upload aria-hidden="true" />
              Import
            </Button>
            <Button size="sm" onClick={() => void runResearch()} loading={researching} loadingText="Starting">
              <Sparkles aria-hidden="true" />
              Run keyword research
            </Button>
          </>
        }
      />

      {!searchConsoleConnected ? (
        <Alert variant="warning">
          <AlertTitle>Search Console is not connected for this site</AlertTitle>
          <AlertDescription>
            Positions, clicks, impressions and CTR all come from Search Console. Without it, imported keywords
            stay unranked and the opportunity score has no demand signal to weigh.{' '}
            <Link href={`/sites/${website.id}/settings?tab=integrations`}>Connect it in settings</Link>.
          </AlertDescription>
        </Alert>
      ) : null}

      <KeywordKpis facets={facets} />

      <Tabs value={tab} onValueChange={(next) => setFilters({ tab: next === 'keywords' ? null : next })}>
        <TabsList>
          <TabsTrigger value="keywords">
            <KeyRound aria-hidden="true" />
            Keywords
            <span className="tabular text-muted-foreground">{formatNumber(facets.total)}</span>
          </TabsTrigger>
          <TabsTrigger value="clusters">
            <Layers aria-hidden="true" />
            Clusters
            <span className="tabular text-muted-foreground">{formatNumber(clusters.length)}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="keywords" className="pt-4">
          <KeywordTable
            websiteId={website.id}
            result={keywords}
            hasAnyKeywords={facets.total > 0}
            filters={<KeywordFilters facets={facets} />}
            onImportRequested={() => setImportOpen(true)}
          />
        </TabsContent>

        <TabsContent value="clusters" className="pt-4">
          <KeywordClustersPanel
            websiteId={website.id}
            clusters={clusters}
            totalKeywords={facets.total}
            unclustered={facets.unclustered}
            onOpenKeyword={openKeyword}
            onFilterToCluster={filterToCluster}
          />
        </TabsContent>
      </Tabs>

      <KeywordDetailSheet websiteId={website.id} profile={selected} />

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setImportText('');
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Import keywords</DialogTitle>
            <DialogDescription>
              Paste a list or drop in a CSV export. One keyword per line, or a header row with any of{' '}
              <span className="font-mono text-xs">keyword</span>,{' '}
              <span className="font-mono text-xs">volume</span>,{' '}
              <span className="font-mono text-xs">difficulty</span>,{' '}
              <span className="font-mono text-xs">cpc</span>,{' '}
              <span className="font-mono text-xs">locale</span>,{' '}
              <span className="font-mono text-xs">intent</span>. The preview below is exactly what will be
              written.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="keyword-import-text">Keywords</Label>
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  id="keyword-import-file"
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv,text/plain"
                  aria-label="Choose a keyword CSV or text file"
                  className="sr-only"
                  onChange={(event) => {
                    void handleFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Upload aria-hidden="true" />
                  Choose a file
                </Button>
              </div>
            </div>

            <Textarea
              id="keyword-import-text"
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={8}
              placeholder={'best running shoes\nrunning shoes for flat feet\n…'}
              className="font-mono text-xs"
              aria-describedby="keyword-import-summary"
            />

            <div id="keyword-import-summary" aria-live="polite">
              {parsed === null ? (
                <p className="text-2xs text-muted-foreground">
                  Nothing pasted yet. Up to {formatNumber(KEYWORD_IMPORT_MAX_ROWS)} rows per import.
                </p>
              ) : (
                <div className="space-y-2 rounded-md border border-border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={parsed.rows.length > 0 ? 'success' : 'destructive'}>
                      {formatNumber(parsed.rows.length)} to import
                    </Badge>
                    {parsed.duplicates > 0 ? (
                      <Badge variant="muted">{formatNumber(parsed.duplicates)} duplicate rows dropped</Badge>
                    ) : null}
                    {parsed.issues.length > 0 ? (
                      <Badge variant="warning">{formatNumber(parsed.issues.length)} rows with problems</Badge>
                    ) : null}
                    {parsed.truncated ? (
                      <Badge variant="warning">Only the first {formatNumber(KEYWORD_IMPORT_MAX_ROWS)} rows</Badge>
                    ) : null}
                    <Badge variant="outline">
                      {parsed.hasHeader ? `Columns: ${parsed.mappedColumns.join(', ')}` : 'No header — read as one keyword per line'}
                    </Badge>
                  </div>

                  {parsed.ignoredColumns.length > 0 ? (
                    <p className="text-2xs text-muted-foreground">
                      Ignored columns: {parsed.ignoredColumns.join(', ')}.
                    </p>
                  ) : null}

                  {parsed.rows.length > 0 ? (
                    <ul className="space-y-0.5">
                      {parsed.rows.slice(0, PREVIEW_ROWS).map((row) => (
                        <li key={`${row.keyword}-${row.locale ?? ''}`} className="flex flex-wrap items-baseline gap-2 text-xs">
                          <span className="font-medium text-foreground">{row.keyword}</span>
                          <span className="text-2xs text-muted-foreground">
                            {row.locale ?? defaultLocale}
                            {row.searchVolume === undefined ? '' : ` · vol ${formatNumber(row.searchVolume)}`}
                            {row.difficulty === undefined ? '' : ` · KD ${row.difficulty}`}
                            {row.intent === undefined ? '' : ` · ${row.intent.toLowerCase()}`}
                          </span>
                        </li>
                      ))}
                      {parsed.rows.length > PREVIEW_ROWS ? (
                        <li className="text-2xs text-muted-foreground">
                          …and {formatNumber(parsed.rows.length - PREVIEW_ROWS)} more.
                        </li>
                      ) : null}
                    </ul>
                  ) : null}

                  {parsed.issues.length > 0 ? (
                    <ul className="space-y-0.5">
                      {parsed.issues.slice(0, PREVIEW_ROWS).map((issue) => (
                        <li key={`${issue.line}-${issue.message}`} className="text-2xs text-warning">
                          Line {issue.line}: {issue.message}
                          {issue.value === '' ? '' : ` (“${issue.value}”)`}
                        </li>
                      ))}
                      {parsed.issues.length > PREVIEW_ROWS ? (
                        <li className="text-2xs text-muted-foreground">
                          …and {formatNumber(parsed.issues.length - PREVIEW_ROWS)} more problems. Rows with
                          problems are skipped, the rest still import.
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </div>
              )}
            </div>

            <p className="flex items-start gap-1.5 text-2xs leading-relaxed text-muted-foreground">
              <Plug className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              Volume, difficulty and CPC are stored exactly as the file states them and attributed to the
              import — this app never estimates them. Rows that already exist are updated, never duplicated.
            </p>
          </div>

          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setImportOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => void submitImport()}
              disabled={parsed === null || parsed.rows.length === 0}
              loading={importing}
              loadingText="Importing"
            >
              Import {parsed === null ? '' : formatNumber(parsed.rows.length)} keyword
              {parsed !== null && parsed.rows.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
