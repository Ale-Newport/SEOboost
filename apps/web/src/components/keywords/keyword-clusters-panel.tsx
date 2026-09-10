'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Layers, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import type { Paginated } from '@seo/shared';

import { KeywordCell, type SearchIntentValue } from '@/components/data/keyword-cell';
import { ScoreCell } from '@/components/data/score-cell';
import { Badge, humanizeStatus } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { Input } from '@/components/ui/input';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition } from '@/lib/utils';
import type { KeywordListItem } from '@/server/queries/keywords';
import type { KeywordClusterRow } from './types';

/**
 * Clusters: the topics this site's keywords fall into.
 *
 * A cluster's keywords are fetched only when its row is opened — a site can have hundreds of
 * clusters, and shipping every member down with the page would dwarf the page itself.
 */

const MEMBER_PAGE_SIZE = 25;

interface ClusterResponse extends Paginated<KeywordListItem> {
  facets: unknown;
}

type MemberState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; items: KeywordListItem[]; total: number };

interface ClusterRowProps {
  cluster: KeywordClusterRow;
  expanded: boolean;
  members: MemberState | undefined;
  onToggle: (id: string) => void;
  onRetry: (id: string) => void;
  onOpenKeyword: (keywordId: string) => void;
  onFilterToCluster: (id: string) => void;
}

function ClusterRow({
  cluster,
  expanded,
  members,
  onToggle,
  onRetry,
  onOpenKeyword,
  onFilterToCluster,
}: ClusterRowProps): React.JSX.Element {
  const regionId = useId();

  return (
    <li className="border-b border-border last:border-b-0">
      <h3 className="m-0">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => onToggle(cluster.id)}
          className={cn(
            'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
            'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          )}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90 text-foreground',
            )}
          />

          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{cluster.name}</span>
              {cluster.intent === 'UNKNOWN' ? null : (
                <Badge variant="secondary">{humanizeStatus(cluster.intent)}</Badge>
              )}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {cluster.parentTopic ?? cluster.description ?? `${cluster.slug}`}
            </span>
          </span>

          <span className="hidden shrink-0 items-center gap-6 text-xs sm:flex">
            <span className="w-16 text-right">
              <span className="tabular block font-medium text-foreground">{formatNumber(cluster.keywordCount)}</span>
              <span className="block text-2xs text-muted-foreground">keywords</span>
            </span>
            <span className="w-20 text-right">
              <span className="tabular block font-medium text-foreground">
                {formatCompact(cluster.totalImpressions)}
              </span>
              <span className="block text-2xs text-muted-foreground">impressions</span>
            </span>
            <span className="w-16 text-right">
              <span className="tabular block font-medium text-foreground">
                {cluster.avgPosition === null ? '—' : formatPosition(cluster.avgPosition)}
              </span>
              <span className="block text-2xs text-muted-foreground">avg. pos.</span>
            </span>
            <span className="w-24">
              {cluster.coverageScore === null ? (
                <span className="block text-right text-2xs text-muted-foreground">No coverage data</span>
              ) : (
                <ProgressBar
                  value={cluster.coverageScore * 100}
                  size="sm"
                  tone={cluster.coverageScore >= 0.6 ? 'success' : cluster.coverageScore >= 0.3 ? 'warning' : 'muted'}
                  ariaLabel={`Coverage ${formatPercent(cluster.coverageScore, 0)}`}
                  formatValue={() => formatPercent(cluster.coverageScore ?? 0, 0)}
                  showValue
                />
              )}
              <span className="mt-0.5 block text-right text-2xs text-muted-foreground">coverage</span>
            </span>
            <span className="w-28">
              <ScoreCell value={cluster.opportunityScore} label="Cluster opportunity" />
              <span className="mt-0.5 block text-right text-2xs text-muted-foreground">opportunity</span>
            </span>
          </span>
        </button>
      </h3>

      <div id={regionId} hidden={!expanded} className="border-t border-border/70 bg-muted/20 px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {cluster.pillarPageUrl === null ? (
              'No pillar page mapped to this cluster yet.'
            ) : (
              <>
                Pillar page:{' '}
                <a
                  href={cluster.pillarPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-4"
                >
                  {cluster.pillarPageUrl}
                </a>
              </>
            )}
          </p>
          <Button variant="ghost" size="sm" onClick={() => onFilterToCluster(cluster.id)}>
            Filter the keyword list to this cluster
          </Button>
        </div>

        {members === undefined || members.status === 'loading' ? (
          <div className="space-y-2" aria-live="polite">
            <span className="sr-only">Loading cluster keywords</span>
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        ) : members.status === 'error' ? (
          <ErrorState
            title="Could not load this cluster's keywords"
            message={members.message}
            onRetry={() => onRetry(cluster.id)}
          />
        ) : members.items.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            This cluster has no keywords attached any more. Re-run clustering to rebuild it.
          </p>
        ) : (
          <>
            <ul className="divide-y divide-border rounded-md border border-border bg-card">
              {members.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-3 px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => onOpenKeyword(item.id)}
                    className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <KeywordCell
                      keyword={item.keyword}
                      intent={item.intent as SearchIntentValue}
                      branded={item.isBranded}
                    />
                  </button>
                  <span className="flex shrink-0 items-center gap-4 text-xs text-muted-foreground">
                    <span className="tabular w-10 text-right">
                      {item.currentPosition === null ? '—' : formatPosition(item.currentPosition)}
                    </span>
                    <span className="tabular w-16 text-right">{formatCompact(item.impressions28d)} impr.</span>
                    <span className="w-24">
                      <ScoreCell value={item.opportunityScore} label="Opportunity score" />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            {members.total > members.items.length ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Showing the {formatNumber(members.items.length)} highest-impression keywords of{' '}
                {formatNumber(members.total)}.{' '}
                <button
                  type="button"
                  onClick={() => onFilterToCluster(cluster.id)}
                  className="font-medium text-primary underline underline-offset-4"
                >
                  See them all
                </button>
              </p>
            ) : null}
          </>
        )}
      </div>
    </li>
  );
}

export interface KeywordClustersPanelProps {
  websiteId: string;
  clusters: readonly KeywordClusterRow[];
  totalKeywords: number;
  unclustered: number;
  onOpenKeyword: (keywordId: string) => void;
  onFilterToCluster: (clusterId: string) => void;
}

export function KeywordClustersPanel({
  websiteId,
  clusters,
  totalKeywords,
  unclustered,
  onOpenKeyword,
  onFilterToCluster,
}: KeywordClustersPanelProps): React.JSX.Element {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, MemberState>>({});
  const [query, setQuery] = useState('');
  const [clustering, setClustering] = useState(false);

  const loadMembers = useCallback(
    async (clusterId: string) => {
      setMembers((current) => ({ ...current, [clusterId]: { status: 'loading' } }));
      try {
        const params = new URLSearchParams({
          clusterId,
          pageSize: String(MEMBER_PAGE_SIZE),
          sort: 'impressions28d',
          order: 'desc',
        });
        const result = await apiGet<ClusterResponse>(`/api/websites/${websiteId}/keywords?${params.toString()}`);
        setMembers((current) => ({
          ...current,
          [clusterId]: { status: 'ready', items: result.items, total: result.total },
        }));
      } catch (error) {
        setMembers((current) => ({
          ...current,
          [clusterId]: {
            status: 'error',
            message: error instanceof ApiError ? error.message : 'The request failed.',
          },
        }));
      }
    },
    [websiteId],
  );

  const toggle = useCallback(
    (clusterId: string) => {
      setExpanded((current) => (current === clusterId ? null : clusterId));
      if (members[clusterId] === undefined) void loadMembers(clusterId);
    },
    [loadMembers, members],
  );

  const runClustering = useCallback(async () => {
    setClustering(true);
    try {
      const result = await apiPost<{ queued: boolean; skipped: boolean; reason?: string; remedy?: string; message?: string }>(
        `/api/websites/${websiteId}/keywords/cluster`,
        {},
      );
      if (result.skipped) {
        toast.warning(result.reason ?? 'Clustering did not run', { description: result.remedy });
      } else if (!result.queued) {
        toast.warning(result.message ?? 'Recorded, but nothing picked it up');
      } else {
        toast.success('Clustering queued', {
          description: 'The worker groups the keywords by intent, then this page shows the clusters. Refresh in a moment.',
        });
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not queue clustering');
    } finally {
      setClustering(false);
    }
  }, [router, websiteId]);

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (term.length === 0) return clusters;
    return clusters.filter(
      (cluster) =>
        cluster.name.toLowerCase().includes(term) ||
        (cluster.parentTopic ?? '').toLowerCase().includes(term),
    );
  }, [clusters, query]);

  if (clusters.length === 0) {
    return (
      <EmptyState
        bordered
        icon={Layers}
        title="No keyword clusters yet"
        description={
          totalKeywords < 2
            ? 'Clustering needs at least two keywords. Import a list or connect Search Console first, then run it.'
            : `Clustering groups this site's ${formatNumber(totalKeywords)} keywords into topics that one page can answer together — the unit content is actually planned in.`
        }
        action={
          totalKeywords < 2 ? undefined : (
            <Button onClick={() => void runClustering()} disabled={clustering}>
              {clustering ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
              Cluster keywords
            </Button>
          )
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search clusters…"
            aria-label="Search clusters"
            className="h-8 w-56"
          />
          <p className="text-xs text-muted-foreground">
            {formatNumber(visible.length)} of {formatNumber(clusters.length)} clusters
            {unclustered > 0 ? ` · ${formatNumber(unclustered)} keywords unclustered` : ''}
            <TooltipInfo
              className="ml-1"
              content="Coverage is the share of a cluster's keywords that currently rank anywhere. Opportunity is the mean of its keywords' own opportunity scores — open a keyword for that score's full breakdown."
            />
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void runClustering()} disabled={clustering}>
          {clustering ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
          Re-cluster
        </Button>
      </div>

      {visible.length === 0 ? (
        <EmptyState size="sm" bordered icon={Layers} title="No clusters match that search" />
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="m-0 list-none p-0">
            {visible.map((cluster) => (
              <ClusterRow
                key={cluster.id}
                cluster={cluster}
                expanded={expanded === cluster.id}
                members={members[cluster.id]}
                onToggle={toggle}
                onRetry={(id) => void loadMembers(id)}
                onOpenKeyword={onOpenKeyword}
                onFilterToCluster={onFilterToCluster}
              />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
