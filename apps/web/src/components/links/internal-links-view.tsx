'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Layers, Link2, Network, Play, Radar, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/error-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTableParams } from '@/components/data/use-table-params';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import { formatNumber } from '@/lib/utils';
import { AnchorAuditPanel } from './anchor-audit-panel';
import { LinkSuggestionsPanel } from './link-suggestions-panel';
import { OrphanPagesPanel } from './orphan-pages-panel';
import type {
  CmsAdapterSummary,
  EnqueueSummaryDto,
  LinkGraphResponse,
  LinksResponse,
  SkippedDto,
} from './types';

/** Enough orphans to work through in one sitting without shipping the whole long tail. */
const ORPHAN_LIMIT = 200;

type TabId = 'suggestions' | 'orphans' | 'anchors';

const TAB_IDS: readonly TabId[] = ['suggestions', 'orphans', 'anchors'];

interface SuggestResponse extends SkippedDto {
  pagesInScope?: number;
  job?: EnqueueSummaryDto;
}

export interface InternalLinksViewProps {
  websiteId: string;
  websiteName: string;
  siteUrl: string;
  hasCrawl: boolean;
  adapters: CmsAdapterSummary[];
}

export function InternalLinksView({
  websiteId,
  websiteName,
  siteUrl,
  hasCrawl,
  adapters,
}: InternalLinksViewProps): React.JSX.Element {
  const params = useTableParams({ defaultPageSize: 25 });
  const { page, pageSize, setPage, setPageSize, setFilters, getParam, getParamList } = params;

  const statusKey = getParamList('status').join(',');
  const tab = resolveTab(getParam('tab'));

  const [data, setData] = useState<LinksResponse | null>(null);
  const [graph, setGraph] = useState<LinkGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [graphLoading, setGraphLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [analysisRunning, setAnalysisRunning] = useState(false);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const query = new URLSearchParams({
      websiteId,
      page: String(page),
      pageSize: String(pageSize),
      orphanLimit: String(ORPHAN_LIMIT),
    });
    for (const status of statusKey.length > 0 ? statusKey.split(',') : []) query.append('status', status);

    apiGet<LinksResponse>(`/api/links?${query.toString()}`)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : 'The internal link data could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [websiteId, page, pageSize, statusKey, reloadToken]);

  /*
   * Average inbound links and the connected-component count are properties of the whole graph,
   * not of any page of suggestions, so they come from the graph endpoint. `maxNodes`/`maxEdges`
   * are floored: `stats` is always computed over the full graph and only the *rendered* sample is
   * decimated, so asking for ten nodes buys the same numbers for a fraction of the payload.
   */
  useEffect(() => {
    let cancelled = false;
    setGraphLoading(true);

    apiGet<LinkGraphResponse>(`/api/links/graph?websiteId=${encodeURIComponent(websiteId)}&maxNodes=10&maxEdges=10`)
      .then((response) => {
        if (!cancelled) setGraph(response);
      })
      .catch(() => {
        // The KPI tiles degrade to "—"; a failed side query must not blank the whole screen.
        if (!cancelled) setGraph(null);
      })
      .finally(() => {
        if (!cancelled) setGraphLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [websiteId, reloadToken]);

  const applyAdapter = useMemo(() => adapters.find((adapter) => adapter.canUpdateContent) ?? null, [adapters]);

  const runAnalysis = useCallback(async (): Promise<void> => {
    setAnalysisRunning(true);
    try {
      const result = await apiPost<SuggestResponse>('/api/links/suggest', { websiteId });
      if (result.status === 'skipped') {
        toast.warning(result.reason ?? 'The analysis did not run.', { description: result.fix });
        return;
      }
      if (result.job && result.job.enqueued === false) {
        toast.warning('Recorded, but no worker picked it up', { description: result.job.message });
      } else {
        toast.success('Internal link analysis queued', {
          description: `Reading ${formatNumber(result.pagesInScope ?? 0)} pages. Suggestions appear here when it finishes.`,
        });
      }
      refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : 'The analysis could not be started.');
    } finally {
      setAnalysisRunning(false);
    }
  }, [websiteId, refresh]);

  const stats = graph?.stats ?? null;
  const pending = data?.suggestions.byStatus.PENDING ?? 0;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Internal links"
        description={
          <>
            Link opportunities, orphan pages and anchor health for{' '}
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              {websiteName}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/sites/${websiteId}/architecture`}>
                <Network className="size-3.5" aria-hidden="true" />
                Site architecture
              </Link>
            </Button>
            <Button
              size="sm"
              onClick={() => void runAnalysis()}
              loading={analysisRunning}
              loadingText="Queueing"
              disabled={!hasCrawl}
            >
              <Play className="size-3.5" aria-hidden="true" />
              Run link analysis
            </Button>
          </div>
        }
      />

      {hasCrawl ? null : (
        <Alert variant="warning">
          <AlertTitle>This site has not been crawled yet</AlertTitle>
          <AlertDescription>
            Every number on this screen is derived from a completed crawl: the link graph comes from the
            crawler’s recorded edges and the suggestions come from crawled page text.{' '}
            <Link href={`/sites/${websiteId}`}>Start a crawl from the site overview</Link>.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="Orphan pages"
          value={data ? formatNumber(data.orphans.total) : '—'}
          loading={loading && data === null}
          icon={Radar}
          info="Active pages with zero inbound internal links in the last completed crawl."
          footer={
            data && data.orphans.total > 0
              ? 'No internal authority reaches these'
              : 'Every page has at least one inbound link'
          }
        />
        <MetricCard
          label="Pending suggestions"
          value={data ? formatNumber(pending) : '—'}
          loading={loading && data === null}
          icon={Sparkles}
          info="Proposed links waiting for a decision. Approving does not change the site; applying does."
          footer={`${formatNumber(data?.suggestions.byStatus.APPROVED ?? 0)} approved and ready to apply`}
        />
        <MetricCard
          label="Avg. inbound links"
          value={stats ? stats.avgInboundLinks.toFixed(1) : '—'}
          loading={graphLoading && graph === null}
          icon={Link2}
          info="Mean inbound internal links per page across the whole site, from the crawled link graph."
          footer={stats ? `${stats.avgOutboundLinks.toFixed(1)} outbound on average` : 'Needs a completed crawl'}
        />
        <MetricCard
          label="Isolated clusters"
          value={stats ? formatNumber(stats.components) : '—'}
          loading={graphLoading && graph === null}
          icon={Layers}
          info="Connected components in the undirected link graph. One means every page is reachable from every other by following internal links; more than one means islands."
          footer={
            stats
              ? stats.components <= 1
                ? 'The site is one connected graph'
                : `${formatNumber(stats.components - 1)} island${stats.components === 2 ? '' : 's'} to connect`
              : 'Needs a completed crawl'
          }
        />
      </div>

      {error === null ? null : (
        <ErrorState message={error} onRetry={refresh} retryLabel="Try again" bordered />
      )}

      <Tabs value={tab} onValueChange={(next) => setFilters({ tab: next === 'suggestions' ? null : next })}>
        <TabsList>
          <TabsTrigger value="suggestions">
            Suggestions
            {data ? <span className="tabular text-muted-foreground">{formatNumber(data.suggestions.total)}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="orphans">
            Orphans
            {data ? <span className="tabular text-muted-foreground">{formatNumber(data.orphans.total)}</span> : null}
          </TabsTrigger>
          <TabsTrigger value="anchors">
            Anchor audit
            {data ? <span className="tabular text-muted-foreground">{formatNumber(data.anchorAudit.length)}</span> : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="suggestions">
          <LinkSuggestionsPanel
            websiteId={websiteId}
            suggestions={data?.suggestions ?? null}
            loading={loading}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            onRefresh={refresh}
            canApply={applyAdapter !== null}
            adapterLabel={applyAdapter?.label ?? null}
            hasCrawl={hasCrawl}
            onRunAnalysis={() => void runAnalysis()}
            analysisRunning={analysisRunning}
          />
        </TabsContent>

        <TabsContent value="orphans">
          <OrphanPagesPanel
            orphans={data?.orphans ?? null}
            loading={loading}
            hasCrawl={hasCrawl}
            onFindLinks={runAnalysis}
            analysisRunning={analysisRunning}
          />
        </TabsContent>

        <TabsContent value="anchors">
          <AnchorAuditPanel
            audits={data?.anchorAudit ?? null}
            loading={loading}
            hasCrawl={hasCrawl}
            crawledAt={data?.source.crawledAt ?? null}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Unknown `?tab=` values fall back rather than rendering an empty tab panel. */
function resolveTab(raw: string | null): TabId {
  return TAB_IDS.includes(raw as TabId) ? (raw as TabId) : 'suggestions';
}
