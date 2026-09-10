/**
 * Sitemap discovery and parsing.
 *
 * Sitemaps are the cheapest signal we get about what a site *thinks* its pages are, so we
 * expand indexes recursively — but under hard caps, because a misconfigured index can point
 * at itself or fan out to millions of URLs and take the whole crawl down with it.
 */

import { createLogger, errorMessage, normalizeUrl } from '@seo/shared';
import { XMLParser } from 'fast-xml-parser';
import { gunzipSync } from 'node:zlib';
import { createFetcher, type Fetcher } from './fetcher';
import type { SitemapEntry, SitemapResult } from './types';

const log = createLogger('crawler:sitemap');

export const DEFAULT_MAX_SITEMAP_URLS = 50_000;
export const DEFAULT_MAX_SITEMAP_DOCUMENTS = 50;
export const DEFAULT_MAX_SITEMAP_DEPTH = 3;

/** Well-known locations tried when robots.txt names no sitemap. */
export const SITEMAP_FALLBACK_PATHS = ['/sitemap.xml', '/sitemap_index.xml'] as const;

export interface DiscoverSitemapsOptions {
  fetcher?: Fetcher;
  signal?: AbortSignal;
  userAgent?: string;
  /** Sitemap URLs harvested from robots.txt; tried before the well-known fallbacks. */
  robotsSitemaps?: string[];
  maxUrls?: number;
  maxDocuments?: number;
  /** How deep sitemap indexes may nest. */
  maxDepth?: number;
}

export type SitemapKind = 'index' | 'urlset' | 'text' | 'unknown';

export interface ParsedSitemap {
  kind: SitemapKind;
  entries: SitemapEntry[];
  /** Child sitemap documents referenced by a `<sitemapindex>`. */
  sitemaps: string[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  // Sitemaps are namespaced (`<sitemap:urlset>`, `<xhtml:link>`); stripping prefixes lets one
  // set of lookups handle every dialect in the wild.
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Normalise fast-xml-parser's "one child collapses to an object" behaviour into a list. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  const record = asRecord(value);
  if (record && typeof record['#text'] === 'string') return record['#text'].trim() || null;
  return null;
}

function toPriority(value: unknown): number | null {
  const text = asText(value);
  if (text === null) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** True when the bytes carry the gzip magic number, regardless of what the server claimed. */
export function looksGzipped(bytes: Uint8Array | null): boolean {
  return Boolean(bytes && bytes.length > 2 && bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]);
}

/**
 * Turn a sitemap response into text, transparently gunzipping `.xml.gz` documents.
 * Gzip is detected from the bytes rather than the URL because plenty of servers hand back a
 * gzipped body from a plain `.xml` path.
 */
export function decodeSitemapBody(rawBody: Uint8Array | null, body: string | null): string | null {
  if (looksGzipped(rawBody) && rawBody) {
    try {
      return gunzipSync(Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)).toString('utf8');
    } catch (err) {
      log.warn('failed to gunzip sitemap', { error: errorMessage(err) });
      return null;
    }
  }
  return body;
}

function buildEntry(loc: string, source: string, raw: Record<string, unknown> | null): SitemapEntry | null {
  const trimmed = loc.trim();
  if (!trimmed) return null;
  const normalized = normalizeUrl(trimmed);
  if (!normalized) return null;
  return {
    loc: trimmed,
    normalizedLoc: normalized,
    lastmod: raw ? asText(raw['lastmod']) : null,
    changefreq: raw ? asText(raw['changefreq']) : null,
    priority: raw ? toPriority(raw['priority']) : null,
    source,
  };
}

/**
 * Parse one sitemap document. Handles `<urlset>`, `<sitemapindex>` and the plain-text
 * variant (one URL per line) that the protocol also permits.
 */
export function parseSitemapXml(xml: string, sourceUrl: string): ParsedSitemap {
  const trimmed = xml.trim();
  if (!trimmed) return { kind: 'unknown', entries: [], sitemaps: [] };

  if (!trimmed.startsWith('<')) {
    const entries: SitemapEntry[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const value = line.trim();
      if (!value || value.startsWith('#')) continue;
      const entry = buildEntry(value, sourceUrl, null);
      if (entry) entries.push(entry);
    }
    return { kind: entries.length > 0 ? 'text' : 'unknown', entries, sitemaps: [] };
  }

  // XMLParser is typed as returning `any`; funnel it through `unknown` and narrow explicitly.
  const parsed: unknown = parser.parse(trimmed);
  const doc = asRecord(parsed);
  if (!doc) return { kind: 'unknown', entries: [], sitemaps: [] };

  const index = asRecord(doc['sitemapindex']);
  if (index) {
    const sitemaps: string[] = [];
    for (const node of asArray(index['sitemap'])) {
      const record = asRecord(node);
      const loc = asText(record ? record['loc'] : node);
      if (!loc) continue;
      try {
        sitemaps.push(new URL(loc, sourceUrl).toString());
      } catch {
        // Unresolvable child sitemap reference; nothing useful to do with it.
      }
    }
    return { kind: 'index', entries: [], sitemaps };
  }

  const urlset = asRecord(doc['urlset']);
  if (urlset) {
    const entries: SitemapEntry[] = [];
    for (const node of asArray(urlset['url'])) {
      const record = asRecord(node);
      const loc = asText(record ? record['loc'] : node);
      if (!loc) continue;
      const entry = buildEntry(loc, sourceUrl, record);
      if (entry) entries.push(entry);
    }
    return { kind: 'urlset', entries, sitemaps: [] };
  }

  return { kind: 'unknown', entries: [], sitemaps: [] };
}

/**
 * Walk every sitemap reachable from robots.txt plus the well-known fallbacks, expanding
 * indexes breadth-first. Stops at the first cap hit and reports `truncated: true` rather
 * than pretending the list is complete.
 */
export async function discoverSitemaps(
  origin: string,
  options: DiscoverSitemapsOptions = {},
): Promise<SitemapResult> {
  const maxUrls = options.maxUrls ?? DEFAULT_MAX_SITEMAP_URLS;
  const maxDocuments = options.maxDocuments ?? DEFAULT_MAX_SITEMAP_DOCUMENTS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_SITEMAP_DEPTH;
  const fetcher = options.fetcher ?? createFetcher({ userAgent: options.userAgent });

  const result: SitemapResult = { sitemapUrls: [], entries: [], errors: [], truncated: false };

  let base: string;
  try {
    base = new URL(/^[a-z][a-z0-9+.-]*:/i.test(origin) ? origin : `https://${origin}`).origin;
  } catch {
    result.errors.push({ url: origin, error: 'Invalid origin' });
    return result;
  }

  const seen = new Set<string>();
  const queue: Array<{ url: string; depth: number }> = [];
  const enqueue = (url: string, depth: number) => {
    const key = normalizeUrl(url) ?? url;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ url, depth });
  };

  for (const url of options.robotsSitemaps ?? []) enqueue(url, 0);
  // Fallbacks are always tried: robots.txt frequently lists only one of several sitemaps.
  for (const path of SITEMAP_FALLBACK_PATHS) enqueue(`${base}${path}`, 0);

  const seenEntries = new Set<string>();
  let documentsFetched = 0;

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      result.truncated = true;
      break;
    }
    if (documentsFetched >= maxDocuments || result.entries.length >= maxUrls) {
      result.truncated = true;
      break;
    }

    const next = queue.shift();
    if (!next) break;

    documentsFetched += 1;
    const response = await fetcher.fetchPage(next.url, {
      signal: options.signal,
      acceptText: true,
      acceptAny: true,
      raw: true,
    });

    if (response.error !== null) {
      result.errors.push({ url: next.url, error: response.error });
      continue;
    }
    if (response.statusCode === null || response.statusCode >= 400) {
      // A missing fallback path is the normal case, not an error worth surfacing.
      if (!next.url.startsWith(base) || response.statusCode !== 404) {
        result.errors.push({ url: next.url, error: `HTTP ${response.statusCode ?? 'no response'}` });
      }
      continue;
    }

    const xml = decodeSitemapBody(response.rawBody, response.body);
    if (!xml) {
      result.errors.push({ url: next.url, error: 'Empty or undecodable sitemap body' });
      continue;
    }

    let parsed: ParsedSitemap;
    try {
      parsed = parseSitemapXml(xml, response.finalUrl);
    } catch (err) {
      result.errors.push({ url: next.url, error: errorMessage(err) });
      continue;
    }

    if (parsed.kind === 'unknown') {
      result.errors.push({ url: next.url, error: 'Not a recognisable sitemap document' });
      continue;
    }

    result.sitemapUrls.push(response.finalUrl);

    for (const entry of parsed.entries) {
      if (result.entries.length >= maxUrls) {
        result.truncated = true;
        break;
      }
      if (seenEntries.has(entry.normalizedLoc)) continue;
      seenEntries.add(entry.normalizedLoc);
      result.entries.push(entry);
    }

    if (next.depth < maxDepth) {
      for (const child of parsed.sitemaps) enqueue(child, next.depth + 1);
    } else if (parsed.sitemaps.length > 0) {
      result.truncated = true;
    }
  }

  log.debug('sitemap discovery finished', {
    origin: base,
    documents: result.sitemapUrls.length,
    urls: result.entries.length,
    truncated: result.truncated,
  });

  return result;
}
