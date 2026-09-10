/**
 * Engine behaviour against an in-memory site.
 *
 * `fetch` is stubbed inside the test (the only place a stub is allowed) so the frontier,
 * dedupe, skip reasons, redirect handling, caps and cancellation are all exercised without a
 * network. The site below is deliberately awkward: a redirect, a 404, a disallowed path, an
 * asset link and an off-site link.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { crawlSinglePage, crawlWebsite } from '../crawler';
import type { CrawlProgress, SkipReason } from '../types';

const ROBOTS = `User-agent: *
Disallow: /private/
Sitemap: https://example.com/sitemap.xml
`;

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`;

const HOME = `<!doctype html><html lang="en"><head><title>Home</title>
<meta name="description" content="The home page." />
<meta name="generator" content="WordPress 6.4.2" />
<link rel="canonical" href="https://example.com/" />
</head><body><main>
<h1>Home</h1>
<p>Some words on the home page so the word count is not zero.</p>
<a href="/about">About</a>
<a href="/contact">Contact</a>
<a href="/old">Old link</a>
<a href="/private/secret">Secret</a>
<a href="/brochure.pdf">Brochure</a>
<a href="/missing">Missing</a>
<a href="https://external.example.org/partner">Partner</a>
<img src="/img/logo.png" alt="Logo" />
</main></body></html>`;

const simplePage = (title: string): string =>
  `<!doctype html><html lang="en"><head><title>${title}</title></head><body><main><h1>${title}</h1><p>Body copy.</p><a href="/">Home</a></main></body></html>`;

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** Minimal origin server for `https://example.com` plus one external host. */
function respond(url: string, method: string): Response {
  const parsed = new URL(url);

  if (parsed.host === 'external.example.org') {
    return new Response(method === 'HEAD' ? null : 'ok', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  }
  // Both the apex and `www.` answer here; which host the engine actually asks for is asserted
  // from the call log, since a real site frequently resolves only one of the two.
  if (parsed.host !== 'example.com' && parsed.host !== 'www.example.com') {
    return new Response(null, { status: 404 });
  }

  switch (parsed.pathname) {
    case '/robots.txt':
      return new Response(ROBOTS, { status: 200, headers: { 'content-type': 'text/plain' } });
    case '/sitemap.xml':
      return new Response(SITEMAP, { status: 200, headers: { 'content-type': 'application/xml' } });
    case '/':
      return html(HOME);
    case '/about':
      return html(simplePage('About'));
    case '/contact':
      return html(simplePage('Contact'));
    case '/new':
      return html(simplePage('New'));
    case '/private/secret':
      return html(simplePage('Secret'));
    case '/old':
      return new Response(null, { status: 301, headers: { location: 'https://example.com/new' } });
    case '/img/logo.png':
      return new Response(method === 'HEAD' ? null : 'png', {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '2048' },
      });
    case '/brochure.pdf':
      return new Response(method === 'HEAD' ? null : 'pdf', {
        status: 404,
        headers: { 'content-type': 'application/pdf' },
      });
    default:
      return new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } });
  }
}

/** Stubs `fetch` and returns the log of URLs the engine asked for, in order. */
function stubFetch(): string[] {
  const requested: string[] = [];
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    return Promise.resolve(respond(url, init?.method ?? 'GET'));
  });
  return requested;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseConfig = {
  startUrl: 'https://example.com/',
  maxPages: 25,
  maxDepth: 3,
  concurrency: 2,
  retries: 1,
  useSitemap: true,
};

const reasonsFor = (skipped: Array<{ url: string; reason: SkipReason }>, needle: string): SkipReason[] =>
  skipped.filter((entry) => entry.url.includes(needle)).map((entry) => entry.reason);

describe('crawlWebsite', () => {
  it('crawls the site breadth-first and returns a complete outcome', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);

    const urls = outcome.pages.map((page) => page.normalizedUrl).sort();
    expect(urls).toContain('https://example.com/');
    expect(urls).toContain('https://example.com/about');
    expect(urls).toContain('https://example.com/contact');
    expect(outcome.cancelled).toBe(false);
    expect(outcome.domain).toBe('example.com');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reads robots.txt and its sitemap, seeding both', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    expect(outcome.robots.found).toBe(true);
    expect(outcome.robots.sitemaps).toContain('https://example.com/sitemap.xml');
    expect(outcome.sitemap.entries).toHaveLength(2);
    const about = outcome.pages.find((page) => page.normalizedUrl === 'https://example.com/about');
    expect(about?.inSitemap).toBe(true);
  });

  it('records every skip with a reason instead of dropping it', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    expect(reasonsFor(outcome.skipped, '/private/secret')).toEqual(['robots-disallow']);
    expect(reasonsFor(outcome.skipped, '/brochure.pdf')).toEqual(['non-html-extension']);
    expect(reasonsFor(outcome.skipped, 'external.example.org')).toEqual(['off-site']);
    expect(outcome.stats.pagesSkipped).toBe(outcome.skipped.length);
  });

  it('records external links as edges but never fetches them as pages', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    const external = outcome.linkGraph.find((edge) => edge.targetUrl.includes('external.example.org'));
    expect(external?.isInternal).toBe(false);
    expect(outcome.pages.some((page) => page.url.includes('external.example.org'))).toBe(false);
  });

  it('records a redirect as its own row and crawls the destination', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    const old = outcome.pages.find((page) => page.normalizedUrl === 'https://example.com/old');
    expect(old?.redirectTarget).toBe('https://example.com/new');
    expect(old?.isIndexable).toBe(false);
    expect(old?.indexabilityReason).toContain('https://example.com/new');
    expect(outcome.pages.some((page) => page.normalizedUrl === 'https://example.com/new')).toBe(true);
  });

  it('keeps the redirect status on the redirect row, not the destination status', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    const old = outcome.pages.find((page) => page.normalizedUrl === 'https://example.com/old');
    // 301 vs 302 is the whole point of auditing a redirect; reporting the destination's 200 here
    // would make a permanent and a temporary redirect indistinguishable.
    expect(old?.statusCode).toBe(301);
    const destination = outcome.pages.find((page) => page.normalizedUrl === 'https://example.com/new');
    expect(destination?.statusCode).toBe(200);
  });

  it('never reports a URL as both crawled and skipped', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, maxDepth: 1 });
    const crawled = new Set(outcome.pages.map((page) => page.normalizedUrl));
    const contradictions = outcome.skipped.filter(
      (entry) => entry.normalizedUrl !== null && crawled.has(entry.normalizedUrl),
    );
    expect(contradictions).toEqual([]);
    expect(outcome.stats.pagesSkipped).toBe(outcome.skipped.length);
  });

  it('keeps a 404 as a non-indexable row rather than an error', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    const missing = outcome.pages.find((page) => page.normalizedUrl === 'https://example.com/missing');
    expect(missing?.statusCode).toBe(404);
    expect(missing?.isIndexable).toBe(false);
  });

  it('detects the CMS from the pages it fetched', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    expect(outcome.cms?.cms).toBe('WORDPRESS');
    expect(outcome.cms?.signals.length).toBeGreaterThan(0);
  });

  it('never visits the same normalised URL twice', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    const seen = outcome.pages.map((page) => page.normalizedUrl);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('reports progress without flooding the caller', async () => {
    stubFetch();
    const updates: CrawlProgress[] = [];
    await crawlWebsite(baseConfig, { onProgress: (progress) => updates.push(progress) });
    expect(updates.length).toBeGreaterThan(1);
    expect(updates.map((update) => update.phase)).toContain('crawling');
    expect(updates[updates.length - 1]?.phase).toBe('finishing');
  });

  it('survives a hook that throws', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig, {
      onPage: () => {
        throw new Error('consumer exploded');
      },
    });
    expect(outcome.pages.length).toBeGreaterThan(0);
  });
});

describe('crawlWebsite — limits', () => {
  it('stops at maxPages and marks the remainder skipped', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, maxPages: 2, concurrency: 1 });
    expect(outcome.pages).toHaveLength(2);
    expect(outcome.limitReached).toBe(true);
    expect(outcome.skipped.some((entry) => entry.reason === 'max-pages')).toBe(true);
  });

  it('stops at maxDepth', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, maxDepth: 0 });
    expect(outcome.pages.map((page) => page.normalizedUrl)).toEqual(['https://example.com/']);
    expect(outcome.skipped.some((entry) => entry.reason === 'max-depth')).toBe(true);
  });

  it('honours exclude patterns', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, excludePatterns: ['*/contact*'] });
    expect(outcome.pages.some((page) => page.url.includes('/contact'))).toBe(false);
    expect(reasonsFor(outcome.skipped, '/contact')).toEqual(['exclude-pattern']);
  });

  it('honours include patterns while still starting at the seed', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, includePatterns: ['*/about*'] });
    const urls = outcome.pages.map((page) => page.normalizedUrl);
    expect(urls).toContain('https://example.com/');
    expect(urls).toContain('https://example.com/about');
    expect(urls).not.toContain('https://example.com/contact');
  });

  it('asks the host it was given for robots.txt and sitemaps, www included', async () => {
    const requested = stubFetch();
    await crawlWebsite({ ...baseConfig, startUrl: 'https://www.example.com/', maxPages: 1 });
    // Normalisation drops `www.`; the crawl must not, or a site whose apex has no DNS record
    // loses both its robots.txt and its sitemap.
    expect(requested).toContain('https://www.example.com/robots.txt');
    expect(requested).not.toContain('https://example.com/robots.txt');
    expect(requested.some((url) => url.startsWith('https://www.example.com/sitemap'))).toBe(true);
  });

  it('ignores robots.txt when told to, but still reports it', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, respectRobots: false });
    expect(outcome.robots.found).toBe(true);
    expect(outcome.pages.some((page) => page.url.includes('/private/secret'))).toBe(true);
  });
});

describe('crawlWebsite — optional probes', () => {
  it('HEAD-checks external links once each when asked', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, checkExternalLinks: true });
    expect(outcome.externalLinks).toHaveLength(1);
    const [check] = outcome.externalLinks;
    expect(check?.url).toBe('https://external.example.org/partner');
    expect(check?.statusCode).toBe(200);
    expect(check?.foundOn).toContain('https://example.com/');
  });

  it('returns no external checks when the option is off', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig);
    expect(outcome.externalLinks).toEqual([]);
  });

  it('probes internal assets and reports a broken one', async () => {
    stubFetch();
    const outcome = await crawlWebsite({ ...baseConfig, checkAssets: true });
    const brochure = outcome.pages.find((page) => page.url.includes('brochure.pdf'));
    expect(brochure?.statusCode).toBe(404);
    const logo = outcome.pages.find((page) => page.url.includes('logo.png'));
    expect(logo?.statusCode).toBe(200);
    expect(logo?.contentBytes).toBe(2048);
  });
});

describe('crawlWebsite — cancellation', () => {
  it('returns a partial outcome with cancelled: true', async () => {
    stubFetch();
    const controller = new AbortController();
    const outcome = await crawlWebsite(
      { ...baseConfig, concurrency: 1 },
      { signal: controller.signal, onPage: () => controller.abort() },
    );
    expect(outcome.cancelled).toBe(true);
    expect(outcome.pages).toHaveLength(1);
    expect(outcome.skipped.some((entry) => entry.reason === 'cancelled')).toBe(true);
  });

  it('does nothing at all when the signal is already aborted', async () => {
    stubFetch();
    const outcome = await crawlWebsite(baseConfig, { signal: AbortSignal.abort() });
    expect(outcome.cancelled).toBe(true);
    expect(outcome.pages).toEqual([]);
  });
});

describe('crawlWebsite — bad input', () => {
  it('rejects a start URL that is not a URL', async () => {
    stubFetch();
    await expect(crawlWebsite({ ...baseConfig, startUrl: 'not a url at all' })).rejects.toThrow(
      /Invalid start URL/,
    );
  });
});

describe('crawlSinglePage', () => {
  it('re-checks one URL and returns its analysis, links and CMS', async () => {
    stubFetch();
    const result = await crawlSinglePage('https://example.com/', { domain: 'example.com' });
    expect(result.page.statusCode).toBe(200);
    expect(result.page.title).toBe('Home');
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.cms?.cms).toBe('WORDPRESS');
  });

  it('refuses a URL robots.txt disallows, without fetching it', async () => {
    stubFetch();
    const result = await crawlSinglePage('https://example.com/private/secret', { domain: 'example.com' });
    expect(result.page.statusCode).toBeNull();
    expect(result.page.isIndexable).toBe(false);
    expect(result.page.indexabilityReason).toBe('Blocked by robots.txt');
  });

  it('follows a redirect in place so the caller sees the live content', async () => {
    stubFetch();
    const result = await crawlSinglePage('https://example.com/old', { domain: 'example.com' });
    expect(result.page.url).toBe('https://example.com/old');
    expect(result.page.redirectTarget).toBe('https://example.com/new');
    expect(result.page.title).toBe('New');
  });
});
