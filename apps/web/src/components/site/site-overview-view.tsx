import Link from 'next/link';
import {
  AlertTriangle, ArrowRight, Bot, Compass, ExternalLink, FileText, KeyRound, Link2,
  MousePointerClick, RefreshCw, Search, Sparkles, Target, TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { ScoreRing } from '@/components/ui/score-ring';
import { EmptyState } from '@/components/ui/empty-state';
import { Alert } from '@/components/ui/alert';
import { DistributionChart } from '@/components/charts/distribution-chart';
import { ScoreHistoryChart } from '@/components/charts/score-history-chart';
import { CrawlStatusCard } from '@/components/site/crawl-status-card';
import { formatCompact, formatNumber, formatPercent, formatPosition, shortenUrl } from '@/lib/utils';
import type { SiteOverview } from '@/server/queries/site-overview';

export function SiteOverviewView({ overview }: { overview: SiteOverview }) {
  const { website, performance, keywordCounts, issues, pages, counts, opportunities, actions } = overview;
  const siteUrl = `${website.protocol}://${website.domain}`;
  const hasCrawled = Boolean(overview.latestCrawl && overview.latestCrawl.status === 'COMPLETED');
  const hasSearchData = performance.hasData;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title={website.name}
        description={
          <a
            href={siteUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
          >
            {website.domain}
            <ExternalLink className="h-3 w-3" />
          </a>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/sites/${website.id}/technical`}>View audit</Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/sites/${website.id}/strategy`}>
                <Bot className="mr-1.5 h-3.5 w-3.5" />
                AI SEO Manager
              </Link>
            </Button>
          </div>
        }
      />

      {!hasCrawled && (
        <Alert variant="info" title="This site has not been crawled yet">
          Start a crawl to populate the technical audit, page inventory, internal link graph and
          GEO analysis. Everything on this page below the scores depends on it.
          <div className="mt-3">
            <CrawlStatusCard websiteId={website.id} crawl={overview.latestCrawl} compact />
          </div>
        </Alert>
      )}

      {issues.critical > 0 && (
        <Alert variant="destructive" title={`${issues.critical} critical technical issue${issues.critical === 1 ? '' : 's'}`}>
          Critical issues block indexing or serve errors to crawlers. Clear these before investing
          in content.{' '}
          <Link href={`/sites/${website.id}/technical?severity=CRITICAL`} className="font-medium underline">
            Review them
          </Link>
        </Alert>
      )}

      {/* Scores */}
      <div className="grid gap-4 md:grid-cols-[auto_1fr]">
        <Card className="flex items-center justify-around gap-6 p-6 md:w-auto">
          <ScoreRing value={website.healthScore} label="Health" size="lg" />
          <ScoreRing value={website.geoScore} label="GEO" size="lg" />
          <ScoreRing value={website.aiVisibilityScore} label="AI visibility" size="lg" />
        </Card>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricCard
            label="Clicks"
            value={hasSearchData ? formatNumber(performance.totals.clicks) : '—'}
            delta={performance.deltas?.clicks.changePct ?? null}
            deltaLabel="vs the previous 28 days"
            icon={MousePointerClick}
            footer={hasSearchData ? 'Last 28 days' : 'Connect Search Console'}
          />
          <MetricCard
            label="Impressions"
            value={hasSearchData ? formatCompact(performance.totals.impressions) : '—'}
            delta={performance.deltas?.impressions.changePct ?? null}
            deltaLabel="vs the previous 28 days"
            icon={TrendingUp}
          />
          <MetricCard
            label="Avg. position"
            value={hasSearchData ? formatPosition(performance.totals.position) : '—'}
            delta={performance.deltas?.position.changePct ?? null}
            invertDelta
            deltaLabel="vs the previous 28 days"
            icon={Target}
            info="Impression-weighted average across every query. Lower is better."
          />
          <MetricCard
            label="CTR"
            value={hasSearchData ? formatPercent(performance.totals.ctr, 2) : '—'}
            delta={performance.deltas?.ctr.changePct ?? null}
            deltaLabel="vs the previous 28 days"
            icon={Search}
          />
        </div>
      </div>

      {/* Inventory row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <MetricCard label="Pages indexed" value={formatNumber(pages.indexable)} icon={FileText}
          footer={`${formatNumber(pages.nonIndexable)} non-indexable`} />
        <MetricCard label="Keywords top 10" value={formatNumber(keywordCounts.top10)} icon={KeyRound}
          footer={`${formatNumber(keywordCounts.top3)} in the top 3`} />
        <MetricCard label="Striking distance" value={formatNumber(counts.strikingDistance)} icon={Target}
          info="Queries ranking 8-20: close enough that focused on-page work can realistically reach page one."
          footer="Positions 8-20" />
        <MetricCard label="Orphan pages" value={formatNumber(pages.orphans)} icon={Link2}
          footer={counts.linkSuggestions > 0 ? `${formatNumber(counts.linkSuggestions)} link suggestions ready` : 'No internal links point here'} />
        <MetricCard label="Declining pages" value={formatNumber(pages.declining)} icon={RefreshCw}
          footer="Clicks down >20% period over period" />
        <MetricCard label="Open issues" value={formatNumber(issues.total)} icon={AlertTriangle}
          footer={issues.critical > 0 ? `${issues.critical} critical` : 'No critical issues'} />
      </div>

      {/* Actions + opportunities */}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Next actions
            </CardTitle>
            <Link href={`/sites/${website.id}/strategy`} className="text-xs font-medium text-primary hover:underline">
              Full plan
            </Link>
          </CardHeader>
          <CardContent>
            {actions.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Bot}
                title="No proposed actions yet"
                description="Run the AI SEO Manager to turn this site's data into a prioritised plan."
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/sites/${website.id}/strategy`}>Open AI SEO Manager</Link>
                  </Button>
                }
              />
            ) : (
              <ol className="space-y-2">
                {actions.map((action, index) => (
                  <li key={action.id}>
                    <Link
                      href={`/actions/${action.id}`}
                      className="flex gap-3 rounded-md border border-transparent p-2 transition-colors hover:border-border hover:bg-accent"
                    >
                      <span className="tabular mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium">{action.title}</p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">{action.reasoning}</p>
                        {action.affectedUrls.length > 0 && (
                          <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
                            {shortenUrl(action.affectedUrls[0]!, 44)}
                            {action.affectedUrls.length > 1 && ` +${action.affectedUrls.length - 1}`}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="tabular text-sm font-semibold">{Math.round(action.priorityScore)}</div>
                        <Badge
                          variant={action.risk === 'HIGH' ? 'destructive' : action.risk === 'MEDIUM' ? 'warning' : 'success'}
                          className="mt-0.5 text-2xs"
                        >
                          {action.risk.toLowerCase()}
                        </Badge>
                      </div>
                    </Link>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle className="flex items-center gap-2">
              <Target className="h-4 w-4" />
              Content opportunities
            </CardTitle>
            <Link href={`/sites/${website.id}/opportunities`} className="text-xs font-medium text-primary hover:underline">
              All opportunities
            </Link>
          </CardHeader>
          <CardContent>
            {opportunities.length === 0 ? (
              <EmptyState
                size="sm"
                icon={Target}
                title="No opportunities identified yet"
                description={
                  hasSearchData
                    ? 'Run the keyword and content strategy agents to surface opportunities.'
                    : 'Connect Search Console — most opportunity detection depends on query data.'
                }
              />
            ) : (
              <ul className="space-y-2">
                {opportunities.map((opportunity) => (
                  <li key={opportunity.id}>
                    <Link
                      href={`/sites/${website.id}/opportunities?focus=${opportunity.id}`}
                      className="flex gap-3 rounded-md border border-transparent p-2 transition-colors hover:border-border hover:bg-accent"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-1 text-sm font-medium">{opportunity.title}</p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">{opportunity.reasoning}</p>
                        <div className="mt-1 flex items-center gap-2">
                          <Badge variant="outline" className="text-2xs">
                            {opportunity.type.replace(/_/g, ' ').toLowerCase()}
                          </Badge>
                          {opportunity.estimatedTrafficGain ? (
                            <span className="text-2xs text-muted-foreground">
                              ~{formatNumber(opportunity.estimatedTrafficGain)} clicks/mo
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="tabular shrink-0 text-sm font-semibold">
                        {Math.round(opportunity.priorityScore)}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Charts + issues */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <ScoreHistoryChart
          data={overview.scoreHistory}
          series={[
            { key: 'health', label: 'Health' },
            { key: 'geo', label: 'GEO' },
            { key: 'aiVisibility', label: 'AI visibility' },
          ]}
          title="Score history"
          description="Daily snapshots since the site was added"
        />
        <DistributionChart
          segments={overview.rankingDistribution.map((bucket) => ({ id: bucket.bucket, label: bucket.bucket, count: bucket.count }))}
          title="Ranking distribution"
          description={`${formatNumber(keywordCounts.total)} tracked queries`}
          unitLabel="keywords"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Top technical issues</CardTitle>
            <Link href={`/sites/${website.id}/technical`} className="text-xs font-medium text-primary hover:underline">
              Full audit
            </Link>
          </CardHeader>
          <CardContent>
            {issues.top.length === 0 ? (
              <EmptyState
                size="sm"
                title={hasCrawled ? 'No open technical issues' : 'Nothing audited yet'}
                description={
                  hasCrawled
                    ? 'The last crawl found nothing to fix. Re-crawl after making changes to confirm.'
                    : 'Run a crawl to audit this site against ~60 technical rules.'
                }
              />
            ) : (
              <ul className="divide-y divide-border">
                {issues.top.map((issue) => (
                  <li key={issue.id} className="py-2.5 first:pt-0 last:pb-0">
                    <Link
                      href={`/sites/${website.id}/technical?rule=${issue.ruleId}`}
                      className="flex items-start gap-3"
                    >
                      <SeverityBadge severity={issue.severity} className="mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{issue.title}</p>
                        <p className="line-clamp-2 text-xs text-muted-foreground">{issue.description}</p>
                        {issue.url && (
                          <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">
                            {shortenUrl(issue.url, 60)}
                          </p>
                        )}
                      </div>
                      {issue.autoFixable && (
                        <Badge variant="secondary" className="shrink-0 text-2xs">Auto-fixable</Badge>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <CrawlStatusCard websiteId={website.id} crawl={overview.latestCrawl} />
          <GeoSummaryCard websiteId={website.id} audit={overview.geoAudit} aiVisibility={overview.aiVisibility} />
        </div>
      </div>
    </div>
  );
}

function GeoSummaryCard({
  websiteId,
  audit,
  aiVisibility,
}: {
  websiteId: string;
  audit: SiteOverview['geoAudit'];
  aiVisibility: SiteOverview['aiVisibility'];
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Compass className="h-4 w-4" />
          AI search readiness
        </CardTitle>
        <Link href={`/sites/${websiteId}/geo`} className="text-xs font-medium text-primary hover:underline">
          Details
        </Link>
      </CardHeader>
      <CardContent className="space-y-3">
        {audit ? (
          <>
            <div className="flex items-center gap-3">
              <ScoreRing value={audit.overallScore} size="md" />
              <p className="text-xs leading-relaxed text-muted-foreground">{audit.summary}</p>
            </div>
            <p className="text-2xs text-muted-foreground">
              {audit.pagesAudited} page{audit.pagesAudited === 1 ? '' : 's'} audited
            </p>
          </>
        ) : (
          <EmptyState
            size="sm"
            title="No GEO audit yet"
            description="Run the GEO agent to score how clearly answer engines can read this site."
          />
        )}

        <div className="border-t border-border pt-3">
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
            AI visibility
          </p>
          {aiVisibility.runCount === 0 ? (
            <p className="text-xs text-muted-foreground">
              No prompt runs yet.{' '}
              <Link href={`/sites/${websiteId}/ai-visibility`} className="text-primary hover:underline">
                Set up prompt tracking
              </Link>
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <dt className="text-muted-foreground">Mention rate</dt>
                  <dd className="tabular font-semibold">{formatPercent(aiVisibility.mentionRate, 0)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Citation rate</dt>
                  <dd className="tabular font-semibold">{formatPercent(aiVisibility.citationRate, 0)}</dd>
                </div>
              </dl>
              <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
                Observational: measured across {aiVisibility.runCount} answer
                {aiVisibility.runCount === 1 ? '' : 's'} from {aiVisibility.providers.join(', ')}. Not a
                ranking metric.
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
