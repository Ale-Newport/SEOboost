import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ExternalLink,
  FlaskConical,
  ListChecks,
  Sparkles,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from 'lucide-react';

import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Delta } from '@/components/ui/delta';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { cn, formatCompact, formatNumber, formatPercent, formatPosition, shortenUrl } from '@/lib/utils';
import type {
  ParsedReport,
  ReportAiActivityItem,
  ReportExperiment,
  ReportMovement,
  ReportProblem,
  ReportRecommendation,
} from './report-data';

/**
 * Presentational sections for a stored report.
 *
 * Every section renders only what the payload actually contained: a section with no rows is not
 * rendered at all rather than being shown empty, because an absent section in a report means
 * "the generator had nothing to say here", not "loading".
 */

function SectionCard({
  title,
  icon: Icon,
  description,
  action,
  children,
  className,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          {title}
        </CardTitle>
        {description ? (
          <p className="col-start-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
        {action ? <div className="col-start-2 row-start-1 justify-self-end">{action}</div> : null}
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

// ── organic performance ──────────────────────────────────────

export function PerformanceSection({
  performance,
  comparisonLabel,
}: {
  performance: NonNullable<ParsedReport['performance']>;
  comparisonLabel: string;
}): React.JSX.Element {
  const tiles = [
    {
      key: 'clicks',
      label: 'Clicks',
      metric: performance.clicks,
      format: (value: number) => formatNumber(value),
      invert: false,
      info: 'Total Search Console clicks recorded for this reporting period.',
    },
    {
      key: 'impressions',
      label: 'Impressions',
      metric: performance.impressions,
      format: (value: number) => formatCompact(value),
      invert: false,
      info: 'Times a result for this property appeared in search during the period.',
    },
    {
      key: 'ctr',
      label: 'CTR',
      // Search Console reports CTR as a fraction; a value above 1 is already a percentage.
      metric: performance.ctr,
      format: (value: number) => (value > 1 ? `${value.toFixed(2)}%` : formatPercent(value, 2)),
      invert: false,
      info: 'Clicks divided by impressions across the whole period.',
    },
    {
      key: 'position',
      label: 'Avg. position',
      metric: performance.position,
      format: (value: number) => formatPosition(value),
      invert: true,
      info: 'Impression-weighted average position. Lower is better, so a fall is shown as an improvement.',
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <MetricCard
          key={tile.key}
          label={tile.label}
          value={tile.metric && tile.metric.value !== null ? tile.format(tile.metric.value) : '—'}
          delta={tile.metric?.changePct ?? null}
          invertDelta={tile.invert}
          deltaLabel={comparisonLabel}
          info={tile.info}
          footer={
            tile.metric && tile.metric.previous !== null
              ? `Previous period: ${tile.format(tile.metric.previous)}`
              : undefined
          }
        />
      ))}
    </div>
  );
}

// ── movers ───────────────────────────────────────────────────

function MovementRow({ row, invert }: { row: ReportMovement; invert: boolean }): React.JSX.Element {
  return (
    <li className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground" title={row.label}>
          {row.url ? shortenUrl(row.url) : row.label}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-2xs text-muted-foreground">
          {row.clicks !== null ? <span className="tabular">{formatNumber(row.clicks)} clicks</span> : null}
          {row.position !== null ? <span className="tabular">pos {formatPosition(row.position)}</span> : null}
          {row.url && row.url !== row.label ? <span className="truncate">{row.label}</span> : null}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {row.change !== null ? (
          <span className="tabular text-xs text-muted-foreground">
            {row.change > 0 ? '+' : ''}
            {formatNumber(row.change)}
          </span>
        ) : null}
        <Delta value={row.changePct} invertColors={invert} />
      </div>
    </li>
  );
}

export function MoversSection({
  improvements,
  declines,
}: {
  improvements: ReportMovement[];
  declines: ReportMovement[];
}): React.JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {improvements.length > 0 ? (
        <SectionCard
          title="Top improvements"
          icon={TrendingUp}
          description="What gained the most ground during this period."
        >
          <ul className="-my-2">
            {improvements.map((row, index) => (
              <MovementRow key={`${row.label}-${index}`} row={row} invert={false} />
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {declines.length > 0 ? (
        <SectionCard
          title="Top declines"
          icon={TrendingDown}
          description="Where traffic or ranking was lost — the first place to look for work."
        >
          <ul className="-my-2">
            {declines.map((row, index) => (
              <MovementRow key={`${row.label}-${index}`} row={row} invert={false} />
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

// ── problems ─────────────────────────────────────────────────

export function ProblemsSection({
  problems,
  href,
}: {
  problems: ReportProblem[];
  href: string | null;
}): React.JSX.Element {
  return (
    <SectionCard
      title="Problems found"
      icon={TriangleAlert}
      description="Technical and content problems detected while the report was generated."
      action={
        href ? (
          <Link href={href} className="text-xs font-medium text-primary hover:underline">
            Open the audit
          </Link>
        ) : null
      }
    >
      <ul className="-my-2">
        {problems.map((problem, index) => (
          <li
            key={`${problem.label}-${index}`}
            className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">{problem.label}</p>
              {problem.detail ? (
                <p className="mt-0.5 line-clamp-2 text-2xs leading-relaxed text-muted-foreground">
                  {problem.detail}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {problem.count !== null ? (
                <span className="tabular text-xs text-muted-foreground">{formatNumber(problem.count)}</span>
              ) : null}
              {problem.severity ? <SeverityBadge severity={problem.severity} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ── AI activity ──────────────────────────────────────────────

export function AiActivitySection({ items }: { items: ReportAiActivityItem[] }): React.JSX.Element {
  return (
    <SectionCard
      title="AI activity"
      icon={Sparkles}
      description="What the agents produced and changed during the period."
    >
      <StatList divided>
        {items.map((item) => (
          <StatListItem key={item.key} label={item.label} value={formatNumber(item.count)} />
        ))}
      </StatList>
    </SectionCard>
  );
}

// ── experiments ──────────────────────────────────────────────

export function ExperimentsSection({ experiments }: { experiments: ReportExperiment[] }): React.JSX.Element {
  return (
    <SectionCard
      title="Experiment outcomes"
      icon={FlaskConical}
      description="Changes that were measured against a control window."
    >
      <ul className="-my-2">
        {experiments.map((experiment, index) => (
          <li
            key={`${experiment.label}-${index}`}
            className="flex items-start justify-between gap-3 border-b border-border/60 py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">{experiment.label}</p>
              {experiment.detail ? (
                <p className="mt-0.5 line-clamp-2 text-2xs leading-relaxed text-muted-foreground">
                  {experiment.detail}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {experiment.liftPct !== null ? <Delta value={experiment.liftPct} /> : null}
              {experiment.outcome ? <Badge variant="outline">{experiment.outcome}</Badge> : null}
              {experiment.status ? <Badge variant="muted">{experiment.status}</Badge> : null}
            </div>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

// ── recommendations ──────────────────────────────────────────

export function RecommendationsSection({
  recommendations,
}: {
  recommendations: ReportRecommendation[];
}): React.JSX.Element {
  return (
    <SectionCard
      title="What to do next"
      icon={ListChecks}
      description="The recommendations this report ends on, in the order the generator ranked them."
    >
      <ol className="-my-2">
        {recommendations.map((row, index) => (
          <li key={`${row.label}-${index}`} className="border-b border-border/60 py-2.5 last:border-b-0">
            <div className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-muted/60 text-2xs font-semibold text-muted-foreground"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium leading-snug text-foreground">{row.label}</p>
                {row.detail ? (
                  <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{row.detail}</p>
                ) : null}
                {row.href ? (
                  <Link
                    href={row.href}
                    className="mt-1 inline-flex items-center gap-1 text-2xs font-medium text-primary hover:underline"
                  >
                    Go there
                    <ArrowRight className="size-3" aria-hidden="true" />
                  </Link>
                ) : null}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </SectionCard>
  );
}

// ── anything the reader did not recognise ────────────────────

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Renders payload keys this page has no dedicated section for.
 *
 * Showing the raw value is deliberate: the generator may write sections this screen predates,
 * and silently dropping stored data would make the report look emptier than it is.
 */
export function ExtraSections({ extras }: { extras: ParsedReport['extras'] }): React.JSX.Element {
  return (
    <SectionCard
      title="Other data in this report"
      icon={ExternalLink}
      description="Values the generator stored that this screen has no dedicated section for."
    >
      <dl className="space-y-3">
        {extras.map((entry) => (
          <div key={entry.key}>
            <dt className="text-xs font-medium text-foreground">{entry.label}</dt>
            <dd className="mt-1">
              {typeof entry.value === 'number' || typeof entry.value === 'string' ? (
                <span className="tabular text-xs text-muted-foreground">{String(entry.value)}</span>
              ) : (
                <pre className="max-h-56 overflow-auto rounded-md border border-border bg-muted/40 p-2.5 text-2xs leading-relaxed text-muted-foreground">
                  <code>{stringify(entry.value)}</code>
                </pre>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}

// ── nothing at all ───────────────────────────────────────────

export function EmptyReportBody({ generateHref }: { generateHref: React.ReactNode }): React.JSX.Element {
  return (
    <EmptyState
      bordered
      icon={ListChecks}
      title="This report has no stored data"
      description="The report row exists but its payload is empty. That happens when the generator ran before Search Console was connected or before the site had been crawled. Connect the data sources and generate the report again."
      action={generateHref}
    />
  );
}
