/**
 * The crawl lane.
 *
 * `crawl.site` is the only job in the product that can run for hours and touch six figures of
 * rows, so its shape is dictated by two constraints:
 *
 *  1. **Nothing is buffered that does not have to be.** Pages are written as the crawler emits
 *     them (`onPage`), the durable `Page` reconcile walks `CrawlPage` by keyset, and the link
 *     graph is written in chunks. A 10 000-page site never materialises as 10 000 rows in the
 *     worker heap.
 *  2. **Cancellation must actually stop it.** BullMQ cannot interrupt a running processor, so
 *     the job polls two flags — the `JobRecord` (the Jobs screen) and `Crawl.status` (the
 *     Crawls screen) — and aborts the engine through an `AbortSignal`.
 *
 * A cancelled or capped crawl deliberately does *not* deactivate pages it never reached:
 * "we stopped early" and "this URL is gone" are different facts, and conflating them would
 * quietly delete half a site from the index view.
 */

import {
  CmsType,
  CrawlStatus,
  type Prisma,
  createManyChunked,
  json,
  prisma,
} from '@seo/db';
import {
  type CrawlEngineOutcome,
  type CrawlProgress,
  type DetectedCms,
  type PageAnalysis,
  crawlWebsite,
} from '@seo/crawler';
import { cancelJob, enqueue, type JobHandler } from '@seo/queue';
import { createLogger, errorMessage, getPath, round, truncate } from '@seo/shared';
import { effectiveSettings, loadWebsite, siteUrl } from '../lib/website';
import { runChunked } from '../lib/batch';
import { inferPageType } from '../lib/page-type';
import { cancelled, skip } from '../lib/result';

const log = createLogger('worker:crawl');

/** CrawlPage rows buffered before a write. Big enough to amortise, small enough to stay flat. */
const PAGE_FLUSH_SIZE = 200;

/** Characters of extracted text stored per page. Enough for every rule; bounded for the disk. */
const MAX_TEXT_CHARS = 60_000;

/** robots.txt is stored verbatim for the audit; a pathological file is truncated. */
const MAX_ROBOTS_CHARS = 20_000;

/** Ceiling on persisted link edges. A 10k-page site with 100 links per page hits this. */
const MAX_LINK_EDGES = 250_000;

/** Pages reconciled into the durable `Page` table per round trip. */
const RECONCILE_BATCH = 200;

/** How often the Crawl row's live counters are refreshed while the engine runs. */
const COUNTER_INTERVAL_MS = 5_000;

/** How often the two cancellation flags are polled. */
const CANCEL_POLL_MS = 3_000;

export interface CrawlSiteResult {
  status: 'completed';
  crawlId: string;
  pagesCrawled: number;
  pagesFailed: number;
  pagesPersisted: number;
  linkEdges: number;
  pagesUpserted: number;
  pagesDeactivated: number;
  snapshotsWritten: number;
  cms: string | null;
  limitReached: boolean;
  warnings: string[];
  auditEnqueued: boolean;
}

// ─────────────────────────────────────────────────────────────
// crawl.site
// ─────────────────────────────────────────────────────────────

export const crawlSite: JobHandler<'crawl.site'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const settings = effectiveSettings(website);
  const warnings: string[] = [];

  if (website.status === 'ARCHIVED') {
    return skip(`${website.name} is archived; unarchive it before crawling.`);
  }

  const start = payload.startUrls?.[0] ?? siteUrl(website);
  if (payload.startUrls && payload.startUrls.length > 1) {
    warnings.push(
      `Only the first of ${payload.startUrls.length} start URLs was used: the crawl engine seeds one entry point plus the sitemap. Queue a separate crawl for the others.`,
    );
  }

  const crawl = await ensureCrawlRow(payload.crawlId ?? null, {
    websiteId: website.id,
    trigger: payload.trigger ?? 'manual',
    maxPages: payload.maxPages ?? settings.crawlMaxPages,
    maxDepth: payload.maxDepth ?? settings.crawlMaxDepth,
    renderJs: payload.renderJs ?? settings.crawlRenderJs,
    userAgent: settings.crawlUserAgent,
  });

  const startedAt = new Date();
  await prisma.crawl.update({
    where: { id: crawl.id },
    data: {
      status: CrawlStatus.RUNNING,
      startedAt,
      finishedAt: null,
      error: null,
      progressMessage: 'Starting',
    },
  });

  await ctx.updateProgress(1, `Crawling ${website.domain}`);

  const abort = new AbortController();
  const state = {
    persisted: 0,
    failedWrites: 0,
    writeError: null as string | null,
    lastCounterAt: 0,
    lastCancelCheckAt: Date.now(),
    cancelCheckInFlight: false,
  };

  // CrawlPage inserts are serialised behind one promise chain: the engine's `onPage` hook is
  // synchronous, so this is what turns a stream of callbacks into ordered, awaited writes.
  let writeChain: Promise<void> = Promise.resolve();
  let buffer: Prisma.CrawlPageCreateManyInput[] = [];

  const flush = (rows: Prisma.CrawlPageCreateManyInput[]): void => {
    if (rows.length === 0) return;
    writeChain = writeChain.then(async () => {
      try {
        const written = await createManyChunked(prisma.crawlPage, rows, 250);
        state.persisted += written;
      } catch (err) {
        // Losing a page batch must not lose the crawl: record it and keep going, then report.
        state.failedWrites += rows.length;
        state.writeError = errorMessage(err);
        log.error('failed to persist crawl pages', { crawlId: crawl.id, error: state.writeError });
      }
    });
  };

  const pollCancellation = (): void => {
    if (abort.signal.aborted || state.cancelCheckInFlight) return;
    const now = Date.now();
    if (now - state.lastCancelCheckAt < CANCEL_POLL_MS) return;
    state.lastCancelCheckAt = now;
    state.cancelCheckInFlight = true;
    void (async () => {
      try {
        if (await ctx.isCancelled()) {
          abort.abort();
          return;
        }
        const row = await prisma.crawl.findUnique({
          where: { id: crawl.id },
          select: { status: true },
        });
        if (row?.status === CrawlStatus.CANCELLED) abort.abort();
      } catch (err) {
        log.warn('cancellation check failed', { crawlId: crawl.id, error: errorMessage(err) });
      } finally {
        state.cancelCheckInFlight = false;
      }
    })();
  };

  const maxPages = payload.maxPages ?? settings.crawlMaxPages;

  const onProgress = (progress: CrawlProgress): void => {
    pollCancellation();

    // 0-70% is the fetch phase; persistence and reconciliation own the rest.
    const share = progress.crawled / Math.max(1, maxPages);
    const percent = progress.phase === 'crawling' ? 5 + Math.min(share, 1) * 65 : 3;
    void ctx.updateProgress(percent, progress.message);

    const now = Date.now();
    if (now - state.lastCounterAt < COUNTER_INTERVAL_MS) return;
    state.lastCounterAt = now;
    void prisma.crawl
      .update({
        where: { id: crawl.id },
        data: {
          pagesDiscovered: progress.discovered,
          pagesCrawled: progress.crawled,
          pagesFailed: progress.failed,
          progressMessage: progress.message,
        },
      })
      .catch((err: unknown) => {
        log.warn('failed to update crawl counters', { crawlId: crawl.id, error: errorMessage(err) });
      });
  };

  const onPage = (page: PageAnalysis): void => {
    buffer.push(toCrawlPageRow(crawl.id, page));
    if (buffer.length >= PAGE_FLUSH_SIZE) {
      flush(buffer);
      buffer = [];
    }
  };

  let outcome: CrawlEngineOutcome;
  try {
    outcome = await crawlWebsite(
      {
        startUrl: start,
        domain: website.domain,
        maxPages,
        maxDepth: payload.maxDepth ?? settings.crawlMaxDepth,
        concurrency: settings.crawlConcurrency,
        delayMs: settings.crawlDelayMs,
        userAgent: settings.crawlUserAgent,
        respectRobots: settings.crawlRespectRobots,
        renderJs: payload.renderJs ?? settings.crawlRenderJs,
        includePatterns: settings.crawlIncludePatterns,
        excludePatterns: settings.crawlExcludePatterns,
        timeoutMs: settings.crawlTimeoutMs,
      },
      { signal: abort.signal, onProgress, onPage },
    );
  } catch (err) {
    flush(buffer);
    buffer = [];
    await writeChain;
    const message = errorMessage(err);
    await prisma.crawl.update({
      where: { id: crawl.id },
      data: {
        status: CrawlStatus.FAILED,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        error: truncate(message, 2_000),
        progressMessage: 'Failed',
      },
    });
    throw err;
  }

  flush(buffer);
  buffer = [];
  await writeChain;

  if (state.writeError) {
    warnings.push(
      `${state.failedWrites} crawled page(s) could not be stored (${state.writeError}). The audit will run on what was saved.`,
    );
  }
  warnings.push(...outcome.warnings);

  await ctx.updateProgress(72, 'Storing the link graph');
  const edgeResult = await persistLinkGraph(crawl.id, outcome);
  if (edgeResult.truncated) {
    warnings.push(
      `Only the first ${MAX_LINK_EDGES.toLocaleString()} internal links were stored; link analysis uses that sample.`,
    );
  }

  await ctx.updateProgress(80, 'Reconciling pages');
  const reconcile = await reconcilePages({
    websiteId: website.id,
    crawlId: crawl.id,
    crawlStartedAt: startedAt,
    deactivateMissing: !outcome.cancelled && !outcome.limitReached,
    onProgress: (done) => ctx.updateProgress(80 + Math.min(done / Math.max(1, outcome.stats.pagesCrawled), 1) * 12, `Reconciling pages (${done})`),
  });

  if (outcome.limitReached) {
    warnings.push(
      `The crawl stopped at the ${maxPages.toLocaleString()}-page limit, so pages beyond it were left untouched rather than marked missing.`,
    );
  }

  const cms = await persistCms(website.id, website.cmsType, outcome.cms?.cms ?? null, outcome.cms?.confidence ?? 0);

  const finishedAt = new Date();
  const wasCancelled = outcome.cancelled || abort.signal.aborted;

  await prisma.crawl.update({
    where: { id: crawl.id },
    data: {
      status: wasCancelled ? CrawlStatus.CANCELLED : CrawlStatus.COMPLETED,
      pagesDiscovered: outcome.stats.pagesDiscovered,
      pagesCrawled: outcome.stats.pagesCrawled,
      pagesFailed: outcome.stats.pagesFailed,
      robotsTxtFound: outcome.robots.found,
      robotsTxtBody: outcome.robots.body ? truncate(outcome.robots.body, MAX_ROBOTS_CHARS) : null,
      sitemapUrls: outcome.sitemap.sitemapUrls.slice(0, 100),
      sitemapUrlCount: outcome.sitemap.entries.length,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      progressMessage: wasCancelled ? 'Cancelled' : 'Completed',
    },
  });

  await prisma.website.update({ where: { id: website.id }, data: { lastCrawlAt: finishedAt } });

  if (wasCancelled) {
    await ctx.updateProgress(100, 'Cancelled');
    return cancelled('The crawl was cancelled; everything fetched before the stop was saved.', {
      pagesPersisted: state.persisted,
      pagesUpserted: reconcile.upserted,
    });
  }

  const enqueued = await enqueue(
    'analysis.technical-audit',
    { websiteId: website.id, crawlId: crawl.id },
    { trigger: 'chain', dedupeKey: `audit:${crawl.id}` },
  );

  await ctx.updateProgress(100, 'Crawl complete');

  const result: CrawlSiteResult = {
    status: 'completed',
    crawlId: crawl.id,
    pagesCrawled: outcome.stats.pagesCrawled,
    pagesFailed: outcome.stats.pagesFailed,
    pagesPersisted: state.persisted,
    linkEdges: edgeResult.written,
    pagesUpserted: reconcile.upserted,
    pagesDeactivated: reconcile.deactivated,
    snapshotsWritten: reconcile.snapshots,
    cms,
    limitReached: outcome.limitReached,
    warnings,
    auditEnqueued: enqueued.enqueued,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// crawl.cancel
// ─────────────────────────────────────────────────────────────

export interface CrawlCancelResult {
  status: 'completed';
  crawlId: string;
  crawlStatus: CrawlStatus;
  jobsCancelled: number;
}

/**
 * Sets the flag the running crawl polls, and cancels the job record driving it.
 *
 * Deliberately does not wait for the crawl to notice: the processor checks between pages, so
 * the stop lands within a few seconds, and this job must not hold a worker slot while it does.
 */
export const crawlCancel: JobHandler<'crawl.cancel'> = async ({ payload }) => {
  const crawl = await prisma.crawl.findFirst({
    where: { id: payload.crawlId, websiteId: payload.websiteId },
    select: { id: true, status: true },
  });
  if (!crawl) return skip(`Crawl ${payload.crawlId} does not exist for this website.`);

  if (crawl.status === CrawlStatus.COMPLETED || crawl.status === CrawlStatus.FAILED) {
    return skip(`Crawl ${crawl.id} already finished with status ${crawl.status}.`);
  }

  await prisma.crawl.update({
    where: { id: crawl.id },
    data: {
      status: CrawlStatus.CANCELLED,
      progressMessage: payload.reason ?? 'Cancelled by the operator',
      finishedAt: new Date(),
    },
  });

  // The processor also polls its own JobRecord, so mark that too: with Redis unavailable the
  // Crawl flag is the only signal, and with Redis available this takes the job off the queue.
  const jobs = await prisma.jobRecord.findMany({
    where: {
      websiteId: payload.websiteId,
      jobName: 'crawl.site',
      status: { in: ['QUEUED', 'RUNNING', 'DELAYED'] },
    },
    select: { id: true, payload: true },
  });

  let jobsCancelled = 0;
  for (const job of jobs) {
    const jobPayload = job.payload as { crawlId?: unknown } | null;
    if (jobPayload && typeof jobPayload === 'object' && jobPayload.crawlId !== crawl.id) continue;
    await cancelJob(job.id);
    jobsCancelled += 1;
  }

  const result: CrawlCancelResult = {
    status: 'completed',
    crawlId: crawl.id,
    crawlStatus: CrawlStatus.CANCELLED,
    jobsCancelled,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// Persistence helpers
// ─────────────────────────────────────────────────────────────

interface CrawlRowInput {
  websiteId: string;
  trigger: string;
  maxPages: number;
  maxDepth: number;
  renderJs: boolean;
  userAgent: string;
}

/** Reuses the row the API pre-created, or creates one so the UI has something to follow. */
async function ensureCrawlRow(crawlId: string | null, input: CrawlRowInput): Promise<{ id: string }> {
  if (crawlId) {
    const existing = await prisma.crawl.findUnique({ where: { id: crawlId }, select: { id: true } });
    if (existing) return existing;
    log.warn('crawl row referenced by the job is missing; creating a replacement', { crawlId });
  }
  return prisma.crawl.create({
    data: {
      websiteId: input.websiteId,
      status: CrawlStatus.QUEUED,
      trigger: input.trigger,
      maxPages: input.maxPages,
      maxDepth: input.maxDepth,
      renderJs: input.renderJs,
      userAgent: input.userAgent,
    },
    select: { id: true },
  });
}

function toCrawlPageRow(crawlId: string, page: PageAnalysis): Prisma.CrawlPageCreateManyInput {
  return {
    crawlId,
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    statusCode: page.statusCode,
    contentType: page.contentType,
    redirectTarget: page.redirectTarget,
    redirectChain: page.redirectChain,
    depth: page.depth,
    responseTimeMs: page.responseTimeMs,
    contentBytes: page.contentBytes,
    error: page.error ? truncate(page.error, 1_000) : null,
    title: page.title,
    titleLength: page.titleLength,
    metaDescription: page.metaDescription,
    metaDescriptionLength: page.metaDescriptionLength,
    canonicalUrl: page.canonicalUrl,
    robotsMeta: page.robotsMeta,
    xRobotsTag: page.xRobotsTag,
    metaViewport: page.metaViewport,
    lang: page.lang,
    h1: page.h1,
    headings: json(page.headings),
    wordCount: page.wordCount,
    textContent: page.textContent ? page.textContent.slice(0, MAX_TEXT_CHARS) : null,
    contentHash: page.contentHash,
    simhash: page.simhash,
    internalLinkCount: page.links.filter((link) => link.isInternal).length,
    externalLinkCount: page.links.filter((link) => !link.isInternal).length,
    imageCount: page.images.length,
    imagesMissingAlt: page.imagesMissingAlt,
    schemaTypes: page.schemaTypes,
    structuredData: json(page.structuredData),
    hreflang: json(page.hreflang),
    openGraph: json(page.openGraph),
    isIndexable: page.isIndexable,
    indexabilityReason: page.indexabilityReason,
    inSitemap: page.inSitemap,
  };
}

/**
 * Writes the crawl's link edges.
 *
 * Existing edges for the crawl are dropped first so a retried job replaces rather than doubles
 * them — `LinkEdge` has no natural unique key, so `skipDuplicates` cannot do that for us.
 */
async function persistLinkGraph(
  crawlId: string,
  outcome: CrawlEngineOutcome,
): Promise<{ written: number; truncated: boolean }> {
  await prisma.linkEdge.deleteMany({ where: { crawlId } });

  const idByUrl = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; normalizedUrl: string }> = await prisma.crawlPage.findMany({
      where: { crawlId, ...(cursor === null ? {} : { id: { gt: cursor } }) },
      select: { id: true, normalizedUrl: true },
      orderBy: { id: 'asc' },
      take: 1_000,
    });
    if (rows.length === 0) break;
    for (const row of rows) idByUrl.set(row.normalizedUrl, row.id);
    cursor = rows[rows.length - 1].id;
    if (rows.length < 1_000) break;
  }

  const total = Math.min(outcome.linkGraph.length, MAX_LINK_EDGES);
  let written = 0;
  let batch: Prisma.LinkEdgeCreateManyInput[] = [];

  for (let i = 0; i < total; i += 1) {
    const edge = outcome.linkGraph[i];
    const sourceId = idByUrl.get(edge.sourceNormalizedUrl);
    if (!sourceId) continue; // the source page failed to persist; its edges have no anchor row
    batch.push({
      crawlId,
      sourceCrawlPageId: sourceId,
      sourceUrl: edge.sourceUrl,
      targetUrl: edge.targetUrl,
      normalizedTarget: edge.normalizedTarget,
      anchorText: truncate(edge.anchorText, 300),
      rel: edge.rel,
      isInternal: edge.isInternal,
      isNofollow: edge.isNofollow,
      inNav: edge.inNav,
      inFooter: edge.inFooter,
      inMainContent: edge.inMainContent,
      position: edge.position,
    });

    if (batch.length >= 500) {
      written += await createManyChunked(prisma.linkEdge, batch, 500);
      batch = [];
    }
  }

  if (batch.length) written += await createManyChunked(prisma.linkEdge, batch, 500);

  return { written, truncated: outcome.linkGraph.length > MAX_LINK_EDGES };
}

interface ReconcileInput {
  websiteId: string;
  crawlId: string;
  crawlStartedAt: Date;
  deactivateMissing: boolean;
  onProgress: (done: number) => Promise<void>;
}

interface ReconcileResult {
  upserted: number;
  deactivated: number;
  snapshots: number;
}

/**
 * Folds this crawl's immutable `CrawlPage` rows into the durable `Page` table.
 *
 * Walks by keyset in batches so memory is a function of the batch size, not of the site. Each
 * batch does four bounded queries: read the crawl rows, read the matching pages, count inbound
 * internal links for exactly those URLs, then one transaction of upserts.
 */
async function reconcilePages(input: ReconcileInput): Promise<ReconcileResult> {
  const result: ReconcileResult = { upserted: 0, deactivated: 0, snapshots: 0 };
  let cursor: string | null = null;

  for (;;) {
    // The `where` is annotated so the query's result type cannot depend on `cursor`, which is
    // itself assigned from the result — TypeScript reports that loop as a circular inference.
    const where: Prisma.CrawlPageWhereInput = {
      crawlId: input.crawlId,
      ...(cursor === null ? {} : { id: { gt: cursor } }),
    };
    const crawlPages = await prisma.crawlPage.findMany({
      where,
      orderBy: { id: 'asc' },
      take: RECONCILE_BATCH,
      select: {
        id: true,
        url: true,
        normalizedUrl: true,
        statusCode: true,
        title: true,
        metaDescription: true,
        h1: true,
        canonicalUrl: true,
        lang: true,
        wordCount: true,
        depth: true,
        isIndexable: true,
        indexabilityReason: true,
        inSitemap: true,
        contentHash: true,
        schemaTypes: true,
        textContent: true,
        headings: true,
        internalLinkCount: true,
        externalLinkCount: true,
        crawledAt: true,
      },
    });
    if (crawlPages.length === 0) break;
    cursor = crawlPages[crawlPages.length - 1].id;

    const urls = crawlPages.map((page) => page.normalizedUrl);

    const [existingPages, inbound] = await Promise.all([
      prisma.page.findMany({
        where: { websiteId: input.websiteId, normalizedUrl: { in: urls } },
        select: {
          id: true,
          normalizedUrl: true,
          contentHash: true,
          pageType: true,
          seoScore: true,
          geoScore: true,
          clicks28d: true,
          impressions28d: true,
          position28d: true,
        },
      }),
      prisma.linkEdge.groupBy({
        by: ['normalizedTarget'],
        where: { crawlId: input.crawlId, isInternal: true, normalizedTarget: { in: urls } },
        _count: { _all: true },
      }),
    ]);

    const existingByUrl = new Map(existingPages.map((page) => [page.normalizedUrl, page]));
    const inboundByUrl = new Map(inbound.map((row) => [row.normalizedTarget, row._count._all]));

    const upserts: Prisma.PrismaPromise<{ id: string }>[] = [];
    for (const page of crawlPages) {
      const existing = existingByUrl.get(page.normalizedUrl);
      const inboundLinks = inboundByUrl.get(page.normalizedUrl) ?? 0;
      const data = {
        url: page.url,
        path: getPath(page.url),
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
        internalLinksIn: inboundLinks,
        internalLinksOut: page.internalLinkCount,
        externalLinksOut: page.externalLinkCount,
        isOrphan: inboundLinks === 0 && page.depth > 0,
        pageType: existing?.pageType ?? inferPageType(page.url, page.title),
        lastCrawledAt: page.crawledAt,
        isActive: true,
      };

      upserts.push(
        prisma.page.upsert({
          where: {
            websiteId_normalizedUrl: {
              websiteId: input.websiteId,
              normalizedUrl: page.normalizedUrl,
            },
          },
          create: { websiteId: input.websiteId, normalizedUrl: page.normalizedUrl, ...data },
          update: data,
          select: { id: true },
        }),
      );
    }

    const upsertedRows = await prisma.$transaction(upserts);
    result.upserted += upsertedRows.length;

    const linkOps: Prisma.PrismaPromise<unknown>[] = [];
    const snapshots: Prisma.PageSnapshotCreateManyInput[] = [];

    for (let i = 0; i < crawlPages.length; i += 1) {
      const page = crawlPages[i];
      const pageId = upsertedRows[i]?.id;
      if (!pageId) continue;

      linkOps.push(prisma.crawlPage.update({ where: { id: page.id }, data: { pageId } }));

      const existing = existingByUrl.get(page.normalizedUrl);
      const changed = Boolean(page.contentHash) && existing?.contentHash !== page.contentHash;
      if (!changed) continue;

      // The snapshot captures the *new* content: it is the only version we hold the text for,
      // and it is what a future diff (or an experiment's "before") reads back.
      snapshots.push({
        pageId,
        title: page.title,
        metaDescription: page.metaDescription,
        h1: page.h1[0] ?? null,
        wordCount: page.wordCount,
        contentHash: page.contentHash,
        textContent: page.textContent,
        headings: json(page.headings),
        statusCode: page.statusCode,
        seoScore: existing?.seoScore ?? null,
        geoScore: existing?.geoScore ?? null,
        clicks28d: existing?.clicks28d ?? null,
        impressions28d: existing?.impressions28d ?? null,
        position28d: existing?.position28d ?? null,
        reason: existing ? 'crawl' : 'first-crawl',
      });
    }

    await runChunked(linkOps, RECONCILE_BATCH);
    if (snapshots.length) {
      result.snapshots += await createManyChunked(prisma.pageSnapshot, snapshots, 200);
    }

    await input.onProgress(result.upserted);
    if (crawlPages.length < RECONCILE_BATCH) break;
  }

  if (input.deactivateMissing) {
    const deactivated = await prisma.page.updateMany({
      where: {
        websiteId: input.websiteId,
        isActive: true,
        lastCrawledAt: { lt: input.crawlStartedAt },
      },
      data: { isActive: false },
    });
    result.deactivated = deactivated.count;
  }

  return result;
}

/** Mirrors the crawler's `DetectedCms` union onto the Prisma enum; `GIT` is never detected. */
const CMS_BY_DETECTION: Record<DetectedCms, CmsType> = {
  UNKNOWN: CmsType.UNKNOWN,
  WORDPRESS: CmsType.WORDPRESS,
  SHOPIFY: CmsType.SHOPIFY,
  WEBFLOW: CmsType.WEBFLOW,
  NEXTJS: CmsType.NEXTJS,
  ASTRO: CmsType.ASTRO,
  HUGO: CmsType.HUGO,
  GHOST: CmsType.GHOST,
  SQUARESPACE: CmsType.SQUARESPACE,
  WIX: CmsType.WIX,
  CUSTOM: CmsType.CUSTOM,
};

/**
 * Stores the detected CMS. A low-confidence guess never overwrites a value the operator (or a
 * previous, confident crawl) already set — the field drives which publish adapter is offered.
 */
async function persistCms(
  websiteId: string,
  current: CmsType,
  detected: DetectedCms | null,
  confidence: number,
): Promise<string | null> {
  if (!detected || detected === 'UNKNOWN') return current === CmsType.UNKNOWN ? null : current;
  const mapped = CMS_BY_DETECTION[detected];
  if (mapped === current) return current;
  if (current !== CmsType.UNKNOWN && confidence < 0.6) return current;

  await prisma.website.update({ where: { id: websiteId }, data: { cmsType: mapped } });
  log.info('cms detected', { websiteId, cms: mapped, confidence: round(confidence, 2) });
  return mapped;
}

