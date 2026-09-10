'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, Layers, Link2, MousePointerClick, Network, Radar, Ruler } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Label } from '@/components/ui/label';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { Section, SectionHeader, SectionTitle, SectionDescription } from '@/components/ui/section';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { Switch } from '@/components/ui/switch';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { ChartContainer, seriesColor, useChartColors } from '@/components/charts/chart-container';
import { DistributionChart } from '@/components/charts/distribution-chart';
import { SiteGraph, type SiteGraphNode } from '@/components/charts/site-graph';
import { ApiError, apiGet } from '@/lib/api-client';
import { cn, colorIndex, formatNumber, shortenUrl } from '@/lib/utils';
import {
  authorityBand,
  authorityIndex,
  clusterLabelFor,
  depthHistogram,
  sectionOf,
  type GraphColorMode,
} from './graph-utils';
import type { GraphNodeDto, LinkGraphResponse } from './types';

/** Node caps offered to the operator. The force simulation is O(n²) per tick, so this is bounded. */
const NODE_CAPS = [150, 300, 600] as const;

const AUTHORITY_EXPLANATION =
  'PageRank over this site’s own internal links, normalised so the strongest page scores 100. It is ' +
  'computed over every crawled page, not just the ones drawn, and nofollow links are excluded because ' +
  'they pass no authority.';

export interface SiteArchitectureViewProps {
  websiteId: string;
  websiteName: string;
  siteUrl: string;
  hasCrawl: boolean;
}

export function SiteArchitectureView({
  websiteId,
  websiteName,
  siteUrl,
  hasCrawl,
}: SiteArchitectureViewProps): React.JSX.Element {
  const [maxNodes, setMaxNodes] = useState<number>(300);
  const [indexableOnly, setIndexableOnly] = useState(false);
  const [colorMode, setColorMode] = useState<GraphColorMode>('section');
  const [highlightOrphans, setHighlightOrphans] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [data, setData] = useState<LinkGraphResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const query = new URLSearchParams({
      websiteId,
      maxNodes: String(maxNodes),
      maxEdges: String(Math.min(8000, maxNodes * 8)),
      indexableOnly: String(indexableOnly),
    });

    apiGet<LinkGraphResponse>(`/api/links/graph?${query.toString()}`)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
        setSelectedId(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : 'The link graph could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [websiteId, maxNodes, indexableOnly, reloadToken]);

  const nodes = data?.nodes ?? [];
  const stats = data?.stats ?? null;
  const rendered = data?.rendered ?? null;

  /**
   * `SiteGraph` colours by `cluster` (hashed) or by `depth`, and its own dropdown filters on
   * `cluster`. Feeding `cluster` whatever the chosen colour mode groups by keeps the colour, the
   * hover card and the filter all describing the same dimension.
   */
  const graphNodes = useMemo<SiteGraphNode[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        url: node.url,
        label: node.title ?? shortenUrl(node.url, 40),
        inboundLinks: node.inboundLinks,
        outboundLinks: node.outboundLinks,
        depth: node.depth,
        cluster: clusterLabelFor(node, colorMode),
        isOrphan: highlightOrphans && node.isOrphan,
      })),
    [nodes, colorMode, highlightOrphans],
  );

  const graphEdges = useMemo(
    () => (data?.edges ?? []).map((edge) => ({ source: edge.source, target: edge.target })),
    [data],
  );

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selected = selectedId === null ? null : (nodeById.get(selectedId) ?? null);

  const depthSegments = useMemo(
    () =>
      depthHistogram(nodes).map((bucket) => ({
        id: `depth-${bucket.depth}`,
        label: bucket.depth === 0 ? 'Homepage' : `${bucket.depth} click${bucket.depth === 1 ? '' : 's'}`,
        count: bucket.count,
        colorIndex: Math.min(bucket.depth, 5),
      })),
    [nodes],
  );

  const noGraph = data !== null && nodes.length === 0;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Site architecture"
        description={
          <>
            How internal links actually connect{' '}
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
          <Button asChild variant="outline" size="sm">
            <Link href={`/sites/${websiteId}/links`}>
              <Link2 className="size-3.5" aria-hidden="true" />
              Internal links
            </Link>
          </Button>
        }
      />

      {hasCrawl ? null : (
        <Alert variant="warning">
          <AlertTitle>This site has not been crawled yet</AlertTitle>
          <AlertDescription>
            The graph is drawn from the link edges recorded by the last completed crawl.{' '}
            <Link href={`/sites/${websiteId}`}>Start a crawl from the site overview</Link>.
          </AlertDescription>
        </Alert>
      )}

      {data?.status === 'skipped' ? (
        <Alert variant="neutral">
          <AlertTitle>{data.reason}</AlertTitle>
          <AlertDescription>{data.fix}</AlertDescription>
        </Alert>
      ) : null}

      {error === null ? null : <ErrorState message={error} onRetry={refresh} bordered />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard
          label="Pages in graph"
          value={stats ? formatNumber(stats.pageCount) : '—'}
          loading={loading && data === null}
          icon={Network}
          info="Every crawled page in the link graph. These six figures always describe the whole graph — the canvas below draws only the highest-authority sample allowed by the node cap, so it will usually show fewer."
        />
        <MetricCard
          label="Internal links"
          value={stats ? formatNumber(stats.edgeCount) : '—'}
          loading={loading && data === null}
          icon={Link2}
          info="Internal link edges between crawled pages, counted across the whole graph rather than the drawn sample."
        />
        <MetricCard
          label="Orphans"
          value={stats ? formatNumber(stats.orphanCount) : '—'}
          loading={loading && data === null}
          icon={Radar}
          info="Indexable pages with no inbound internal link. The homepage is never counted."
        />
        <MetricCard
          label="Avg. inbound"
          value={stats ? stats.avgInboundLinks.toFixed(1) : '—'}
          loading={loading && data === null}
          icon={Link2}
          info="Mean inbound internal links per page across the whole crawled graph. A low average with a high max depth usually means link equity is not reaching the deep pages."
          footer={stats ? `${stats.avgOutboundLinks.toFixed(1)} outbound` : undefined}
        />
        <MetricCard
          label="Max depth"
          value={stats ? formatNumber(stats.maxDepth) : '—'}
          loading={loading && data === null}
          icon={Ruler}
          info="Clicks from the homepage to the deepest page found by the crawler."
        />
        <MetricCard
          label="Components"
          value={stats ? formatNumber(stats.components) : '—'}
          loading={loading && data === null}
          icon={Layers}
          info="Islands in the undirected link graph. More than one means part of the site cannot be reached from the rest by following links."
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-3">
          <GraphControls
            colorMode={colorMode}
            onColorModeChange={setColorMode}
            highlightOrphans={highlightOrphans}
            onHighlightOrphansChange={setHighlightOrphans}
            indexableOnly={indexableOnly}
            onIndexableOnlyChange={setIndexableOnly}
            maxNodes={maxNodes}
            onMaxNodesChange={setMaxNodes}
          />

          {noGraph && !loading ? (
            <Card>
              <CardContent className="p-5">
                <EmptyState
                  icon={Network}
                  title="No link graph to draw"
                  description={
                    hasCrawl
                      ? 'The last crawl recorded no internal links between active pages. That usually means the crawl stopped at the homepage — check the crawl’s page count and its robots rules.'
                      : 'Run a crawl. The graph is built from the pages and the internal links the crawler records.'
                  }
                  action={
                    <Button asChild size="sm">
                      <Link href={`/sites/${websiteId}`}>Go to the site overview</Link>
                    </Button>
                  }
                />
              </CardContent>
            </Card>
          ) : (
            <SiteGraph
              nodes={graphNodes}
              edges={graphEdges}
              maxNodes={maxNodes}
              height={560}
              loading={loading && data === null}
              colorBy={colorMode === 'depth' ? 'depth' : 'cluster'}
              onNodeClick={(node) => setSelectedId(node.id)}
              title="Internal link graph"
              description={
                rendered
                  ? rendered.decimated
                    ? `Showing the top ${formatNumber(rendered.nodes)} of ${formatNumber(rendered.totalNodes)} pages by internal authority, and ${formatNumber(rendered.edges)} of ${formatNumber(rendered.totalEdges)} links between them.`
                    : `All ${formatNumber(rendered.nodes)} pages and ${formatNumber(rendered.edges)} internal links.`
                  : 'Drag to pan, scroll to zoom, click a node for its details.'
              }
            />
          )}

          <GraphLegend nodes={nodes} colorMode={colorMode} />
        </div>

        <NodeDetailPanel node={selected} onClear={() => setSelectedId(null)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <DistributionChart
          title="Click depth"
          description={
            rendered?.decimated
              ? `Across the ${formatNumber(nodes.length)} pages drawn. The site has ${formatNumber(rendered.totalNodes)} in total.`
              : 'Clicks from the homepage to each page.'
          }
          segments={depthSegments}
          loading={loading && data === null}
          emptyMessage="No pages to bucket yet — run a crawl."
        />

        <TopPagesCard
          title="Hub pages"
          description="The pages that link out the most. These distribute authority; a hub that points at the wrong pages wastes it."
          rows={(stats?.hubs ?? []).map((hub) => ({
            id: hub.id,
            url: hub.url,
            value: formatNumber(hub.outboundLinks),
            suffix: 'out',
          }))}
          loading={loading && data === null}
          emptyMessage="No outbound internal links recorded yet."
        />

        <TopPagesCard
          title="Top authority pages"
          description={AUTHORITY_EXPLANATION}
          rows={(stats?.authorities ?? []).map((entry) => ({
            id: entry.id,
            url: entry.url,
            value: String(authorityIndex(entry.authority)),
            suffix: '/ 100',
          }))}
          loading={loading && data === null}
          emptyMessage="Authority needs internal links to flow along. None were recorded."
        />
      </div>
    </div>
  );
}

function GraphControls({
  colorMode,
  onColorModeChange,
  highlightOrphans,
  onHighlightOrphansChange,
  indexableOnly,
  onIndexableOnlyChange,
  maxNodes,
  onMaxNodesChange,
}: {
  colorMode: GraphColorMode;
  onColorModeChange: (mode: GraphColorMode) => void;
  highlightOrphans: boolean;
  onHighlightOrphansChange: (value: boolean) => void;
  indexableOnly: boolean;
  onIndexableOnlyChange: (value: boolean) => void;
  maxNodes: number;
  onMaxNodesChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Label htmlFor="graph-color-mode" className="text-xs text-muted-foreground">
          Colour by
        </Label>
        <Select value={colorMode} onValueChange={(next) => onColorModeChange(next as GraphColorMode)}>
          <SelectTrigger id="graph-color-mode" className="h-8 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="section" className="text-xs">
              URL section
            </SelectItem>
            <SelectItem value="depth" className="text-xs">
              Click depth
            </SelectItem>
            <SelectItem value="authority" className="text-xs">
              Internal authority
            </SelectItem>
          </SelectContent>
        </Select>
        <TooltipInfo
          label="What the colour groups mean"
          content={
            <>
              The graph carries no topic-cluster assignment — clusters live on keywords, not on the link
              graph — so “URL section” groups by the first path segment, which is the site’s own structure.
              The graph’s own filter dropdown filters by whichever grouping is selected here.
            </>
          }
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id="graph-highlight-orphans"
          checked={highlightOrphans}
          onCheckedChange={onHighlightOrphansChange}
        />
        <Label htmlFor="graph-highlight-orphans" className="text-xs text-muted-foreground">
          Highlight orphans
        </Label>
      </div>

      <div className="flex items-center gap-2">
        <Switch id="graph-indexable-only" checked={indexableOnly} onCheckedChange={onIndexableOnlyChange} />
        <Label htmlFor="graph-indexable-only" className="text-xs text-muted-foreground">
          Indexable pages only
        </Label>
      </div>

      <div className="flex items-center gap-2">
        <Label htmlFor="graph-max-nodes" className="text-xs text-muted-foreground">
          Draw up to
        </Label>
        <Select value={String(maxNodes)} onValueChange={(next) => onMaxNodesChange(Number(next))}>
          <SelectTrigger id="graph-max-nodes" className="h-8 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NODE_CAPS.map((cap) => (
              <SelectItem key={cap} value={String(cap)} className="text-xs">
                {cap} pages
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/**
 * Mirrors `SiteGraph`'s own colour derivation (`seriesColor` indexed by the hashed cluster name,
 * or by depth) so the key on the page cannot drift from the pixels in the canvas.
 */
function GraphLegend({
  nodes,
  colorMode,
}: {
  nodes: readonly GraphNodeDto[];
  colorMode: GraphColorMode;
}): React.JSX.Element | null {
  const colors = useChartColors();

  const entries = useMemo(() => {
    if (nodes.length === 0) return [];

    if (colorMode === 'depth') {
      const depths = new Map<number, number>();
      for (const node of nodes) depths.set(Math.min(node.depth, 5), (depths.get(Math.min(node.depth, 5)) ?? 0) + 1);
      return [...depths.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([depth, count]) => ({
          key: `depth-${depth}`,
          label: depth === 0 ? 'Homepage' : depth === 5 ? '5+ clicks' : `${depth} click${depth === 1 ? '' : 's'}`,
          count,
          color: seriesColor(colors, depth),
        }));
    }

    const groups = new Map<string, number>();
    for (const node of nodes) {
      const label = colorMode === 'authority' ? authorityBand(node.authority) : sectionOf(node.url);
      groups.set(label, (groups.get(label) ?? 0) + 1);
    }
    return [...groups.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([label, count]) => ({
        key: label,
        label,
        count,
        color: seriesColor(colors, colorIndex(label)),
      }));
  }, [nodes, colorMode, colors]);

  if (entries.length === 0) return null;

  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {entries.map((entry) => (
        <li key={entry.key} className="flex min-w-0 items-center gap-1.5">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="truncate">{entry.label}</span>
          <span className="tabular text-foreground/70">{formatNumber(entry.count)}</span>
        </li>
      ))}
    </ul>
  );
}

function NodeDetailPanel({
  node,
  onClear,
}: {
  node: GraphNodeDto | null;
  onClear: () => void;
}): React.JSX.Element {
  if (node === null) {
    return (
      <Card className="h-fit">
        <CardContent className="p-5">
          <EmptyState
            size="sm"
            icon={MousePointerClick}
            title="Select a page"
            description="Click any node in the graph to see its depth, links, internal authority and section."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-fit">
      <CardHeader className="pb-3">
        <CardTitle className="min-w-0 truncate">{node.title ?? shortenUrl(node.url, 40)}</CardTitle>
        <Button variant="ghost" size="sm" onClick={onClear} className="col-start-2 row-start-1 h-7">
          Clear
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <a
          href={node.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1 truncate font-mono text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <span className="truncate">{node.url}</span>
          <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
        </a>

        <div className="flex flex-wrap gap-1.5">
          {node.isOrphan ? <Badge variant="destructive">Orphan</Badge> : null}
          <Badge variant={node.isIndexable ? 'outline' : 'muted'}>
            {node.isIndexable ? 'Indexable' : 'Not indexable'}
          </Badge>
          <Badge variant="muted">{sectionOf(node.url)}</Badge>
        </div>

        <StatList divided dense>
          <StatListItem label="Click depth" value={node.depth === 0 ? 'Homepage' : formatNumber(node.depth)} mono />
          <StatListItem label="Inbound links" value={formatNumber(node.inboundLinks)} mono />
          <StatListItem label="Outbound links" value={formatNumber(node.outboundLinks)} mono />
          <StatListItem
            label="Internal authority"
            value={`${authorityIndex(node.authority)} / 100`}
            mono
            hint={AUTHORITY_EXPLANATION}
          />
          <StatListItem label="Words" value={formatNumber(node.wordCount)} mono />
        </StatList>
      </CardContent>
    </Card>
  );
}

interface TopPageRow {
  id: string;
  url: string;
  value: string;
  suffix: string;
}

function TopPagesCard({
  title,
  description,
  rows,
  loading,
  emptyMessage,
}: {
  title: string;
  description: string;
  rows: TopPageRow[];
  loading: boolean;
  emptyMessage: string;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-3">
        <Section spacing="sm">
          <SectionHeader>
            <SectionTitle as="h3">{title}</SectionTitle>
          </SectionHeader>
          <SectionDescription className="text-xs">{description}</SectionDescription>
        </Section>
      </CardHeader>
      <CardContent>
        {loading ? (
          <ul className="space-y-2">
            {[0, 1, 2, 3, 4].map((index) => (
              <li key={index} className="skeleton h-5 w-full rounded-sm" aria-hidden="true" />
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <ol className="space-y-1.5">
            {rows.map((row, index) => (
              <li key={row.id} className="flex items-center gap-2 text-sm">
                <span className="tabular w-4 shrink-0 text-2xs text-muted-foreground">{index + 1}</span>
                <a
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={row.url}
                  className={cn(
                    'min-w-0 flex-1 truncate underline-offset-4 hover:text-primary hover:underline',
                  )}
                >
                  {shortenUrl(row.url, 34)}
                </a>
                <span className="tabular shrink-0 font-medium">
                  {row.value}
                  <span className="ml-1 text-2xs font-normal text-muted-foreground">{row.suffix}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
