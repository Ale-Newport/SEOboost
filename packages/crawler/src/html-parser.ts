/**
 * HTML → `PageAnalysis`.
 *
 * Everything here is pure and synchronous: given the same bytes it always produces the same
 * analysis, which is what makes the SEO rules downstream testable and re-runnable without a
 * network. All URL-shaped values come out absolute so no consumer has to know the base.
 */

import { countWords, normalizeUrl, resolveUrl, truncate, urlDepth, isSameSite, type DiscoveredLink, type HeadingNode, type ImageInfo, type StructuredDataBlock } from '@seo/shared';
import { contentHash as hashContent, simhash } from '@seo/shared/hash';
import { load, type CheerioAPI } from 'cheerio';
import type { HreflangAlternate, PageAnalysis } from './types';

/**
 * Chrome-style limit on stored body text. Real pages never approach it; the cap exists so a
 * single runaway document cannot bloat a crawl's memory or its database row.
 */
const MAX_TEXT_LENGTH = 200_000;

/** Removed before text extraction: chrome, boilerplate and non-prose nodes. */
const NOISE_SELECTOR = [
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'svg',
  'canvas',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[aria-hidden="true"]',
].join(', ');

const NAV_SELECTOR = 'nav, [role="navigation"]';
const FOOTER_SELECTOR = 'footer, [role="contentinfo"]';
const HEADER_SELECTOR = 'header, [role="banner"]';
const MAIN_SELECTOR = 'main, article, [role="main"]';

/** Link relations that stop equity flowing, per Google's link-attribute guidance. */
const NOFOLLOW_RELS = new Set(['nofollow', 'ugc', 'sponsored']);

export interface HtmlAnalysisInput {
  /** URL that served this HTML (post-redirect). Used as the base for relative URLs. */
  url: string;
  html: string;
  /** Bare domain of the site being crawled; drives internal/external link classification. */
  siteDomain: string;
  /** URL originally requested, when it differs from `url`. */
  requestedUrl?: string;
  depth?: number;
  statusCode?: number | null;
  contentType?: string | null;
  /** Lower-cased response headers; `x-robots-tag` is read from here. */
  headers?: Record<string, string>;
  responseTimeMs?: number | null;
  contentBytes?: number | null;
  redirectChain?: string[];
  redirectTarget?: string | null;
  /** Result of robots.txt evaluation for this URL. Defaults to allowed. */
  robotsAllowed?: boolean;
  rendered?: boolean;
  inSitemap?: boolean;
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function attrOrNull($: CheerioAPI, selector: string, attribute: string): string | null {
  const value = $(selector).first().attr(attribute);
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIntOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const num = Number.parseInt(value.trim(), 10);
  return Number.isFinite(num) ? num : null;
}

/** `<base href>` wins over the response URL for every relative reference on the page. */
export function resolveBaseUrl($: CheerioAPI, documentUrl: string): string {
  const baseHref = $('base[href]').first().attr('href');
  if (!baseHref) return documentUrl;
  return resolveUrl(documentUrl, baseHref) ?? documentUrl;
}

/** h1..h6 in document order — heading *sequence* is what the structure rules judge. */
export function extractHeadings($: CheerioAPI): HeadingNode[] {
  const headings: HeadingNode[] = [];
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const tag = $(el).prop('tagName');
    const level = Number.parseInt(String(tag ?? 'h6').slice(1), 10);
    const text = collapseWhitespace($(el).text());
    if (!Number.isFinite(level)) return;
    headings.push({ level, text });
  });
  return headings;
}

/**
 * Main body text: strip chrome, then prefer `<main>`/`<article>` when the document marks it.
 * Falls back to the whole body so templates without landmarks still produce a word count.
 */
export function extractMainText($: CheerioAPI): string {
  const root = $.root().clone();
  root.find(NOISE_SELECTOR).remove();

  const main = root.find('main').first();
  const article = root.find('article').first();
  const body = root.find('body').first();
  const scope = main.length > 0 ? main : article.length > 0 ? article : body;

  // `root` is the document itself; only fall back to it when the markup has no <body>.
  return collapseWhitespace(scope.length > 0 ? scope.text() : root.text());
}

export function extractLinks($: CheerioAPI, baseUrl: string, siteDomain: string): DiscoveredLink[] {
  const links: DiscoveredLink[] = [];

  $('a').each((index, el) => {
    const node = $(el);
    const href = node.attr('href');
    if (href === undefined) return;

    const absolute = resolveUrl(baseUrl, href);
    if (!absolute) return; // mailto:, tel:, javascript:, bare fragments

    const rel = node.attr('rel')?.trim().toLowerCase() ?? null;
    const relTokens = rel ? rel.split(/\s+/) : [];
    const inNav = node.closest(NAV_SELECTOR).length > 0 || node.closest(HEADER_SELECTOR).length > 0;
    const inFooter = node.closest(FOOTER_SELECTOR).length > 0;
    const explicitMain = node.closest(MAIN_SELECTOR).length > 0;

    // An anchor counts as content when it is inside a main landmark, or — for templates with
    // no landmarks at all — when it is simply not part of the chrome.
    const inMainContent = explicitMain || (!inNav && !inFooter && node.closest('aside').length === 0);

    const anchorText =
      collapseWhitespace(node.text()) ||
      collapseWhitespace(node.find('img[alt]').first().attr('alt') ?? '') ||
      collapseWhitespace(node.attr('aria-label') ?? '') ||
      collapseWhitespace(node.attr('title') ?? '');

    links.push({
      href: absolute,
      normalized: normalizeUrl(absolute) ?? absolute,
      anchorText,
      rel,
      isInternal: isSameSite(absolute, siteDomain),
      isNofollow: relTokens.some((token) => NOFOLLOW_RELS.has(token)),
      inNav,
      inFooter,
      inMainContent,
      position: index,
    });
  });

  return links;
}

export interface ImageExtraction {
  images: ImageInfo[];
  missingAlt: number;
}

/**
 * Images plus an accessibility/SEO count. `alt=""` is the correct marker for decorative
 * images, so it only counts as missing when the image is *not* also flagged decorative —
 * otherwise every icon set in the world reports as an error.
 */
export function extractImages($: CheerioAPI, baseUrl: string): ImageExtraction {
  const images: ImageInfo[] = [];
  let missingAlt = 0;

  $('img').each((_, el) => {
    const node = $(el);
    const rawSrc =
      node.attr('src') ??
      node.attr('data-src') ??
      node.attr('data-lazy-src') ??
      (node.attr('srcset') ?? node.attr('data-srcset'))?.split(',')[0]?.trim().split(/\s+/)[0];
    if (!rawSrc) return;

    const absolute = resolveUrl(baseUrl, rawSrc);
    if (!absolute) return;

    const altAttr = node.attr('alt');
    const decorative =
      node.attr('aria-hidden') === 'true' ||
      node.attr('role') === 'presentation' ||
      node.attr('role') === 'none';

    if ((altAttr === undefined || altAttr.trim().length === 0) && !decorative) missingAlt += 1;

    images.push({
      src: absolute,
      alt: altAttr === undefined ? null : altAttr,
      width: toIntOrNull(node.attr('width')),
      height: toIntOrNull(node.attr('height')),
      loading: node.attr('loading') ?? null,
    });
  });

  return { images, missingAlt };
}

function cleanSchemaType(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // `https://schema.org/Article` and `schema:Article` both mean `Article`.
  const afterSlash = trimmed.split(/[/#]/).pop() ?? trimmed;
  return afterSlash.split(':').pop() ?? afterSlash;
}

function collectSchemaTypes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) collectSchemaTypes(item, out, depth + 1);
    return;
  }

  const record = node as Record<string, unknown>;
  const type = record['@type'];
  if (typeof type === 'string') {
    const cleaned = cleanSchemaType(type);
    if (cleaned) out.add(cleaned);
  } else if (Array.isArray(type)) {
    for (const item of type) {
      if (typeof item !== 'string') continue;
      const cleaned = cleanSchemaType(item);
      if (cleaned) out.add(cleaned);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === '@type' || key === '@context' || key === '@id') continue;
    if (value !== null && typeof value === 'object') collectSchemaTypes(value, out, depth + 1);
  }
}

/** Strip the comment/CDATA wrappers some CMSs put around inline JSON-LD. */
function unwrapJsonLd(raw: string): string {
  return raw
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .replace(/^\/\/\s*<!\[CDATA\[/, '')
    .replace(/\/\/\s*\]\]>$/, '')
    .replace(/^<!\[CDATA\[/, '')
    .replace(/\]\]>$/, '')
    .trim();
}

export interface StructuredDataExtraction {
  blocks: StructuredDataBlock[];
  /** Union of JSON-LD `@type`s, microdata `itemtype`s and RDFa `typeof`s. */
  schemaTypes: string[];
}

/**
 * `blocks` covers JSON-LD only — those are the blocks a validator can act on. Microdata and
 * RDFa still contribute to `schemaTypes` so "does this page declare a Product?" stays answerable
 * for sites that never adopted JSON-LD.
 */
export function extractStructuredData($: CheerioAPI): StructuredDataExtraction {
  const blocks: StructuredDataBlock[] = [];
  const types = new Set<string>();

  $('script[type="application/ld+json"], script[type="application/ld+json; charset=utf-8"]').each((_, el) => {
    const raw = unwrapJsonLd($(el).text());
    if (!raw) return;

    try {
      const parsed: unknown = JSON.parse(raw);
      const blockTypes = new Set<string>();
      collectSchemaTypes(parsed, blockTypes);
      for (const type of blockTypes) types.add(type);
      blocks.push({ type: [...blockTypes], raw: parsed, valid: true });
    } catch (err) {
      blocks.push({
        type: [],
        raw: truncate(raw, 2000),
        valid: false,
        errors: [err instanceof Error ? err.message : 'Invalid JSON-LD'],
      });
    }
  });

  $('[itemtype]').each((_, el) => {
    const itemtype = $(el).attr('itemtype');
    if (!itemtype) return;
    for (const part of itemtype.split(/\s+/)) {
      const cleaned = cleanSchemaType(part);
      if (cleaned) types.add(cleaned);
    }
  });

  $('[typeof]').each((_, el) => {
    const typeOf = $(el).attr('typeof');
    if (!typeOf) return;
    for (const part of typeOf.split(/\s+/)) {
      const cleaned = cleanSchemaType(part);
      if (cleaned) types.add(cleaned);
    }
  });

  return { blocks, schemaTypes: [...types].sort() };
}

export function extractHreflang($: CheerioAPI, baseUrl: string): HreflangAlternate[] {
  const alternates: HreflangAlternate[] = [];
  $('link[rel~="alternate"][hreflang]').each((_, el) => {
    const node = $(el);
    const hreflang = node.attr('hreflang')?.trim();
    const href = node.attr('href')?.trim();
    if (!hreflang || !href) return;
    const absolute = resolveUrl(baseUrl, href);
    if (!absolute) return;
    alternates.push({ hreflang, href: absolute });
  });
  return alternates;
}

const SOCIAL_META_PREFIXES = ['og:', 'twitter:', 'article:', 'profile:', 'product:', 'fb:'];

/** Open Graph, Twitter cards and their siblings, keyed by the property as authored. */
export function extractSocialMeta($: CheerioAPI): Record<string, string> {
  const out: Record<string, string> = {};
  $('meta').each((_, el) => {
    const node = $(el);
    // OG uses `property`, Twitter uses `name`, and plenty of sites mix the two up.
    const key = (node.attr('property') ?? node.attr('name') ?? '').trim().toLowerCase();
    if (!key || !SOCIAL_META_PREFIXES.some((prefix) => key.startsWith(prefix))) return;
    const content = node.attr('content');
    if (content === undefined) return;
    const value = collapseWhitespace(content);
    if (!value || out[key] !== undefined) return; // first declaration wins, as crawlers do
    out[key] = value;
  });
  return out;
}

export interface IndexabilityInput {
  url: string;
  statusCode: number | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  canonicalUrl: string | null;
  robotsAllowed: boolean;
  error?: string | null;
}

export interface IndexabilityVerdict {
  isIndexable: boolean;
  indexabilityReason: string;
}

function hasNoindex(directives: string | null): boolean {
  if (!directives) return false;
  // `none` is shorthand for `noindex, nofollow`.
  return /\bnoindex\b/i.test(directives) || /\bnone\b/i.test(directives);
}

/**
 * First blocking condition wins, in the order a search engine would hit them: it can't fetch
 * it, it was told not to fetch it, it was told not to index it, or it was told to index a
 * different URL instead.
 */
export function computeIndexability(input: IndexabilityInput): IndexabilityVerdict {
  if (input.error) return { isIndexable: false, indexabilityReason: `Request failed: ${input.error}` };
  if (input.statusCode === null) return { isIndexable: false, indexabilityReason: 'No response' };
  if (input.statusCode >= 400) {
    return { isIndexable: false, indexabilityReason: `HTTP ${input.statusCode}` };
  }
  if (input.statusCode >= 300) {
    return { isIndexable: false, indexabilityReason: `Redirect (HTTP ${input.statusCode})` };
  }
  if (!input.robotsAllowed) {
    return { isIndexable: false, indexabilityReason: 'Blocked by robots.txt' };
  }
  if (hasNoindex(input.robotsMeta)) {
    return { isIndexable: false, indexabilityReason: 'noindex in meta robots' };
  }
  if (hasNoindex(input.xRobotsTag)) {
    return { isIndexable: false, indexabilityReason: 'noindex in X-Robots-Tag' };
  }
  if (input.canonicalUrl) {
    const canonical = normalizeUrl(input.canonicalUrl);
    const self = normalizeUrl(input.url);
    if (canonical && self && canonical !== self) {
      return { isIndexable: false, indexabilityReason: `Canonicalised to ${input.canonicalUrl}` };
    }
  }
  return { isIndexable: true, indexabilityReason: 'Indexable' };
}

/** Meta robots plus the `googlebot` variant, joined so a rule can grep one string. */
function readRobotsMeta($: CheerioAPI): string | null {
  const values: string[] = [];
  $('meta[name]').each((_, el) => {
    const name = $(el).attr('name')?.trim().toLowerCase();
    if (name !== 'robots' && name !== 'googlebot' && name !== 'bingbot') return;
    const content = $(el).attr('content');
    if (!content) return;
    values.push(name === 'robots' ? content.trim() : `${name}: ${content.trim()}`);
  });
  return values.length > 0 ? values.join(', ') : null;
}

/** Analyse a fetched HTML document into the row shape the crawl stores. */
export function analyzeHtml(input: HtmlAnalysisInput): PageAnalysis {
  const $ = load(input.html);
  const documentUrl = input.url;
  const baseUrl = resolveBaseUrl($, documentUrl);
  const requestedUrl = input.requestedUrl ?? documentUrl;

  const title = collapseWhitespace($('title').first().text()) || null;
  const metaDescription =
    collapseWhitespace($('meta[name="description"]').first().attr('content') ?? '') ||
    collapseWhitespace($('meta[property="og:description"]').first().attr('content') ?? '') ||
    null;

  const canonicalHref = attrOrNull($, 'link[rel~="canonical"]', 'href');
  const canonicalUrl = canonicalHref ? resolveUrl(baseUrl, canonicalHref) : null;

  const headings = extractHeadings($);
  const h1 = headings.filter((heading) => heading.level === 1).map((heading) => heading.text);

  const text = extractMainText($);
  const storedText = text.length > MAX_TEXT_LENGTH ? truncate(text, MAX_TEXT_LENGTH, '') : text;

  const links = extractLinks($, baseUrl, input.siteDomain);
  const { images, missingAlt } = extractImages($, baseUrl);
  const { blocks, schemaTypes } = extractStructuredData($);

  const robotsMeta = readRobotsMeta($);
  const xRobotsTag = input.headers?.['x-robots-tag'] ?? null;
  const statusCode = input.statusCode ?? null;

  const { isIndexable, indexabilityReason } = computeIndexability({
    url: documentUrl,
    statusCode,
    robotsMeta,
    xRobotsTag,
    canonicalUrl,
    robotsAllowed: input.robotsAllowed ?? true,
  });

  return {
    url: requestedUrl,
    normalizedUrl: normalizeUrl(requestedUrl) ?? requestedUrl,
    statusCode,
    contentType: input.contentType ?? null,
    redirectTarget: input.redirectTarget ?? null,
    redirectChain: input.redirectChain ?? [],
    depth: input.depth ?? urlDepth(requestedUrl),
    responseTimeMs: input.responseTimeMs ?? null,
    contentBytes: input.contentBytes ?? null,
    error: null,

    title,
    titleLength: title === null ? null : title.length,
    metaDescription,
    metaDescriptionLength: metaDescription === null ? null : metaDescription.length,
    canonicalUrl,
    robotsMeta,
    xRobotsTag,
    metaViewport: attrOrNull($, 'meta[name="viewport"]', 'content'),
    lang: attrOrNull($, 'html', 'lang'),
    h1,
    headings,
    wordCount: countWords(storedText),
    textContent: storedText || null,
    contentHash: storedText ? hashContent(storedText) : null,
    simhash: storedText ? simhash(storedText) : null,

    links,
    images,
    imagesMissingAlt: missingAlt,
    schemaTypes,
    structuredData: blocks,
    hreflang: extractHreflang($, baseUrl),
    openGraph: extractSocialMeta($),

    isIndexable,
    indexabilityReason,

    inSitemap: input.inSitemap ?? false,
    rendered: input.rendered ?? false,
  };
}

export interface NonHtmlPageInput {
  url: string;
  normalizedUrl?: string;
  depth: number;
  statusCode: number | null;
  contentType: string | null;
  responseTimeMs?: number | null;
  contentBytes?: number | null;
  redirectChain?: string[];
  redirectTarget?: string | null;
  error?: string | null;
  inSitemap?: boolean;
  /** Overrides the derived reason, e.g. "Blocked by robots.txt". */
  indexabilityReason?: string;
}

/**
 * A `PageAnalysis` for something we could not parse — a failed request, a redirect off-site,
 * or a non-HTML response. Recorded rather than dropped so the audit can show broken links and
 * asset problems instead of a silent gap.
 */
export function emptyPageAnalysis(input: NonHtmlPageInput): PageAnalysis {
  const verdict = computeIndexability({
    url: input.url,
    statusCode: input.statusCode,
    robotsMeta: null,
    xRobotsTag: null,
    canonicalUrl: null,
    robotsAllowed: true,
    error: input.error ?? null,
  });

  const nonHtml = Boolean(input.contentType && !/html/i.test(input.contentType));
  const reason =
    input.indexabilityReason ??
    (verdict.isIndexable && nonHtml ? `Non-HTML content type: ${input.contentType}` : verdict.indexabilityReason);
  const isIndexable = input.indexabilityReason === undefined && verdict.isIndexable && !nonHtml;

  return {
    url: input.url,
    normalizedUrl: input.normalizedUrl ?? normalizeUrl(input.url) ?? input.url,
    statusCode: input.statusCode,
    contentType: input.contentType,
    redirectTarget: input.redirectTarget ?? null,
    redirectChain: input.redirectChain ?? [],
    depth: input.depth,
    responseTimeMs: input.responseTimeMs ?? null,
    contentBytes: input.contentBytes ?? null,
    error: input.error ?? null,

    title: null,
    titleLength: null,
    metaDescription: null,
    metaDescriptionLength: null,
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    metaViewport: null,
    lang: null,
    h1: [],
    headings: [],
    wordCount: 0,
    textContent: null,
    contentHash: null,
    simhash: null,

    links: [],
    images: [],
    imagesMissingAlt: 0,
    schemaTypes: [],
    structuredData: [],
    hreflang: [],
    openGraph: {},

    isIndexable,
    indexabilityReason: reason,

    inSitemap: input.inSitemap ?? false,
    rendered: false,
  };
}
