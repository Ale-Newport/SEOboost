import Link from 'next/link';
import {
  AlertTriangle,
  Compass,
  ExternalLink,
  FileSearch,
  Layers,
  ListChecks,
  ScanSearch,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { ScoreRing } from '@/components/ui/score-ring';
import { Section, SectionDescription, SectionHeader, SectionTitle } from '@/components/ui/section';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { ScoreHistoryChart } from '@/components/charts/score-history-chart';
import { UrlCell } from '@/components/data/url-cell';
import { GeoDimensions } from '@/components/geo/geo-dimensions';
import { GeoPagesTable } from '@/components/geo/geo-pages-table';
import { GeoRecommendations } from '@/components/geo/geo-recommendations';
import { RunGeoAuditButton } from '@/components/geo/run-geo-audit-button';
import { formatNumber } from '@/lib/utils';
import type { GeoReadiness } from '@/server/queries/geo';

/**
 * GEO readiness — how legibly this site presents itself to answer engines.
 *
 * The screen is built entirely from the stored audit: the eleven weighted dimensions with their
 * arithmetic on show, the findings rolled up with how many audited pages each one touches, the
 * per-page scores, and the recommendations that can be promoted into the action queue.
 *
 * The honesty note is not decoration. The engine itself refuses to call these ranking factors —
 * they are best-practice signals for machine readability, and improving one raises the
 * probability of being understood and cited rather than moving a deterministic lever.
 */

const HONEST_NOTE =
  'These are best-practice signals for machine readability, not guaranteed ranking factors. ' +
  'AI retrieval is not deterministic and no engine publishes why it cites a source, so treat an ' +
  'improvement here as raising the probability of being understood and quoted — never as a lever ' +
  'that moves a ranking.';

/** The one-line "how is this number built" answer, repeated wherever the score appears. */
const SCORE_TOOLTIP =
  'A weighted average of eleven measured dimensions, each scored 0-100 from the page content ' +
  'itself. The full breakdown — weight, measured value and what the audit found — is directly ' +
  'below this ring; nothing in it is estimated.';

function auditedOn(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function GeoView({ data }: { data: GeoReadiness }): React.JSX.Element {
  const { website, audit, score, dimensions, findings, recommendations, pages, history, prerequisites } = data;
  const siteUrl = `${website.protocol}://${website.domain}`;
  const highFindings = findings.filter((finding) => finding.severity === 'high').length;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="GEO readiness"
        description={
          <>
            How clearly answer engines can read, attribute and quote{' '}
            <a
              href={siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
            >
              {website.domain}
              <ExternalLink aria-hidden="true" className="size-3" />
            </a>
          </>
        }
        actions={
          <RunGeoAuditButton
            websiteId={website.id}
            auditablePages={prerequisites.auditablePages}
            label={audit ? 'Re-run GEO audit' : 'Run GEO audit'}
          />
        }
      />

      <Alert variant="neutral" title="What this score is, and what it is not">
        {HONEST_NOTE}
      </Alert>

      {audit === null || score === null ? (
        <NotAuditedYet website={website} prerequisites={prerequisites} />
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
            <Card className="flex items-center gap-5 p-5">
              <ScoreRing
                value={audit.overallScore}
                size="lg"
                label="GEO"
                ariaLabel={`GEO readiness ${audit.overallScore} out of 100`}
              />
              <div className="min-w-0 max-w-sm space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">Overall GEO score</h2>
                  <TooltipInfo label="How the GEO score is calculated" content={SCORE_TOOLTIP} />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">{score.summary}</p>
                <p className="text-2xs text-muted-foreground">
                  {audit.previousScore === null
                    ? 'First audit — no earlier score to compare against.'
                    : `${audit.overallScore > audit.previousScore ? '+' : ''}${(
                        audit.overallScore - audit.previousScore
                      ).toFixed(1)} points versus the previous audit (${audit.previousScore}).`}
                </p>
              </div>
            </Card>

            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <MetricCard
                label="Pages audited"
                value={formatNumber(audit.pagesAudited)}
                icon={FileSearch}
                footer={`${formatNumber(prerequisites.auditablePages)} eligible on this site`}
                info="Only indexable pages with more than 100 words are scored — below that there is not enough text to measure a dimension honestly."
              />
              <MetricCard
                label="Findings"
                value={formatNumber(findings.length)}
                icon={AlertTriangle}
                footer={highFindings > 0 ? `${formatNumber(highFindings)} high severity` : 'None at high severity'}
              />
              <MetricCard
                label="Recommendations"
                value={formatNumber(recommendations.length)}
                icon={ListChecks}
                footer="Each one can become a proposed action"
              />
              <MetricCard
                label="Last audited"
                value={auditedOn(audit.createdAt)}
                icon={ScanSearch}
                footer={`Method: ${audit.method}`}
                info="The method records how the audit was produced — deterministic measurement, or measurement plus a model-written recommendation pass."
              />
            </div>
          </div>

          <Section spacing="lg">
            <SectionHeader>
              <SectionTitle>Dimension breakdown</SectionTitle>
              <SectionDescription>
                Every dimension the engine scores, with its weight, its measured value and the points it
                is leaving on the table. Select one for the evidence and the weakest pages behind it.
              </SectionDescription>
            </SectionHeader>
            <GeoDimensions score={score} dimensions={dimensions} websiteId={website.id} />
          </Section>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
            <FindingsCard findings={findings} />
            <ScoreHistoryChart
              data={history.map((point) => ({ date: point.date, geo: point.score }))}
              series={[{ key: 'geo', label: 'GEO score', type: 'area' }]}
              title="GEO score history"
              description="One point per completed audit"
              emptyMessage="Only one audit has run so far — the trend appears from the second onwards."
              height={260}
            />
          </div>

          <Section spacing="lg">
            <SectionHeader>
              <SectionTitle>Per-page GEO scores</SectionTitle>
              <SectionDescription>
                The same eleven dimensions measured on each audited page. Sorted worst first, because
                that is where a rewrite pays for itself.
              </SectionDescription>
            </SectionHeader>
            <GeoPagesTable websiteId={website.id} pages={pages} pageAuditCount={data.pageAuditCount} />
          </Section>

          <Section spacing="lg">
            <SectionHeader>
              <SectionTitle>Recommendations</SectionTitle>
              <SectionDescription>
                What to change, why it matters and what it costs. Creating an action proposes it for
                review — nothing is applied to the site from this screen.
              </SectionDescription>
            </SectionHeader>
            <GeoRecommendations
              websiteId={website.id}
              auditId={audit.id}
              recommendations={recommendations}
            />
          </Section>
        </>
      )}
    </div>
  );
}

/**
 * Rolled-up findings: one row per site-level finding, with the severity the engine assigned and
 * the number of audited pages whose own findings flag the same dimension.
 */
function FindingsCard({ findings }: { findings: GeoReadiness['findings'] }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers aria-hidden="true" className="size-4 text-muted-foreground" />
          Findings
        </CardTitle>
      </CardHeader>
      <CardContent>
        {findings.length === 0 ? (
          <EmptyState
            size="sm"
            title="The audit raised no findings"
            description="Every dimension scored above the threshold that produces one. Re-run the audit after content changes to confirm it holds."
          />
        ) : (
          <ul className="divide-y divide-border">
            {findings.map((finding) => (
              <li key={finding.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                <SeverityBadge severity={finding.badgeSeverity} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm leading-relaxed text-foreground">{finding.message}</p>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge variant="outline">{finding.dimensionLabel}</Badge>
                    <span className="text-2xs text-muted-foreground">
                      {finding.affectedPages > 0
                        ? `${formatNumber(finding.affectedPages)} audited page${
                            finding.affectedPages === 1 ? '' : 's'
                          } flagged on this dimension`
                        : 'Site-level: no individual page was flagged'}
                    </span>
                  </div>
                  {finding.url ? <UrlCell url={finding.url} maxLength={52} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The pre-audit state. It names the exact prerequisite that is missing rather than showing an
 * empty chart: without a crawl there is no page text, and without page text there is no score.
 */
function NotAuditedYet({
  website,
  prerequisites,
}: {
  website: GeoReadiness['website'];
  prerequisites: GeoReadiness['prerequisites'];
}): React.JSX.Element {
  const needsCrawl = !prerequisites.hasCompletedCrawl || prerequisites.auditablePages === 0;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <EmptyState
        bordered
        icon={Compass}
        title="No GEO audit has run for this site yet"
        description={
          needsCrawl
            ? 'The score is computed from the text of your own pages, so a completed crawl has to exist first. Run a crawl from the site overview, then run the GEO audit.'
            : 'The pages are crawled and eligible. Run the GEO audit to score all eleven dimensions and produce the findings and recommendations.'
        }
        action={
          <RunGeoAuditButton websiteId={website.id} auditablePages={prerequisites.auditablePages} />
        }
        secondaryAction={
          needsCrawl ? (
            <Link
              href={`/sites/${website.id}`}
              className="text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Go to the site overview to crawl
            </Link>
          ) : null
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Prerequisites</CardTitle>
        </CardHeader>
        <CardContent>
          <StatList divided>
            <StatListItem
              label="Pages crawled"
              value={formatNumber(prerequisites.crawledPages)}
              muted={prerequisites.crawledPages === 0}
              hint="Active pages stored from the most recent crawls."
            />
            <StatListItem
              label="Indexable pages"
              value={formatNumber(prerequisites.indexablePages)}
              muted={prerequisites.indexablePages === 0}
            />
            <StatListItem
              label="Eligible for scoring"
              value={formatNumber(prerequisites.auditablePages)}
              muted={prerequisites.auditablePages === 0}
              hint="Indexable pages with more than 100 words. Thinner pages are skipped rather than scored on guesswork."
            />
            <StatListItem
              label="Completed crawl"
              value={prerequisites.hasCompletedCrawl ? 'Yes' : 'Not yet'}
              muted={!prerequisites.hasCompletedCrawl}
            />
          </StatList>
        </CardContent>
      </Card>

      <Alert variant="info" className="lg:col-span-2">
        <AlertTitle>What the audit will measure</AlertTitle>
        <AlertDescription>
          Eleven weighted dimensions — entity clarity, structured data, fact density, content
          structure, expertise signals, citation worthiness, brand consistency, definitions,
          comparisons, first-party data and source quality. Each is measured from the page itself and
          reported with the evidence behind it.
        </AlertDescription>
      </Alert>
    </div>
  );
}
