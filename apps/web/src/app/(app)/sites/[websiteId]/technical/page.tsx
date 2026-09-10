import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { IssueCategory, IssueSeverity, IssueStatus, prisma } from '@seo/db';
import { RULE_LIST, calculateHealthScore } from '@seo/seo-engine';
import {
  HEALTH_CATEGORY_WEIGHT,
  SEVERITY_WEIGHT,
  round,
  type ExplainableScore,
} from '@seo/shared';

import { getCurrentUser } from '@/lib/auth';
import { LIVE_ISSUE_STATUSES, getIssueFacets, listIssues } from '@/server/queries/issues';
import { AuditView, type AuditCrawlState } from '@/components/audit/audit-view';
import {
  CATEGORY_LABEL,
  SEVERITY_SEQUENCE,
  WEIGHTED_CATEGORIES,
  categoryLabel,
  severityLabel,
  statusLabel,
  type AuditIssueRow,
  type CategorySummary,
  type HealthMethodology,
  type IssueCategoryName,
  type IssueFacetData,
  type IssueSeverityName,
  type RuleReferenceEntry,
  type SeverityCount,
} from '@/components/audit/types';

export const metadata: Metadata = { title: 'Technical SEO' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/**
 * How many open issues the on-screen breakdown will re-score.
 *
 * The health score is recomputed here rather than read off `website.healthScore` so it responds
 * the moment something is ignored or reopened. That means loading the open issues, which on a
 * pathological site is a very large number — so the read is capped and the panel is told it was,
 * instead of the page quietly timing out or reporting a score built from a partial set.
 */
const HEALTH_ISSUE_CAP = 20_000;

/** Fixed locale and UTC so the server and the browser cannot disagree about which day it is. */
const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

function formatDate(value: Date | null | undefined): string | null {
  return value ? DATE_FORMATTER.format(value) : null;
}

// ── URL params ────────────────────────────────────────────────────────────
// The issue table writes its state with `useTableParams`, so the server has to read exactly the
// shape the client writes: repeated params arrive as arrays, single ones as strings.

type RawSearchParams = Record<string, string | string[] | undefined>;

function paramList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((entry) => entry.length > 0);
  return value === undefined || value.length === 0 ? [] : [value];
}

function paramValue(value: string | string[] | undefined): string | undefined {
  return paramList(value)[0];
}

function paramPage(value: string | string[] | undefined): number {
  const parsed = Number(paramValue(value));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

function paramPageSize(value: string | string[] | undefined): number {
  const parsed = Number(paramValue(value));
  if (!Number.isFinite(parsed) || parsed < 1) return PAGE_SIZE;
  return Math.min(Math.floor(parsed), 200);
}

function paramEnums<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T[] | undefined {
  const wanted = paramList(value).filter((entry): entry is T =>
    (allowed as readonly string[]).includes(entry),
  );
  return wanted.length > 0 ? wanted : undefined;
}

function paramBoolean(value: string | string[] | undefined): boolean | undefined {
  const raw = paramValue(value);
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return undefined;
}

// ── The rule catalogue, exactly as the engine declares it ─────────────────

const RULES: RuleReferenceEntry[] = RULE_LIST.map((rule) => ({
  id: rule.id,
  title: rule.title,
  category: rule.category,
  severity: rule.severity,
  weight: rule.weight,
  autoFixable: rule.autoFixable,
  scope: rule.scope,
  rationale: rule.rationale,
})).sort((a, b) => a.id.localeCompare(b.id));

const RULES_BY_ID: Record<string, RuleReferenceEntry> = Object.fromEntries(
  RULES.map((rule) => [rule.id, rule]),
);

/**
 * Page- versus site-scoped is the one property the database does not carry: `TechnicalIssue` has
 * no `scope` column, it lives on the rule. The health score treats the two completely differently,
 * so the scope has to be joined back on from the catalogue before anything is scored.
 */
const SCOPE_BY_RULE_ID: Record<string, 'page' | 'site'> = Object.fromEntries(
  RULES.map((rule) => [rule.id, rule.scope]),
);

export default async function TechnicalAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ websiteId: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;
  const query = await searchParams;

  const website = await prisma.website.findFirst({
    where: { id: websiteId, userId: user.id },
    select: {
      id: true,
      name: true,
      domain: true,
      protocol: true,
      healthScore: true,
      lastAnalysisAt: true,
    },
  });
  if (!website) notFound();

  const page = paramPage(query.page);
  const pageSize = paramPageSize(query.pageSize);
  const severity = paramEnums(query.severity, Object.values(IssueSeverity));
  const category = paramEnums(query.category, Object.values(IssueCategory));
  const status = paramEnums(query.status, Object.values(IssueStatus));
  const ruleId = paramList(query.ruleId);
  const search = paramValue(query.search);
  const url = paramValue(query.url);
  const autoFixable = paramBoolean(query.autoFixable);
  const sort = paramValue(query.sort);
  const order = paramValue(query.order) === 'asc' ? 'asc' : 'desc';

  const liveWhere = { websiteId: website.id, status: { in: LIVE_ISSUE_STATUSES } };

  const [
    result,
    rawFacets,
    latestCrawl,
    lastCompletedCrawl,
    activePages,
    liveIssueCount,
    scoredIssues,
    categorySeverityCounts,
  ] = await Promise.all([
    listIssues({
      websiteId: website.id,
      page,
      pageSize,
      ...(sort === undefined ? {} : { sort }),
      order,
      ...(search === undefined ? {} : { search }),
      ...(severity === undefined ? {} : { severity }),
      ...(category === undefined ? {} : { category }),
      ...(status === undefined ? {} : { status }),
      ...(ruleId.length === 0 ? {} : { ruleId }),
      ...(url === undefined ? {} : { url }),
      ...(autoFixable === undefined ? {} : { autoFixable }),
    }),
    getIssueFacets(website.id),
    prisma.crawl.findFirst({
      where: { websiteId: website.id },
      orderBy: { createdAt: 'desc' },
      select: { status: true, pagesCrawled: true, error: true },
    }),
    prisma.crawl.findFirst({
      where: { websiteId: website.id, status: 'COMPLETED' },
      orderBy: [{ finishedAt: 'desc' }, { createdAt: 'desc' }],
      select: { pagesCrawled: true, finishedAt: true },
    }),
    prisma.page.count({ where: { websiteId: website.id, isActive: true } }),
    prisma.technicalIssue.count({ where: liveWhere }),
    prisma.technicalIssue.findMany({
      where: liveWhere,
      select: { ruleId: true, category: true, severity: true, weight: true, status: true },
      take: HEALTH_ISSUE_CAP,
    }),
    prisma.technicalIssue.groupBy({
      by: ['category', 'severity'],
      where: liveWhere,
      _count: { _all: true },
    }),
  ]);

  // ── Crawl state ─────────────────────────────────────────────────────────
  // "Pages audited" is the size of the crawl the findings came from; the live page inventory is
  // the fallback for a crawl row that finished without recording a count.
  const pagesCrawled =
    lastCompletedCrawl && lastCompletedCrawl.pagesCrawled > 0
      ? lastCompletedCrawl.pagesCrawled
      : activePages;
  const hasCrawled = lastCompletedCrawl !== null && pagesCrawled > 0;

  const crawl: AuditCrawlState | null = latestCrawl
    ? {
        status: latestCrawl.status,
        inFlight: latestCrawl.status === 'QUEUED' || latestCrawl.status === 'RUNNING',
        pagesCrawled: latestCrawl.pagesCrawled,
        finishedLabel: formatDate(lastCompletedCrawl?.finishedAt),
        error: latestCrawl.status === 'FAILED' ? latestCrawl.error : null,
      }
    : null;

  // ── Health, recomputed from what is open right now ───────────────────────
  const health: ExplainableScore | null = hasCrawled
    ? calculateHealthScore({
        issues: scoredIssues.map((issue) => ({
          category: issue.category,
          severity: issue.severity,
          weight: issue.weight,
          status: issue.status,
          scope: SCOPE_BY_RULE_ID[issue.ruleId] ?? 'page',
        })),
        pageCount: pagesCrawled,
      })
    : null;

  const methodology: HealthMethodology = {
    severityWeights: SEVERITY_SEQUENCE.map((name) => ({
      severity: name,
      weight: SEVERITY_WEIGHT[name],
    })),
    categoryWeights: WEIGHTED_CATEGORIES.map((name) => ({
      category: name,
      label: CATEGORY_LABEL[name],
      weight: HEALTH_CATEGORY_WEIGHT[name],
    })),
    pageHalfPoint: Math.max(4, pagesCrawled * 0.15),
    siteHalfPoint: 8,
    pagesCrawled,
    liveIssuesScored: scoredIssues.length,
    truncated: liveIssueCount > scoredIssues.length,
    storedScore: website.healthScore,
    storedScoreLabel: formatDate(website.lastAnalysisAt),
  };

  // ── Per-category summary ────────────────────────────────────────────────
  const countsByCategory = new Map<IssueCategoryName, Map<IssueSeverityName, number>>();
  for (const row of categorySeverityCounts) {
    const bucket = countsByCategory.get(row.category) ?? new Map<IssueSeverityName, number>();
    bucket.set(row.severity, (bucket.get(row.severity) ?? 0) + row._count._all);
    countsByCategory.set(row.category, bucket);
  }

  const factorByCategory = new Map(health?.factors.map((factor) => [factor.key, factor]) ?? []);

  const summaryCategories: IssueCategoryName[] = [
    ...WEIGHTED_CATEGORIES,
    // GEO carries a weight of 0 and has a screen of its own, so it only earns a card when the
    // site actually has GEO findings to show.
    ...((countsByCategory.get('GEO')?.size ?? 0) > 0 ? (['GEO'] as const) : []),
  ];

  const summaries: CategorySummary[] = summaryCategories.map((name) => {
    const bucket = countsByCategory.get(name);
    const bySeverity: SeverityCount[] = SEVERITY_SEQUENCE.map((sev) => ({
      severity: sev,
      count: bucket?.get(sev) ?? 0,
    })).filter((entry) => entry.count > 0);
    const factor = factorByCategory.get(name);

    return {
      category: name,
      label: CATEGORY_LABEL[name],
      total: bySeverity.reduce((sum, entry) => sum + entry.count, 0),
      bySeverity,
      score: factor ? round(factor.value * 100, 1) : null,
      weight: factor ? factor.weight : null,
    };
  });

  // ── Table rows and facets ───────────────────────────────────────────────
  const rows: AuditIssueRow[] = result.items.map((issue) => ({
    id: issue.id,
    ruleId: issue.ruleId,
    title: issue.title,
    category: issue.category,
    severity: issue.severity,
    status: issue.status,
    url: issue.url ?? issue.pageUrl,
    description: issue.description,
    recommendation: issue.recommendation,
    estimatedImpact: issue.estimatedImpact,
    confidence: issue.confidence,
    autoFixable: issue.autoFixable,
    discoveredAt: issue.discoveredAt.getTime(),
    discoveredLabel: DATE_FORMATTER.format(issue.discoveredAt),
    lastSeenLabel: DATE_FORMATTER.format(issue.lastSeenAt),
    ignoredReason: issue.ignoredReason,
  }));

  const facets: IssueFacetData = {
    total: rawFacets.total,
    live: rawFacets.live,
    autoFixable: rawFacets.autoFixable,
    severity: rawFacets.severity.map((entry) => ({
      value: entry.value,
      label: severityLabel(entry.value),
      count: entry.count,
    })),
    category: rawFacets.category.map((entry) => ({
      value: entry.value,
      label: categoryLabel(entry.value),
      count: entry.count,
    })),
    status: rawFacets.status.map((entry) => ({
      value: entry.value,
      label: statusLabel(entry.value),
      count: entry.count,
    })),
    rules: rawFacets.topRules.map((entry) => ({
      value: entry.ruleId,
      label: entry.title,
      count: entry.count,
      severity: entry.severity,
    })),
  };

  return (
    <AuditView
      website={{
        id: website.id,
        name: website.name,
        domain: website.domain,
        url: `${website.protocol}://${website.domain}`,
      }}
      health={health}
      methodology={methodology}
      summaries={summaries}
      rows={rows}
      total={result.total}
      page={result.page}
      pageSize={result.pageSize}
      facets={facets}
      rules={RULES}
      rulesById={RULES_BY_ID}
      crawl={crawl}
      hasCrawled={hasCrawled}
    />
  );
}
