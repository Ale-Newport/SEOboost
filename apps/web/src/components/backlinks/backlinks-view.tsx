import { ArrowDownRight, ArrowUpRight, Globe, Link2, Percent } from 'lucide-react';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { Section, SectionDescription, SectionHeader, SectionTitle } from '@/components/ui/section';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { BarChart } from '@/components/charts/bar-chart';
import { BacklinksTable, ReferringDomainsTable } from '@/components/backlinks/links-table';
import { CsvImportPanel } from '@/components/backlinks/csv-import-panel';
import { LinkMovement } from '@/components/backlinks/link-movement';
import { LinkOpportunitiesPanel } from '@/components/backlinks/link-opportunities-panel';
import { SuspiciousLinks } from '@/components/backlinks/suspicious-links';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { BacklinksData } from '@/server/queries/backlinks';

/**
 * Backlinks — the off-site profile, computed entirely from stored rows.
 *
 * Nothing on this screen requires a paid API: the same analysis runs whether the rows came from a
 * provider or a CSV, which is why the import panel is a first-class part of the page rather than a
 * settings afterthought. Numbers a source did not report stay empty instead of being filled in.
 */

/** How the risk read is built, stated wherever the 0-100 number appears. */
const RISK_TOOLTIP =
  'A weighted read of observable properties of the stored profile — anchor concentration, ' +
  'nofollow balance, referring-domain diversity, flagged domains. It is not a purchased ' +
  '"toxicity" figure and it is not a penalty prediction: the factors below are the whole model.';

export function BacklinksView({ data }: { data: BacklinksData }): React.JSX.Element {
  const {
    website,
    hasData,
    storedLinks,
    analysis,
    suspicious,
    links,
    newLinks,
    lostLinks,
    providers,
    anyProviderConfigured,
    maxCsvRows,
  } = data;

  const header = (
    <PageHeader
      title="Backlinks"
      description={`Who links to ${website.domain}, what changed, and which links are worth a second look.`}
      actions={
        <Badge variant={anyProviderConfigured ? 'success' : 'muted'}>
          {anyProviderConfigured ? 'Provider connected' : 'CSV import only'}
        </Badge>
      }
    />
  );

  if (!hasData || analysis === null) {
    return (
      <div className="space-y-6 px-4 py-6 md:px-6">
        {header}

        <EmptyState
          bordered
          icon={Link2}
          title="No backlinks are stored for this site yet"
          description="Import a CSV export from Ahrefs, Semrush, Moz, DataForSEO or Search Console below — every analysis on this screen runs off stored rows, so an import gives you the complete profile without a paid API key."
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <CsvImportPanel
            websiteId={website.id}
            maxCsvRows={maxCsvRows}
            anyProviderConfigured={anyProviderConfigured}
          />

          <Card>
            <CardHeader>
              <CardTitle>Providers</CardTitle>
              <CardDescription>
                A provider only automates the ingestion step. None of them is required.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <StatList divided dense>
                {providers.map((provider) => (
                  <StatListItem
                    key={provider.name}
                    label={provider.label}
                    value={provider.configured ? 'Configured' : 'Not configured'}
                    muted={!provider.configured}
                    hint={
                      provider.configured
                        ? undefined
                        : `Set ${provider.requiredEnv.join(' and ')} to fetch automatically.`
                    }
                  />
                ))}
              </StatList>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  const { totals, velocity, anchorProfile, topReferringDomains, risk, window: analysisWindow } = analysis;
  const followedShare = totals.backlinks === 0 ? null : (totals.followed / totals.backlinks) * 100;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      {header}

      {!anyProviderConfigured ? (
        <Alert variant="info" title="No backlink provider is configured — and none is needed">
          Every figure below is computed from the {formatNumber(storedLinks)} link(s) stored for this
          site. Import a fresh export whenever you want the picture updated; a provider key would only
          automate that step.
        </Alert>
      ) : null}

      {analysis.truncated ? (
        <Alert variant="warning" title="The profile is larger than one analysis pass">
          More links are stored than a single pass reads, so the totals and heuristics below describe
          the most recent subset rather than the entire profile. The link table itself is unaffected —
          it pages through everything.
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard
          label="Referring domains"
          value={formatNumber(totals.referringDomains)}
          icon={Globe}
          footer={
            velocity.referringDomainGrowthPct === null
              ? 'No earlier baseline to compare'
              : `${velocity.referringDomainGrowthPct >= 0 ? '+' : ''}${velocity.referringDomainGrowthPct}% over the window`
          }
          info="Distinct domains with at least one stored link. Domains matter more than raw link counts — a hundred links from one site is still one endorsement."
        />
        <MetricCard
          label="Backlinks"
          value={formatNumber(totals.backlinks)}
          icon={Link2}
          footer={`${formatNumber(totals.lost)} reported lost`}
        />
        <MetricCard
          label="Followed"
          value={followedShare === null ? '—' : formatPercent(followedShare, 0)}
          icon={Percent}
          footer={`${formatNumber(totals.followed)} followed · ${formatNumber(totals.nofollowed)} nofollow`}
          info="Share of stored links that pass authority. A profile that is almost entirely nofollow is usually a syndication or directory footprint."
        />
        <MetricCard
          label="New in the window"
          value={formatNumber(velocity.newLinks)}
          icon={ArrowUpRight}
          footer={`${formatNumber(velocity.newReferringDomains)} new domain(s)`}
        />
        <MetricCard
          label="Lost in the window"
          value={formatNumber(velocity.lostLinks)}
          icon={ArrowDownRight}
          footer={`Net ${velocity.netLinks >= 0 ? '+' : ''}${formatNumber(velocity.netLinks)} links`}
          info="A link counts as lost when the source that used to report it stops. That is evidence, not proof — a gap in a vendor's crawl looks the same."
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Card className="space-y-3 p-5">
          <ScoreBreakdown score={risk} title="Profile risk" sort="contribution" />
          <p className="border-t border-border pt-3 text-2xs leading-relaxed text-muted-foreground">
            {RISK_TOOLTIP}
          </p>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Anchor profile</CardTitle>
            <CardDescription>
              Share of followed links per anchor. A natural profile is dominated by brand and bare-URL
              anchors; a concentration of exact commercial matches is the classic paid-link footprint.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {anchorProfile.length === 0 ? (
              <EmptyState
                size="sm"
                title="No anchor text stored"
                description="The import carried no anchor column, so the anchor heuristics cannot run. Re-import with anchors included to enable them."
              />
            ) : (
              <BarChart
                data={anchorProfile.slice(0, 12).map((entry) => ({
                  id: entry.anchor,
                  label: entry.isExactMatch ? `${entry.anchor} (exact match)` : entry.anchor,
                  value: Math.round(entry.share * 1000) / 10,
                  colorIndex: entry.isExactMatch ? 3 : 0,
                }))}
                layout="bars"
                format="percent"
                categoryLabel="Anchor"
                valueLabel="Share of followed links"
                categoryWidth={180}
                height={Math.max(220, Math.min(12, anchorProfile.length) * 28)}
                bare
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Section spacing="lg">
        <SectionHeader>
          <SectionTitle>What changed</SectionTitle>
          <SectionDescription>
            Links first seen and links reported lost between {analysisWindow.from} and{' '}
            {analysisWindow.to}.
          </SectionDescription>
        </SectionHeader>
        <LinkMovement newLinks={newLinks} lostLinks={lostLinks} windowDays={analysisWindow.days} />
      </Section>

      <Section spacing="lg">
        <SectionHeader>
          <SectionTitle>Referring domains</SectionTitle>
          <SectionDescription>
            The strongest domains in the profile, ranked by how many links they send.
          </SectionDescription>
        </SectionHeader>
        <ReferringDomainsTable domains={topReferringDomains} />
      </Section>

      <Section spacing="lg">
        <SectionHeader>
          <SectionTitle>All links</SectionTitle>
          <SectionDescription>
            Every stored link with its anchor, type, reported authority and status. Filters and sorting
            live in the URL, so a filtered view is shareable.
          </SectionDescription>
        </SectionHeader>
        <BacklinksTable links={links} />
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <SuspiciousLinks domains={suspicious} totalLinks={storedLinks} />
        <LinkOpportunitiesPanel websiteId={website.id} />
      </div>

      <CsvImportPanel
        websiteId={website.id}
        maxCsvRows={maxCsvRows}
        anyProviderConfigured={anyProviderConfigured}
      />
    </div>
  );
}
