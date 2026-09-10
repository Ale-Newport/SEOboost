'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ExternalLink,
  Network,
  RefreshCw,
  Shapes,
  Share2,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ScoreRing } from '@/components/ui/score-ring';
import { Skeleton } from '@/components/ui/skeleton';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { EnumFilter, FilterBar, TextFilter } from '@/components/data/filter-bar';
import { useTableParams } from '@/components/data/use-table-params';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import { formatNumber, formatPercent, shortenUrl } from '@/lib/utils';

/**
 * Wire shapes for `GET /api/entities`. The response has been through `JSON.stringify`, so every
 * server-side `Date` is an ISO string here and every `Json` column is `unknown`.
 */

const ENTITY_TYPES = [
  'BRAND',
  'WEBSITE',
  'COMPANY',
  'PRODUCT',
  'SERVICE',
  'PERSON',
  'TOPIC',
  'ORGANIZATION',
  'LOCATION',
  'SOFTWARE',
  'FEATURE',
  'EVENT',
  'CONCEPT',
] as const;

type EntityTypeValue = (typeof ENTITY_TYPES)[number];

/** The types the coverage check treats as load-bearing; stated on screen, not implied. */
const IMPORTANT_TYPES: readonly EntityTypeValue[] = ['BRAND', 'PRODUCT', 'SERVICE', 'SOFTWARE', 'COMPANY', 'PERSON'];

interface EntityDto {
  id: string;
  name: string;
  type: EntityTypeValue;
  description: string | null;
  aliases: string[];
  sameAs: string[];
  canonicalUrl: string | null;
  attributes: Record<string, unknown>;
  /** 0-1 from the extractor. */
  confidence: number;
  mentionCount: number;
  isPrimary: boolean;
  /** `ai`, `schema`, `knowledge-base`, `content`… free-form on the server. */
  source: string;
  updatedAt: string;
}

interface RelationshipEndpoint {
  id: string;
  name: string;
  type: EntityTypeValue;
}

interface RelationshipDto {
  id: string;
  fromId: string;
  toId: string;
  relation: string;
  weight: number;
  evidence: string | null;
  from: RelationshipEndpoint;
  to: RelationshipEndpoint;
}

interface CoverageGapDto {
  entity: string;
  type: string;
  issue: string;
  recommendation: string;
}

interface EntitiesResponse {
  websiteId: string;
  entities: EntityDto[];
  relationships: RelationshipDto[];
  coverage: {
    /** 0-100, or null when there was no crawled text to measure against. */
    score: number | null;
    gaps: CoverageGapDto[];
    measured: boolean;
    pagesSampled: number;
    crawlId: string | null;
    crawledAt: string | null;
  };
  summary: { total: number; byType: Record<string, number> };
}

interface SkippedDto {
  status?: 'skipped';
  reason?: string;
  fix?: string;
}

interface ExtractResponse extends SkippedDto {
  pagesWithContent?: number;
  job?: {
    enqueued: boolean;
    message: string;
  };
}

const COVERAGE_EXPLANATION =
  'The share of brand, product, service, software, company and person entities that are fully explained. ' +
  'An entity counts as covered only when all three hold: it has a description, its name appears near the ' +
  'top of at least one sampled page, and it is mentioned at least three times across the site. Everything ' +
  'short of that is listed as a gap below, with the specific condition it failed.';

export interface EntityGraphViewProps {
  websiteId: string;
  websiteName: string;
  siteUrl: string;
  hasCrawl: boolean;
}

export function EntityGraphView({
  websiteId,
  websiteName,
  siteUrl,
  hasCrawl,
}: EntityGraphViewProps): React.JSX.Element {
  const { getParam } = useTableParams();
  const typeFilter = getParam('type');
  const search = getParam('search') ?? '';

  const [data, setData] = useState<EntitiesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [extracting, setExtracting] = useState(false);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const query = new URLSearchParams({ websiteId });
    if (typeFilter) query.set('type', typeFilter);
    if (search.trim().length > 0) query.set('search', search.trim());

    apiGet<EntitiesResponse>(`/api/entities?${query.toString()}`)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof ApiError ? cause.message : 'The entity graph could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [websiteId, typeFilter, search, reloadToken]);

  const extract = useCallback(async (): Promise<void> => {
    setExtracting(true);
    try {
      const result = await apiPost<ExtractResponse>('/api/entities/extract', { websiteId });
      if (result.status === 'skipped') {
        toast.warning(result.reason ?? 'Extraction did not run.', { description: result.fix });
        return;
      }
      if (result.job && result.job.enqueued === false) {
        toast.warning('Recorded, but no worker picked it up', { description: result.job.message });
      } else {
        toast.success('Entity extraction queued', {
          description: `Reading ${formatNumber(result.pagesWithContent ?? 0)} crawled pages, the site's schema markup and the knowledge base.`,
        });
      }
      refresh();
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : 'Extraction could not be started.');
    } finally {
      setExtracting(false);
    }
  }, [websiteId, refresh]);

  const entities = useMemo(() => data?.entities ?? [], [data]);
  const coverage = data?.coverage ?? null;

  /** Grouped by type, types ordered by how much they matter, then by how many there are. */
  const groups = useMemo(() => {
    const byType = new Map<EntityTypeValue, EntityDto[]>();
    for (const entity of entities) {
      const bucket = byType.get(entity.type);
      if (bucket) bucket.push(entity);
      else byType.set(entity.type, [entity]);
    }
    return [...byType.entries()].sort((a, b) => {
      const aImportant = IMPORTANT_TYPES.indexOf(a[0]);
      const bImportant = IMPORTANT_TYPES.indexOf(b[0]);
      if (aImportant !== bImportant) {
        if (aImportant === -1) return 1;
        if (bImportant === -1) return -1;
        return aImportant - bImportant;
      }
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });
  }, [entities]);

  const typeOptions = useMemo(
    () =>
      ENTITY_TYPES.map((value) => ({
        value,
        label: titleCase(value),
        ...(data?.summary.byType[value] === undefined ? {} : { count: data.summary.byType[value] }),
      })),
    [data],
  );

  const importantCount = entities.filter((entity) => IMPORTANT_TYPES.includes(entity.type)).length;
  const coveredCount = coverage?.gaps ? Math.max(0, importantCount - coverage.gaps.length) : 0;
  const filtered = typeFilter !== null || search.trim().length > 0;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Entity graph"
        description={
          <>
            The things{' '}
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              {websiteName}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>{' '}
            is about, how they relate, and which of them the site never actually explains
          </>
        }
        actions={
          <Button
            size="sm"
            onClick={() => void extract()}
            loading={extracting}
            loadingText="Queueing"
            disabled={!hasCrawl}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Re-run extraction
          </Button>
        }
      />

      {hasCrawl ? null : (
        <Alert variant="warning">
          <AlertTitle>This site has not been crawled yet</AlertTitle>
          <AlertDescription>
            Extraction reads crawled page text, the site&rsquo;s own schema markup and the knowledge base — with no
            crawl there is nothing to read.{' '}
            <Link href={`/sites/${websiteId}`}>Start a crawl from the site overview</Link>.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <MetricCard
          label="Entities"
          value={data ? formatNumber(data.summary.total) : '—'}
          loading={loading && data === null}
          icon={Shapes}
          info="Distinct entities extracted for this site. Filtered by the controls below."
          footer={
            data
              ? `${formatNumber(Object.keys(data.summary.byType).length)} of ${ENTITY_TYPES.length} types present`
              : undefined
          }
        />
        <MetricCard
          label="Load-bearing entities"
          value={data ? formatNumber(importantCount) : '—'}
          loading={loading && data === null}
          icon={Sparkles}
          info={`Brands, products, services, software, companies and people — the types answer engines quote a site for. Coverage is measured over these only.`}
          footer={data ? `${formatNumber(coveredCount)} fully explained` : undefined}
        />
        <MetricCard
          label="Relationships"
          value={data ? formatNumber(data.relationships.length) : '—'}
          loading={loading && data === null}
          icon={Share2}
          info="Typed edges between two entities, e.g. “Acme — makes → Widget Pro”. Extracted alongside the entities themselves."
        />
        <MetricCard
          label="Coverage gaps"
          value={coverage ? formatNumber(coverage.gaps.length) : '—'}
          loading={loading && data === null}
          icon={TriangleAlert}
          info="Load-bearing entities that fail at least one of the three coverage conditions. Each one is listed with the condition it failed."
          footer={
            coverage && !coverage.measured ? 'Not measured — no crawled page text' : 'Each gap names its own fix'
          }
        />
      </div>

      {error === null ? null : <ErrorState message={error} onRetry={refresh} retryLabel="Try again" bordered />}

      <CoverageCard
        coverage={coverage}
        loading={loading && data === null}
        importantCount={importantCount}
        coveredCount={coveredCount}
      />

      <FilterBar>
        <EnumFilter paramKey="type" label="Type" options={typeOptions} allLabel="All types" />
        <TextFilter paramKey="search" label="Search entities" placeholder="Search by name" />
      </FilterBar>

      {loading && data === null ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {[0, 1].map((index) => (
            <Skeleton key={index} className="h-64 w-full rounded-lg" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="p-5">
            <EmptyState
              icon={Network}
              title={filtered ? 'No entities match these filters' : 'No entities extracted yet'}
              description={
                filtered
                  ? 'Clear the type filter and the search box to see the whole graph.'
                  : hasCrawl
                    ? 'Run “Re-run extraction”. It reads the crawled page text, any Organization/Product markup already on the site and the knowledge base, and records only what it can point at.'
                    : 'Crawl the site first — extraction reads the page text the crawler captures.'
              }
              action={
                hasCrawl ? (
                  <Button size="sm" onClick={() => void extract()} loading={extracting} loadingText="Queueing">
                    Re-run extraction
                  </Button>
                ) : (
                  <Button asChild size="sm">
                    <Link href={`/sites/${websiteId}`}>Go to the site overview</Link>
                  </Button>
                )
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map(([type, rows]) => (
            <EntityTypeCard key={type} type={type} entities={rows} />
          ))}
        </div>
      )}

      <RelationshipsCard
        relationships={data?.relationships ?? []}
        loading={loading && data === null}
        hasEntities={entities.length > 0}
      />
    </div>
  );
}

function CoverageCard({
  coverage,
  loading,
  importantCount,
  coveredCount,
}: {
  coverage: EntitiesResponse['coverage'] | null;
  loading: boolean;
  importantCount: number;
  coveredCount: number;
}): React.JSX.Element {
  if (loading) return <Skeleton className="h-48 w-full rounded-lg" />;

  if (coverage === null) {
    return (
      <Card>
        <CardContent className="p-5">
          <EmptyState
            size="sm"
            icon={TriangleAlert}
            title="Coverage has not been measured"
            description="Load the entity graph to see which entities the site explains and which it only mentions."
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-1.5">
          Entity coverage
          <TooltipInfo label="How entity coverage is scored" content={COVERAGE_EXPLANATION} />
        </CardTitle>
        <p className="col-start-1 text-xs text-muted-foreground">
          {coverage.measured
            ? `Measured against the text of ${formatNumber(coverage.pagesSampled)} crawled page${coverage.pagesSampled === 1 ? '' : 's'}${
                coverage.crawledAt
                  ? `, from the crawl of ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(coverage.crawledAt))}`
                  : ''
              }.`
            : 'Not measured: no crawled page text is stored, and there is nothing to check the entities against.'}
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-5">
          <ScoreRing
            value={coverage.measured ? coverage.score : null}
            size="lg"
            label="Coverage"
            ariaLabel="Entity coverage score out of 100"
          />
          <div className="min-w-[14rem] flex-1 space-y-2">
            {/* The score is a ratio, so the ratio itself is on screen — not just the number. */}
            <ProgressBar
              label="Fully explained entities"
              value={coveredCount}
              max={Math.max(1, importantCount)}
              tone={coveredCount === importantCount ? 'success' : 'warning'}
              formatValue={(value, max) => `${formatNumber(value)} of ${formatNumber(max)}`}
              ariaLabel="Fully explained load-bearing entities"
            />
            <ul className="space-y-0.5 text-2xs text-muted-foreground">
              <li>An entity counts as explained only when all three of these hold:</li>
              <li>· it has a description the site itself states;</li>
              <li>· its name appears near the top of at least one crawled page;</li>
              <li>· it is mentioned three or more times across the site.</li>
            </ul>
          </div>
        </div>

        {coverage.gaps.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {coverage.measured
              ? 'Every load-bearing entity is described, mentioned prominently and repeated across the site.'
              : 'Run a crawl to have the gaps measured.'}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {coverage.gaps.map((gap, index) => (
              <li key={`${gap.entity}-${index}`} className="space-y-1 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{gap.entity}</span>
                  <Badge variant="muted">{titleCase(gap.type)}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">{gap.issue}</p>
                <p className="flex gap-1.5 text-xs text-foreground">
                  <ArrowRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {gap.recommendation}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function EntityTypeCard({
  type,
  entities,
}: {
  type: EntityTypeValue;
  entities: readonly EntityDto[];
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          {titleCase(type)}
          <span className="tabular text-xs font-normal text-muted-foreground">{formatNumber(entities.length)}</span>
          {IMPORTANT_TYPES.includes(type) ? (
            <SimpleTooltip content="Coverage is measured over this type — answer engines quote sites for their brands, products, services and people.">
              <Badge variant="outline">Load-bearing</Badge>
            </SimpleTooltip>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border/60">
          {entities.map((entity) => (
            <li key={entity.id} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-foreground">{entity.name}</span>
                {entity.isPrimary ? <Badge variant="info">Primary</Badge> : null}
                {entity.canonicalUrl ? (
                  <a
                    href={entity.canonicalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={entity.canonicalUrl}
                    className="inline-flex items-center gap-1 font-mono text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    {shortenUrl(entity.canonicalUrl, 30)}
                    <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                  </a>
                ) : null}
              </div>

              {entity.description ? (
                <p className="text-xs leading-relaxed text-muted-foreground">{entity.description}</p>
              ) : (
                <p className="text-xs italic text-muted-foreground">
                  No description — the site never states what this is.
                </p>
              )}

              {entity.aliases.length > 0 ? (
                <p className="text-2xs text-muted-foreground">
                  Also called: <span className="text-foreground/80">{entity.aliases.join(', ')}</span>
                </p>
              ) : null}

              <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <dt>Mentions</dt>
                  <dd className="tabular font-medium text-foreground">{formatNumber(entity.mentionCount)}</dd>
                </div>
                <div className="flex items-center gap-1">
                  <dt>Confidence</dt>
                  <dd className="tabular font-medium text-foreground">
                    <SimpleTooltip content="The extractor's own certainty that this is a real, distinct entity on this site. It is not a quality score for the entity.">
                      <span>{formatPercent(entity.confidence, 0)}</span>
                    </SimpleTooltip>
                  </dd>
                </div>
                <div className="flex items-center gap-1">
                  <dt>Source</dt>
                  <dd className="font-medium text-foreground">{sourceLabel(entity.source)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RelationshipsCard({
  relationships,
  loading,
  hasEntities,
}: {
  relationships: readonly RelationshipDto[];
  loading: boolean;
  hasEntities: boolean;
}): React.JSX.Element {
  if (loading) return <Skeleton className="h-48 w-full rounded-lg" />;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Relationships</CardTitle>
        <p className="col-start-1 text-xs text-muted-foreground">
          Typed edges between two entities. These are what let an answer engine say “Acme makes Widget Pro”
          rather than listing two unrelated names.
        </p>
      </CardHeader>
      <CardContent>
        {relationships.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Share2}
            title="No relationships recorded"
            description={
              hasEntities
                ? 'The extractor found entities but no statement connecting two of them. Relationships come from sentences that name both entities, and from schema markup that links them.'
                : 'Run entity extraction first — relationships are extracted alongside the entities themselves.'
            }
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {relationships.map((relation) => (
              <li key={relation.id} className="space-y-1 py-2.5 first:pt-0 last:pb-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="font-medium text-foreground">{relation.from.name}</span>
                  <span className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs text-muted-foreground">
                    <ArrowRight className="size-3" aria-hidden="true" />
                    {relation.relation}
                  </span>
                  <span className="font-medium text-foreground">{relation.to.name}</span>
                  <SimpleTooltip content="How strongly the extractor believes this edge, from 0 to 1.">
                    <span className="tabular text-2xs text-muted-foreground">
                      weight {relation.weight.toFixed(2)}
                    </span>
                  </SimpleTooltip>
                </p>
                {relation.evidence ? (
                  <p className="text-xs italic leading-relaxed text-muted-foreground">
                    &ldquo;{relation.evidence}&rdquo;
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** `KNOWLEDGE_BASE` / `knowledge-base` → `Knowledge base`. */
function titleCase(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'ai':
      return 'AI extraction';
    case 'schema':
      return 'Schema markup';
    case 'knowledge-base':
      return 'Knowledge base';
    case 'content':
      return 'Page content';
    default:
      return titleCase(source);
  }
}
