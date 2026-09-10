import Link from 'next/link';
import { Radar, Target, Users } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { Section, SectionDescription, SectionHeader, SectionTitle } from '@/components/ui/section';
import {
  AddCompetitorDialog,
  RunCompetitorAnalysisButton,
} from '@/components/competitors/competitor-actions';
import { CompetitorCard } from '@/components/competitors/competitor-card';
import { GapTable } from '@/components/competitors/gap-table';
import type { CompetitorsData } from '@/components/competitors/queries';
import { formatNumber } from '@/lib/utils';

export function CompetitorsView({ data }: { data: CompetitorsData }): React.JSX.Element {
  const { website, competitors, totals, serpConfigured, gapAnalysis } = data;
  const activeDomains = competitors.filter((row) => row.isActive).map((row) => row.domain);

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Competitors"
        description={`Who ${website.domain} competes with in search, what you share, and what they rank for that you do not.`}
        actions={
          <div className="flex items-center gap-2">
            <RunCompetitorAnalysisButton websiteId={website.id} disabled={competitors.length === 0} />
            <AddCompetitorDialog websiteId={website.id} serpConfigured={serpConfigured} />
          </div>
        }
      />

      {!serpConfigured ? (
        <Alert variant="warning">
          <AlertTitle>No SERP provider is configured</AlertTitle>
          <AlertDescription>
            Competitor rankings are collected from a search-results provider. Without one, no new
            observations can be made: the analysis falls back to the{' '}
            <strong className="font-medium text-foreground">
              {formatNumber(
                gapAnalysis.available ? gapAnalysis.counts.observedCompetitorKeywords : 0,
              )}
            </strong>{' '}
            competitor rankings already stored, and reports nothing where it has none — it never
            estimates a position. Set <code className="font-mono text-2xs">DATAFORSEO_LOGIN</code>,{' '}
            <code className="font-mono text-2xs">SERPAPI_KEY</code> or{' '}
            <code className="font-mono text-2xs">SERPER_API_KEY</code> to turn collection on.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Tracked competitors"
          value={formatNumber(totals.tracked)}
          icon={Users}
          footer={
            totals.tracked === 0
              ? 'None yet'
              : `${formatNumber(totals.analysed)} analysed at least once`
          }
        />
        <MetricCard
          label="Shared keywords"
          value={totals.analysed > 0 ? formatNumber(totals.sharedKeywords) : '—'}
          icon={Target}
          info="Sum of the shared-keyword counts recorded by the last competitor analysis. Empty until it has run."
          footer={totals.analysed > 0 ? 'Queries you both rank for' : 'Run the analysis to populate'}
        />
        <MetricCard
          label="Gap keywords"
          value={totals.analysed > 0 ? formatNumber(totals.gapKeywords) : '—'}
          icon={Radar}
          info="Sum of the gap counts recorded by the last analysis: queries a competitor ranks for and this site does not."
          footer={totals.analysed > 0 ? 'They rank, you do not' : 'Run the analysis to populate'}
        />
        <MetricCard
          label="Actionable gaps"
          value={gapAnalysis.available ? formatNumber(gapAnalysis.counts.gaps) : '—'}
          icon={Target}
          info="Computed live from the observed rankings: queries where at least one tracked competitor sits in the top 20 and this site does not rank in the top 10."
          footer={
            gapAnalysis.available
              ? `${formatNumber(gapAnalysis.counts.missing)} not ranking · ${formatNumber(gapAnalysis.counts.underperforming)} outranked`
              : 'No observations yet'
          }
        />
      </div>

      <Section spacing="lg">
        <SectionHeader>
          <div className="space-y-1">
            <SectionTitle>Tracked competitors</SectionTitle>
            <SectionDescription>
              Counters come from the last competitor analysis; head-to-head and topical strengths are
              recomputed from the stored observations on every load.
            </SectionDescription>
          </div>
        </SectionHeader>

        {competitors.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={Users}
              title="No competitors tracked yet"
              description="Add the domains you actually compete with in search. Once the analysis runs, this screen shows shared keywords, SERP overlap and the queries they win that you do not."
              action={<AddCompetitorDialog websiteId={website.id} serpConfigured={serpConfigured} />}
              secondaryAction={
                <Button asChild variant="outline" size="sm">
                  <Link href={`/sites/${website.id}/keywords`}>Review your keywords first</Link>
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {competitors.map((competitor) => (
              <CompetitorCard key={competitor.id} websiteId={website.id} competitor={competitor} />
            ))}
          </div>
        )}
      </Section>

      <Section spacing="lg">
        <SectionHeader>
          <div className="space-y-1">
            <SectionTitle>Keyword gap analysis</SectionTitle>
            <SectionDescription>
              Queries a tracked competitor ranks for in the top 20 where this site is absent or sits
              outside the top 10. Convert one into a content opportunity to put it in the pipeline.
            </SectionDescription>
          </div>
        </SectionHeader>

        {gapAnalysis.available ? (
          <GapTable
            websiteId={website.id}
            gaps={gapAnalysis.gaps}
            counts={gapAnalysis.counts}
            competitorDomains={activeDomains}
          />
        ) : (
          <Card className="p-0">
            <EmptyState
              icon={Radar}
              title={gapAnalysis.reason}
              description={gapAnalysis.remedy}
              action={
                competitors.length > 0 ? (
                  <RunCompetitorAnalysisButton websiteId={website.id} />
                ) : (
                  <AddCompetitorDialog websiteId={website.id} serpConfigured={serpConfigured} />
                )
              }
              secondaryAction={
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/sites/${website.id}/settings?tab=integrations`}>Check integrations</Link>
                </Button>
              }
            />
          </Card>
        )}
      </Section>
    </div>
  );
}
