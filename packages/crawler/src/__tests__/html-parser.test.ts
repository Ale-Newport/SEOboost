/**
 * Extraction is the foundation every SEO rule stands on, so these tests pin the exact shape
 * of a parsed page against inline fixtures. No network, no browser: same bytes in, same
 * analysis out, forever.
 */

import { describe, expect, it } from 'vitest';
import {
  analyzeHtml,
  computeIndexability,
  emptyPageAnalysis,
  extractHeadings,
  extractMainText,
} from '../html-parser';
import { load } from 'cheerio';

const PAGE_URL = 'https://example.com/blog/post';

const FIXTURE = `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8" />
    <title>  Best   Widgets — Example  </title>
    <meta name="description" content="A guide to widgets." />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="index, follow, max-snippet:-1" />
    <link rel="canonical" href="/blog/post" />
    <link rel="alternate" hreflang="es" href="https://example.com/es/blog/post" />
    <meta property="og:title" content="Best Widgets" />
    <meta name="twitter:card" content="summary_large_image" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": "Best Widgets",
        "author": { "@type": "Person", "name": "Ada" }
      }
    </script>
  </head>
  <body>
    <header><a href="/">Home</a></header>
    <nav><a href="/pricing">Pricing</a></nav>
    <main>
      <h1>Best Widgets</h1>
      <p>Widgets are genuinely useful and this paragraph exists so the extractor has real words to count.</p>
      <h2>Buying guide</h2>
      <a href="/blog/other">Another post</a>
      <a href="https://partner.example.org/deal" rel="nofollow sponsored">Partner deal</a>
      <a href="mailto:hi@example.com">Email us</a>
      <img src="/img/hero.png" alt="A hero widget" width="800" height="600" loading="lazy" />
      <img src="/img/decor.png" alt="" role="presentation" />
      <img src="/img/missing.png" />
      <h3>Details</h3>
    </main>
    <footer><a href="/legal">Legal</a></footer>
  </body>
</html>`;

const analysis = analyzeHtml({
  url: PAGE_URL,
  html: FIXTURE,
  siteDomain: 'example.com',
  depth: 2,
  statusCode: 200,
  contentType: 'text/html; charset=utf-8',
  headers: {},
  responseTimeMs: 120,
  contentBytes: 4096,
});

describe('analyzeHtml — head metadata', () => {
  it('collapses whitespace in the title and measures it', () => {
    expect(analysis.title).toBe('Best Widgets — Example');
    expect(analysis.titleLength).toBe('Best Widgets — Example'.length);
  });

  it('reads the meta description, viewport, lang and robots directives', () => {
    expect(analysis.metaDescription).toBe('A guide to widgets.');
    expect(analysis.metaDescriptionLength).toBe('A guide to widgets.'.length);
    expect(analysis.metaViewport).toContain('width=device-width');
    expect(analysis.lang).toBe('en-GB');
    expect(analysis.robotsMeta).toBe('index, follow, max-snippet:-1');
  });

  it('resolves a relative canonical against the document URL', () => {
    expect(analysis.canonicalUrl).toBe('https://example.com/blog/post');
  });

  it('resolves hreflang alternates to absolute URLs', () => {
    expect(analysis.hreflang).toEqual([{ hreflang: 'es', href: 'https://example.com/es/blog/post' }]);
  });

  it('keeps Open Graph and Twitter meta under the property as authored', () => {
    expect(analysis.openGraph['og:title']).toBe('Best Widgets');
    expect(analysis.openGraph['twitter:card']).toBe('summary_large_image');
  });
});

describe('analyzeHtml — structure and content', () => {
  it('records headings in document order and lists the h1s', () => {
    expect(analysis.headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(analysis.h1).toEqual(['Best Widgets']);
  });

  it('counts words from the main landmark and excludes chrome', () => {
    expect(analysis.wordCount).toBeGreaterThan(10);
    expect(analysis.textContent).toContain('Widgets are genuinely useful');
    expect(analysis.textContent).not.toContain('Pricing');
    expect(analysis.textContent).not.toContain('Legal');
  });

  it('produces stable content fingerprints', () => {
    expect(analysis.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(analysis.simhash).toBeTruthy();
    const again = analyzeHtml({ url: PAGE_URL, html: FIXTURE, siteDomain: 'example.com' });
    expect(again.contentHash).toBe(analysis.contentHash);
  });
});

describe('analyzeHtml — links', () => {
  const byHref = (href: string) => analysis.links.find((link) => link.href === href);

  it('resolves relative hrefs and classifies internal vs external', () => {
    expect(byHref('https://example.com/blog/other')?.isInternal).toBe(true);
    expect(byHref('https://partner.example.org/deal')?.isInternal).toBe(false);
  });

  it('flags nofollow families and placement', () => {
    const partner = byHref('https://partner.example.org/deal');
    expect(partner?.isNofollow).toBe(true);
    expect(byHref('https://example.com/pricing')?.inNav).toBe(true);
    expect(byHref('https://example.com/')?.inNav).toBe(true);
    expect(byHref('https://example.com/legal')?.inFooter).toBe(true);
    expect(byHref('https://example.com/blog/other')?.inMainContent).toBe(true);
  });

  it('drops non-crawlable schemes', () => {
    expect(analysis.links.some((link) => link.href.startsWith('mailto:'))).toBe(false);
  });

  it('captures anchor text', () => {
    expect(byHref('https://example.com/blog/other')?.anchorText).toBe('Another post');
  });
});

describe('analyzeHtml — images', () => {
  it('collects every image with its dimensions', () => {
    expect(analysis.images).toHaveLength(3);
    const hero = analysis.images.find((image) => image.src.endsWith('/img/hero.png'));
    expect(hero?.alt).toBe('A hero widget');
    expect(hero?.width).toBe(800);
    expect(hero?.loading).toBe('lazy');
  });

  it('counts only non-decorative images as missing alt', () => {
    // `alt=""` plus role="presentation" is the correct way to mark decoration, not an error.
    expect(analysis.imagesMissingAlt).toBe(1);
  });
});

describe('analyzeHtml — structured data', () => {
  it('parses JSON-LD and collects nested @types', () => {
    expect(analysis.structuredData).toHaveLength(1);
    expect(analysis.structuredData[0]?.valid).toBe(true);
    expect(analysis.schemaTypes).toContain('Article');
    expect(analysis.schemaTypes).toContain('Person');
  });

  it('records malformed JSON-LD as an invalid block rather than throwing', () => {
    const broken = analyzeHtml({
      url: PAGE_URL,
      html: '<html><body><script type="application/ld+json">{ nope }</script></body></html>',
      siteDomain: 'example.com',
    });
    expect(broken.structuredData[0]?.valid).toBe(false);
    expect(broken.structuredData[0]?.errors?.length).toBeGreaterThan(0);
  });

  it('picks up microdata itemtype even without JSON-LD', () => {
    const microdata = analyzeHtml({
      url: PAGE_URL,
      html: '<html><body><div itemtype="https://schema.org/Product"><span>x</span></div></body></html>',
      siteDomain: 'example.com',
    });
    expect(microdata.schemaTypes).toContain('Product');
  });
});

describe('indexability', () => {
  it('treats a self-referencing canonical on a 200 as indexable', () => {
    expect(analysis.isIndexable).toBe(true);
    expect(analysis.indexabilityReason).toBe('Indexable');
  });

  it('honours meta robots noindex', () => {
    const page = analyzeHtml({
      url: PAGE_URL,
      html: '<html><head><meta name="robots" content="noindex, follow"><title>x</title></head><body></body></html>',
      siteDomain: 'example.com',
      statusCode: 200,
    });
    expect(page.isIndexable).toBe(false);
    expect(page.indexabilityReason).toBe('noindex in meta robots');
  });

  it('honours an X-Robots-Tag response header', () => {
    const page = analyzeHtml({
      url: PAGE_URL,
      html: '<html><head><title>x</title></head><body></body></html>',
      siteDomain: 'example.com',
      statusCode: 200,
      headers: { 'x-robots-tag': 'noindex' },
    });
    expect(page.isIndexable).toBe(false);
    expect(page.indexabilityReason).toBe('noindex in X-Robots-Tag');
  });

  it('marks a cross-canonical page as non-indexable and names the target', () => {
    const page = analyzeHtml({
      url: PAGE_URL,
      html: '<html><head><link rel="canonical" href="https://example.com/other"><title>x</title></head><body></body></html>',
      siteDomain: 'example.com',
      statusCode: 200,
    });
    expect(page.isIndexable).toBe(false);
    expect(page.indexabilityReason).toContain('https://example.com/other');
  });

  it('reports the first blocking condition in search-engine order', () => {
    expect(
      computeIndexability({
        url: PAGE_URL,
        statusCode: 404,
        robotsMeta: 'noindex',
        xRobotsTag: null,
        canonicalUrl: null,
        robotsAllowed: false,
      }).indexabilityReason,
    ).toBe('HTTP 404');

    expect(
      computeIndexability({
        url: PAGE_URL,
        statusCode: 200,
        robotsMeta: 'none',
        xRobotsTag: null,
        canonicalUrl: null,
        robotsAllowed: true,
      }).isIndexable,
    ).toBe(false);

    expect(
      computeIndexability({
        url: PAGE_URL,
        statusCode: 200,
        robotsMeta: null,
        xRobotsTag: null,
        canonicalUrl: null,
        robotsAllowed: false,
      }).indexabilityReason,
    ).toBe('Blocked by robots.txt');
  });
});

describe('emptyPageAnalysis', () => {
  it('keeps a failed request as a row with the error and no status', () => {
    const page = emptyPageAnalysis({
      url: 'https://example.com/gone',
      depth: 1,
      statusCode: null,
      contentType: null,
      error: 'Timed out after 20000ms',
    });
    expect(page.statusCode).toBeNull();
    expect(page.error).toBe('Timed out after 20000ms');
    expect(page.isIndexable).toBe(false);
    expect(page.normalizedUrl).toBe('https://example.com/gone');
  });

  it('marks a non-HTML response as non-indexable with the type in the reason', () => {
    const page = emptyPageAnalysis({
      url: 'https://example.com/brochure.pdf',
      depth: 1,
      statusCode: 200,
      contentType: 'application/pdf',
    });
    expect(page.isIndexable).toBe(false);
    expect(page.indexabilityReason).toContain('application/pdf');
  });
});

describe('pure extraction helpers', () => {
  it('falls back to <body> when a document has no landmarks', () => {
    const $ = load('<html><body><p>Just a paragraph of body text.</p></body></html>');
    expect(extractMainText($)).toBe('Just a paragraph of body text.');
  });

  it('reads heading levels from the tag name', () => {
    const $ = load('<h2>Two</h2><h4>Four</h4>');
    expect(extractHeadings($)).toEqual([
      { level: 2, text: 'Two' },
      { level: 4, text: 'Four' },
    ]);
  });
});
