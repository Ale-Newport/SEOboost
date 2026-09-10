import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { format } from 'date-fns';
import { ArrowLeft, ExternalLink, Quote } from 'lucide-react';

import { prisma, readJson } from '@seo/db';
import { slugify } from '@seo/shared/text';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Section, SectionHeader, SectionTitle, SectionDescription } from '@/components/ui/section';
import { parseReportData, readHighlights } from '@/components/reports/report-data';
import { ReportExportBar } from '@/components/reports/report-export-bar';
import {
  AiActivitySection,
  EmptyReportBody,
  ExperimentsSection,
  ExtraSections,
  MoversSection,
  PerformanceSection,
  ProblemsSection,
  RecommendationsSection,
} from '@/components/reports/report-sections';
import { GenerateReportDialog } from '@/components/reports/generate-report-dialog';
import { getCurrentUser } from '@/lib/auth';

export const metadata: Metadata = { title: 'Report' };
export const dynamic = 'force-dynamic';

function periodLabel(start: Date, end: Date): string {
  return `${format(start, 'd MMM yyyy')} – ${format(end, 'd MMM yyyy')}`;
}

function typeLabel(type: string): string {
  const lower = type.replace(/[_-]+/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export default async function ReportDetailPage({ params }: { params: Promise<{ reportId: string }> }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { reportId } = await params;

  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: { website: { select: { id: true, name: true, domain: true, userId: true } } },
  });

  // A report belonging to somebody else's site is indistinguishable from one that does not
  // exist, so the two collapse into the same 404.
  if (!report) notFound();
  if (report.website && report.website.userId !== user.id) notFound();
  if (!report.website && report.websiteId !== null) notFound();

  const data = readJson<Record<string, unknown>>(report.data, {});
  const parsed = parseReportData(data);
  const highlights = readHighlights(readJson<unknown[]>(report.highlights, []));
  const site = report.website;

  const payload = {
    id: report.id,
    websiteId: report.websiteId,
    type: report.type,
    title: report.title,
    periodStart: report.periodStart.toISOString(),
    periodEnd: report.periodEnd.toISOString(),
    summary: report.summary,
    highlights: readJson<unknown[]>(report.highlights, []),
    data,
    createdAt: report.createdAt.toISOString(),
  };

  const sitesForDialog = site ? [{ id: site.id, name: site.name }] : [];

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        breadcrumb={
          <Button asChild variant="ghost" size="sm" className="-ml-2 h-7 text-muted-foreground">
            <Link href="/reports">
              <ArrowLeft aria-hidden="true" />
              All reports
            </Link>
          </Button>
        }
        title={report.title}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge variant="outline">{typeLabel(report.type)}</Badge>
            <span className="tabular">{periodLabel(report.periodStart, report.periodEnd)}</span>
            <span aria-hidden="true">·</span>
            {site ? (
              <Link href={`/sites/${site.id}`} className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
                {site.name}
                <ExternalLink className="size-3" aria-hidden="true" />
              </Link>
            ) : (
              <span>Portfolio-wide</span>
            )}
            <span aria-hidden="true">·</span>
            <span>Generated {format(report.createdAt, 'd MMM yyyy, HH:mm')}</span>
          </span>
        }
        actions={
          <ReportExportBar
            reportId={report.id}
            filename={slugify(report.title || report.type) || 'report'}
            parsed={parsed}
            payload={payload}
          />
        }
      />

      {report.summary ? (
        <Card>
          <CardContent className="flex gap-3 py-4">
            <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm leading-relaxed text-foreground">{report.summary}</p>
          </CardContent>
        </Card>
      ) : null}

      {highlights.length > 0 ? (
        <Section spacing="sm">
          <SectionHeader>
            <SectionTitle>Highlights</SectionTitle>
            <SectionDescription>The lines the generator chose to lead with.</SectionDescription>
          </SectionHeader>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {highlights.map((highlight, index) => (
              <li
                key={`${highlight.label}-${index}`}
                className="rounded-lg border border-border bg-card p-3 shadow-xs"
              >
                <p className="text-xs font-medium leading-snug text-foreground">{highlight.label}</p>
                {highlight.detail ? (
                  <p className="mt-1 text-2xs text-muted-foreground">{highlight.detail}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!parsed.hasContent && highlights.length === 0 ? (
        <EmptyReportBody
          generateHref={<GenerateReportDialog sites={sitesForDialog} triggerLabel="Generate it again" />}
        />
      ) : null}

      {parsed.performance ? (
        <Section spacing="sm">
          <SectionHeader>
            <SectionTitle>Organic performance</SectionTitle>
            <SectionDescription>
              Search Console totals for {periodLabel(report.periodStart, report.periodEnd)}, compared with
              the period immediately before it.
            </SectionDescription>
          </SectionHeader>
          <PerformanceSection performance={parsed.performance} comparisonLabel="vs the previous period" />
        </Section>
      ) : null}

      {parsed.improvements.length > 0 || parsed.declines.length > 0 ? (
        <MoversSection improvements={parsed.improvements} declines={parsed.declines} />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {parsed.problems.length > 0 ? (
          <ProblemsSection
            problems={parsed.problems}
            href={site ? `/sites/${site.id}/technical` : null}
          />
        ) : null}
        {parsed.aiActivity.length > 0 ? <AiActivitySection items={parsed.aiActivity} /> : null}
        {parsed.experiments.length > 0 ? <ExperimentsSection experiments={parsed.experiments} /> : null}
        {parsed.extras.length > 0 ? <ExtraSections extras={parsed.extras} /> : null}
      </div>

      {parsed.recommendations.length > 0 ? (
        <RecommendationsSection recommendations={parsed.recommendations} />
      ) : null}
    </div>
  );
}
