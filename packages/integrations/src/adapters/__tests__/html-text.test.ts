import { describe, expect, it } from 'vitest';
import { providerMessage, removeHtmlTags, trimTrailingSlash, type HttpResult } from '../http';
import { nextPageInfo } from '../shopify';
import { siteUrlFor } from '../types';
import { extractJsonLd, stripTags } from '../wordpress';

/**
 * Helpers that read remote content (WordPress/Shopify bodies, provider error pages, Link
 * headers). Each used to be a regex with quadratic backtracking; the pathological inputs below
 * pin them to linear time.
 */

const BIG = 50_000;

function expectFast(run: () => void, budgetMs = 100): void {
  const started = performance.now();
  run();
  expect(performance.now() - started).toBeLessThan(budgetMs);
}

function htmlResult(text: string, status = 403): HttpResult {
  return { ok: false, status, body: null, text, headers: new Headers() };
}

describe('removeHtmlTags', () => {
  it('matches the old /<[^>]*>/g replacement', () => {
    const samples = [
      '<p>Hello <b>world</b></p>',
      'a < b and c > d',
      '<scr<script>ipt>x',
      'no tags',
      'trailing <unclosed',
      '<>empty<>',
      '<a href="x">link</a> text <',
    ];
    for (const sample of samples) {
      expect(removeHtmlTags(sample)).toBe(sample.replace(/<[^>]*>/g, ''));
    }
  });

  it('is linear on many unclosed tags', () => {
    expectFast(() => expect(removeHtmlTags('<'.repeat(BIG))).toBe('<'.repeat(BIG)));
    expectFast(() => removeHtmlTags(`${'<a'.repeat(BIG / 2)}>`));
  });
});

describe('trimTrailingSlash / siteUrlFor', () => {
  it('drops trailing slashes only', () => {
    expect(trimTrailingSlash('https://example.com/wp///')).toBe('https://example.com/wp');
    expect(siteUrlFor('example.com/', '')).toBe('https://example.com');
    expect(siteUrlFor('example.com', 'http')).toBe('http://example.com');
  });

  it('is linear on a long slash run', () => {
    const input = `${'/'.repeat(BIG)}x`;
    expectFast(() => expect(trimTrailingSlash(input)).toBe(input));
    expectFast(() => expect(siteUrlFor(input, 'https')).toBe(`https://${input}`));
  });
});

describe('providerMessage on HTML error pages', () => {
  it('quotes the page title', () => {
    const message = providerMessage(htmlResult('<html><head><title lang="en">Just a moment...</title></head></html>'));
    expect(message).toContain('("Just a moment...")');
  });

  it('is linear on many unterminated <title tags', () => {
    expectFast(() => expect(providerMessage(htmlResult(`<${'<title'.repeat(BIG / 6)}`))).toContain('HTML page'));
  });
});

describe('WordPress stripTags', () => {
  it('strips tags and decodes the handful of entities WordPress emits', () => {
    expect(stripTags('<em>Rock&nbsp;&amp;&nbsp;Roll</em> it&#8217;s ')).toBe('Rock & Roll it’s');
  });

  it('decodes &amp; last so an escaped entity stays literal', () => {
    expect(stripTags('&amp;#8217; &amp;nbsp;')).toBe('&#8217; &nbsp;');
  });

  it('is linear on many unclosed tags', () => {
    expectFast(() => stripTags('<'.repeat(BIG)));
  });
});

describe('WordPress extractJsonLd', () => {
  it('finds every JSON-LD block and skips other scripts and malformed JSON', () => {
    const html = [
      '<p>Intro</p>',
      '<script type="application/ld+json">{"@type":"Article"}</script>',
      '<script>var x = 1;</script>',
      "<SCRIPT data-x='1' type='application/ld+json' id=\"faq\">\n {\"@type\":\"FAQPage\"} \n</SCRIPT>",
      '<script type="application/ld+json">{broken</script>',
      '<script data-type="application/ld+json">{"@type":"Odd"}</script>',
    ].join('\n');
    expect(extractJsonLd(html)).toEqual([{ '@type': 'Article' }, { '@type': 'FAQPage' }, { '@type': 'Odd' }]);
  });

  it('agrees with the regex it replaced', () => {
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    const html =
      '<script type="application/ld+json">1</script><script type="text/javascript">2</script>' +
      '<script <script type="application/ld+json">3</script><script type="application/ld+json">[4]</script>' +
      '<script type="application/ld+json">5';
    const expected = [...html.matchAll(re)].flatMap((m) => {
      try {
        return [JSON.parse(m[1]!.trim()) as unknown];
      } catch {
        return [];
      }
    });
    expect(extractJsonLd(html)).toEqual(expected);
    expect(expected).toEqual([1, 3, [4]]);
  });

  it('is linear on unterminated script tags', () => {
    expectFast(() => expect(extractJsonLd('<script type=type='.repeat(BIG / 18))).toEqual([]));
    expectFast(() => expect(extractJsonLd('<script type="application/ld+json">'.repeat(BIG / 36))).toEqual([]));
  });
});

describe('Shopify nextPageInfo', () => {
  it('reads page_info from the rel="next" link', () => {
    const header =
      '<https://shop.myshopify.com/admin/api/2024-01/articles.json?limit=50&page_info=prev123>; rel="previous", ' +
      '<https://shop.myshopify.com/admin/api/2024-01/articles.json?limit=50&page_info=abc%3D>; rel="next"';
    expect(nextPageInfo(header)).toBe('abc=');
    expect(nextPageInfo(null)).toBeUndefined();
  });

  it('is linear on a header full of unclosed brackets', () => {
    expectFast(() => expect(nextPageInfo(`${'<'.repeat(BIG)}; rel=next`)).toBeUndefined());
  });
});
