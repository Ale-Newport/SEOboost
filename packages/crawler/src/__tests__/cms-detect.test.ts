/**
 * CMS fingerprinting. Every fixture is a stripped-down version of what the real platform
 * emits; the assertions check both the verdict and that the reasoning came back with it,
 * because a detection nobody can audit is worse than no detection.
 */

import { describe, expect, it } from 'vitest';
import { CMS_CONFIDENCE_THRESHOLD, detectCms, extractGenerators } from '../cms-detect';

const page = (head: string, body = '<h1>Hello</h1>'): string =>
  `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

describe('detectCms — platform fixtures', () => {
  it('identifies WordPress from the generator and wp-content assets', () => {
    const html = page(
      '<meta name="generator" content="WordPress 6.4.2" />' +
        '<link rel="stylesheet" href="/wp-content/themes/twenty/style.css" />' +
        '<link rel="https://api.w.org/" href="https://example.com/wp-json/" />',
    );
    const result = detectCms(html, {}, 'https://example.com/');
    expect(result.cms).toBe('WORDPRESS');
    expect(result.confidence).toBe(1);
    expect(result.signals).toContain('WORDPRESS:generator-wordpress');
    expect(result.signals).toContain('WORDPRESS:wp-content');
  });

  it('identifies Shopify from the CDN, theme object and x-shopid header', () => {
    const html = page(
      '<link href="https://cdn.shopify.com/s/files/1/x.css" rel="stylesheet" />',
      '<div class="shopify-section"><script>var Shopify = Shopify || {}; Shopify.theme = { id: 1 };</script></div>',
    );
    const result = detectCms(html, { 'X-ShopId': '12345' }, 'https://shop.example.com/');
    expect(result.cms).toBe('SHOPIFY');
    expect(result.signals).toContain('SHOPIFY:x-shopid-header');
    expect(result.signals).toContain('SHOPIFY:cdn-shopify');
  });

  it('identifies Webflow from data-wf attributes', () => {
    const html =
      '<!doctype html><html data-wf-page="65a" data-wf-site="65b"><head><title>t</title></head><body></body></html>';
    const result = detectCms(html, {}, 'https://example.com/');
    expect(result.cms).toBe('WEBFLOW');
    expect(result.signals).toContain('WEBFLOW:data-wf-page');
    expect(result.signals).toContain('WEBFLOW:data-wf-site');
  });

  it('identifies Next.js from __NEXT_DATA__ and the static chunk path', () => {
    const html = page(
      '<script src="/_next/static/chunks/main.js"></script>',
      '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>',
    );
    const result = detectCms(html, { 'x-powered-by': 'Next.js' }, 'https://example.com/');
    expect(result.cms).toBe('NEXTJS');
    expect(result.signals).toContain('NEXTJS:__NEXT_DATA__');
    expect(result.signals).toContain('NEXTJS:x-powered-by-next');
  });

  it('identifies Astro from the generator and islands', () => {
    const html = page(
      '<meta name="generator" content="Astro v4.5.0" />',
      '<astro-island uid="Z1"></astro-island>',
    );
    const result = detectCms(html, {}, 'https://example.com/');
    expect(result.cms).toBe('ASTRO');
    expect(result.signals).toContain('ASTRO:generator-astro');
  });

  it('identifies Hugo from the generator alone', () => {
    const result = detectCms(page('<meta name="generator" content="Hugo 0.120.4" />'), {}, 'https://example.com/');
    expect(result.cms).toBe('HUGO');
    expect(result.confidence).toBe(0.95);
  });

  it('identifies Ghost from the generator', () => {
    const result = detectCms(page('<meta name="generator" content="Ghost 5.75" />'), {}, 'https://example.com/');
    expect(result.cms).toBe('GHOST');
  });

  it('identifies Squarespace from the generator and context object', () => {
    const result = detectCms(
      page('<meta name="generator" content="Squarespace" />', '<script>Static.SQUARESPACE_CONTEXT = {};</script>'),
      {},
      'https://example.com/',
    );
    expect(result.cms).toBe('SQUARESPACE');
  });

  it('identifies Wix from the generator and warmup data', () => {
    const result = detectCms(
      page('<meta name="generator" content="Wix.com Website Builder" />', '<script id="wix-warmup-data">{}</script>'),
      {},
      'https://example.com/',
    );
    expect(result.cms).toBe('WIX');
  });

  it('trusts a vendor-owned hostname even with no markup fingerprints', () => {
    const result = detectCms(page(''), {}, 'https://acme.myshopify.com/products/thing');
    expect(result.cms).toBe('SHOPIFY');
    expect(result.signals).toContain('SHOPIFY:myshopify-host');
  });
});

describe('detectCms — ambiguity and absence', () => {
  it('picks the stronger platform but keeps the other stack visible in the signals', () => {
    // Headless WordPress behind a Next.js front end: both are true, one is the CMS.
    const html = page(
      '<meta name="generator" content="WordPress 6.4.2" /><script src="/_next/static/chunks/main.js"></script>',
      '<script id="__NEXT_DATA__" type="application/json">{}</script><img src="/wp-content/uploads/a.png" />',
    );
    const result = detectCms(html, {}, 'https://example.com/');
    expect(result.cms).toBe('WORDPRESS');
    expect(result.signals.some((signal) => signal.startsWith('NEXTJS:'))).toBe(true);
    // The winner's signals come first so the verdict reads top-down.
    expect(result.signals[0]?.startsWith('WORDPRESS:')).toBe(true);
  });

  it('returns CUSTOM for a real page with no known fingerprint', () => {
    const result = detectCms(page('', '<p>A hand-rolled page.</p>'), {}, 'https://example.com/');
    expect(result.cms).toBe('CUSTOM');
    expect(result.confidence).toBeLessThan(CMS_CONFIDENCE_THRESHOLD);
    expect(result.signals).toContain('no-known-cms-fingerprint');
  });

  it('does not name a platform on one weak signal alone', () => {
    // `shopify-section` is a copyable class name, worth less than the threshold by itself.
    const result = detectCms(page('', '<div class="shopify-section"></div>'), {}, 'https://example.com/');
    expect(result.cms).toBe('CUSTOM');
    expect(result.signals).toContain('SHOPIFY:shopify-section');
  });

  it('returns UNKNOWN when there was nothing to look at', () => {
    expect(detectCms(null).cms).toBe('UNKNOWN');
    expect(detectCms('').cms).toBe('UNKNOWN');
    expect(detectCms('   ').confidence).toBe(0);
    expect(detectCms('%PDF-1.7 binary junk').cms).toBe('UNKNOWN');
  });

  it('never exceeds a confidence of 1', () => {
    const html = page(
      '<meta name="generator" content="WordPress 6.4.2" /><link href="/wp-content/x.css" /><link href="/wp-includes/y.js" />',
      '<a href="/wp-json/wp/v2/posts">api</a><div class="wp-block-group"></div>',
    );
    expect(detectCms(html, {}, 'https://example.com/').confidence).toBeLessThanOrEqual(1);
  });

  it('survives malformed headers without throwing', () => {
    expect(() => detectCms(page(''), { link: '', 'x-powered-by': '' }, 'not a url')).not.toThrow();
  });
});

describe('extractGenerators', () => {
  it('reads generator meta in either attribute order, lower-cased', () => {
    expect(extractGenerators('<meta name="generator" content="Hugo 0.1">')).toEqual(['hugo 0.1']);
    expect(extractGenerators("<meta content='Astro v4' name='generator'>")).toEqual(['astro v4']);
  });

  it('ignores other meta tags', () => {
    expect(extractGenerators('<meta name="description" content="Hugo is great">')).toEqual([]);
  });
});
