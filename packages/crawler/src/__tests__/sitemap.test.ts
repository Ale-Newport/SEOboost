/**
 * Sitemap parsing against the dialects that actually turn up in the wild: namespaced XML,
 * a single collapsed `<url>`, an index that nests, the plain-text variant, and gzip served
 * from a `.xml` path. All pure — `discoverSitemaps` is the only part that needs a network.
 */

import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeSitemapBody, looksGzipped, parseSitemapXml } from '../sitemap';

const SOURCE = 'https://example.com/sitemap.xml';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2024-01-15</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/blog/post</loc>
    <lastmod>2024-02-01T09:30:00+00:00</lastmod>
  </url>
  <url>
    <loc>not a url</loc>
  </url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap>
    <loc>https://example.com/sitemap-posts.xml</loc>
    <lastmod>2024-02-01</lastmod>
  </sitemap>
  <sitemap>
    <loc>/sitemap-pages.xml</loc>
  </sitemap>
</sitemapindex>`;

describe('parseSitemapXml — urlset', () => {
  const parsed = parseSitemapXml(URLSET, SOURCE);

  it('recognises a urlset document', () => {
    expect(parsed.kind).toBe('urlset');
    expect(parsed.sitemaps).toEqual([]);
  });

  it('keeps every entry that normalises to a real URL', () => {
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((entry) => entry.normalizedLoc)).toEqual([
      'https://example.com/',
      'https://example.com/blog/post',
    ]);
  });

  it('carries lastmod, changefreq and priority through', () => {
    const [home, post] = parsed.entries;
    expect(home?.lastmod).toBe('2024-01-15');
    expect(home?.changefreq).toBe('daily');
    expect(home?.priority).toBe(1);
    expect(post?.changefreq).toBeNull();
    expect(post?.priority).toBeNull();
  });

  it('records which document each entry came from', () => {
    expect(parsed.entries.every((entry) => entry.source === SOURCE)).toBe(true);
  });

  it('handles a urlset with a single <url> that the parser collapses to an object', () => {
    const single = parseSitemapXml(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/only</loc></url></urlset>',
      SOURCE,
    );
    expect(single.entries).toHaveLength(1);
    expect(single.entries[0]?.loc).toBe('https://example.com/only');
  });

  it('strips namespace prefixes so <sitemap:urlset> parses the same way', () => {
    const prefixed = parseSitemapXml(
      '<sitemap:urlset xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap:url><sitemap:loc>https://example.com/ns</sitemap:loc></sitemap:url></sitemap:urlset>',
      SOURCE,
    );
    expect(prefixed.kind).toBe('urlset');
    expect(prefixed.entries[0]?.loc).toBe('https://example.com/ns');
  });
});

describe('parseSitemapXml — sitemap index', () => {
  const parsed = parseSitemapXml(SITEMAP_INDEX, SOURCE);

  it('returns child documents rather than entries', () => {
    expect(parsed.kind).toBe('index');
    expect(parsed.entries).toEqual([]);
  });

  it('resolves relative child locations against the index URL', () => {
    expect(parsed.sitemaps).toEqual([
      'https://example.com/sitemap-posts.xml',
      'https://example.com/sitemap-pages.xml',
    ]);
  });
});

describe('parseSitemapXml — other shapes', () => {
  it('reads the plain-text variant and ignores comments', () => {
    const parsed = parseSitemapXml(
      ['# generated', 'https://example.com/a', '', 'https://example.com/b'].join('\n'),
      SOURCE,
    );
    expect(parsed.kind).toBe('text');
    expect(parsed.entries.map((entry) => entry.loc)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('reports an HTML soft-404 as unknown instead of inventing entries', () => {
    const parsed = parseSitemapXml('<html><body><h1>Not found</h1></body></html>', SOURCE);
    expect(parsed.kind).toBe('unknown');
    expect(parsed.entries).toEqual([]);
  });

  it('treats an empty document as unknown', () => {
    expect(parseSitemapXml('   ', SOURCE).kind).toBe('unknown');
  });
});

describe('gzip handling', () => {
  it('detects gzip from the bytes, not the file extension', () => {
    const gzipped = new Uint8Array(gzipSync(Buffer.from(URLSET, 'utf8')));
    expect(looksGzipped(gzipped)).toBe(true);
    expect(looksGzipped(new Uint8Array([0x3c, 0x3f, 0x78]))).toBe(false);
    expect(looksGzipped(null)).toBe(false);
  });

  it('gunzips a compressed body and parses it', () => {
    const gzipped = new Uint8Array(gzipSync(Buffer.from(URLSET, 'utf8')));
    const xml = decodeSitemapBody(gzipped, null);
    expect(xml).not.toBeNull();
    expect(parseSitemapXml(xml ?? '', SOURCE).entries).toHaveLength(2);
  });

  it('passes plain bodies through untouched', () => {
    expect(decodeSitemapBody(null, URLSET)).toBe(URLSET);
  });

  it('returns null rather than throwing on a corrupt gzip body', () => {
    // Gzip magic followed by garbage: the shape says compressed, the content is not.
    const corrupt = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);
    expect(decodeSitemapBody(corrupt, null)).toBeNull();
  });
});
