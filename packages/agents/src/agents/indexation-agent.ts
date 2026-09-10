import { prisma } from '@seo/db';
import { ensureBingIntegration, isBingConfigured, submitBingSitemap, submitBingUrls } from '@seo/integrations/bing/index';
import { canAutoExecute } from '@seo/seo-engine';
import { clamp, errorMessage, normalizeUrl, round, saturate, truncate } from '@seo/shared';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  NO_CRAWL,
  autonomyOf,
  comparisonWindows,
  latestCrawl,
  loadSite,
  pluralise,
  propose,
  result,
  skipped,
  step,
  unique,
} from './shared';

const AGENT = 'IndexationAgent' as const;
const ALLOWED_ACTION_TYPES = ['SUBMIT_URL_INDEXING'] as const;

const MAX_SUBMIT = 200;

/**
 * The single most important thing a user must understand about this agent.
 *
 * Google's Indexing API only accepts JobPosting and BroadcastEvent pages. For everything else the
 * available levers are a correct sitemap, internal links, and crawlable, indexable HTML. Any tool
 * claiming to "force" a normal page into Google's index is either wrong or describing Bing.
 */
export const GOOGLE_INDEXING_REALITY =
  'Google offers no general-purpose indexing API: the Indexing API only accepts JobPosting and ' +
  'BroadcastEvent pages, so this platform cannot force a normal page into Google\'s index. What it can ' +
  'do is submit sitemaps, keep them accurate, and remove the crawl and indexability blockers that keep ' +
  'a page out. Bing does accept URL submission, and that is used where a Bing key is configured.';

export interface IndexationBuckets {
  /** Indexable, internally linked, in the sitemap — but earning nothing in Search Console. */
  missingFromSearchConsole: string[];
  /** Indexable and linked but absent from the sitemap. */
  missingFromSitemap: string[];
  /** In the sitemap but not indexable — a contradictory signal. */
  nonIndexableInSitemap: string[];
  /** Earning impressions but never reached by the crawler. */
  unknownToCrawler: string[];
}

export interface ReconcilablePage {
  url: string;
  normalizedUrl: string;
  isIndexable: boolean;
  inSitemap: boolean;
  internalLinksIn: number;
}

/**
 * Reconcile the three views of a site: what we crawled, what the sitemap claims, and what Search
 * Console has actually seen. Each disagreement means something different, so they are separated
 * rather than merged into one "not indexed" number.
 */
export function reconcileIndexation(
  pages: readonly ReconcilablePage[],
  gscUrls: ReadonlySet<string>,
): IndexationBuckets {
  const missingFromSearchConsole: string[] = [];
  const missingFromSitemap: string[] = [];
  const nonIndexableInSitemap: string[] = [];
  const crawled = new Set(pages.map((page) => page.normalizedUrl));

  for (const page of pages) {
    if (page.inSitemap && !page.isIndexable) nonIndexableInSitemap.push(page.url);
    if (!page.isIndexable) continue;
    if (!page.inSitemap && page.internalLinksIn > 0) missingFromSitemap.push(page.url);
    if (page.internalLinksIn > 0 && !gscUrls.has(page.normalizedUrl)) missingFromSearchConsole.push(page.url);
  }

  const unknownToCrawler = [...gscUrls].filter((url) => !crawled.has(url));

  return { missingFromSearchConsole, missingFromSitemap, nonIndexableInSitemap, unknownToCrawler };
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);
  const crawl = await step(ctx, 'get_latest_crawl', { websiteId: ctx.websiteId }, () => latestCrawl(ctx.websiteId));
  if (!crawl) return skipped('No crawl to reconcile against.', NO_CRAWL);

  const pages = await step(
    ctx,
    'list_pages',
    { websiteId: ctx.websiteId },
    () =>
      prisma.page.findMany({
        where: { websiteId: ctx.websiteId, isActive: true },
        select: { id: true, url: true, normalizedUrl: true, isIndexable: true, inSitemap: true, internalLinksIn: true, statusCode: true },
        take: 20_000,
      }),
    (rows) => ({ pages: rows.length }),
  );

  const windows = comparisonWindows();
  const gscPages = await step(
    ctx,
    'get_search_console_pages',
    { window: '28d' },
    () =>
      prisma.gscQueryMetric.groupBy({
        by: ['page'],
        where: { websiteId: ctx.websiteId, date: { gte: windows.current.start, lte: windows.current.end }, impressions: { gt: 0 } },
        _sum: { impressions: true },
        orderBy: { _sum: { impressions: 'desc' } },
        take: 20_000,
      }),
    (rows) => ({ pagesWithImpressions: rows.length }),
  );

  const gscUrls = new Set<string>(
    gscPages.flatMap((row) => {
      const normalized = normalizeUrl(row.page);
      return normalized ? [normalized] : [];
    }),
  );

  const buckets = reconcileIndexation(
    pages.map((page) => ({
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      isIndexable: page.isIndexable,
      inSitemap: page.inSitemap,
      internalLinksIn: page.internalLinksIn,
    })),
    gscUrls,
  );

  const gscConnected = gscUrls.size > 0;

  // ── Bing submission, where configured and permitted ────────────────────────
  const autonomy = autonomyOf(site);
  const permitted = canAutoExecute({
    actionType: 'SUBMIT_URL_INDEXING',
    autonomyLevel: autonomy.level,
    autoApproveSafe: autonomy.autoApproveSafe,
  });
  const explicitSubmit = ctx.input.submit === true;
  const submission = await submitToBing(ctx, {
    enabled: explicitSubmit || permitted.allowed,
    urls: buckets.missingFromSearchConsole.slice(0, MAX_SUBMIT),
    sitemaps: crawl.sitemapUrls,
  });

  // ── Actions for what could not be submitted automatically ──────────────────
  const actions = new ActionCollector();
  if (buckets.missingFromSearchConsole.length > 0 && !submission.submittedUrls) {
    await propose(ctx, actions, {
      type: 'SUBMIT_URL_INDEXING',
      title: `${buckets.missingFromSearchConsole.length} indexable ${pluralise(buckets.missingFromSearchConsole.length, 'page')} earn nothing in Search Console`,
      reasoning:
        `${buckets.missingFromSearchConsole.length} ${pluralise(buckets.missingFromSearchConsole.length, 'page')} are indexable and internally linked but recorded ` +
        `no impressions in the last 28 days. That is consistent with not being indexed, though it can also mean the ` +
        `page simply matches no queries yet. ${GOOGLE_INDEXING_REALITY}` +
        (submission.reason ? ` Bing submission: ${submission.reason}` : ''),
      evidence: {
        urls: buckets.missingFromSearchConsole.slice(0, 50),
        total: buckets.missingFromSearchConsole.length,
        window: { start: windows.current.start, end: windows.current.end },
        googleIndexingApi: GOOGLE_INDEXING_REALITY,
        bing: submission,
        caveat:
          'Zero impressions is evidence of absence from results, not proof of absence from the index. Use the ' +
          'URL Inspection tool on a sample before treating this as an indexing failure.',
      },
      affectedUrls: buckets.missingFromSearchConsole.slice(0, 50),
      payload: { urls: buckets.missingFromSearchConsole.slice(0, MAX_SUBMIT) },
      impact: round(clamp(saturate(buckets.missingFromSearchConsole.length, 20) * 0.6), 3),
      // We are inferring indexation from an absence of impressions, which is genuinely uncertain.
      confidence: gscConnected ? 0.55 : 0.3,
      effort: 1,
      sourceType: 'IndexationGap',
      sourceId: `missing-gsc:${crawl.id}`,
      ...(isBingConfigured()
        ? {}
        : {
            advisory:
              'Nothing can be submitted anywhere from here: Google accepts no general-purpose indexing submission and ' +
              'no Bing key is configured. Fix the discoverability causes instead.',
          }),
    });
  }

  const findings = [
    {
      kind: 'indexation',
      bucket: 'missing-from-search-console',
      count: buckets.missingFromSearchConsole.length,
      sample: buckets.missingFromSearchConsole.slice(0, 20),
      meaning: 'Indexable and internally linked, but no Search Console impressions in the window.',
    },
    {
      kind: 'indexation',
      bucket: 'missing-from-sitemap',
      count: buckets.missingFromSitemap.length,
      sample: buckets.missingFromSitemap.slice(0, 20),
      meaning: 'Indexable and linked but not listed in any sitemap — add them so discovery does not depend on crawling.',
    },
    {
      kind: 'indexation',
      bucket: 'non-indexable-in-sitemap',
      count: buckets.nonIndexableInSitemap.length,
      sample: buckets.nonIndexableInSitemap.slice(0, 20),
      meaning: 'Listed in a sitemap but blocked from indexing — a contradictory signal that wastes crawl budget.',
    },
    {
      kind: 'indexation',
      bucket: 'unknown-to-crawler',
      count: buckets.unknownToCrawler.length,
      sample: buckets.unknownToCrawler.slice(0, 20),
      meaning: 'Earning impressions but never reached by our crawler — usually orphaned or blocked from our user agent.',
    },
  ];

  return result({
    summary:
      (gscConnected
        ? `${buckets.missingFromSearchConsole.length} indexable ${pluralise(buckets.missingFromSearchConsole.length, 'page')} have no Search Console impressions, `
        : 'Search Console has no data for this site, so indexation cannot be verified against real impressions. ') +
      `${buckets.missingFromSitemap.length} missing from the sitemap, ${buckets.nonIndexableInSitemap.length} non-indexable ${pluralise(buckets.nonIndexableInSitemap.length, 'URL')} listed in it. ` +
      submission.summary,
    confidence: gscConnected ? 0.7 : 0.4,
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings,
    data: {
      crawlId: crawl.id,
      pagesCrawled: pages.length,
      sitemapsDiscovered: crawl.sitemapUrls,
      searchConsoleConnected: gscConnected,
      buckets: {
        missingFromSearchConsole: buckets.missingFromSearchConsole.length,
        missingFromSitemap: buckets.missingFromSitemap.length,
        nonIndexableInSitemap: buckets.nonIndexableInSitemap.length,
        unknownToCrawler: buckets.unknownToCrawler.length,
      },
      bing: submission,
      googleIndexingApi: GOOGLE_INDEXING_REALITY,
    },
  });
}

interface SubmissionReport {
  configured: boolean;
  attempted: boolean;
  submittedUrls: number;
  submittedSitemaps: string[];
  reason: string | null;
  summary: string;
}

/**
 * Submit sitemaps and URLs to Bing.
 *
 * Bing is the only search engine here that accepts URL submission for ordinary pages. It is still
 * gated on the site's autonomy level, because it is an outbound call that tells a third party
 * about URLs — cheap, but not the platform's decision to make unilaterally.
 */
async function submitToBing(
  ctx: AgentContext,
  input: { enabled: boolean; urls: readonly string[]; sitemaps: readonly string[] },
): Promise<SubmissionReport> {
  const base: SubmissionReport = {
    configured: isBingConfigured(),
    attempted: false,
    submittedUrls: 0,
    submittedSitemaps: [],
    reason: null,
    summary: '',
  };

  if (!base.configured) {
    return {
      ...base,
      reason: 'BING_API_KEY is not set, so no URL or sitemap submission was attempted.',
      summary: 'Bing submission is unavailable (no BING_API_KEY).',
    };
  }
  if (!input.enabled) {
    return {
      ...base,
      reason:
        'This site\'s autonomy level requires approval before submitting URLs, so an action was proposed instead of submitting.',
      summary: 'Bing submission held for approval.',
    };
  }

  try {
    const integration = await step(ctx, 'ensure_bing_property', { websiteId: ctx.websiteId }, () =>
      ensureBingIntegration(ctx.websiteId, ctx.signal),
    );
    if (!integration.siteUrl) {
      return {
        ...base,
        reason: integration.reason ?? 'No verified Bing property matches this domain.',
        summary: 'Bing submission skipped: no verified property.',
      };
    }

    const submittedSitemaps: string[] = [];
    for (const sitemap of unique(input.sitemaps).slice(0, 10)) {
      const res = await submitBingSitemap(integration.siteUrl, sitemap);
      if (res.ok) submittedSitemaps.push(sitemap);
    }

    let submittedUrls = 0;
    let reason: string | null = null;
    if (input.urls.length > 0) {
      const res = await submitBingUrls(integration.siteUrl, input.urls);
      if (res.ok) submittedUrls = res.data.submitted;
      else reason = `${res.code}: ${res.error}`;
    }

    return {
      ...base,
      attempted: true,
      submittedUrls,
      submittedSitemaps,
      reason,
      summary: `Bing: submitted ${submittedUrls} ${pluralise(submittedUrls, 'URL')} and ${submittedSitemaps.length} ${pluralise(submittedSitemaps.length, 'sitemap')}.`,
    };
  } catch (err) {
    ctx.log('bing submission failed', { error: errorMessage(err) });
    return {
      ...base,
      attempted: true,
      reason: truncate(errorMessage(err), 300, '…'),
      summary: 'Bing submission failed; see the reason in the run data.',
    };
  }
}

export const indexationAgent: AgentDefinition = {
  name: AGENT,
  label: 'Indexation',
  description:
    'Reconciles crawled pages, sitemap coverage and Search Console data, and submits URLs to Bing where that is configured and permitted.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: ['get_latest_crawl', 'list_pages', 'get_search_console_pages', 'ensure_bing_property'],
  requiresAi: false,
  run,
};

registerAgent(indexationAgent);
