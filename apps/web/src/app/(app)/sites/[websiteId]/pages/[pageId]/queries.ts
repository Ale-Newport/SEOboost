import 'server-only';
import { Prisma, prisma } from '@seo/db';
import {
  GEO_DIMENSION_LABELS,
  GEO_DIMENSION_WEIGHTS,
  SEO_THRESHOLDS,
  containsPhrase,
  expectedCtr,
  fleschReadingEase,
  formatDateKey,
  lastNDays,
  percentChange,
  previousPeriod,
  readabilityLabel,
  round,
  type ExplainableScore,
  type HeadingNode,
  type ScoreFactor,
  type StructuredDataBlock,
} from '@seo/shared';
import { calculatePageOpportunity, calculatePageSeoScore } from '@seo/seo-engine';

import { GSC_LAG_DAYS } from '@/server/queries/analytics';
import { getPageProfile, type PageProfile, type PageQueryRow } from '@/server/queries/pages';
import type {
  MetaField,
  MetaReview,
  MetaStatus,
  PageChange,
  PageDetailData,
  PageDocument,
  PageHistoryEntry,
  PagePerformance,
  PagePerformancePoint,
  PagePerformanceTotals,
  PageQueryInsight,
  PageRecommendation,
} from '@/components/pages/types';

/**
 * Everything the page-detail screen renders that the shared page read model does not already
 * return: the per-URL daily series, the crawl-time document (headings, images, body text), the
 * explainable form of each score, and the snapshot diffs.
 *
 * It lives beside the route rather than in `server/queries` because it is specific to this one
 * screen, and it re-uses `getPageProfile` rather than re-querying what that model already owns.
 */

/** Days of history the performance chart covers. */
const SERIES_DAYS = 90;

// ── Performance ──────────────────────────────────────────────────────────────

interface DailyRow {
  date: Date;
  clicks: bigint;
  impressions: bigint;
  weighted: number;
}

/**
 * Daily Search Console rows for one URL.
 *
 * Aggregated in SQL because a busy page can hold hundreds of query rows per day, and because the
 * average position has to be impression-weighted — something Prisma's `groupBy` cannot express.
 */
async function dailySeries(pageId: string, start: Date, end: Date): Promise<DailyRow[]> {
  return prisma.$queryRaw<DailyRow[]>(Prisma.sql`
    SELECT
      "date",
      SUM("clicks")::bigint      AS clicks,
      SUM("impressions")::bigint AS impressions,
      COALESCE(SUM("position" * "impressions") / NULLIF(SUM("impressions"), 0), 0) AS weighted
    FROM "GscQueryMetric"
    WHERE "pageId" = ${pageId}
      AND "source" = 'gsc'
      AND "date" >= ${start}
      AND "date" <= ${end}
    GROUP BY "date"
    ORDER BY "date" ASC
  `);
}

function totalsOf(rows: DailyRow[]): PagePerformanceTotals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  for (const row of rows) {
    const dayImpressions = Number(row.impressions);
    clicks += Number(row.clicks);
    impressions += dayImpressions;
    weighted += Number(row.weighted) * dayImpressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? round(clicks / impressions, 5) : 0,
    position: impressions > 0 ? round(weighted / impressions, 2) : null,
  };
}

async function getPagePerformance(pageId: string): Promise<PagePerformance> {
  const range = lastNDays(SERIES_DAYS, GSC_LAG_DAYS);
  const comparison = previousPeriod(range);

  const [current, previousRows] = await Promise.all([
    dailySeries(pageId, range.start, range.end),
    dailySeries(pageId, comparison.start, comparison.end),
  ]);

  // Every day in the window gets a row, so a gap in the data reads as a gap rather than as a
  // continuous line drawn between two distant points.
  const byDate = new Map(current.map((row) => [formatDateKey(row.date), row]));
  const points: PagePerformancePoint[] = [];
  for (let index = 0; index < SERIES_DAYS; index++) {
    const day = new Date(range.start.getTime() + index * 86_400_000);
    const key = formatDateKey(day);
    const row = byDate.get(key);
    const impressions = row ? Number(row.impressions) : 0;
    points.push({
      date: key,
      clicks: row ? Number(row.clicks) : 0,
      impressions,
      position: row && impressions > 0 ? round(Number(row.weighted), 1) : null,
    });
  }

  const totals = totalsOf(current);
  const previous = totalsOf(previousRows);

  return {
    points,
    totals,
    previous,
    deltas: {
      clicks: percentChange(previous.clicks, totals.clicks),
      impressions: percentChange(previous.impressions, totals.impressions),
      ctr: percentChange(previous.ctr, totals.ctr),
      position:
        previous.position === null || totals.position === null
          ? null
          : percentChange(previous.position, totals.position),
    },
    hasData: totals.impressions > 0 || totals.clicks > 0,
    range: { from: formatDateKey(range.start), to: formatDateKey(range.end) },
    comparisonRange: { from: formatDateKey(comparison.start), to: formatDateKey(comparison.end) },
    days: SERIES_DAYS,
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/** Attach the expected-CTR comparison. Nothing is invented: it is a function of the position. */
function withCtrGaps(rows: PageQueryRow[]): PageQueryInsight[] {
  return rows.map((row) => {
    const expected = expectedCtr(row.position);
    const gap = round(row.ctr - expected, 5);
    const potential = gap < 0 ? Math.round(row.impressions * -gap) : 0;
    return {
      ...row,
      expectedCtr: round(expected, 5),
      ctrGap: gap,
      potentialClicks: potential,
      // A gap only counts when there is enough volume for the rate to mean anything.
      underperforms: gap < 0 && row.impressions >= SEO_THRESHOLDS.ctrOpportunity.minImpressions,
    };
  });
}

// ── Crawl-time document ──────────────────────────────────────────────────────

function parseHeadings(value: Prisma.JsonValue | null): HeadingNode[] {
  if (!Array.isArray(value)) return [];
  const out: HeadingNode[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const level = typeof record.level === 'number' ? record.level : Number(record.level);
    const text = typeof record.text === 'string' ? record.text : null;
    if (!Number.isFinite(level) || text === null) continue;
    out.push({ level, text });
  }
  return out;
}

function parseStructuredData(value: Prisma.JsonValue | null): StructuredDataBlock[] {
  if (!Array.isArray(value)) return [];
  const out: StructuredDataBlock[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const types = Array.isArray(record.type)
      ? record.type.filter((item): item is string => typeof item === 'string')
      : typeof record.type === 'string'
        ? [record.type]
        : [];
    if (types.length === 0) continue;
    out.push({
      type: types,
      raw: record.raw ?? null,
      valid: record.valid !== false,
      ...(Array.isArray(record.errors)
        ? { errors: record.errors.filter((item): item is string => typeof item === 'string') }
        : {}),
    });
  }
  return out;
}

// ── Scores ───────────────────────────────────────────────────────────────────

/**
 * GEO stores each dimension's 0-1 result, not the whole explanation, so the breakdown is
 * rebuilt from those values and the published weights. Contributions are recomputed the same
 * way the engine computes them, and the per-dimension findings supply the wording.
 */
function geoExplainable(
  score: number,
  dimensions: Prisma.JsonValue | null,
  findings: Prisma.JsonValue | null,
): ExplainableScore | null {
  if (dimensions === null || typeof dimensions !== 'object' || Array.isArray(dimensions)) return null;
  const values = dimensions as Record<string, unknown>;

  const messages = new Map<string, string>();
  if (Array.isArray(findings)) {
    for (const entry of findings) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.dimension === 'string' && typeof record.message === 'string') {
        if (!messages.has(record.dimension)) messages.set(record.dimension, record.message);
      }
    }
  }

  const factors: ScoreFactor[] = [];
  for (const key of Object.keys(GEO_DIMENSION_WEIGHTS) as Array<keyof typeof GEO_DIMENSION_WEIGHTS>) {
    const raw = values[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const weight = GEO_DIMENSION_WEIGHTS[key];
    factors.push({
      key,
      label: GEO_DIMENSION_LABELS[key],
      value: raw,
      weight,
      contribution: round(raw * weight * 100, 2),
      explanation:
        messages.get(key) ??
        `Scored ${Math.round(raw * 100)} out of 100 on this dimension by the deterministic GEO audit.`,
    });
  }
  if (factors.length === 0) return null;

  return {
    score,
    factors,
    summary:
      'How readable this page is to answer engines: eleven measurable document properties, ' +
      'weighted. Deterministic — it describes the page, not a ranking guarantee.',
  };
}

// ── History ──────────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  capturedAt: Date;
  reason: string;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  wordCount: number;
  contentHash: string | null;
  statusCode: number | null;
  seoScore: number | null;
  geoScore: number | null;
  clicks28d: number | null;
  position28d: number | null;
}

/** Newest first, each entry diffed against the snapshot immediately before it. */
function buildHistory(rows: SnapshotRow[]): PageHistoryEntry[] {
  return rows.map((row, index) => {
    const previous = rows[index + 1];
    const changes: PageChange[] = [];

    if (previous) {
      if ((row.title ?? null) !== (previous.title ?? null)) {
        changes.push({ field: 'Title', before: previous.title, after: row.title });
      }
      if ((row.metaDescription ?? null) !== (previous.metaDescription ?? null)) {
        changes.push({ field: 'Meta description', before: previous.metaDescription, after: row.metaDescription });
      }
      if ((row.h1 ?? null) !== (previous.h1 ?? null)) {
        changes.push({ field: 'H1', before: previous.h1, after: row.h1 });
      }
      if (row.contentHash !== null && previous.contentHash !== null && row.contentHash !== previous.contentHash) {
        const delta = row.wordCount - previous.wordCount;
        changes.push({
          field: 'Body content',
          before: `${previous.wordCount} words`,
          after: `${row.wordCount} words`,
          detail:
            delta === 0
              ? 'The text changed while the length stayed the same.'
              : `${delta > 0 ? '+' : ''}${delta} words.`,
        });
      } else if (row.wordCount !== previous.wordCount) {
        changes.push({
          field: 'Word count',
          before: String(previous.wordCount),
          after: String(row.wordCount),
        });
      }
      if (row.statusCode !== previous.statusCode) {
        changes.push({
          field: 'Status code',
          before: previous.statusCode === null ? null : String(previous.statusCode),
          after: row.statusCode === null ? null : String(row.statusCode),
        });
      }
    }

    return {
      id: row.id,
      capturedAt: row.capturedAt,
      reason: row.reason,
      wordCount: row.wordCount,
      seoScore: row.seoScore,
      geoScore: row.geoScore,
      clicks28d: row.clicks28d,
      position28d: row.position28d,
      changes,
      isFirst: previous === undefined,
    };
  });
}

// ── Title & meta review ──────────────────────────────────────────────────────

function metaField(value: string | null, min: number, max: number): MetaField {
  const trimmed = value?.trim() ?? '';
  const length = trimmed.length;
  const status: MetaStatus =
    length === 0 ? 'missing' : length < min ? 'short' : length > max ? 'long' : 'ok';
  return { value: trimmed === '' ? null : trimmed, length, min, max, status };
}

function buildMetaReview(
  title: string | null,
  metaDescription: string | null,
  h1: string | null,
  queries: PageQueryRow[],
): MetaReview {
  const titleText = title?.trim() ?? '';
  const missingFromTitle = queries
    .filter((row) => row.impressions > 0 && (titleText === '' || !containsPhrase(titleText, row.query)))
    .slice(0, 5)
    .map((row) => ({ query: row.query, impressions: row.impressions, position: row.position }));

  return {
    title: metaField(title, SEO_THRESHOLDS.title.min, SEO_THRESHOLDS.title.max),
    metaDescription: metaField(
      metaDescription,
      SEO_THRESHOLDS.metaDescription.min,
      SEO_THRESHOLDS.metaDescription.max,
    ),
    h1: h1?.trim() === '' ? null : (h1 ?? null),
    missingFromTitle,
  };
}

// ── Recommendations ──────────────────────────────────────────────────────────

/**
 * Concrete next steps, derived only from what is on this screen.
 *
 * Every entry names the measurement that produced it, so nothing here is advice the data does
 * not already support. An empty list is a real answer and the UI says so.
 */
function buildRecommendations(input: {
  websiteId: string;
  pageId: string;
  profile: PageProfile;
  meta: MetaReview;
  performance: PagePerformance;
  queries: PageQueryInsight[];
  thinContentWords: number;
}): PageRecommendation[] {
  const { profile, meta, queries, performance } = input;
  const page = profile.page;
  const base = `/sites/${input.websiteId}`;
  const out: PageRecommendation[] = [];

  const criticalIssues = profile.issues.filter(
    (issue) => issue.severity === 'CRITICAL' && (issue.status === 'OPEN' || issue.status === 'REGRESSED'),
  );
  if (criticalIssues.length > 0) {
    out.push({
      id: 'critical-issues',
      tone: 'critical',
      title: `Clear ${criticalIssues.length} critical issue${criticalIssues.length === 1 ? '' : 's'} first`,
      detail: criticalIssues
        .slice(0, 3)
        .map((issue) => issue.title)
        .join(' · '),
      href: `${base}/technical?severity=CRITICAL`,
      hrefLabel: 'Open the audit',
    });
  }

  if (!page.isIndexable) {
    out.push({
      id: 'indexability',
      tone: 'critical',
      title: 'This page cannot be indexed as it stands',
      detail:
        page.indexabilityReason ??
        'The last crawl marked it non-indexable but recorded no reason. Re-crawl to capture one.',
      href: `${base}/indexation`,
      hrefLabel: 'Indexation',
    });
  }

  if (meta.title.status === 'missing') {
    out.push({
      id: 'title-missing',
      tone: 'critical',
      title: 'Write a title tag',
      detail: 'The page has no title. It is the single largest on-page ranking and click-through signal.',
    });
  } else if (meta.title.status !== 'ok') {
    out.push({
      id: 'title-length',
      tone: 'warning',
      title: meta.title.status === 'short' ? 'Lengthen the title' : 'Shorten the title',
      detail: `${meta.title.length} characters; the readable range is ${meta.title.min}-${meta.title.max} before Google truncates it.`,
    });
  }

  if (meta.metaDescription.status === 'missing') {
    out.push({
      id: 'meta-missing',
      tone: 'warning',
      title: 'Write a meta description',
      detail:
        'Without one, the search snippet is assembled from whatever text the crawler finds first, and click-through suffers.',
    });
  } else if (meta.metaDescription.status !== 'ok') {
    out.push({
      id: 'meta-length',
      tone: 'info',
      title: meta.metaDescription.status === 'short' ? 'Expand the meta description' : 'Trim the meta description',
      detail: `${meta.metaDescription.length} characters; ${meta.metaDescription.min}-${meta.metaDescription.max} survives truncation on both desktop and mobile.`,
    });
  }

  const underperformers = queries.filter((row) => row.underperforms);
  if (underperformers.length > 0) {
    const potential = underperformers.reduce((total, row) => total + row.potentialClicks, 0);
    out.push({
      id: 'ctr-gap',
      tone: 'warning',
      title: `${underperformers.length} quer${underperformers.length === 1 ? 'y earns' : 'ies earn'} fewer clicks than their position predicts`,
      detail: `Closing the gap to the expected curve is worth roughly ${potential} click${potential === 1 ? '' : 's'} over 90 days. Rewrite the title and description for the intent behind ${underperformers[0]?.query ?? 'these queries'}.`,
    });
  }

  if (page.isOrphan) {
    out.push({
      id: 'orphan',
      tone: 'warning',
      title: 'Nothing links to this page internally',
      detail:
        'Orphans are reachable only through the sitemap and inherit no authority from the rest of the site.',
      href: `${base}/links`,
      hrefLabel: 'Internal links',
    });
  } else if (page.internalLinksIn < SEO_THRESHOLDS.internalLinksIn.lowThreshold) {
    out.push({
      id: 'few-links',
      tone: 'info',
      title: `Only ${page.internalLinksIn} internal link${page.internalLinksIn === 1 ? '' : 's'} point here`,
      detail: `Pages below ${SEO_THRESHOLDS.internalLinksIn.lowThreshold} inbound internal links are typically crawled less often and rank below their content quality.`,
      href: `${base}/links`,
      hrefLabel: 'Internal links',
    });
  }

  const pendingLinks = profile.recommendations.linkSuggestionsIn.filter((row) => row.status === 'PENDING');
  if (pendingLinks.length > 0) {
    out.push({
      id: 'pending-links',
      tone: 'info',
      title: `${pendingLinks.length} internal link suggestion${pendingLinks.length === 1 ? '' : 's'} waiting for a decision`,
      detail: `Highest relevance: ${pendingLinks[0]?.sourceUrl ?? ''}.`,
      href: `${base}/links`,
      hrefLabel: 'Review suggestions',
    });
  }

  if (page.wordCount < input.thinContentWords) {
    out.push({
      id: 'thin',
      tone: 'warning',
      title: 'Thin content',
      detail: `${page.wordCount} words against this site's ${input.thinContentWords}-word threshold. Either deepen it or consolidate it into a stronger page.`,
    });
  }

  if (page.depth > SEO_THRESHOLDS.crawlDepth.warn) {
    out.push({
      id: 'depth',
      tone: 'info',
      title: `${page.depth} clicks from the homepage`,
      detail: `Anything past depth ${SEO_THRESHOLDS.crawlDepth.warn} is crawled less often. Link to it from a hub page closer to the root.`,
      href: `${base}/architecture`,
      hrefLabel: 'Architecture',
    });
  }

  if (page.schemaTypes.length === 0) {
    out.push({
      id: 'schema',
      tone: 'info',
      title: 'No structured data on this page',
      detail:
        'Schema markup is how answer engines read a page as facts rather than prose. Only mark up what is visibly on the page.',
      href: `${base}/schema`,
      hrefLabel: 'Structured data',
    });
  }

  if (
    page.clicksTrendPct !== null &&
    page.clicksTrendPct < -20 &&
    page.clicks28d > 0
  ) {
    out.push({
      id: 'decay',
      tone: 'warning',
      title: `Clicks are down ${Math.abs(Math.round(page.clicksTrendPct))}% period over period`,
      detail:
        performance.deltas.position !== null && performance.deltas.position > 0
          ? 'Average position slipped over the same window, so this reads as ranking loss rather than falling demand.'
          : 'Positions held, so this looks like falling demand or a changed SERP rather than a page problem.',
      href: `${base}/content`,
      hrefLabel: 'Content refresh',
    });
  }

  return out;
}

// ── The screen's data ────────────────────────────────────────────────────────

export async function getPageDetail(
  websiteId: string,
  pageId: string,
  thinContentWords: number,
): Promise<PageDetailData | null> {
  const profile = await getPageProfile(websiteId, pageId, { linkLimit: 50, queryLimit: 50 });
  if (!profile) return null;

  const page = profile.page;

  const [crawlPage, snapshots, geoAudit, maxImpressions, performance, openIssues] = await Promise.all([
    prisma.crawlPage.findFirst({
      where: { pageId },
      orderBy: { crawledAt: 'desc' },
      select: {
        crawledAt: true,
        statusCode: true,
        responseTimeMs: true,
        contentBytes: true,
        canonicalUrl: true,
        robotsMeta: true,
        xRobotsTag: true,
        lang: true,
        redirectChain: true,
        headings: true,
        imageCount: true,
        imagesMissingAlt: true,
        structuredData: true,
        textContent: true,
      },
    }),
    prisma.pageSnapshot.findMany({
      where: { pageId },
      orderBy: { capturedAt: 'desc' },
      take: 25,
      select: {
        id: true,
        capturedAt: true,
        reason: true,
        title: true,
        metaDescription: true,
        h1: true,
        wordCount: true,
        contentHash: true,
        statusCode: true,
        seoScore: true,
        geoScore: true,
        clicks28d: true,
        position28d: true,
      },
    }),
    prisma.geoPageAudit.findFirst({
      where: { pageId },
      orderBy: { audit: { createdAt: 'desc' } },
      select: { score: true, dimensions: true, findings: true, audit: { select: { createdAt: true } } },
    }),
    prisma.page.aggregate({
      where: { websiteId, isActive: true },
      _max: { impressions28d: true },
    }),
    getPagePerformance(pageId),
    prisma.technicalIssue.findMany({
      where: { pageId, status: { in: ['OPEN', 'REGRESSED', 'IN_PROGRESS'] } },
      select: { severity: true, weight: true },
    }),
  ]);

  const textContent = crawlPage?.textContent ?? null;

  const document: PageDocument | null = crawlPage
    ? {
        crawledAt: crawlPage.crawledAt,
        statusCode: crawlPage.statusCode,
        responseTimeMs: crawlPage.responseTimeMs,
        contentBytes: crawlPage.contentBytes,
        canonicalUrl: crawlPage.canonicalUrl,
        robotsMeta: crawlPage.robotsMeta,
        xRobotsTag: crawlPage.xRobotsTag,
        lang: crawlPage.lang,
        redirectChain: crawlPage.redirectChain,
        headings: parseHeadings(crawlPage.headings),
        imageCount: crawlPage.imageCount,
        imagesMissingAlt: crawlPage.imagesMissingAlt,
        structuredData: parseStructuredData(crawlPage.structuredData),
        readability:
          textContent && page.wordCount > 100
            ? (() => {
                const score = round(fleschReadingEase(textContent), 1);
                return { score, label: readabilityLabel(score) };
              })()
            : null,
      }
    : null;

  /*
   * The SEO score is recomputed here rather than displayed as a bare column value: it is the
   * same pure function, over the same inputs the analysis job used, so the breakdown can never
   * describe a different number than the one on screen. Without a crawl there is no document to
   * score, and the screen says so instead of showing an unexplainable figure.
   */
  const seo: ExplainableScore | null = crawlPage
    ? calculatePageSeoScore({
        title: page.title,
        metaDescription: page.metaDescription,
        h1: page.h1,
        headingCount: parseHeadings(crawlPage.headings).length,
        wordCount: page.wordCount,
        isIndexable: page.isIndexable,
        indexabilityReason: page.indexabilityReason,
        internalLinksIn: page.internalLinksIn,
        internalLinksOut: page.internalLinksOut,
        schemaTypes: page.schemaTypes,
        imageCount: crawlPage.imageCount,
        imagesMissingAlt: crawlPage.imagesMissingAlt,
        openIssues: openIssues.map((issue) => ({ severity: issue.severity, weight: issue.weight })),
        targetKeyword: profile.keywords[0]?.keyword ?? null,
        textContent,
        thinContentWords,
      })
    : null;

  const opportunity = calculatePageOpportunity({
    impressions28d: page.impressions28d,
    clicks28d: page.clicks28d,
    position28d: page.position28d,
    ctr28d: page.ctr28d,
    clicksTrendPct: page.clicksTrendPct,
    seoScore: seo?.score ?? page.seoScore,
    internalLinksIn: page.internalLinksIn,
    wordCount: page.wordCount,
    openIssueCount: openIssues.length,
    maxImpressionsOnSite: maxImpressions._max.impressions28d ?? 0,
  });

  const queries = withCtrGaps(profile.topQueries);
  const meta = buildMetaReview(page.title, page.metaDescription, page.h1, profile.topQueries);

  return {
    profile,
    document,
    performance,
    queries,
    history: buildHistory(snapshots),
    meta,
    recommendations: buildRecommendations({
      websiteId,
      pageId,
      profile,
      meta,
      performance,
      queries,
      thinContentWords,
    }),
    scores: {
      seo,
      opportunity,
      geo: geoAudit ? geoExplainable(geoAudit.score, geoAudit.dimensions, geoAudit.findings) : null,
      geoAuditedAt: geoAudit?.audit.createdAt ?? null,
    },
    thinContentWords,
    generatedSchema: profile.recommendations.structuredData,
  };
}
