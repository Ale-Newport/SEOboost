import { describe, expect, it } from 'vitest';
import {
  cleanDomain, getPath, hasNonHtmlExtension, isSameSite, looksLikeCrawlTrap,
  matchesPattern, normalizeUrl, resolveUrl, slugFromUrl, urlDepth,
} from '../url';

describe('normalizeUrl', () => {
  it('unifies protocol-relative, www and trailing slashes', () => {
    const canonical = 'https://example.com/blog/post';
    expect(normalizeUrl('https://www.example.com/blog/post/')).toBe(canonical);
    expect(normalizeUrl('//example.com/blog/post')).toBe(canonical);
    expect(normalizeUrl('example.com/blog/post')).toBe(canonical);
    expect(normalizeUrl('https://EXAMPLE.com/blog/post#section')).toBe(canonical);
  });

  it('keeps the root slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com/');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('strips tracking parameters but keeps meaningful ones, sorted', () => {
    expect(normalizeUrl('https://example.com/p?utm_source=x&id=2&gclid=abc&a=1')).toBe(
      'https://example.com/p?a=1&id=2',
    );
  });

  it('collapses index files and duplicate slashes', () => {
    expect(normalizeUrl('https://example.com//blog//index.html')).toBe('https://example.com/blog');
  });

  it('drops the default port', () => {
    expect(normalizeUrl('https://example.com:443/x')).toBe('https://example.com/x');
    expect(normalizeUrl('http://example.com:80/x')).toBe('http://example.com/x');
  });

  it('rejects non-http schemes and malformed input', () => {
    expect(normalizeUrl('mailto:a@b.com')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  it('can force a protocol to unify http/https duplicates', () => {
    expect(normalizeUrl('http://example.com/x', { forceProtocol: 'https:' })).toBe('https://example.com/x');
  });
});

describe('resolveUrl', () => {
  it('resolves relative hrefs against the base', () => {
    expect(resolveUrl('https://example.com/blog/post', '../about')).toBe('https://example.com/about');
    expect(resolveUrl('https://example.com/blog/post', '/contact')).toBe('https://example.com/contact');
  });

  it('returns null for non-navigational hrefs', () => {
    for (const href of ['mailto:a@b.com', 'tel:+1234', 'javascript:x', '#top', 'data:text/plain,x', '']) {
      expect(resolveUrl('https://example.com/', href)).toBeNull();
    }
  });
});

describe('site membership', () => {
  it('treats subdomains as the same site but other domains as external', () => {
    expect(isSameSite('https://blog.example.com/x', 'example.com')).toBe(true);
    expect(isSameSite('https://www.example.com/x', 'example.com')).toBe(true);
    expect(isSameSite('https://notexample.com/x', 'example.com')).toBe(false);
    expect(isSameSite('https://example.com.evil.com/x', 'example.com')).toBe(false);
  });

  it('cleans user-entered domains', () => {
    expect(cleanDomain('https://www.Example.com/path?q=1')).toBe('example.com');
    expect(cleanDomain('example.com')).toBe('example.com');
  });
});

describe('urlDepth and getPath', () => {
  it('counts path segments', () => {
    expect(urlDepth('https://example.com/')).toBe(0);
    expect(urlDepth('https://example.com/blog')).toBe(1);
    expect(urlDepth('https://example.com/blog/2024/post')).toBe(3);
  });
  it('extracts the path', () => {
    expect(getPath('https://example.com/a/b?c=1')).toBe('/a/b');
    expect(getPath('not a url')).toBe('/');
  });
  it('derives a slug from the last segment', () => {
    expect(slugFromUrl('https://example.com/blog/my-post/')).toBe('my-post');
    expect(slugFromUrl('https://example.com/')).toBe('home');
  });
});

describe('hasNonHtmlExtension', () => {
  it('detects asset URLs', () => {
    expect(hasNonHtmlExtension('https://example.com/a.pdf')).toBe(true);
    expect(hasNonHtmlExtension('https://example.com/style.css')).toBe(true);
    expect(hasNonHtmlExtension('https://example.com/page.html')).toBe(false);
    expect(hasNonHtmlExtension('https://example.com/page')).toBe(false);
  });
});

describe('looksLikeCrawlTrap', () => {
  it('flags repeated segments and faceted navigation', () => {
    expect(looksLikeCrawlTrap('https://example.com/a/b/a/b/a/b').trap).toBe(true);
    expect(looksLikeCrawlTrap('https://example.com/shop?sort=a&filter=b&color=c&size=d').trap).toBe(true);
    expect(looksLikeCrawlTrap('https://example.com/blog/my-post').trap).toBe(false);
  });
});

describe('matchesPattern', () => {
  it('supports glob wildcards', () => {
    expect(matchesPattern('https://example.com/blog/x', ['*/blog/*'])).toBe(true);
    expect(matchesPattern('https://example.com/shop/x', ['*/blog/*'])).toBe(false);
    expect(matchesPattern('https://example.com/x', [])).toBe(false);
  });
});
