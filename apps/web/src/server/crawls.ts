import 'server-only';
import { type Crawl, prisma } from '@seo/db';
import { ConflictError, NotFoundError, createLogger, env } from '@seo/shared';
import { type EnqueueResult, type JobTrigger, cancelJob, enqueue } from '@seo/queue';

const log = createLogger('web:crawls');

/**
 * Crawl lifecycle control shared by `POST /api/websites/[id]/crawl` and site creation.
 *
 * The `Crawl` row is created here rather than left to the worker so the UI has something to
 * show the instant the button is pressed — including when Redis is unavailable, where the row
 * plus its durable `JobRecord` are the only evidence the run was ever requested.
 */

/** Statuses that mean a crawl is still live and must not be started twice. */
const ACTIVE_CRAWL_STATUSES = ['QUEUED', 'RUNNING'] as const;

/** Strict total order over crawl rows, so a race has exactly one loser. */
function isOlder(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): boolean {
  const delta = a.createdAt.getTime() - b.createdAt.getTime();
  return delta !== 0 ? delta < 0 : a.id < b.id;
}

export interface StartCrawlOverrides {
  maxPages?: number;
  maxDepth?: number;
  renderJs?: boolean;
}

export interface StartCrawlResult {
  crawl: Crawl;
  enqueue: EnqueueResult;
  /** False when the broker is unreachable: the row exists but nothing will pick it up yet. */
  queued: boolean;
  message: string;
}

/**
 * Queues a crawl for a website.
 *
 * Overrides apply to this run only; anything omitted falls back to `WebsiteSettings`, which is
 * why nothing here invents a default. JS rendering additionally requires the process-level
 * `ENABLE_JS_RENDERING` flag — a renderer that is not installed cannot be switched on per-run.
 */
export async function startCrawl(
  websiteId: string,
  overrides: StartCrawlOverrides = {},
  trigger: JobTrigger = 'manual',
): Promise<StartCrawlResult> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    include: { settings: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.status === 'ARCHIVED') {
    throw new ConflictError('This website is archived. Reactivate it before crawling.');
  }

  const active = await prisma.crawl.findFirst({
    where: { websiteId, status: { in: [...ACTIVE_CRAWL_STATUSES] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (active) {
    throw new ConflictError(
      `A crawl is already ${active.status.toLowerCase()} for this site. Cancel it before starting another.`,
      { crawlId: active.id, status: active.status },
    );
  }

  const settings = website.settings;
  const maxPages = overrides.maxPages ?? settings?.crawlMaxPages ?? 1000;
  const maxDepth = overrides.maxDepth ?? settings?.crawlMaxDepth ?? 10;
  const renderJs = (overrides.renderJs ?? settings?.crawlRenderJs ?? false) && env.enableJsRendering;

  const crawl = await prisma.crawl.create({
    data: {
      websiteId,
      status: 'QUEUED',
      trigger,
      maxPages,
      maxDepth,
      renderJs,
      userAgent: settings?.crawlUserAgent ?? env.crawlerUserAgent,
      progressMessage: 'Waiting for a worker to pick this up',
    },
  });

  // The check above is not atomic: two requests a few milliseconds apart both see no active
  // crawl and both insert one, and the site then gets crawled twice over — double the traffic
  // to somebody's server and two sets of CrawlPage rows. There is no unique constraint to lean
  // on (a site legitimately has many crawls over time), so the tie is broken after the fact on
  // (createdAt, id) — a strict total order, so racers that can see each other's rows agree on
  // a single winner and every other one withdraws. The losing row is deleted rather than
  // cancelled: nothing references it yet, and a CANCELLED crawl in the history would imply an
  // operator decision that never happened.
  const rival = await prisma.crawl.findFirst({
    where: { websiteId, status: { in: [...ACTIVE_CRAWL_STATUSES] }, id: { not: crawl.id } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, status: true, createdAt: true },
  });
  if (rival && isOlder(rival, crawl)) {
    await prisma.crawl.delete({ where: { id: crawl.id } }).catch(() => undefined);
    throw new ConflictError(
      `A crawl is already ${rival.status.toLowerCase()} for this site. Cancel it before starting another.`,
      { crawlId: rival.id, status: rival.status },
    );
  }

  const result = await enqueue(
    'crawl.site',
    { websiteId, crawlId: crawl.id, trigger, maxPages, maxDepth, renderJs },
    // Keyed on the crawl row: a double-click cannot produce two runs of the same crawl.
    { dedupeKey: crawl.id, trigger },
  );

  if (!result.enqueued) {
    await prisma.crawl.update({
      where: { id: crawl.id },
      data: {
        progressMessage:
          result.reason === 'redis-unavailable'
            ? 'Queued in the database. It will start when a worker and Redis are available.'
            : `Not queued: ${result.reason}`,
      },
    });
  }

  log.info('crawl requested', { websiteId, crawlId: crawl.id, queued: result.enqueued });

  return {
    crawl,
    enqueue: result,
    queued: result.enqueued,
    message: result.enqueued
      ? 'Crawl queued.'
      : result.reason === 'redis-unavailable'
        ? 'Crawl recorded, but no queue broker is reachable. Start Redis and the worker to run it.'
        : `Crawl not queued: ${result.reason}.`,
  };
}

export interface CancelCrawlResult {
  crawlId: string;
  cancelled: boolean;
  status: string;
  message: string;
}

/**
 * Cancels a crawl.
 *
 * The database flag is written first, then the broker is touched — the same ordering
 * `cancelJob()` uses, and for the same reason: the row is what a running processor polls, so
 * writing it first closes the window where a queued job could still be picked up.
 */
export async function cancelCrawl(
  websiteId: string,
  crawlId: string,
  reason?: string,
): Promise<CancelCrawlResult> {
  const crawl = await prisma.crawl.findFirst({ where: { id: crawlId, websiteId } });
  if (!crawl) throw new NotFoundError('Crawl');

  if (!ACTIVE_CRAWL_STATUSES.includes(crawl.status as (typeof ACTIVE_CRAWL_STATUSES)[number])) {
    return {
      crawlId,
      cancelled: false,
      status: crawl.status,
      message: `This crawl already finished with status ${crawl.status}.`,
    };
  }

  const wasRunning = crawl.status === 'RUNNING';
  const finishedAt = new Date();

  await prisma.crawl.update({
    where: { id: crawlId },
    data: {
      status: 'CANCELLED',
      finishedAt,
      durationMs: crawl.startedAt ? finishedAt.getTime() - crawl.startedAt.getTime() : null,
      progressMessage: reason ?? 'Cancelled by the operator',
    },
  });

  // The crawl's own JobRecord, matched through the payload it was enqueued with.
  const jobRecord = await prisma.jobRecord.findFirst({
    where: {
      websiteId,
      jobName: 'crawl.site',
      status: { in: ['QUEUED', 'RUNNING', 'DELAYED'] },
      payload: { path: ['crawlId'], equals: crawlId },
    },
    select: { id: true },
  });
  if (jobRecord) await cancelJob(jobRecord.id);

  // A run already in flight needs the explicit stop signal; a merely queued one is dead the
  // moment its job record is cancelled, so enqueueing there would only create noise.
  if (wasRunning) {
    await enqueue(
      'crawl.cancel',
      { websiteId, crawlId, ...(reason ? { reason } : {}) },
      { dedupeKey: `cancel:${crawlId}`, trigger: 'manual' },
    );
  }

  log.info('crawl cancelled', { websiteId, crawlId, wasRunning });

  return {
    crawlId,
    cancelled: true,
    status: 'CANCELLED',
    message: wasRunning
      ? 'Cancelling. The running crawl stops at its next checkpoint.'
      : 'Crawl cancelled before it started.',
  };
}
