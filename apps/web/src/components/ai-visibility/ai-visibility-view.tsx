import { Bot, MessageSquare, Quote, Sparkles, Target, Users } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { Section, SectionDescription, SectionHeader, SectionTitle } from '@/components/ui/section';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { BarChart } from '@/components/charts/bar-chart';
import { TimeSeriesChart } from '@/components/charts/time-series-chart';
import { ManualImportPanel } from '@/components/ai-visibility/manual-import-panel';
import { PromptManager, PromptRateLegend } from '@/components/ai-visibility/prompt-manager';
import { RunsTable } from '@/components/ai-visibility/runs-table';
import {
  DiscoverPromptsButton,
  RunPromptsButton,
} from '@/components/ai-visibility/run-prompts-button';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { AiVisibilityData } from '@/server/queries/ai-visibility';

/**
 * AI visibility — what assistants said about this brand when we asked them.
 *
 * Framing matters here more than anywhere else in the product. These are OBSERVATIONS: a sample
 * of answers, recorded with the prompt, the provider and the raw text. They are not rankings,
 * they are not a ranking signal, and no assistant publishes a position. A rate is `null` until
 * something has actually been measured, so the screen never shows 0% where it means "never asked".
 */

const OBSERVATIONAL_NOTE =
  'Observational, not a ranking. Each figure is counted from answers we recorded — a sample of what ' +
  'assistants said at the moment we asked. Answers vary between runs, models and accounts, no ' +
  'assistant publishes a position, and nothing here is a ranking signal. Read a movement as a change ' +
  'in what we observed, not as a change in standing.';

/** A rate that has never been measured shows its reason rather than a zero. */
function rateValue(rate: number | null): string {
  return rate === null ? '—' : formatPercent(rate, 1);
}

export function AiVisibilityView({ data }: { data: AiVisibilityData }): React.JSX.Element {
  const {
    website,
    brandName,
    window: observationWindow,
    totals,
    promptCoverage,
    byProvider,
    byMethod,
    trend,
    shareOfVoice,
    prompts,
    runs,
    totalRuns,
    providers,
    aiConfigured,
  } = data;

  const ourSharePct = shareOfVoice.find((row) => row.isOurBrand)?.sharePct ?? null;
  const measuredShare = ourSharePct !== null;
  const competitorShare = ourSharePct === null ? null : Math.round((100 - ourSharePct) * 10) / 10;
  const leadingCompetitor = shareOfVoice.find((row) => !row.isOurBrand) ?? null;
  const activePrompts = prompts.filter((prompt) => prompt.isActive).length;
  const envVars = [...new Set(providers.map((provider) => provider.envVar))];

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="AI visibility"
        description={`How often ${brandName} is named and cited when assistants answer the questions you track.`}
        actions={
          <div className="flex items-center gap-2">
            <DiscoverPromptsButton websiteId={website.id} aiConfigured={aiConfigured} />
            <RunPromptsButton
              websiteId={website.id}
              aiConfigured={aiConfigured}
              activePrompts={activePrompts}
            />
          </div>
        }
      />

      <Alert variant="neutral" title="These are observations, not rankings">
        {OBSERVATIONAL_NOTE}
      </Alert>

      {!aiConfigured ? (
        <EmptyState
          bordered
          icon={Bot}
          title="No AI provider is configured on this installation"
          description={
            <>
              Prompts cannot be queried automatically until one of{' '}
              {envVars.map((envVar, index) => (
                <span key={envVar}>
                  {index > 0 ? ', ' : ''}
                  <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
                    {envVar}
                  </code>
                </span>
              ))}{' '}
              is set on the server. Until then this screen still works: record answers by hand with the
              import panel below, and every rate on it is counted from those.
            </>
          }
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Mention rate"
          value={rateValue(totals.mentionRate)}
          icon={MessageSquare}
          info={`Share of recorded answers in which ${brandName} was named anywhere in the text. Counted across ${formatNumber(totals.runs)} answer(s) in the window.`}
          footer={
            totals.runs === 0
              ? 'Nothing measured in this window'
              : `${formatNumber(totals.mentions)} of ${formatNumber(totals.runs)} answers`
          }
        />
        <MetricCard
          label="Citation rate"
          value={rateValue(totals.citationRate)}
          icon={Quote}
          info="Share of recorded answers citing at least one URL on your own domain. Ownership is decided by hostname, so a third-party article about you does not count."
          footer={
            totals.runs === 0
              ? 'Nothing measured in this window'
              : `${formatNumber(totals.citations)} of ${formatNumber(totals.runs)} answers`
          }
        />
        <MetricCard
          label="Prompt coverage"
          value={promptCoverage.pct === null ? '—' : formatPercent(promptCoverage.pct, 0)}
          icon={Target}
          info="Share of your active prompts that were actually run at least once inside this window. Low coverage means the rates above describe only part of your tracked set."
          footer={
            promptCoverage.active === 0
              ? 'No active prompts yet'
              : `${formatNumber(promptCoverage.covered)} of ${formatNumber(promptCoverage.active)} active prompts run`
          }
        />
        <MetricCard
          label="Competitor share of voice"
          value={competitorShare === null ? '—' : formatPercent(competitorShare, 1)}
          icon={Users}
          info="Of every brand mention across the recorded answers, the share that went to a brand other than yours. Measured against the whole named field, so it only means something relative to it."
          footer={
            leadingCompetitor && leadingCompetitor.sharePct !== null
              ? `${leadingCompetitor.name} leads on ${formatPercent(leadingCompetitor.sharePct, 1)}`
              : 'No competitor named yet'
          }
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <TimeSeriesChart
          data={trend.map((point) => ({
            date: point.date,
            mentionRate: point.mentionRate,
            citationRate: point.citationRate,
            runs: point.runs,
          }))}
          series={[
            { key: 'mentionRate', label: 'Mention rate', format: 'percent', type: 'area' },
            { key: 'citationRate', label: 'Citation rate', format: 'percent' },
            { key: 'runs', label: 'Answers recorded', axis: 'right', format: 'number', colorIndex: 4 },
          ]}
          title="Observed over time"
          description={`Recorded answers per day since ${observationWindow.since}`}
          emptyMessage="No answers have been recorded in this window. Run the prompt set, or import an answer by hand."
          height={280}
        />

        <Card>
          <CardHeader>
            <CardTitle>Share of voice</CardTitle>
            <CardDescription>
              Every brand named across the recorded answers, yours included. A competitor&apos;s share
              only means something relative to the whole field.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {measuredShare ? (
              <BarChart
                data={shareOfVoice.map((row) => ({
                  id: row.name,
                  label: row.isOurBrand ? `${row.name} (you)` : row.name,
                  value: row.sharePct ?? 0,
                  colorIndex: row.isOurBrand ? 0 : 3,
                }))}
                layout="bars"
                format="percent"
                categoryLabel="Brand"
                valueLabel="Share of mentions"
                height={Math.max(200, shareOfVoice.length * 28)}
                bare
              />
            ) : (
              <EmptyState
                size="sm"
                title="No brand mentions measured yet"
                description="Share of voice is counted from named brands across recorded answers. It appears once at least one answer has been recorded."
              />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Providers</CardTitle>
            <CardDescription>
              Which assistants this installation can query directly. The rest are covered by manual
              import — the platform does not scrape restricted interfaces.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <StatList divided dense>
              {providers.map((provider) => {
                const measured = byProvider.find((row) => row.provider === provider.name) ?? null;
                return (
                  <StatListItem
                    key={provider.name}
                    label={
                      <span className="flex items-center gap-2">
                        {provider.name}
                        <Badge variant={provider.configured ? 'success' : 'muted'}>
                          {provider.configured ? 'Configured' : 'Not configured'}
                        </Badge>
                      </span>
                    }
                    value={
                      measured
                        ? `${formatNumber(measured.runs)} answers · ${rateValue(measured.mentionRate)} mention`
                        : 'No answers recorded'
                    }
                    muted={measured === null}
                    hint={provider.configured ? undefined : `Set ${provider.envVar} to enable it.`}
                  />
                );
              })}
            </StatList>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>How these answers were collected</CardTitle>
            <CardDescription>
              API samples and hand-collected answers are counted together but stored apart, so you can
              always tell which is which.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {byMethod.length === 0 ? (
              <EmptyState
                size="sm"
                title="Nothing collected in this window"
                description="Run the tracked prompts against a configured provider, or paste an answer into the import panel below."
              />
            ) : (
              <StatList divided dense>
                {byMethod.map((row) => (
                  <StatListItem
                    key={row.method}
                    label={row.method === 'manual' ? 'Imported by hand' : 'Provider API'}
                    value={`${formatNumber(row.runs)} answers · ${rateValue(row.mentionRate)} mention · ${rateValue(row.citationRate)} citation`}
                  />
                ))}
                <StatListItem
                  label="Window"
                  value={`${observationWindow.days} days, ${formatNumber(observationWindow.runsScanned)} answers scanned`}
                  hint={
                    observationWindow.capped
                      ? 'The scan hit its ceiling, so the aggregates describe the most recent answers rather than every one in the window.'
                      : undefined
                  }
                />
              </StatList>
            )}
          </CardContent>
        </Card>
      </div>

      <Section spacing="lg">
        <SectionHeader>
          <SectionTitle>Tracked prompts</SectionTitle>
          <SectionDescription>
            The questions we ask on your behalf. Pausing a prompt keeps its history; removing it
            deletes the runs with it. <PromptRateLegend />
          </SectionDescription>
        </SectionHeader>
        <PromptManager websiteId={website.id} brandName={brandName} prompts={prompts} />
      </Section>

      <Section spacing="lg">
        <SectionHeader>
          <SectionTitle>Recorded answers</SectionTitle>
          <SectionDescription>
            Every observation behind the rates above. Select a row to read the answer exactly as it was
            stored, with the URLs it cited.
          </SectionDescription>
        </SectionHeader>
        <RunsTable runs={runs} totalRuns={totalRuns} brandName={brandName} />
      </Section>

      <Section spacing="lg">
        <SectionHeader>
          <SectionTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-muted-foreground" />
            Manual import
          </SectionTitle>
        </SectionHeader>
        <ManualImportPanel websiteId={website.id} prompts={prompts} />
      </Section>
    </div>
  );
}
