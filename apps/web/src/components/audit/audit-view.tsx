import Link from 'next/link';
import { AlertTriangle, CircleCheck, FileSearch, Layers, ShieldCheck, Wrench } from 'lucide-react';
import type { ExplainableScore } from '@seo/shared';

import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import {
  Section,
  SectionActions,
  SectionDescription,
  SectionHeader,
  SectionTitle,
} from '@/components/ui/section';
import { formatNumber } from '@/lib/utils';
import { CategorySummaryGrid } from './category-summary';
import { HealthPanel } from './health-panel';
import { IssueTable } from './issue-table';
import { RuleReferenceSheet } from './rule-reference-sheet';
import { RunCrawlButton } from './run-crawl-button';
import type {
  AuditIssueRow,
  CategorySummary,
  HealthMethodology,
  IssueFacetData,
  RuleReferenceEntry,
} from './types';

export interface AuditCrawlState {
  status: string;
  /** True while a crawl is queued or running — a second one would only queue behind it. */
  inFlight: boolean;
  pagesCrawled: number;
  /** Pre-formatted on the server, e.g. “9 Sep 2026”. Null when no crawl has ever finished. */
  finishedLabel: string | null;
  error: string | null;
}

export interface AuditViewProps {
  website: { id: string; name: string; domain: string; url: string };
  /** Null until a crawl has produced pages to score. */
  health: ExplainableScore | null;
  methodology: HealthMethodology;
  summaries: readonly CategorySummary[];
  rows: readonly AuditIssueRow[];
  total: number;
  page: number;
  pageSize: number;
  facets: IssueFacetData;
  rules: readonly RuleReferenceEntry[];
  rulesById: Readonly<Record<string, RuleReferenceEntry>>;
  crawl: AuditCrawlState | null;
  /** A crawl has completed and left pages behind — everything below depends on it. */
  hasCrawled: boolean;
}

/**
 * The site audit screen.
 *
 * Ordered the way the question is actually asked: how healthy is this site, what is the score made
 * of, which area is worst, and then — only then — the list of individual findings. Absence of data
 * is a real answer here, so a site that has never been crawled and a site that came back clean each
 * get their own screen rather than an empty table.
 */
export function AuditView({
  website,
  health,
  methodology,
  summaries,
  rows,
  total,
  page,
  pageSize,
  facets,
  rules,
  rulesById,
  crawl,
  hasCrawled,
}: AuditViewProps): React.JSX.Element {
  const activeRuleIds = facets.rules.map((rule) => rule.value);
  const criticalCount = facets.severity.find((entry) => entry.value === 'CRITICAL')?.count ?? 0;

  const header = (
    <PageHeader
      title="Technical SEO"
      description={
        <>
          Every finding the audit produced for{' '}
          <Link
            href={`/sites/${website.id}`}
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            {website.domain}
          </Link>
          {crawl?.finishedLabel ? <> · last crawled {crawl.finishedLabel}</> : null}
          {hasCrawled ? <> · {formatNumber(methodology.pagesCrawled)} pages audited</> : null}
        </>
      }
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <RuleReferenceSheet rules={rules} activeRuleIds={activeRuleIds} />
          <RunCrawlButton
            websiteId={website.id}
            variant={hasCrawled ? 'outline' : 'default'}
            label={hasCrawled ? 'Re-crawl' : 'Run a crawl'}
            disabled={crawl?.inFlight ?? false}
          />
        </div>
      }
    />
  );

  // ── Nothing has been crawled ────────────────────────────────────────────
  if (!hasCrawled) {
    return (
      <div className="space-y-6 px-4 py-6 md:px-6">
        {header}

        {crawl?.inFlight ? (
          <Alert variant="info" title="A crawl is running">
            The audit fills in as pages are fetched. Reload in a minute to see the first findings.
          </Alert>
        ) : null}

        {crawl?.error ? (
          <Alert variant="destructive" title="The last crawl failed">
            {crawl.error}
          </Alert>
        ) : null}

        <EmptyState
          bordered
          icon={FileSearch}
          title="This site has not been audited yet"
          description={
            <>
              The technical audit runs against a crawl: it fetches your pages, applies the{' '}
              {formatNumber(rules.length)} rules in the catalogue and records what it finds. Until a
              crawl completes there is nothing to score and nothing to list — and this screen will
              not invent either.
            </>
          }
          action={<RunCrawlButton websiteId={website.id} disabled={crawl?.inFlight ?? false} />}
          secondaryAction={
            <Button asChild variant="ghost" size="sm">
              <Link href={`/sites/${website.id}`}>Back to the site overview</Link>
            </Button>
          }
        />

        <div className="flex justify-center">
          <RuleReferenceSheet rules={rules} />
        </div>
      </div>
    );
  }

  // ── Crawled ─────────────────────────────────────────────────────────────
  const cleanSite = facets.total === 0;
  const nothingOpen = facets.live === 0 && facets.total > 0;

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      {header}

      {criticalCount > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>
            {formatNumber(criticalCount)} critical{' '}
            {criticalCount === 1 ? 'issue' : 'issues'} on this site
          </AlertTitle>
          <AlertDescription>
            Critical findings block indexing or serve errors to crawlers. They carry ten times the
            penalty of a low-severity finding, so they are the fastest way to move the health score —
            and the only work worth doing before anything else.
          </AlertDescription>
        </Alert>
      ) : null}

      {cleanSite || nothingOpen ? (
        <Alert variant="success">
          <AlertTitle>No open technical issues</AlertTitle>
          <AlertDescription>
            The audit ran all {formatNumber(rules.length)} rules against{' '}
            {formatNumber(methodology.pagesCrawled)} crawled{' '}
            {methodology.pagesCrawled === 1 ? 'page' : 'pages'}
            {crawl?.finishedLabel ? ` on ${crawl.finishedLabel}` : ''} and found nothing to fix.
            {nothingOpen
              ? ' Everything previously found has been resolved or ignored — switch the status filter below to review that history.'
              : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          label="Open issues"
          value={formatNumber(facets.live)}
          icon={AlertTriangle}
          footer={
            facets.total === facets.live
              ? 'Nothing resolved or ignored yet'
              : `${formatNumber(facets.total - facets.live)} resolved or ignored`
          }
          info="Issues in the OPEN or REGRESSED state. Only these count against the health score."
        />
        <MetricCard
          label="Critical"
          value={formatNumber(criticalCount)}
          icon={ShieldCheck}
          footer={criticalCount === 0 ? 'None outstanding' : 'Fix these first'}
          info="Findings that stop indexing outright — server errors, redirect loops, noindex on pages that rank."
        />
        <MetricCard
          label="Auto-fixable"
          value={formatNumber(facets.autoFixable)}
          icon={Wrench}
          footer={
            facets.autoFixable === 0
              ? 'No rule here has an automated fix'
              : 'Can be raised as fix actions'
          }
          info="Issues raised by rules the platform can act on itself. Creating a fix action still needs your approval before anything changes."
        />
        <MetricCard
          label="Pages audited"
          value={formatNumber(methodology.pagesCrawled)}
          icon={Layers}
          footer={crawl?.finishedLabel ? `Crawled ${crawl.finishedLabel}` : 'From the latest crawl'}
          info="Active pages from the most recent crawl. Page-level penalties are normalised against this number."
        />
      </div>

      {health ? <HealthPanel score={health} methodology={methodology} /> : null}

      <Section spacing="md">
        <SectionHeader>
          <div className="space-y-1">
            <SectionTitle>Where the problems are</SectionTitle>
            <SectionDescription>
              Open issues per category, with each category&rsquo;s own health score. Select one to
              filter the list below; select several to compare them.
            </SectionDescription>
          </div>
          <SectionActions>
            <RuleReferenceSheet rules={rules} activeRuleIds={activeRuleIds} />
          </SectionActions>
        </SectionHeader>
        <CategorySummaryGrid summaries={summaries} />
      </Section>

      <Section spacing="md">
        <SectionHeader>
          <div className="space-y-1">
            <SectionTitle>Issues</SectionTitle>
            <SectionDescription>
              Every finding, deduplicated by rule and URL. Filters and sort live in the address bar,
              so any view of this list is a link you can hand to whoever owns the fix.
            </SectionDescription>
          </div>
        </SectionHeader>

        {cleanSite ? (
          <EmptyState
            bordered
            icon={CircleCheck}
            title="Nothing to list — the audit found no issues"
            description={
              <>
                {formatNumber(rules.length)} rules ran against{' '}
                {formatNumber(methodology.pagesCrawled)} crawled{' '}
                {methodology.pagesCrawled === 1 ? 'page' : 'pages'}
                {crawl?.finishedLabel ? ` on ${crawl.finishedLabel}` : ''} without raising a single
                finding. The next crawl will re-check all of them.
              </>
            }
            action={
              <RunCrawlButton
                websiteId={website.id}
                variant="outline"
                label="Re-crawl now"
                disabled={crawl?.inFlight ?? false}
              />
            }
          />
        ) : (
          <IssueTable
            websiteId={website.id}
            rows={rows}
            total={total}
            page={page}
            pageSize={pageSize}
            facets={facets}
            rulesById={rulesById}
          />
        )}
      </Section>
    </div>
  );
}
