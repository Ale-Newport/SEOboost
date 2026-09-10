import { getPath, normalizeUrl, type ExplainableScore } from '@seo/shared';
import { calculateHealthScore, runTechnicalAudit, type AuditResult, type IssueDraft } from '@seo/seo-engine';
import type { IssueStatus } from '@prisma/client';
import { prisma } from '../client';
import { createManyChunked, json } from '../helpers';
import type { DemoCrawl } from './demo-pages';
import type { DemoSiteBlueprint } from './demo-sites';
import { Rng } from './rng';

/** One issue's lifetime, used to recompute the health score for each day of the score history. */
export interface IssueLifetime {
  category: string;
  severity: string;
  weight: number;
  discoveredAt: Date;
  resolvedAt: Date | null;
}

export interface DemoCrawlResult {
  crawlId: string;
  pageIdByPath: Map<string, string>;
  pageIdByNormalizedUrl: Map<string, string>;
  audit: AuditResult;
  issues: IssueDraft[];
  issueLifetimes: IssueLifetime[];
  health: ExplainableScore;
  counts: Record<string, number>;
}

const CRAWL_DAYS_AGO = 1;
/** Search Console lags ~3 days, so the score history ends there; nothing may be newer than that. */
const SCORE_HISTORY_FLOOR_DAYS = 5;

/**
 * Persist the synthetic crawl and the issues the real rule engine finds in it.
 *
 * Nothing in here writes an issue by hand: `runTechnicalAudit` is handed the crawl and whatever it
 * returns is what the demo shows. The only editorial choice is *when* each finding was first seen,
 * which is what gives the score history something to move against.
 */
export async function persistDemoCrawl(
  site: DemoSiteBlueprint,
  websiteId: string,
  crawl: DemoCrawl,
  now: Date,
): Promise<DemoCrawlResult> {
  const rng = new Rng(`${site.key}:crawl`);
  const crawledAt = new Date(now.getTime() - CRAWL_DAYS_AGO * 86_400_000);
  const audit = runTechnicalAudit(crawl.dataset);

  const crawlRow = await prisma.crawl.create({
    data: {
      websiteId,
      status: 'COMPLETED',
      trigger: 'seed:demo',
      maxPages: 1000,
      maxDepth: 10,
      renderJs: false,
      userAgent: 'SEO-OS-Bot/1.0 (+https://github.com/seo-os)',
      pagesDiscovered: crawl.pages.length,
      pagesCrawled: crawl.pages.length,
      pagesFailed: crawl.pages.filter((p) => (p.statusCode ?? 0) >= 500).length,
      issuesFound: audit.issues.length,
      robotsTxtFound: crawl.dataset.robots.found,
      robotsTxtBody: crawl.dataset.robots.body,
      sitemapUrls: crawl.dataset.robots.sitemaps,
      sitemapUrlCount: crawl.dataset.sitemap.urls.length,
      startedAt: new Date(crawledAt.getTime() - 4 * 60_000),
      finishedAt: crawledAt,
      durationMs: 4 * 60_000,
      progressMessage: `Crawled ${crawl.pages.length} URLs`,
    },
    select: { id: true },
  });

  // ── Pages (the durable, cross-crawl view) ──────────────────────────────────
  await createManyChunked(prisma.page, crawl.pages.map((page) => ({
    websiteId,
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    path: getPath(page.url),
    pageType: page.pageType,
    title: page.title,
    metaDescription: page.metaDescription,
    h1: page.h1[0] ?? null,
    canonicalUrl: page.canonicalUrl,
    lang: page.lang,
    wordCount: page.wordCount,
    statusCode: page.statusCode,
    depth: page.depth,
    isIndexable: page.isIndexable,
    indexabilityReason: page.indexabilityReason,
    inSitemap: page.inSitemap,
    contentHash: page.contentHash,
    schemaTypes: page.schemaTypes,
    internalLinksIn: page.internalLinksIn ?? 0,
    internalLinksOut: page.internalLinksOut ?? 0,
    externalLinksOut: page.externalLinkCount,
    isOrphan: (page.internalLinksIn ?? 0) === 0 && page.path !== '/',
    publishedAt: page.publishedAt,
    contentUpdatedAt: page.contentUpdatedAt,
    firstSeenAt: page.publishedAt ?? crawledAt,
    lastCrawledAt: crawledAt,
    lastAnalysedAt: crawledAt,
    isActive: true,
  })));

  const pageRows = await prisma.page.findMany({
    where: { websiteId },
    select: { id: true, normalizedUrl: true },
  });
  const pageIdByNormalizedUrl = new Map(pageRows.map((row) => [row.normalizedUrl, row.id]));
  const pageIdByPath = new Map<string, string>();
  for (const page of crawl.pages) {
    const id = pageIdByNormalizedUrl.get(page.normalizedUrl);
    if (id) pageIdByPath.set(page.path, id);
  }

  // ── Crawl pages (the immutable snapshot) ───────────────────────────────────
  await createManyChunked(prisma.crawlPage, crawl.pages.map((page) => ({
    crawlId: crawlRow.id,
    pageId: pageIdByNormalizedUrl.get(page.normalizedUrl) ?? null,
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    statusCode: page.statusCode,
    contentType: page.contentType,
    redirectTarget: page.redirectTarget,
    redirectChain: page.redirectChain,
    depth: page.depth,
    responseTimeMs: page.responseTimeMs,
    contentBytes: page.contentBytes,
    error: page.error,
    title: page.title,
    titleLength: page.title?.length ?? null,
    metaDescription: page.metaDescription,
    metaDescriptionLength: page.metaDescription?.length ?? null,
    canonicalUrl: page.canonicalUrl,
    robotsMeta: page.robotsMeta,
    xRobotsTag: page.xRobotsTag,
    metaViewport: page.metaViewport,
    lang: page.lang,
    h1: page.h1,
    headings: json(page.headings),
    wordCount: page.wordCount,
    textContent: page.textContent,
    contentHash: page.contentHash,
    simhash: page.simhash,
    internalLinkCount: page.internalLinkCount,
    externalLinkCount: page.externalLinkCount,
    imageCount: page.imageCount,
    imagesMissingAlt: page.imagesMissingAlt,
    schemaTypes: page.schemaTypes,
    structuredData: json(page.structuredData),
    hreflang: json(page.hreflang),
    openGraph: json({ 'og:title': page.title, 'og:type': page.path === '/' ? 'website' : 'article' }),
    isIndexable: page.isIndexable,
    indexabilityReason: page.indexabilityReason,
    inSitemap: page.inSitemap,
    crawledAt,
  })));

  const crawlPageRows = await prisma.crawlPage.findMany({
    where: { crawlId: crawlRow.id },
    select: { id: true, normalizedUrl: true },
  });
  const crawlPageIdByNormalized = new Map(crawlPageRows.map((row) => [row.normalizedUrl, row.id]));

  // ── Link graph ─────────────────────────────────────────────────────────────
  const edgeRows = crawl.edges
    .map((edge) => {
      const sourceNormalized = normalizeUrl(edge.fromUrl);
      const targetNormalized = normalizeUrl(edge.toUrl);
      const sourceCrawlPageId = sourceNormalized ? crawlPageIdByNormalized.get(sourceNormalized) : undefined;
      if (!sourceCrawlPageId || !targetNormalized) return null;
      return {
        crawlId: crawlRow.id,
        sourceCrawlPageId,
        sourceUrl: edge.fromUrl,
        targetUrl: edge.toUrl,
        normalizedTarget: targetNormalized,
        anchorText: edge.anchorText,
        rel: null,
        isInternal: true,
        isNofollow: false,
        inNav: edge.inNav,
        inFooter: edge.inFooter,
        inMainContent: edge.inMainContent,
        position: edge.position,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  await createManyChunked(prisma.linkEdge, edgeRows);

  // ── Issues ─────────────────────────────────────────────────────────────────
  const issueLifetimes: IssueLifetime[] = [];
  const issueRows = audit.issues.map((issue) => {
    // Findings are not all discovered at once in reality: a site accumulates them, and yesterday's
    // crawl mostly re-confirms what an earlier one already found. Spreading `discoveredAt` across
    // the window is what makes the score history a curve rather than a step.
    //
    // The floor is `SCORE_HISTORY_FLOOR_DAYS`, not 1, and that matters: the score history ends at
    // the end of the Search Console window, which lags real time. An issue discovered inside that
    // lag would be counted in the site's current health score but not in the last point of its own
    // history chart, so the chart would end well above the number on the dashboard.
    const ageDays = rng.int(SCORE_HISTORY_FLOOR_DAYS, 88);
    const discoveredAt = new Date(now.getTime() - ageDays * 86_400_000);

    // A slice of the low-severity, auto-fixable findings are presented as already fixed, so the
    // "resolved" view and the improving trend have something behind them.
    const resolvable = issue.autoFixable && (issue.severity === 'LOW' || issue.severity === 'INFO');
    const resolved = resolvable && ageDays > 20 && rng.bool(0.35);
    const resolvedAt = resolved ? new Date(now.getTime() - rng.int(4, ageDays - 10) * 86_400_000) : null;
    const status: IssueStatus = resolved ? 'RESOLVED' : 'OPEN';

    issueLifetimes.push({
      category: issue.category,
      severity: issue.severity,
      weight: issue.weight,
      discoveredAt,
      resolvedAt,
    });

    return {
      websiteId,
      crawlId: crawlRow.id,
      pageId: issue.url ? pageIdByNormalizedUrl.get(normalizeUrl(issue.url) ?? '') ?? null : null,
      ruleId: issue.ruleId,
      title: issue.title,
      category: issue.category,
      severity: issue.severity,
      status,
      url: issue.url,
      description: issue.description,
      recommendation: issue.recommendation,
      evidence: json(issue.evidence),
      estimatedImpact: issue.estimatedImpact,
      confidence: issue.confidence,
      autoFixable: issue.autoFixable,
      weight: issue.weight,
      fingerprint: issue.fingerprint,
      discoveredAt,
      lastSeenAt: crawledAt,
      resolvedAt,
    };
  });
  await createManyChunked(prisma.technicalIssue, issueRows);

  const health = calculateHealthScore({
    issues: audit.issues.map((issue, index) => ({
      category: issue.category,
      severity: issue.severity,
      weight: issue.weight,
      status: issueRows[index].status,
    })),
    pageCount: crawl.pages.length,
  });

  return {
    crawlId: crawlRow.id,
    pageIdByPath,
    pageIdByNormalizedUrl,
    audit,
    issues: audit.issues,
    issueLifetimes,
    health,
    counts: {
      Crawl: 1,
      Page: crawl.pages.length,
      CrawlPage: crawl.pages.length,
      LinkEdge: edgeRows.length,
      TechnicalIssue: issueRows.length,
    },
  };
}
