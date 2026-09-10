/**
 * The analysis lane: deterministic work over data that has already been fetched.
 *
 * Nothing in this file calls the network or an LLM, which is what makes these jobs cheap,
 * repeatable and safe to re-run. The one piece of real state machinery is issue reconciliation:
 * a technical issue has a life cycle (open → resolved → regressed) keyed on its fingerprint, and
 * getting that wrong either spams the operator with duplicates or silently loses a regression.
 */

import {
  type IssueCategory,
  type IssueSeverity,
  IssueStatus,
  type Prisma,
  createManyChunked,
  json,
  prisma,
} from '@seo/db';
import { enqueue, type JobHandler } from '@seo/queue';
import {
  createLogger,
  fleschReadingEase,
  formatDateKey,
  lastNDays,
  round,
  toUtcDate,
} from '@seo/shared';
import {
  calculateHealthScore,
  calculatePageOpportunity,
  calculatePageSeoScore,
  runTechnicalAudit,
  type IssueDraft,
} from '@seo/seo-engine';
import { effectiveSettings, loadWebsite, type WebsiteWithSettings } from '../lib/website';
import { buildAuditDataset } from '../lib/audit-dataset';
import { runChunked } from '../lib/batch';
import { loadSiteTotals } from '../lib/gsc';
import { maxImpressionsOnSite, ROLLING_DAYS } from '../lib/metrics';
import { skip, type SkippedOutcome } from '../lib/result';

const log = createLogger('worker:analysis');

/** Existing issues held in memory during reconciliation. Well above any real site's count. */
const MAX_TRACKED_ISSUES = 100_000;
const ISSUE_BATCH = 500;
const PAGE_BATCH = 200;

type Progress = (percent: number, message: string) => Promise<void>;

/** Maps a sub-task's 0-100 progress onto a slice of the parent job's bar. */
function slice(progress: Progress, from: number, to: number): Progress {
  return async (percent, message) => progress(from + (Math.max(0, Math.min(100, percent)) / 100) * (to - from), message);
}

// ─────────────────────────────────────────────────────────────
// analysis.technical-audit
// ─────────────────────────────────────────────────────────────

export interface TechnicalAuditResult {
  status: 'completed';
  crawlId: string;
  pagesAudited: number;
  edgesAudited: number;
  partial: boolean;
  issuesOpened: number;
  issuesUpdated: number;
  issuesResolved: number;
  issuesRegressed: number;
  bySeverity: Record<string, number>;
}

export const technicalAudit: JobHandler<'analysis.technical-audit'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const result = await runAudit(website, payload.crawlId ?? null, payload.pageIds ?? null, (p, m) =>
    ctx.updateProgress(p, m),
  );

  if (result.status === 'completed') {
    await enqueue(
      'analysis.page-scores',
      { websiteId: website.id },
      { trigger: 'chain', dedupeKey: `page-scores:${website.id}` },
    );
    await enqueue(
      'analysis.site-scores',
      { websiteId: website.id, snapshot: true },
      { trigger: 'chain', dedupeKey: `site-scores:${website.id}` },
    );
  }
  return result;
};

async function runAudit(
  website: WebsiteWithSettings,
  requestedCrawlId: string | null,
  pageIds: string[] | null,
  progress: Progress,
): Promise<TechnicalAuditResult | SkippedOutcome> {
  const settings = effectiveSettings(website);

  const crawl = requestedCrawlId
    ? await prisma.crawl.findFirst({
        where: { id: requestedCrawlId, websiteId: website.id },
        select: { id: true },
      })
    : await prisma.crawl.findFirst({
        where: { websiteId: website.id, status: 'COMPLETED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

  if (!crawl) {
    return skip(
      `No completed crawl exists for ${website.domain}, so there is nothing to audit yet.`,
      ['Run a site crawl first'],
    );
  }

  await progress(5, 'Loading the crawl');
  const built = await buildAuditDataset(
    { id: website.id, domain: website.domain, protocol: website.protocol },
    crawl.id,
    { thinContentWords: settings.thinContentWords },
    pageIds?.length ? { pageIds } : {},
  );

  if (built.pagesLoaded === 0) {
    return skip(`Crawl ${crawl.id} stored no pages, so the audit has nothing to inspect.`);
  }

  await progress(35, `Running ${built.pagesLoaded} pages through the rule set`);
  const audit = runTechnicalAudit(built.dataset);

  await progress(60, 'Reconciling issues');
  const reconciled = await reconcileIssues(website.id, crawl.id, audit.issues, progress);

  await prisma.crawl.update({
    where: { id: crawl.id },
    data: { issuesFound: audit.issues.length },
  });
  await prisma.website.update({
    where: { id: website.id },
    data: { lastAnalysisAt: new Date() },
  });

  await progress(100, 'Audit complete');
  log.info('technical audit complete', {
    websiteId: website.id,
    crawlId: crawl.id,
    issues: audit.issues.length,
    ...reconciled,
  });

  return {
    status: 'completed',
    crawlId: crawl.id,
    pagesAudited: audit.stats.pagesAudited,
    edgesAudited: built.edgesLoaded,
    partial: built.truncated,
    ...reconciled,
    bySeverity: audit.stats.issuesBySeverity,
  };
}

interface ReconcileIssueCounts {
  issuesOpened: number;
  issuesUpdated: number;
  issuesResolved: number;
  issuesRegressed: number;
}

/**
 * Folds a run's drafts into the durable issue table.
 *
 * The fingerprint is the identity of a finding, so the same broken title on the same URL keeps
 * one row across crawls and keeps its `discoveredAt`. Three transitions matter:
 *  - a fingerprint that was RESOLVED and is present again becomes REGRESSED (never silently OPEN
 *    again — a regression is a different fact from a new problem);
 *  - a fingerprint the operator IGNORED stays ignored, but its `lastSeenAt` still moves, so the
 *    ignore list does not rot;
 *  - anything open and absent from this run is RESOLVED with a timestamp.
 */
async function reconcileIssues(
  websiteId: string,
  crawlId: string,
  drafts: IssueDraft[],
  progress: Progress,
): Promise<ReconcileIssueCounts> {
  const now = new Date();
  const counts: ReconcileIssueCounts = {
    issuesOpened: 0,
    issuesUpdated: 0,
    issuesResolved: 0,
    issuesRegressed: 0,
  };

  const pageIdByUrl = await loadPageIdIndex(websiteId);

  const existing = new Map<string, { id: string; status: IssueStatus }>();
  let cursor: string | null = null;
  while (existing.size < MAX_TRACKED_ISSUES) {
    const where: Prisma.TechnicalIssueWhereInput = {
      websiteId,
      ...(cursor === null ? {} : { id: { gt: cursor } }),
    };
    const rows = await prisma.technicalIssue.findMany({
      where,
      orderBy: { id: 'asc' },
      take: ISSUE_BATCH,
      select: { id: true, fingerprint: true, status: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) existing.set(row.fingerprint, { id: row.id, status: row.status });
    if (rows.length < ISSUE_BATCH) break;
  }

  const seen = new Set<string>();
  const creates: Prisma.TechnicalIssueCreateManyInput[] = [];
  const updates: Prisma.PrismaPromise<unknown>[] = [];

  for (const draft of drafts) {
    if (seen.has(draft.fingerprint)) continue;
    seen.add(draft.fingerprint);

    const pageId = draft.url ? pageIdByUrl.get(draft.url) ?? null : null;
    const shared = {
      crawlId,
      pageId,
      title: draft.title,
      category: draft.category as IssueCategory,
      severity: draft.severity as IssueSeverity,
      url: draft.url,
      description: draft.description,
      recommendation: draft.recommendation,
      evidence: json(draft.evidence),
      estimatedImpact: draft.estimatedImpact,
      confidence: draft.confidence,
      autoFixable: draft.autoFixable,
      weight: draft.weight,
      lastSeenAt: now,
    };

    const prior = existing.get(draft.fingerprint);
    if (!prior) {
      creates.push({
        websiteId,
        ruleId: draft.ruleId,
        fingerprint: draft.fingerprint,
        status: IssueStatus.OPEN,
        discoveredAt: now,
        ...shared,
      });
      counts.issuesOpened += 1;
      continue;
    }

    if (prior.status === IssueStatus.RESOLVED) {
      updates.push(
        prisma.technicalIssue.update({
          where: { id: prior.id },
          data: { ...shared, status: IssueStatus.REGRESSED, resolvedAt: null },
        }),
      );
      counts.issuesRegressed += 1;
      continue;
    }

    if (prior.status === IssueStatus.IGNORED) {
      updates.push(
        prisma.technicalIssue.update({ where: { id: prior.id }, data: { ...shared } }),
      );
      counts.issuesUpdated += 1;
      continue;
    }

    updates.push(prisma.technicalIssue.update({ where: { id: prior.id }, data: { ...shared } }));
    counts.issuesUpdated += 1;
  }

  await progress(75, `Writing ${creates.length} new and ${updates.length} existing issues`);

  if (creates.length) await createManyChunked(prisma.technicalIssue, creates, 250);
  await runChunked(updates, 100);

  const staleIds: string[] = [];
  for (const [fingerprint, row] of existing) {
    if (seen.has(fingerprint)) continue;
    if (row.status === IssueStatus.RESOLVED || row.status === IssueStatus.IGNORED) continue;
    staleIds.push(row.id);
  }

  for (let i = 0; i < staleIds.length; i += ISSUE_BATCH) {
    const batch = staleIds.slice(i, i + ISSUE_BATCH);
    const resolved = await prisma.technicalIssue.updateMany({
      where: { id: { in: batch } },
      data: { status: IssueStatus.RESOLVED, resolvedAt: now },
    });
    counts.issuesResolved += resolved.count;
  }

  return counts;
}

/** URL → durable page id, for attaching issues to the page they belong to. */
async function loadPageIdIndex(websiteId: string): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const where: Prisma.PageWhereInput = {
      websiteId,
      ...(cursor === null ? {} : { id: { gt: cursor } }),
    };
    const rows = await prisma.page.findMany({
      where,
      orderBy: { id: 'asc' },
      take: 1_000,
      select: { id: true, url: true, normalizedUrl: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      index.set(row.url, row.id);
      index.set(row.normalizedUrl, row.id);
    }
    if (rows.length < 1_000) break;
  }
  return index;
}

// ─────────────────────────────────────────────────────────────
// analysis.page-scores
// ─────────────────────────────────────────────────────────────

export interface PageScoresResult {
  status: 'completed';
  pagesScored: number;
  pagesSkipped: number;
  crawlId: string | null;
}

export const pageScores: JobHandler<'analysis.page-scores'> = async ({ payload, ctx }) =>
  scorePages(await loadWebsite(payload.websiteId), payload.pageIds ?? null, (p, m) =>
    ctx.updateProgress(p, m),
  );

async function scorePages(
  website: WebsiteWithSettings,
  pageIds: string[] | null,
  progress: Progress,
): Promise<PageScoresResult | SkippedOutcome> {
  const settings = effectiveSettings(website);

  const latestCrawl = await prisma.crawl.findFirst({
    where: { websiteId: website.id, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const total = await prisma.page.count({
    where: {
      websiteId: website.id,
      isActive: true,
      ...(pageIds?.length ? { id: { in: pageIds } } : {}),
    },
  });
  if (total === 0) {
    return skip(`${website.domain} has no active pages to score.`, ['Run a site crawl first']);
  }

  const maxImpressions = await maxImpressionsOnSite(website.id);
  let scored = 0;
  let skipped = 0;
  let cursor: string | null = null;

  for (;;) {
    const where: Prisma.PageWhereInput = {
      websiteId: website.id,
      isActive: true,
      ...(pageIds?.length ? { id: { in: pageIds } } : {}),
      ...(cursor === null ? {} : { id: { gt: cursor } }),
    };
    const pages = await prisma.page.findMany({
      where,
      orderBy: { id: 'asc' },
      take: PAGE_BATCH,
      select: {
        id: true,
        url: true,
        title: true,
        metaDescription: true,
        h1: true,
        wordCount: true,
        isIndexable: true,
        indexabilityReason: true,
        internalLinksIn: true,
        internalLinksOut: true,
        schemaTypes: true,
        clicks28d: true,
        impressions28d: true,
        ctr28d: true,
        position28d: true,
        clicksTrendPct: true,
      },
    });
    if (pages.length === 0) break;
    cursor = pages[pages.length - 1].id;

    const ids = pages.map((page) => page.id);
    const [crawlPages, issues, keywords] = await Promise.all([
      latestCrawl
        ? prisma.crawlPage.findMany({
            where: { crawlId: latestCrawl.id, pageId: { in: ids } },
            select: {
              pageId: true,
              headings: true,
              imageCount: true,
              imagesMissingAlt: true,
              textContent: true,
            },
          })
        : Promise.resolve([]),
      prisma.technicalIssue.findMany({
        where: {
          pageId: { in: ids },
          status: { in: [IssueStatus.OPEN, IssueStatus.REGRESSED, IssueStatus.IN_PROGRESS] },
        },
        select: { pageId: true, severity: true, weight: true },
      }),
      prisma.keyword.findMany({
        where: { pageId: { in: ids } },
        orderBy: { impressions28d: 'desc' },
        take: ids.length * 3,
        select: { pageId: true, keyword: true },
      }),
    ]);

    const crawlByPage = new Map(crawlPages.map((row) => [row.pageId, row]));
    const issuesByPage = new Map<string, Array<{ severity: string; weight: number }>>();
    for (const issue of issues) {
      if (!issue.pageId) continue;
      const list = issuesByPage.get(issue.pageId) ?? [];
      list.push({ severity: issue.severity, weight: issue.weight });
      issuesByPage.set(issue.pageId, list);
    }
    const keywordByPage = new Map<string, string>();
    for (const keyword of keywords) {
      if (keyword.pageId && !keywordByPage.has(keyword.pageId)) {
        keywordByPage.set(keyword.pageId, keyword.keyword);
      }
    }

    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const page of pages) {
      const crawlPage = crawlByPage.get(page.id);
      const openIssues = issuesByPage.get(page.id) ?? [];
      const headings = Array.isArray(crawlPage?.headings) ? crawlPage.headings.length : 0;
      const text = crawlPage?.textContent ?? null;

      const seo = calculatePageSeoScore({
        title: page.title,
        metaDescription: page.metaDescription,
        h1: page.h1,
        headingCount: headings,
        wordCount: page.wordCount,
        isIndexable: page.isIndexable,
        indexabilityReason: page.indexabilityReason,
        internalLinksIn: page.internalLinksIn,
        internalLinksOut: page.internalLinksOut,
        schemaTypes: page.schemaTypes,
        imageCount: crawlPage?.imageCount ?? 0,
        imagesMissingAlt: crawlPage?.imagesMissingAlt ?? 0,
        openIssues,
        targetKeyword: keywordByPage.get(page.id) ?? null,
        textContent: text,
        thinContentWords: settings.thinContentWords,
      });

      const opportunity = calculatePageOpportunity({
        impressions28d: page.impressions28d,
        clicks28d: page.clicks28d,
        position28d: page.position28d,
        ctr28d: page.ctr28d,
        clicksTrendPct: page.clicksTrendPct,
        seoScore: seo.score,
        internalLinksIn: page.internalLinksIn,
        wordCount: page.wordCount,
        openIssueCount: openIssues.length,
        maxImpressionsOnSite: maxImpressions,
      });

      updates.push(
        prisma.page.update({
          where: { id: page.id },
          data: {
            seoScore: seo.score,
            opportunityScore: opportunity.score,
            // Readability is only meaningful when we actually hold the text.
            readabilityScore: text ? round(fleschReadingEase(text), 1) : null,
            lastAnalysedAt: new Date(),
          },
        }),
      );
      if (!crawlPage) skipped += 1;
    }

    await runChunked(updates, 100);
    scored += pages.length;
    await progress(Math.min(95, (scored / total) * 100), `Scored ${scored} of ${total} pages`);
    if (pages.length < PAGE_BATCH) break;
  }

  await progress(100, 'Page scores updated');
  return {
    status: 'completed',
    pagesScored: scored,
    pagesSkipped: skipped,
    crawlId: latestCrawl?.id ?? null,
  };
}

// ─────────────────────────────────────────────────────────────
// analysis.site-scores
// ─────────────────────────────────────────────────────────────

export interface SiteScoresResult {
  status: 'completed';
  healthScore: number;
  contentScore: number | null;
  openIssues: number;
  criticalIssues: number;
  indexablePages: number;
  snapshotDate: string | null;
}

export const siteScores: JobHandler<'analysis.site-scores'> = async ({ payload, ctx }) =>
  scoreSite(await loadWebsite(payload.websiteId), payload.snapshot ?? true, (p, m) =>
    ctx.updateProgress(p, m),
  );

async function scoreSite(
  website: WebsiteWithSettings,
  writeSnapshot: boolean,
  progress: Progress,
): Promise<SiteScoresResult | SkippedOutcome> {
  await progress(10, 'Reading open issues');

  const issues: Array<{ category: string; severity: string; weight: number; status: string }> = [];
  let cursor: string | null = null;
  while (issues.length < MAX_TRACKED_ISSUES) {
    const where: Prisma.TechnicalIssueWhereInput = {
      websiteId: website.id,
      status: { in: [IssueStatus.OPEN, IssueStatus.REGRESSED, IssueStatus.IN_PROGRESS] },
      ...(cursor === null ? {} : { id: { gt: cursor } }),
    };
    const rows = await prisma.technicalIssue.findMany({
      where,
      orderBy: { id: 'asc' },
      take: ISSUE_BATCH,
      select: { id: true, category: true, severity: true, weight: true, status: true },
    });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      issues.push({
        category: row.category,
        severity: row.severity,
        weight: row.weight,
        status: row.status,
      });
    }
    if (rows.length < ISSUE_BATCH) break;
  }

  const [pageCount, indexablePages, orphanPages, criticalIssues, contentAggregate] = await Promise.all([
    prisma.page.count({ where: { websiteId: website.id, isActive: true } }),
    prisma.page.count({ where: { websiteId: website.id, isActive: true, isIndexable: true } }),
    prisma.page.count({ where: { websiteId: website.id, isActive: true, isOrphan: true } }),
    prisma.technicalIssue.count({
      where: {
        websiteId: website.id,
        severity: 'CRITICAL',
        status: { in: [IssueStatus.OPEN, IssueStatus.REGRESSED, IssueStatus.IN_PROGRESS] },
      },
    }),
    prisma.page.aggregate({
      where: { websiteId: website.id, isActive: true, seoScore: { not: null } },
      _avg: { seoScore: true },
    }),
  ]);

  if (pageCount === 0) {
    return skip(`${website.domain} has no crawled pages, so there is no site score to compute.`, [
      'Run a site crawl first',
    ]);
  }

  await progress(45, 'Scoring');
  const health = calculateHealthScore({ issues, pageCount });
  const contentScore =
    contentAggregate._avg.seoScore === null ? null : round(contentAggregate._avg.seoScore, 1);

  await prisma.website.update({
    where: { id: website.id },
    data: {
      healthScore: health.score,
      contentScore,
      lastAnalysisAt: new Date(),
    },
  });

  let snapshotDate: string | null = null;
  if (writeSnapshot) {
    await progress(70, 'Writing the score snapshot');
    const window = lastNDays(ROLLING_DAYS, 3);
    const [totals, top3, top10, top100] = await Promise.all([
      loadSiteTotals(website.id, window),
      prisma.keyword.count({
        where: { websiteId: website.id, currentPosition: { gt: 0, lte: 3 } },
      }),
      prisma.keyword.count({
        where: { websiteId: website.id, currentPosition: { gt: 0, lte: 10 } },
      }),
      prisma.keyword.count({
        where: { websiteId: website.id, currentPosition: { gt: 0, lte: 100 } },
      }),
    ]);

    const today = toUtcDate(new Date());
    await prisma.scoreSnapshot.upsert({
      where: { websiteId_date: { websiteId: website.id, date: today } },
      create: {
        websiteId: website.id,
        date: today,
        healthScore: health.score,
        geoScore: website.geoScore,
        aiVisibilityScore: website.aiVisibilityScore,
        contentScore,
        openIssues: issues.length,
        criticalIssues,
        indexablePages,
        orphanPages,
        keywordsTop3: top3,
        keywordsTop10: top10,
        keywordsTop100: top100,
        clicks28d: totals.clicks,
        impressions28d: totals.impressions,
        avgPosition: totals.position,
      },
      update: {
        healthScore: health.score,
        geoScore: website.geoScore,
        aiVisibilityScore: website.aiVisibilityScore,
        contentScore,
        openIssues: issues.length,
        criticalIssues,
        indexablePages,
        orphanPages,
        keywordsTop3: top3,
        keywordsTop10: top10,
        keywordsTop100: top100,
        clicks28d: totals.clicks,
        impressions28d: totals.impressions,
        avgPosition: totals.position,
      },
    });
    snapshotDate = formatDateKey(today);
  }

  await progress(100, 'Site scores updated');
  return {
    status: 'completed',
    healthScore: health.score,
    contentScore,
    openIssues: issues.length,
    criticalIssues,
    indexablePages,
    snapshotDate,
  };
}

// ─────────────────────────────────────────────────────────────
// analysis.full
// ─────────────────────────────────────────────────────────────

export interface FullAnalysisResult {
  status: 'completed';
  audit: TechnicalAuditResult | SkippedOutcome;
  pageScores: PageScoresResult | SkippedOutcome;
  siteScores: SiteScoresResult | SkippedOutcome;
  enqueued: string[];
  notEnqueued: string[];
}

/**
 * The whole deterministic pipeline for a site.
 *
 * The three analysis-lane steps run inline and in order, because each one reads what the
 * previous wrote (issues → page scores → site health). Everything else is *enqueued* rather
 * than inlined: keyword, link, GEO and content work belongs on lanes with their own
 * concurrency and rate limits, and inlining it here would let one site's full analysis
 * monopolise a worker for an hour.
 */
export const fullAnalysis: JobHandler<'analysis.full'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const progress: Progress = (p, m) => ctx.updateProgress(p, m);

  const audit = await runAudit(website, payload.crawlId ?? null, null, slice(progress, 0, 40));
  const pages = await scorePages(website, null, slice(progress, 40, 70));
  const site = await scoreSite(website, true, slice(progress, 70, 85));

  const chained: Array<[string, Promise<{ enqueued: boolean }>]> = [
    [
      'links.analyse-internal',
      enqueue(
        'links.analyse-internal',
        { websiteId: website.id },
        { trigger: 'chain', dedupeKey: `links:${website.id}` },
      ),
    ],
    [
      'keywords.discover',
      enqueue(
        'keywords.discover',
        { websiteId: website.id },
        { trigger: 'chain', dedupeKey: `kw-discover:${website.id}` },
      ),
    ],
    [
      'keywords.cluster',
      enqueue(
        'keywords.cluster',
        { websiteId: website.id },
        { trigger: 'chain', dedupeKey: `kw-cluster:${website.id}` },
      ),
    ],
    [
      'content.detect-decay',
      enqueue(
        'content.detect-decay',
        { websiteId: website.id },
        { trigger: 'chain', dedupeKey: `decay:${website.id}` },
      ),
    ],
    [
      'geo.audit',
      enqueue(
        'geo.audit',
        { websiteId: website.id },
        { trigger: 'chain', dedupeKey: `geo:${website.id}` },
      ),
    ],
  ];

  const enqueued: string[] = [];
  const notEnqueued: string[] = [];
  for (const [name, promise] of chained) {
    const outcome = await promise;
    if (outcome.enqueued) enqueued.push(name);
    else notEnqueued.push(name);
  }

  await progress(100, 'Full analysis complete');
  const result: FullAnalysisResult = {
    status: 'completed',
    audit,
    pageScores: pages,
    siteScores: site,
    enqueued,
    notEnqueued,
  };
  return result;
};
