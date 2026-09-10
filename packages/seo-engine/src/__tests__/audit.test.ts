import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '@seo/shared';
import { runTechnicalAudit } from '../technical/audit';
import type { AuditDataset, AuditPage } from '../types';

function page(overrides: Partial<AuditPage> & { url: string }): AuditPage {
  const normalized = normalizeUrl(overrides.url)!;
  return {
    normalizedUrl: normalized,
    statusCode: 200,
    contentType: 'text/html',
    redirectTarget: null,
    redirectChain: [],
    depth: 1,
    responseTimeMs: 300,
    contentBytes: 40_000,
    error: null,
    title: 'A perfectly reasonable page title for testing',
    metaDescription:
      'A meta description of a sensible length that describes the page contents clearly for searchers and engines.',
    canonicalUrl: overrides.url,
    robotsMeta: null,
    xRobotsTag: null,
    metaViewport: 'width=device-width, initial-scale=1',
    lang: 'en',
    h1: ['Page heading'],
    headings: [{ level: 1, text: 'Page heading' }, { level: 2, text: 'A section' }],
    wordCount: 900,
    textContent: 'Lorem ipsum '.repeat(200),
    contentHash: `hash-${normalized}`,
    simhash: '0123456789abcdef',
    links: [],
    images: [],
    imagesMissingAlt: 0,
    schemaTypes: ['Article', 'BreadcrumbList'],
    structuredData: [{ '@type': 'Article' }],
    hreflang: [],
    isIndexable: true,
    indexabilityReason: null,
    inSitemap: true,
    ...overrides,
  };
}

function dataset(pages: AuditPage[], overrides: Partial<AuditDataset> = {}): AuditDataset {
  const home = normalizeUrl('https://example.com/')!;
  return {
    websiteId: 'site_1',
    domain: 'example.com',
    protocol: 'https',
    pages,
    edges: pages
      .filter((p) => p.normalizedUrl !== home)
      .map((p) => ({ from: home, to: p.normalizedUrl, anchorText: 'link', isNofollow: false, inMainContent: true })),
    robots: { found: true, body: 'User-agent: *\nAllow: /', sitemaps: ['https://example.com/sitemap.xml'], disallowedUrls: [] },
    sitemap: { found: true, urls: pages.map((p) => p.url), errors: [] },
    settings: { thinContentWords: 300, maxDepthWarn: 4 },
    skipped: [],
    ...overrides,
  };
}

const homepage = page({ url: 'https://example.com/', depth: 0, schemaTypes: ['Organization', 'WebSite'] });

describe('runTechnicalAudit — status rules', () => {
  it('flags 5xx as critical and 404 with inbound links as high', () => {
    const result = runTechnicalAudit(
      dataset([homepage, page({ url: 'https://example.com/broken', statusCode: 500 }), page({ url: 'https://example.com/gone', statusCode: 404 })]),
    );
    const ids = result.issues.map((i) => i.ruleId);
    expect(ids).toContain('HTTP_5XX');
    expect(ids).toContain('HTTP_404');
    expect(result.issues.find((i) => i.ruleId === 'HTTP_5XX')!.severity).toBe('CRITICAL');
    expect(result.issues.find((i) => i.ruleId === 'HTTP_404')!.severity).toBe('HIGH');
  });

  it('flags redirect chains and loops separately', () => {
    const chain = page({
      url: 'https://example.com/chained', statusCode: 301,
      redirectChain: ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
    });
    const loop = page({
      url: 'https://example.com/looped', statusCode: 301,
      redirectChain: ['https://example.com/x', 'https://example.com/y', 'https://example.com/x'],
    });
    const ids = runTechnicalAudit(dataset([homepage, chain, loop])).issues.map((i) => i.ruleId);
    expect(ids).toContain('REDIRECT_CHAIN');
    expect(ids).toContain('REDIRECT_LOOP');
  });

  it('records a fetch failure rather than inventing a status', () => {
    const failed = page({ url: 'https://example.com/timeout', statusCode: null, error: 'Timed out after 20000ms' });
    const issues = runTechnicalAudit(dataset([homepage, failed])).issues;
    expect(issues.some((i) => i.ruleId === 'FETCH_FAILED')).toBe(true);
    // A failed fetch must not also produce metadata findings — we have no metadata.
    expect(issues.filter((i) => i.url === failed.url).every((i) => i.ruleId === 'FETCH_FAILED')).toBe(true);
  });
});

describe('runTechnicalAudit — metadata rules', () => {
  it('flags missing, long and short titles', () => {
    const missing = page({ url: 'https://example.com/no-title', title: null });
    const long = page({ url: 'https://example.com/long-title', title: 'x'.repeat(90) });
    const short = page({ url: 'https://example.com/short-title', title: 'Short' });
    const ids = runTechnicalAudit(dataset([homepage, missing, long, short])).issues.map((i) => i.ruleId);
    expect(ids).toContain('MISSING_TITLE');
    expect(ids).toContain('TITLE_TOO_LONG');
    expect(ids).toContain('TITLE_TOO_SHORT');
  });

  it('detects duplicate titles across pages', () => {
    const a = page({ url: 'https://example.com/a', title: 'The Same Title Everywhere On This Site' });
    const b = page({ url: 'https://example.com/b', title: 'The Same Title Everywhere On This Site' });
    const issue = runTechnicalAudit(dataset([homepage, a, b])).issues.find((i) => i.ruleId === 'DUPLICATE_TITLE');
    expect(issue).toBeDefined();
    expect(issue!.evidence.count).toBe(2);
  });

  it('flags a skipped heading level once per page', () => {
    const skipped = page({
      url: 'https://example.com/skip',
      headings: [{ level: 2, text: 'Two' }, { level: 4, text: 'Four' }, { level: 6, text: 'Six' }],
    });
    const found = runTechnicalAudit(dataset([homepage, skipped])).issues.filter((i) => i.ruleId === 'HEADING_HIERARCHY_SKIP');
    expect(found).toHaveLength(1);
  });
});

describe('runTechnicalAudit — indexability rules', () => {
  it('flags a canonical pointing at a non-indexable page', () => {
    const target = page({ url: 'https://example.com/target', isIndexable: false, indexabilityReason: 'noindex meta tag' });
    const source = page({ url: 'https://example.com/source', canonicalUrl: 'https://example.com/target' });
    const ids = runTechnicalAudit(dataset([homepage, target, source])).issues.map((i) => i.ruleId);
    expect(ids).toContain('CANONICAL_TO_NON_INDEXABLE');
  });

  it('flags a cross-domain canonical', () => {
    const p = page({ url: 'https://example.com/syndicated', canonicalUrl: 'https://other.com/original' });
    const ids = runTechnicalAudit(dataset([homepage, p])).issues.map((i) => i.ruleId);
    expect(ids).toContain('CANONICAL_CROSS_DOMAIN');
  });

  it('flags a non-indexable URL that is still listed in the sitemap', () => {
    const p = page({ url: 'https://example.com/hidden', isIndexable: false, indexabilityReason: 'noindex', inSitemap: true });
    const ids = runTechnicalAudit(dataset([homepage, p])).issues.map((i) => i.ruleId);
    expect(ids).toContain('NOINDEX_IN_SITEMAP');
  });
});

describe('runTechnicalAudit — content and duplicates', () => {
  it('flags thin content against the configured threshold', () => {
    const thin = page({ url: 'https://example.com/thin', wordCount: 120 });
    const issue = runTechnicalAudit(dataset([homepage, thin])).issues.find((i) => i.ruleId === 'THIN_CONTENT');
    expect(issue).toBeDefined();
    expect(issue!.evidence.threshold).toBe(300);
  });

  it('escalates an effectively empty page to HIGH', () => {
    const empty = page({ url: 'https://example.com/empty', wordCount: 20 });
    const issue = runTechnicalAudit(dataset([homepage, empty])).issues.find((i) => i.ruleId === 'THIN_CONTENT');
    expect(issue!.severity).toBe('HIGH');
  });

  it('detects byte-identical duplicate bodies', () => {
    const a = page({ url: 'https://example.com/dup-a', contentHash: 'identical' });
    const b = page({ url: 'https://example.com/dup-b', contentHash: 'identical' });
    const issue = runTechnicalAudit(dataset([homepage, a, b])).issues.find((i) => i.ruleId === 'DUPLICATE_CONTENT');
    expect(issue).toBeDefined();
    expect(issue!.evidence.count).toBe(2);
  });
});

describe('runTechnicalAudit — architecture and links', () => {
  it('detects orphan pages but never the homepage', () => {
    const orphan = page({ url: 'https://example.com/orphan' });
    const data = dataset([homepage, orphan]);
    data.edges = []; // nothing links anywhere
    const orphanIssues = runTechnicalAudit(data).issues.filter((i) => i.ruleId === 'ORPHAN_PAGE');
    expect(orphanIssues).toHaveLength(1);
    expect(orphanIssues[0]!.url).toBe('https://example.com/orphan');
  });

  it('flags broken internal links on the source page', () => {
    const broken = page({ url: 'https://example.com/dead', statusCode: 404 });
    const data = dataset([homepage, broken]);
    const issue = runTechnicalAudit(data).issues.find((i) => i.ruleId === 'BROKEN_INTERNAL_LINK');
    expect(issue).toBeDefined();
    expect(issue!.url).toBe('https://example.com/');
  });

  it('does not claim a link is broken when the target was never crawled', () => {
    const data = dataset([homepage]);
    data.edges = [{ from: homepage.normalizedUrl, to: 'https://example.com/never-crawled', anchorText: 'x', isNofollow: false, inMainContent: true }];
    expect(runTechnicalAudit(data).issues.some((i) => i.ruleId === 'BROKEN_INTERNAL_LINK')).toBe(false);
  });

  it('flags pages buried below the configured depth', () => {
    const deep = page({ url: 'https://example.com/a/b/c/d/e/f', depth: 6 });
    const ids = runTechnicalAudit(dataset([homepage, deep])).issues.map((i) => i.ruleId);
    expect(ids).toContain('DEEP_PAGE');
  });
});

describe('runTechnicalAudit — site-wide rules', () => {
  it('flags a missing sitemap and robots.txt', () => {
    const data = dataset([homepage], {
      robots: { found: false, body: null, sitemaps: [], disallowedUrls: [] },
      sitemap: { found: false, urls: [], errors: [] },
    });
    const ids = runTechnicalAudit(data).issues.map((i) => i.ruleId);
    expect(ids).toContain('MISSING_ROBOTS_TXT');
    expect(ids).toContain('MISSING_SITEMAP');
  });

  it('flags a site with no Organization schema anywhere', () => {
    const plain = page({ url: 'https://example.com/', depth: 0, schemaTypes: [] });
    const ids = runTechnicalAudit(dataset([plain])).issues.map((i) => i.ruleId);
    expect(ids).toContain('MISSING_ORGANIZATION_SCHEMA');
  });

  it('does not flag Organization schema when it is present', () => {
    const ids = runTechnicalAudit(dataset([homepage])).issues.map((i) => i.ruleId);
    expect(ids).not.toContain('MISSING_ORGANIZATION_SCHEMA');
  });
});

describe('runTechnicalAudit — output shape', () => {
  it('produces stable, unique fingerprints', () => {
    const data = dataset([homepage, page({ url: 'https://example.com/a', title: null })]);
    const first = runTechnicalAudit(data).issues.map((i) => i.fingerprint).sort();
    const second = runTechnicalAudit(data).issues.map((i) => i.fingerprint).sort();
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it('reports accurate stats', () => {
    const data = dataset([homepage, page({ url: 'https://example.com/a' }), page({ url: 'https://example.com/b', statusCode: 404 })]);
    const { stats } = runTechnicalAudit(data);
    expect(stats.pagesAudited).toBe(3);
    expect(stats.brokenPages).toBe(1);
    // The 404 is excluded: a page that does not return 2xx cannot be indexable.
    expect(stats.indexablePages).toBe(2);
  });

  it('returns no issues for a clean single-page site', () => {
    const clean = runTechnicalAudit(dataset([homepage]));
    const blocking = clean.issues.filter((i) => i.severity === 'CRITICAL' || i.severity === 'HIGH');
    expect(blocking).toHaveLength(0);
  });
});
