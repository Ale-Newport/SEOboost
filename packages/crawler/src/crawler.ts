/**
 * The crawl engine.
 *
 * Deliberately database-free: it takes a config and returns a `CrawlOutcome`. Persistence,
 * job bookkeeping and retries belong to the worker, which means a crawl can be replayed
 * against a fixture, unit-tested without Postgres, and cancelled without leaving half-written
 * rows behind.
 *
 * Two invariants hold everywhere below:
 *  - nothing is dropped silently — a URL either becomes a `PageAnalysis` or a `SkippedUrl`
 *    with a reason;
 *  - one bad page never ends the crawl — every per-URL operation is wrapped.
 */

import {
  clamp,
  cleanDomain,
  createLimiter,
  createLogger,
  env,
  errorMessage,
  hasNonHtmlExtension,
  isSameSite,
  looksLikeCrawlTrap,
  mapWithConcurrency,
  matchesPattern,
  normalizeUrl,
  round,
  ValidationError,
} from '@seo/shared';
import { detectCms } from './cms-detect';
import { createFetcher, isHtmlContentType, type Fetcher } from './fetcher';
import { analyzeHtml, emptyPageAnalysis } from './html-parser';
import { createRenderer, isRenderingAvailable, type Renderer } from './renderer';
import { loadRobots } from './robots';
import { discoverSitemaps } from './sitemap';
import type {
  CmsDetection,
  CrawlConfig,
  CrawlLinkEdge,
  CrawlOutcome,
  CrawlPhase,
  CrawlProgress,
  CrawlStats,
  FetchResult,
  PageAnalysis,
  RobotsInfo,
  SitemapResult,
  SkipReason,
  SkippedUrl,
} from './types';

const log = createLogger('crawler');

/** At most two progress callbacks per second; phase changes and the final tick always fire. */
const PROGRESS_INTERVAL_MS = 500;

/**
 * Upper bound on an honoured `Crawl-delay`. Sites occasionally publish delays of minutes,
 * which would turn a 500-page audit into a multi-day job; we stay polite up to this point and
 * warn when we clamp.
 */
const MAX_CRAWL_DELAY_MS = 10_000;

/** Hard cap on external HEAD probes, whatever the config asks for. */
export const DEFAULT_MAX_EXTERNAL_CHECKS = 200;

/** Hard cap on internal asset (image/PDF) HEAD probes. */
export const DEFAULT_MAX_ASSET_CHECKS = 200;

/** Sources retained per external target — enough to fix the links, bounded for memory. */
const MAX_EXTERNAL_SOURCES = 20;

/** Skip *records* kept; `stats.pagesSkipped` still counts every skip beyond this. */
const MAX_SKIPPED_RECORDS = 5_000;

/**
 * Link edges retained. `maxPages` bounds the pages but not their links: a 10k-page crawl of a
 * template-heavy site can produce millions of edges, which is a memory profile no caller asked
 * for. Past this the graph is truncated and a warning says so.
 */
const MAX_LINK_EDGES = 250_000;

/**
 * Sitemap URLs seeded into the frontier, as a multiple of `maxPages`. A 50k-URL sitemap on a
 * 200-page crawl would otherwise buy 49.8k queue entries that can never be reached.
 */
const SITEMAP_SEED_MULTIPLE = 4;

/** HTML pages examined for a CMS fingerprint before we accept the answer we have. */
const MAX_CMS_PROBES = 5;

/**
 * Engine-level config. Extends the transportable `CrawlConfig` with switches that only the
 * engine understands, so the JSON job payload shape in `types.ts` stays untouched.
 */
export interface CrawlEngineConfig extends CrawlConfig {
  /**
   * HEAD-check each unique external link once so the broken-external-link rule has real
   * status codes instead of guesses. Off by default: it is traffic to third parties.
   */
  checkExternalLinks?: boolean;
  maxExternalChecks?: number;
  maxAssetChecks?: number;
}

/** Result of a single HEAD probe against an off-site link. */
export interface ExternalLinkCheck {
  url: string;
  normalizedUrl: string;
  statusCode: number | null;
  ok: boolean;
  contentType: string | null;
  redirectTarget: string | null;
  responseTimeMs: number | null;
  error: string | null;
  /** On-site pages linking to it (capped), so a fix can be routed to the right page. */
  foundOn: string[];
}

/**
 * `CrawlOutcome` plus the external-link probe results. External URLs are not pages of the
 * site being audited, so they never enter `pages`.
 */
export interface CrawlEngineOutcome extends CrawlOutcome {
  externalLinks: ExternalLinkCheck[];
}

export interface CrawlHooks {
  /** Cancels the crawl; the outcome comes back partial with `cancelled: true`. */
  signal?: AbortSignal;
  onProgress?: (progress: CrawlProgress) => void;
  /** Fired as each row is finished, so a worker can stream writes instead of buffering. */
  onPage?: (page: PageAnalysis) => void;
}

interface FrontierItem {
  url: string;
  normalizedUrl: string;
  depth: number;
  inSitemap: boolean;
  foundOn: string | null;
}

/**
 * Breadth-first frontier keyed by depth.
 *
 * A plain FIFO would also be breadth-first *if* every push came from the current depth, but
 * sitemap seeds and redirect follow-ups arrive out of band. Bucketing by depth makes the
 * ordering a property of the structure rather than of the call sites.
 */
class DepthFrontier {
  private readonly buckets = new Map<number, FrontierItem[]>();
  private count = 0;

  push(item: FrontierItem): void {
    const bucket = this.buckets.get(item.depth);
    if (bucket) bucket.push(item);
    else this.buckets.set(item.depth, [item]);
    this.count += 1;
  }

  shift(): FrontierItem | undefined {
    if (this.count === 0) return undefined;
    let lowest: number | null = null;
    for (const [depth, bucket] of this.buckets) {
      if (bucket.length === 0) continue;
      if (lowest === null || depth < lowest) lowest = depth;
    }
    if (lowest === null) return undefined;
    const bucket = this.buckets.get(lowest);
    const item = bucket?.shift();
    if (bucket && bucket.length === 0) this.buckets.delete(lowest);
    if (item) this.count -= 1;
    return item;
  }

  get size(): number {
    return this.count;
  }

  /** Everything still queued, shallowest first. Used when a cap or cancellation ends the run. */
  drain(): FrontierItem[] {
    const depths = [...this.buckets.keys()].sort((a, b) => a - b);
    const out: FrontierItem[] = [];
    for (const depth of depths) out.push(...(this.buckets.get(depth) ?? []));
    this.buckets.clear();
    this.count = 0;
    return out;
  }
}

type Verdict =
  | { ok: true; normalizedUrl: string }
  | { ok: false; normalizedUrl: string | null; reason: SkipReason; detail: string };

/** Shared plumbing for the one-URL fetch/analyse step, used by the crawl and by re-checks. */
interface PageContext {
  fetcher: Fetcher;
  renderer: Renderer | null;
  siteDomain: string;
  robots: RobotsInfo;
  signal?: AbortSignal;
  onRenderFailure: (url: string, error: string) => void;
}

type FetchOutcome =
  | { kind: 'cancelled' }
  | {
      kind: 'page';
      page: PageAnalysis;
      /** HTML actually analysed (rendered when rendering was used), for CMS fingerprinting. */
      html: string | null;
      headers: Record<string, string>;
      finalUrl: string;
      /** On-site redirect destination that still needs its own row. */
      followUp: string | null;
    };

/** `content-length` beats a HEAD's zero-byte body when reporting asset weight. */
function declaredBytes(result: FetchResult): number | null {
  const header = result.headers['content-length'];
  const declared = header === undefined ? Number.NaN : Number(header);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return result.contentBytes > 0 ? result.contentBytes : null;
}

/**
 * Fetch one URL and turn it into a row.
 *
 * `mode` decides what happens on a cross-URL redirect: a crawl records the requested URL as a
 * redirect row and hands the destination back for enqueueing (so every row means exactly what
 * it says), while a single-page re-check analyses the destination in place — the caller asked
 * about that URL and wants its content, not a pointer.
 */
async function fetchAndAnalyze(
  ctx: PageContext,
  target: FrontierItem,
  mode: 'crawl' | 'single',
): Promise<FetchOutcome> {
  const result = await ctx.fetcher.fetchPage(target.url, { signal: ctx.signal });
  if (result.aborted) return { kind: 'cancelled' };

  const base = {
    url: target.url,
    normalizedUrl: target.normalizedUrl,
    depth: target.depth,
    statusCode: result.statusCode,
    contentType: result.contentType,
    responseTimeMs: result.responseTimeMs,
    contentBytes: declaredBytes(result),
    redirectChain: result.redirectChain,
    redirectTarget: result.redirectTarget,
    inSitemap: target.inSitemap,
  };

  // Transport failure: no usable response, so the row carries the error and a null status.
  if (result.error !== null || result.statusCode === null) {
    return {
      kind: 'page',
      page: emptyPageAnalysis({ ...base, error: result.error ?? 'No response' }),
      html: null,
      headers: result.headers,
      finalUrl: result.finalUrl,
      followUp: null,
    };
  }

  const finalNormalized = normalizeUrl(result.finalUrl);
  const movedElsewhere =
    result.redirectTarget !== null && finalNormalized !== null && finalNormalized !== target.normalizedUrl;

  if (mode === 'crawl' && movedElsewhere) {
    return {
      kind: 'page',
      page: emptyPageAnalysis({
        ...base,
        // The row is about the requested URL, so it carries the 3xx it answered with — not the
        // 200 the destination served, which belongs to the destination's own row.
        statusCode: result.redirectStatus ?? result.statusCode,
        redirectTarget: result.finalUrl,
        indexabilityReason: `Redirects to ${result.finalUrl}`,
      }),
      html: null,
      headers: result.headers,
      finalUrl: result.finalUrl,
      followUp: isSameSite(result.finalUrl, ctx.siteDomain) ? result.finalUrl : null,
    };
  }

  if (!isHtmlContentType(result.contentType) || result.body === null) {
    return {
      kind: 'page',
      page: emptyPageAnalysis(base),
      html: null,
      headers: result.headers,
      finalUrl: result.finalUrl,
      followUp: null,
    };
  }

  let html = result.body;
  let rendered = false;
  if (ctx.renderer) {
    const render = await ctx.renderer.render(result.finalUrl, { signal: ctx.signal });
    if (render.ok && render.html !== null && render.html.trim().length > 0) {
      html = render.html;
      rendered = true;
    } else {
      // Static HTML is a valid (if poorer) analysis, so a render failure degrades rather than fails.
      ctx.onRenderFailure(target.url, render.error ?? 'Renderer returned no HTML');
    }
  }

  const page = analyzeHtml({
    // The final URL is the document's real base and the URL a canonical must agree with;
    // the row itself is still filed under what we asked for.
    url: result.finalUrl,
    requestedUrl: target.url,
    html,
    siteDomain: ctx.siteDomain,
    depth: target.depth,
    statusCode: result.statusCode,
    contentType: result.contentType,
    headers: result.headers,
    responseTimeMs: result.responseTimeMs,
    contentBytes: declaredBytes(result),
    redirectChain: result.redirectChain,
    redirectTarget: result.redirectTarget,
    robotsAllowed: ctx.robots.isAllowed(target.url),
    rendered,
    inSitemap: target.inSitemap,
  });

  return { kind: 'page', page, html, headers: result.headers, finalUrl: result.finalUrl, followUp: null };
}

/**
 * A HEAD probe that cannot throw. `FetchResult` already carries an `error` field, so the
 * thrown-vs-returned distinction needs its own discriminant rather than an `in` check.
 */
type ProbeOutcome = { kind: 'result'; result: FetchResult } | { kind: 'error'; message: string };

async function probe(fetcher: Fetcher, url: string, signal?: AbortSignal): Promise<ProbeOutcome> {
  try {
    return { kind: 'result', result: await fetcher.fetchAsset(url, { signal }) };
  } catch (err) {
    return { kind: 'error', message: errorMessage(err) };
  }
}

/** A permissive `RobotsInfo` for runs that opt out of robots.txt entirely. */
function allowAllRobots(origin: string): RobotsInfo {
  return {
    origin,
    url: `${origin}/robots.txt`,
    found: false,
    statusCode: null,
    body: null,
    crawlDelay: null,
    sitemaps: [],
    error: null,
    isAllowed: () => true,
  };
}

/**
 * Origin of the host we will actually talk to.
 *
 * Deliberately *not* derived from `normalizeUrl`, which strips `www.`: plenty of sites resolve
 * `www.example.com` while the apex has no A record at all, and asking the apex for robots.txt
 * and /sitemap.xml would then lose both for no reason.
 */
function originOf(url: string): string {
  const keepHost = normalizeUrl(url, { stripWww: false });
  return new URL(keepHost ?? url).origin;
}

function toEdge(page: PageAnalysis, link: PageAnalysis['links'][number]): CrawlLinkEdge {
  return {
    sourceUrl: page.url,
    sourceNormalizedUrl: page.normalizedUrl,
    targetUrl: link.href,
    normalizedTarget: link.normalized,
    anchorText: link.anchorText,
    rel: link.rel,
    isInternal: link.isInternal,
    isNofollow: link.isNofollow,
    inNav: link.inNav,
    inFooter: link.inFooter,
    inMainContent: link.inMainContent,
    position: link.position,
  };
}

/**
 * Crawl a site breadth-first and return everything an analysis needs.
 *
 * Never throws for network reasons — unreachable pages become rows with `error` set. The only
 * thrown error is a `ValidationError` for a start URL that is not a URL at all, which is a
 * caller bug rather than a site problem.
 */
export async function crawlWebsite(
  config: CrawlEngineConfig,
  hooks: CrawlHooks = {},
): Promise<CrawlEngineOutcome> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const startUrl = config.startUrl.trim();
  const startNormalized = normalizeUrl(startUrl);
  if (!startNormalized) throw new ValidationError(`Invalid start URL: ${config.startUrl}`);

  const domain = cleanDomain(config.domain ?? startNormalized);
  const origin = originOf(startUrl);

  const userAgent = config.userAgent ?? env.crawlerUserAgent;
  const respectRobots = config.respectRobots ?? true;
  const concurrency = clamp(Math.floor(config.concurrency ?? env.crawlerMaxConcurrency), 1, 32);
  const maxPages = Math.max(1, Math.floor(config.maxPages));
  const maxDepth = Math.max(0, Math.floor(config.maxDepth));
  const includePatterns = config.includePatterns ?? [];
  const excludePatterns = config.excludePatterns ?? [];
  const useSitemap = config.useSitemap ?? true;
  const checkAssets = config.checkAssets ?? false;
  const checkExternalLinks = config.checkExternalLinks ?? false;
  const maxExternalChecks = clamp(
    Math.floor(config.maxExternalChecks ?? DEFAULT_MAX_EXTERNAL_CHECKS),
    0,
    DEFAULT_MAX_EXTERNAL_CHECKS,
  );
  const maxAssetChecks = clamp(
    Math.floor(config.maxAssetChecks ?? DEFAULT_MAX_ASSET_CHECKS),
    0,
    DEFAULT_MAX_ASSET_CHECKS,
  );

  const signal = hooks.signal;
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  const pages: PageAnalysis[] = [];
  const linkGraph: CrawlLinkEdge[] = [];
  /** Kept by normalised URL rather than in a list so a later acceptance can retract a skip. */
  const skipRecords = new Map<string, SkippedUrl>();
  const seen = new Set<string>();
  const skipKeys = new Set<string>();
  const frontier = new DepthFrontier();

  let skippedCount = 0;
  let failedCount = 0;
  let crawledCount = 0;
  let maxDepthReached = 0;
  let totalBytes = 0;
  let responseTimeTotal = 0;
  let responseTimeSamples = 0;
  let renderFailures = 0;
  let cms: CmsDetection | null = null;
  let cmsProbes = 0;
  let cancelled = false;
  let limitReached = false;
  let currentUrl: string | null = null;

  const fetcher = createFetcher({
    userAgent,
    timeoutMs: config.timeoutMs,
    maxRedirects: config.maxRedirects,
    maxBodyBytes: config.maxBodyBytes,
    minHostIntervalMs: config.delayMs,
    retries: config.retries,
  });

  // ── progress ──────────────────────────────────────────────────────────────
  let lastEmit = 0;
  let lastPhase: CrawlPhase | null = null;
  const emit = (phase: CrawlPhase, message: string, force = false): void => {
    const now = Date.now();
    if (!force && phase === lastPhase && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    lastPhase = phase;
    const progress: CrawlProgress = {
      phase,
      discovered: seen.size,
      crawled: crawledCount,
      failed: failedCount,
      skipped: skippedCount,
      queued: frontier.size,
      depth: maxDepthReached,
      currentUrl,
      elapsedMs: now - startedAtMs,
      message,
    };
    try {
      hooks.onProgress?.(progress);
    } catch (err) {
      // A broken consumer must not take the crawl with it.
      log.warn('onProgress hook threw', { error: errorMessage(err) });
    }
  };

  const recordSkip = (
    url: string,
    normalizedUrl: string | null,
    reason: SkipReason,
    detail: string,
    depth: number,
    foundOn: string | null,
  ): void => {
    const key = normalizedUrl ?? url;
    if (skipKeys.has(key)) return;
    skipKeys.add(key);
    skippedCount += 1;
    if (skipRecords.size < MAX_SKIPPED_RECORDS) {
      skipRecords.set(key, { url, normalizedUrl, reason, detail, depth, foundOn });
    } else {
      warn(`More than ${MAX_SKIPPED_RECORDS} URLs were skipped; the list is truncated.`);
    }
  };

  /**
   * Retract a skip once the same URL is accepted from a shallower path — a redirect can hand
   * back a URL that was already refused for depth. Leaving the record would make the outcome
   * contradict itself: one URL both crawled and reported as skipped.
   */
  const retractSkip = (key: string): void => {
    if (!skipKeys.delete(key)) return;
    if (skipRecords.delete(key)) skippedCount -= 1;
  };

  // ── robots.txt ────────────────────────────────────────────────────────────
  emit('robots', 'Reading robots.txt', true);
  // Always read robots.txt, even when we are not going to obey it: it is the cheapest source
  // of sitemap locations, and `isAllowed` still tells us whether a page is indexable.
  const robots = await loadRobots(origin, userAgent, { fetcher, signal });
  if (robots.error !== null) {
    warn(`robots.txt could not be read (${robots.error}); crawling everything.`);
  }
  if (respectRobots && robots.crawlDelay !== null && robots.crawlDelay > 0) {
    const requestedMs = robots.crawlDelay * 1000;
    const appliedMs = Math.min(requestedMs, MAX_CRAWL_DELAY_MS);
    if (appliedMs > (config.delayMs ?? 0)) fetcher.setHostInterval(origin, appliedMs);
    if (appliedMs < requestedMs) {
      warn(
        `robots.txt asks for a ${robots.crawlDelay}s crawl-delay; capped at ${MAX_CRAWL_DELAY_MS / 1000}s.`,
      );
    }
  }

  // ── sitemaps ──────────────────────────────────────────────────────────────
  let sitemap: SitemapResult = { sitemapUrls: [], entries: [], errors: [], truncated: false };
  if (useSitemap && !signal?.aborted) {
    emit('sitemap', 'Discovering sitemaps', true);
    sitemap = await discoverSitemaps(origin, {
      fetcher,
      signal,
      userAgent,
      robotsSitemaps: robots.sitemaps,
      maxUrls: config.maxSitemapUrls,
    });
    if (sitemap.errors.length > 0) {
      warn(`${sitemap.errors.length} sitemap document(s) could not be read.`);
    }
  }
  const sitemapKeys = new Set(sitemap.entries.map((entry) => entry.normalizedLoc));

  // ── frontier admission ────────────────────────────────────────────────────
  const externalTargets = new Map<string, { url: string; sources: string[] }>();
  const assetTargets = new Map<string, { url: string; depth: number }>();

  const trackAsset = (url: string, depth: number): void => {
    if (!checkAssets || assetTargets.size >= maxAssetChecks) return;
    const key = normalizeUrl(url) ?? url;
    if (assetTargets.has(key) || seen.has(key)) return;
    assetTargets.set(key, { url, depth });
  };

  const trackExternal = (url: string, normalized: string, source: string): void => {
    if (!checkExternalLinks) return;
    let entry = externalTargets.get(normalized);
    if (!entry) {
      if (externalTargets.size >= maxExternalChecks) return;
      entry = { url, sources: [] };
      externalTargets.set(normalized, entry);
    }
    if (entry.sources.length < MAX_EXTERNAL_SOURCES && !entry.sources.includes(source)) {
      entry.sources.push(source);
    }
  };

  /**
   * `isSeed` exempts the start URL from `includePatterns` only. A crawl restricted to a
   * blog subtree still has to start at the homepage to find it, and refusing its own start
   * URL would return an empty audit with no obvious cause.
   */
  const evaluate = (url: string, depth: number, isSeed: boolean): Verdict => {
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return { ok: false, normalizedUrl: null, reason: 'invalid-url', detail: 'Not a crawlable http(s) URL' };
    }
    if (!isSameSite(url, domain)) {
      return { ok: false, normalizedUrl, reason: 'off-site', detail: `Outside ${domain}` };
    }
    if (hasNonHtmlExtension(url)) {
      return { ok: false, normalizedUrl, reason: 'non-html-extension', detail: 'Asset URL, not a page' };
    }
    if (excludePatterns.length > 0 && matchesPattern(url, excludePatterns)) {
      return { ok: false, normalizedUrl, reason: 'exclude-pattern', detail: 'Matched an exclude pattern' };
    }
    if (!isSeed && includePatterns.length > 0 && !matchesPattern(url, includePatterns)) {
      return { ok: false, normalizedUrl, reason: 'include-pattern', detail: 'Matched no include pattern' };
    }
    const trap = looksLikeCrawlTrap(url);
    if (trap.trap) {
      return { ok: false, normalizedUrl, reason: 'crawl-trap', detail: trap.reason ?? 'Looks like a crawl trap' };
    }
    if (depth > maxDepth) {
      return { ok: false, normalizedUrl, reason: 'max-depth', detail: `Deeper than maxDepth ${maxDepth}` };
    }
    if (respectRobots && !robots.isAllowed(url)) {
      return { ok: false, normalizedUrl, reason: 'robots-disallow', detail: 'Disallowed by robots.txt' };
    }
    return { ok: true, normalizedUrl };
  };

  const enqueue = (url: string, depth: number, foundOn: string | null, isSeed = false): boolean => {
    const verdict = evaluate(url, depth, isSeed);
    // A URL already accepted from a shallower path is neither a new page nor a new skip. This
    // check has to precede the verdict: the same URL reached again from deeper down fails the
    // depth test, and filing it as `max-depth` would contradict the row we are producing for it.
    if (verdict.normalizedUrl !== null && seen.has(verdict.normalizedUrl)) return false;
    if (!verdict.ok) {
      // A non-HTML *internal* link is still worth a status check when asset probing is on.
      if (verdict.reason === 'non-html-extension') trackAsset(url, depth);
      recordSkip(url, verdict.normalizedUrl, verdict.reason, verdict.detail, depth, foundOn);
      return false;
    }
    seen.add(verdict.normalizedUrl);
    retractSkip(verdict.normalizedUrl);
    frontier.push({
      url,
      normalizedUrl: verdict.normalizedUrl,
      depth,
      inSitemap: sitemapKeys.has(verdict.normalizedUrl),
      foundOn,
    });
    if (depth > maxDepthReached) maxDepthReached = depth;
    return true;
  };

  // Seeds: the homepage first, then sitemap URLs one hop behind it — they are reachable via
  // the sitemap document rather than via the homepage, and that hop should cost depth.
  enqueue(startUrl, 0, null, true);
  const sitemapSeedLimit = maxPages * SITEMAP_SEED_MULTIPLE;
  let sitemapSeeded = 0;
  for (const entry of sitemap.entries) {
    if (sitemapSeeded >= sitemapSeedLimit) {
      // Not a skip if it is already queued from a shallower path (the start URL, typically).
      if (!seen.has(entry.normalizedLoc)) {
        recordSkip(entry.loc, entry.normalizedLoc, 'max-pages', 'Beyond the sitemap seeding limit', 1, entry.source);
      }
      continue;
    }
    if (enqueue(entry.loc, 1, entry.source)) sitemapSeeded += 1;
  }

  // ── renderer ──────────────────────────────────────────────────────────────
  let renderer: Renderer | null = null;
  if (config.renderJs ?? env.enableJsRendering) {
    if (await isRenderingAvailable()) {
      renderer = await createRenderer({ userAgent, timeoutMs: config.timeoutMs });
      if (!renderer) warn('Headless rendering could not start; pages were analysed as static HTML.');
    } else {
      warn('JS rendering was requested but Playwright/Chromium is unavailable; using static HTML.');
    }
  }

  const ctx: PageContext = {
    fetcher,
    renderer,
    siteDomain: domain,
    robots,
    signal,
    onRenderFailure: (url, error) => {
      renderFailures += 1;
      log.debug('render failed, falling back to static HTML', { url, error });
    },
  };

  const recordPage = (page: PageAnalysis): void => {
    pages.push(page);
    if (page.error !== null || page.statusCode === null) failedCount += 1;
    else crawledCount += 1;
    if (page.contentBytes !== null) totalBytes += page.contentBytes;
    if (page.responseTimeMs !== null && page.statusCode !== null) {
      responseTimeTotal += page.responseTimeMs;
      responseTimeSamples += 1;
    }
    try {
      hooks.onPage?.(page);
    } catch (err) {
      log.warn('onPage hook threw', { url: page.url, error: errorMessage(err) });
    }
  };

  const processUrl = async (item: FrontierItem): Promise<void> => {
    if (signal?.aborted) {
      recordSkip(item.url, item.normalizedUrl, 'cancelled', 'Crawl cancelled', item.depth, item.foundOn);
      return;
    }
    currentUrl = item.url;
    try {
      const outcome = await fetchAndAnalyze(ctx, item, 'crawl');
      if (outcome.kind === 'cancelled') {
        recordSkip(item.url, item.normalizedUrl, 'cancelled', 'Crawl cancelled', item.depth, item.foundOn);
        return;
      }

      const { page, html, headers, finalUrl, followUp } = outcome;
      recordPage(page);

      if (html !== null && cmsProbes < MAX_CMS_PROBES) {
        // Keep looking while the answer is a non-answer: the first page of a site is often a
        // CDN splash or a redirect landing with no platform fingerprint at all.
        if (cms === null || cms.cms === 'UNKNOWN' || cms.cms === 'CUSTOM') {
          cmsProbes += 1;
          const detection = detectCms(html, headers, finalUrl);
          if (cms === null || detection.confidence > cms.confidence) cms = detection;
        }
      }

      if (followUp !== null) enqueue(followUp, item.depth, item.url);

      for (const link of page.links) {
        if (linkGraph.length < MAX_LINK_EDGES) {
          linkGraph.push(toEdge(page, link));
        } else {
          warn(`More than ${MAX_LINK_EDGES} links were found; the link graph is truncated.`);
        }
        if (link.isInternal) {
          enqueue(link.href, item.depth + 1, page.url);
        } else {
          recordSkip(link.href, link.normalized, 'off-site', 'External host', item.depth + 1, page.url);
          trackExternal(link.href, link.normalized, page.url);
        }
      }

      if (checkAssets) {
        for (const image of page.images) {
          if (isSameSite(image.src, domain)) trackAsset(image.src, item.depth + 1);
        }
      }
    } catch (err) {
      // Anything unexpected (a parser blowing up on pathological markup, an OOM-adjacent
      // string op) is one lost page, never a lost crawl.
      const message = errorMessage(err);
      log.warn('page failed', { url: item.url, error: message });
      recordPage(
        emptyPageAnalysis({
          url: item.url,
          normalizedUrl: item.normalizedUrl,
          depth: item.depth,
          statusCode: null,
          contentType: null,
          error: message,
          inSitemap: item.inSitemap,
        }),
      );
    } finally {
      emit('crawling', `Crawled ${crawledCount} of ${seen.size} discovered URLs`);
    }
  };

  // ── main loop ─────────────────────────────────────────────────────────────
  emit('crawling', 'Crawling', true);
  const limit = createLimiter(concurrency);
  const inFlight = new Map<number, Promise<void>>();
  let started = 0;
  let taskId = 0;

  try {
    for (;;) {
      if (signal?.aborted) {
        cancelled = true;
        break;
      }

      while (frontier.size > 0 && inFlight.size < concurrency) {
        if (started >= maxPages) {
          limitReached = true;
          break;
        }
        const item = frontier.shift();
        if (!item) break;
        started += 1;
        const id = taskId;
        taskId += 1;
        const task = limit(() => processUrl(item))
          .catch((err: unknown) => {
            log.error('crawl task failed', { url: item.url, error: errorMessage(err) });
          })
          .finally(() => {
            inFlight.delete(id);
          });
        inFlight.set(id, task);
      }

      if (inFlight.size === 0) break;
      // Wake as soon as any slot frees so newly discovered URLs start immediately.
      await Promise.race([...inFlight.values()]);
    }

    await Promise.allSettled([...inFlight.values()]);

    const leftovers = frontier.drain();
    if (leftovers.length > 0) {
      const reason: SkipReason = cancelled ? 'cancelled' : 'max-pages';
      const detail = cancelled ? 'Crawl cancelled before this URL was fetched' : `Page limit of ${maxPages} reached`;
      if (!cancelled) limitReached = true;
      for (const item of leftovers) {
        recordSkip(item.url, item.normalizedUrl, reason, detail, item.depth, item.foundOn);
      }
    }

    // ── asset probes ───────────────────────────────────────────────────────
    // Probed assets become rows in `pages`: they are URLs on this site with a status code,
    // and `emptyPageAnalysis` exists precisely for responses we cannot parse. They therefore
    // count towards `stats.pagesCrawled` but never towards `maxPages`, which governs HTML.
    if (checkAssets && assetTargets.size > 0 && !cancelled) {
      // A URL tracked as an asset can since have been crawled as a page (an extensionless image
      // route, say). `CrawlPage` is unique per normalised URL, so probing it again would hand
      // the worker two rows for one URL.
      const targets = [...assetTargets.entries()]
        .filter(([key]) => !seen.has(key))
        .map(([, target]) => target);
      emit('finishing', `Checking ${targets.length} asset URLs`, true);
      const results = await mapWithConcurrency(targets, concurrency, (target) => probe(fetcher, target.url, signal));
      results.forEach((outcome, index) => {
        const target = targets[index];
        if (!target) return;
        if (outcome.kind === 'error') {
          recordPage(
            emptyPageAnalysis({
              url: target.url,
              depth: target.depth,
              statusCode: null,
              contentType: null,
              error: outcome.message,
            }),
          );
          return;
        }
        const result = outcome.result;
        if (result.aborted) return;
        recordPage(
          emptyPageAnalysis({
            url: target.url,
            depth: target.depth,
            statusCode: result.statusCode,
            contentType: result.contentType,
            responseTimeMs: result.responseTimeMs,
            contentBytes: declaredBytes(result),
            redirectChain: result.redirectChain,
            redirectTarget: result.redirectTarget,
            error: result.error,
          }),
        );
      });
    }

    // ── external link probes ───────────────────────────────────────────────
    const externalLinks: ExternalLinkCheck[] = [];
    if (checkExternalLinks && externalTargets.size > 0 && !cancelled) {
      emit('finishing', `Checking ${externalTargets.size} external links`, true);
      const entries = [...externalTargets.entries()];
      const results = await mapWithConcurrency(entries, concurrency, ([, entry]) =>
        probe(fetcher, entry.url, signal),
      );
      results.forEach((outcome, index) => {
        const pair = entries[index];
        if (!pair) return;
        const [normalizedUrl, entry] = pair;
        if (outcome.kind === 'error') {
          externalLinks.push({
            url: entry.url,
            normalizedUrl,
            statusCode: null,
            ok: false,
            contentType: null,
            redirectTarget: null,
            responseTimeMs: null,
            error: outcome.message,
            foundOn: entry.sources,
          });
          return;
        }
        const result = outcome.result;
        if (result.aborted) return;
        externalLinks.push({
          url: entry.url,
          normalizedUrl,
          statusCode: result.statusCode,
          ok: result.ok,
          contentType: result.contentType,
          redirectTarget: result.redirectTarget,
          responseTimeMs: result.responseTimeMs,
          error: result.error,
          foundOn: entry.sources,
        });
      });
    }

    if (renderFailures > 0) {
      warn(`Headless rendering failed on ${renderFailures} page(s); static HTML was analysed instead.`);
    }

    const finishedAtMs = Date.now();
    const stats: CrawlStats = {
      pagesCrawled: crawledCount,
      pagesFailed: failedCount,
      pagesSkipped: skippedCount,
      pagesDiscovered: seen.size,
      maxDepthReached,
      totalBytes,
      avgResponseTimeMs: responseTimeSamples > 0 ? round(responseTimeTotal / responseTimeSamples, 0) : 0,
    };

    currentUrl = null;
    emit('finishing', cancelled ? 'Crawl cancelled' : 'Crawl finished', true);
    log.info('crawl finished', {
      startUrl,
      domain,
      pages: pages.length,
      skipped: skippedCount,
      cancelled,
      durationMs: finishedAtMs - startedAtMs,
    });

    return {
      startUrl,
      domain,
      pages,
      linkGraph,
      robots,
      sitemap,
      skipped: [...skipRecords.values()],
      stats,
      cms,
      startedAt,
      finishedAt: new Date(finishedAtMs).toISOString(),
      durationMs: finishedAtMs - startedAtMs,
      cancelled,
      limitReached,
      warnings,
      externalLinks,
    };
  } finally {
    await renderer?.close();
  }
}

/**
 * Options for a one-URL re-check.
 *
 * Everything frontier-shaped is removed from the type rather than merely ignored: a caller who
 * passes `checkExternalLinks` here deserves a compile error, not a silent no-op.
 */
export type SinglePageConfig = Omit<
  CrawlEngineConfig,
  | 'startUrl'
  | 'maxPages'
  | 'maxDepth'
  | 'concurrency'
  | 'includePatterns'
  | 'excludePatterns'
  | 'useSitemap'
  | 'maxSitemapUrls'
  | 'checkAssets'
  | 'checkExternalLinks'
  | 'maxAssetChecks'
  | 'maxExternalChecks'
> & {
  signal?: AbortSignal;
  /** Depth to record on the row, when the caller knows where the page sits. */
  depth?: number;
  inSitemap?: boolean;
};

export interface SinglePageResult {
  page: PageAnalysis;
  /** Outgoing links, ready to replace this page's edges in the link graph. */
  links: CrawlLinkEdge[];
  cms: CmsDetection | null;
}

/**
 * Re-check one URL — after a fix is deployed, or when a rule needs fresh data for a single
 * page. Same fetch, render and analysis path as the crawl, minus the frontier, so a re-check
 * and the crawl that found the issue can never disagree about how a page is read.
 */
export async function crawlSinglePage(url: string, config: SinglePageConfig = {}): Promise<SinglePageResult> {
  const target = url.trim();
  const normalizedUrl = normalizeUrl(target);
  if (!normalizedUrl) throw new ValidationError(`Invalid URL: ${url}`);

  const domain = cleanDomain(config.domain ?? normalizedUrl);
  const origin = originOf(target);
  const userAgent = config.userAgent ?? env.crawlerUserAgent;
  const respectRobots = config.respectRobots ?? true;
  const signal = config.signal;

  const fetcher = createFetcher({
    userAgent,
    timeoutMs: config.timeoutMs,
    maxRedirects: config.maxRedirects,
    maxBodyBytes: config.maxBodyBytes,
    minHostIntervalMs: config.delayMs,
    retries: config.retries,
  });

  const robots = respectRobots
    ? await loadRobots(origin, userAgent, { fetcher, signal })
    : allowAllRobots(origin);

  const item: FrontierItem = {
    url: target,
    normalizedUrl,
    depth: config.depth ?? 0,
    inSitemap: config.inSitemap ?? false,
    foundOn: null,
  };

  if (respectRobots && !robots.isAllowed(target)) {
    return {
      page: emptyPageAnalysis({
        url: target,
        normalizedUrl,
        depth: item.depth,
        statusCode: null,
        contentType: null,
        inSitemap: item.inSitemap,
        indexabilityReason: 'Blocked by robots.txt',
      }),
      links: [],
      cms: null,
    };
  }

  let renderer: Renderer | null = null;
  if (config.renderJs ?? env.enableJsRendering) {
    if (await isRenderingAvailable()) renderer = await createRenderer({ userAgent, timeoutMs: config.timeoutMs });
  }

  try {
    const outcome = await fetchAndAnalyze(
      {
        fetcher,
        renderer,
        siteDomain: domain,
        robots,
        signal,
        onRenderFailure: (failedUrl, error) =>
          log.debug('render failed, falling back to static HTML', { url: failedUrl, error }),
      },
      item,
      'single',
    );

    if (outcome.kind === 'cancelled') {
      return {
        page: emptyPageAnalysis({
          url: target,
          normalizedUrl,
          depth: item.depth,
          statusCode: null,
          contentType: null,
          error: 'Request cancelled',
          inSitemap: item.inSitemap,
        }),
        links: [],
        cms: null,
      };
    }

    const { page, html, headers, finalUrl } = outcome;
    return {
      page,
      links: page.links.map((link) => toEdge(page, link)),
      cms: html === null ? null : detectCms(html, headers, finalUrl),
    };
  } finally {
    await renderer?.close();
  }
}
