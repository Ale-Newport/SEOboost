/**
 * CMS fingerprinting from a single response.
 *
 * Detection drives which CMS adapter can later *write* to a site, so a wrong answer is worse
 * than no answer: every verdict is the sum of independently weighted fingerprints, and the
 * matched fingerprints travel with the result so a human can audit the call. Nothing here
 * makes a network request — it reads only what the crawler already fetched.
 */

import { round } from '@seo/shared';
import type { CmsDetection, DetectedCms } from './types';

/**
 * Minimum summed weight before we name a CMS. One weak fingerprint (a `shopify-section`
 * class on an otherwise bespoke page, say) is a coincidence; 0.4 requires either one strong
 * signal or two corroborating weak ones.
 */
export const CMS_CONFIDENCE_THRESHOLD = 0.4;

/** Confidence attached to a CUSTOM verdict — it is the absence of evidence, never proof. */
const CUSTOM_CONFIDENCE = 0.2;

/**
 * Only the first megabyte is lower-cased for matching. Platform fingerprints live in the head
 * and in asset URLs near it; scanning further would double the memory cost of every page for
 * no additional recall.
 */
const MAX_SCAN_BYTES = 1_000_000;

interface DetectionContext {
  /** Original casing — needed for `__NEXT_DATA__` and friends. */
  html: string;
  /** Lower-cased copy of the scanned prefix, for case-insensitive fingerprints. */
  lower: string;
  headers: Record<string, string>;
  url: string;
  /** Lower-cased `<meta name="generator">` contents, in document order. */
  generators: string[];
}

interface CmsSignal {
  cms: DetectedCms;
  /** Stable identifier reported in `signals[]`. */
  id: string;
  /** What this fingerprint alone is worth, 0-1. */
  weight: number;
  match: (ctx: DetectionContext) => boolean;
}

/** Case-insensitive header lookup; the fetcher lower-cases keys but callers may not. */
function header(ctx: DetectionContext, name: string): string | null {
  const direct = ctx.headers[name];
  if (direct !== undefined) return direct.toLowerCase();
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (key.toLowerCase() === name) return value.toLowerCase();
  }
  return null;
}

function headerIncludes(ctx: DetectionContext, name: string, needle: string): boolean {
  const value = header(ctx, name);
  return value !== null && value.includes(needle);
}

/**
 * Vendor-owned hostnames are the strongest fingerprint there is: a site served from
 * `*.myshopify.com` cannot be anything but Shopify, whatever the markup claims.
 */
function hostEndsWith(ctx: DetectionContext, suffix: string): boolean {
  if (!ctx.url) return false;
  try {
    return new URL(ctx.url).hostname.toLowerCase().endsWith(suffix);
  } catch {
    return false;
  }
}

function generatorStartsWith(ctx: DetectionContext, prefix: string): boolean {
  return ctx.generators.some((value) => value.startsWith(prefix));
}

function generatorIncludes(ctx: DetectionContext, needle: string): boolean {
  return ctx.generators.some((value) => value.includes(needle));
}

/**
 * Fingerprint table. Weights are calibrated so that a single vendor-controlled artefact
 * (a `<meta generator>`, a vendor-only response header) is enough on its own, while
 * conventions a developer could copy by hand (class names, folder paths) need corroboration.
 */
const CMS_SIGNALS: readonly CmsSignal[] = [
  // ── WordPress ────────────────────────────────────────────────────────────
  { cms: 'WORDPRESS', id: 'generator-wordpress', weight: 0.9, match: (c) => generatorStartsWith(c, 'wordpress') },
  { cms: 'WORDPRESS', id: 'wp-content', weight: 0.5, match: (c) => c.lower.includes('/wp-content/') },
  { cms: 'WORDPRESS', id: 'wp-includes', weight: 0.4, match: (c) => c.lower.includes('/wp-includes/') },
  { cms: 'WORDPRESS', id: 'wp-json', weight: 0.4, match: (c) => c.lower.includes('/wp-json') },
  {
    cms: 'WORDPRESS',
    id: 'wp-json-link-header',
    weight: 0.4,
    match: (c) => headerIncludes(c, 'link', '/wp-json/'),
  },
  {
    cms: 'WORDPRESS',
    id: 'wp-block-markup',
    weight: 0.2,
    match: (c) => c.lower.includes('wp-block-') || c.lower.includes('wp-emoji'),
  },

  // ── Shopify ──────────────────────────────────────────────────────────────
  { cms: 'SHOPIFY', id: 'x-shopid-header', weight: 0.9, match: (c) => header(c, 'x-shopid') !== null },
  {
    cms: 'SHOPIFY',
    id: 'x-shopify-stage-header',
    weight: 0.9,
    match: (c) => header(c, 'x-shopify-stage') !== null,
  },
  { cms: 'SHOPIFY', id: 'powered-by-shopify', weight: 0.6, match: (c) => headerIncludes(c, 'powered-by', 'shopify') },
  { cms: 'SHOPIFY', id: 'cdn-shopify', weight: 0.6, match: (c) => c.lower.includes('cdn.shopify.com') },
  { cms: 'SHOPIFY', id: 'shopify-theme-object', weight: 0.6, match: (c) => c.lower.includes('shopify.theme') },
  { cms: 'SHOPIFY', id: 'myshopify-domain', weight: 0.4, match: (c) => c.lower.includes('.myshopify.com') },
  { cms: 'SHOPIFY', id: 'shopify-section', weight: 0.3, match: (c) => c.lower.includes('shopify-section') },
  { cms: 'SHOPIFY', id: 'myshopify-host', weight: 0.9, match: (c) => hostEndsWith(c, '.myshopify.com') },

  // ── Webflow ──────────────────────────────────────────────────────────────
  { cms: 'WEBFLOW', id: 'generator-webflow', weight: 0.9, match: (c) => generatorIncludes(c, 'webflow') },
  { cms: 'WEBFLOW', id: 'data-wf-page', weight: 0.7, match: (c) => c.lower.includes('data-wf-page') },
  { cms: 'WEBFLOW', id: 'data-wf-site', weight: 0.7, match: (c) => c.lower.includes('data-wf-site') },
  {
    cms: 'WEBFLOW',
    id: 'website-files-cdn',
    weight: 0.4,
    match: (c) => c.lower.includes('website-files.com'),
  },
  { cms: 'WEBFLOW', id: 'webflow-js', weight: 0.3, match: (c) => c.lower.includes('webflow.js') },
  { cms: 'WEBFLOW', id: 'webflow-io-host', weight: 0.9, match: (c) => hostEndsWith(c, '.webflow.io') },

  // ── Next.js ──────────────────────────────────────────────────────────────
  {
    cms: 'NEXTJS',
    id: 'x-powered-by-next',
    weight: 0.9,
    match: (c) => headerIncludes(c, 'x-powered-by', 'next.js'),
  },
  { cms: 'NEXTJS', id: '__NEXT_DATA__', weight: 0.7, match: (c) => c.html.includes('__NEXT_DATA__') },
  { cms: 'NEXTJS', id: 'next-static-chunks', weight: 0.6, match: (c) => c.lower.includes('/_next/static') },
  // App Router streams RSC payloads into `self.__next_f`; no pages-router `__NEXT_DATA__` exists.
  { cms: 'NEXTJS', id: 'next-flight-payload', weight: 0.5, match: (c) => c.html.includes('__next_f') },
  {
    cms: 'NEXTJS',
    id: 'next-route-announcer',
    weight: 0.4,
    match: (c) => c.lower.includes('next-route-announcer'),
  },

  // ── Astro ────────────────────────────────────────────────────────────────
  { cms: 'ASTRO', id: 'generator-astro', weight: 0.9, match: (c) => generatorIncludes(c, 'astro') },
  { cms: 'ASTRO', id: 'astro-island', weight: 0.7, match: (c) => c.lower.includes('astro-island') },
  { cms: 'ASTRO', id: 'astro-assets', weight: 0.4, match: (c) => c.lower.includes('/_astro/') },
  { cms: 'ASTRO', id: 'data-astro-attr', weight: 0.4, match: (c) => c.lower.includes('data-astro-') },

  // ── Hugo ─────────────────────────────────────────────────────────────────
  // Hugo leaves nothing behind at runtime; the generator meta is the only honest signal.
  { cms: 'HUGO', id: 'generator-hugo', weight: 0.95, match: (c) => generatorIncludes(c, 'hugo') },

  // ── Ghost ────────────────────────────────────────────────────────────────
  { cms: 'GHOST', id: 'generator-ghost', weight: 0.95, match: (c) => generatorIncludes(c, 'ghost') },
  {
    cms: 'GHOST',
    id: 'ghost-cache-header',
    weight: 0.6,
    match: (c) => header(c, 'x-ghost-cache-status') !== null,
  },
  { cms: 'GHOST', id: 'ghost-api', weight: 0.5, match: (c) => c.lower.includes('/ghost/api/') },
  { cms: 'GHOST', id: 'ghost-sdk', weight: 0.3, match: (c) => c.lower.includes('ghost-sdk') },
  { cms: 'GHOST', id: 'ghost-io-host', weight: 0.9, match: (c) => hostEndsWith(c, '.ghost.io') },

  // ── Squarespace ──────────────────────────────────────────────────────────
  {
    cms: 'SQUARESPACE',
    id: 'generator-squarespace',
    weight: 0.95,
    match: (c) => generatorIncludes(c, 'squarespace'),
  },
  {
    cms: 'SQUARESPACE',
    id: 'squarespace-context',
    weight: 0.7,
    match: (c) => c.lower.includes('squarespace_context'),
  },
  {
    cms: 'SQUARESPACE',
    id: 'squarespace-cdn',
    weight: 0.6,
    match: (c) => c.lower.includes('static1.squarespace.com') || c.lower.includes('squarespace-cdn.com'),
  },
  {
    cms: 'SQUARESPACE',
    id: 'squarespace-host',
    weight: 0.9,
    match: (c) => hostEndsWith(c, '.squarespace.com'),
  },

  // ── Wix ──────────────────────────────────────────────────────────────────
  { cms: 'WIX', id: 'generator-wix', weight: 0.9, match: (c) => generatorIncludes(c, 'wix.com') },
  { cms: 'WIX', id: 'x-wix-request-id', weight: 0.8, match: (c) => header(c, 'x-wix-request-id') !== null },
  { cms: 'WIX', id: 'wixstatic-cdn', weight: 0.6, match: (c) => c.lower.includes('static.wixstatic.com') },
  { cms: 'WIX', id: 'wix-warmup-data', weight: 0.6, match: (c) => c.lower.includes('wix-warmup-data') },
  { cms: 'WIX', id: 'wixsite-host', weight: 0.9, match: (c) => hostEndsWith(c, '.wixsite.com') },
];

const META_TAG = /<meta\b[^>]*>/gi;
const META_NAME = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const META_CONTENT = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

/**
 * Read `<meta name="generator" content="…">` without a full DOM parse — detection runs on
 * every crawled page, so a regex over the head is worth the small loss of generality.
 * Attribute order is not assumed, since generators emit both orders.
 */
export function extractGenerators(html: string): string[] {
  const out: string[] = [];
  // Scan a bounded prefix: the generator meta is required to be inside <head>.
  const head = html.slice(0, 200_000);
  for (const tag of head.match(META_TAG) ?? []) {
    const nameMatch = META_NAME.exec(tag);
    const name = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? '').trim().toLowerCase();
    if (name !== 'generator') continue;
    const contentMatch = META_CONTENT.exec(tag);
    const content = (contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3] ?? '').trim().toLowerCase();
    if (content) out.push(content);
  }
  return out;
}

/** True when the payload is plausibly an HTML document rather than an empty or binary body. */
function looksLikeHtml(html: string): boolean {
  return /<\s*(?:!doctype\s+html|html|head|body|div|p|a|script|meta|title)\b/i.test(html.slice(0, 4000));
}

interface Match {
  cms: DetectedCms;
  id: string;
  weight: number;
}

/**
 * Identify the platform behind a response.
 *
 * Returns `UNKNOWN` only when there was nothing to look at (empty or non-HTML body) and
 * `CUSTOM` when a real document carried no recognised fingerprint — the two cases mean very
 * different things to a site owner, so they must not collapse into one value.
 *
 * `signals` lists every fingerprint that matched, `CMS:id` formatted and ordered with the
 * winning platform's first, so a headless setup (WordPress behind Next.js) stays visible
 * rather than being hidden behind a single label.
 */
export function detectCms(
  html: string | null,
  headers: Record<string, string> = {},
  url = '',
): CmsDetection {
  const source = html ?? '';
  if (!source.trim() || !looksLikeHtml(source)) {
    return { cms: 'UNKNOWN', confidence: 0, signals: [] };
  }

  const scanned = source.length > MAX_SCAN_BYTES ? source.slice(0, MAX_SCAN_BYTES) : source;
  const ctx: DetectionContext = {
    html: scanned,
    lower: scanned.toLowerCase(),
    headers,
    url,
    generators: extractGenerators(source),
  };

  const matches: Match[] = [];
  const scores = new Map<DetectedCms, number>();

  for (const signal of CMS_SIGNALS) {
    let matched = false;
    try {
      matched = signal.match(ctx);
    } catch {
      // A malformed header or pathological body must never take a crawl down over
      // fingerprinting; a signal that throws simply did not match.
      matched = false;
    }
    if (!matched) continue;
    matches.push({ cms: signal.cms, id: signal.id, weight: signal.weight });
    scores.set(signal.cms, (scores.get(signal.cms) ?? 0) + signal.weight);
  }

  let winner: DetectedCms | null = null;
  let best = 0;
  for (const [cms, score] of scores) {
    if (score > best) {
      best = score;
      winner = cms;
    }
  }

  if (winner === null || best < CMS_CONFIDENCE_THRESHOLD) {
    // Sub-threshold evidence is still reported: it is what a human would want to see when
    // arguing with the verdict.
    const weak = formatSignals(matches, null);
    return {
      cms: 'CUSTOM',
      confidence: CUSTOM_CONFIDENCE,
      signals: weak.length > 0 ? ['no-known-cms-fingerprint', ...weak] : ['no-known-cms-fingerprint'],
    };
  }

  return {
    cms: winner,
    confidence: round(Math.min(1, best), 2),
    signals: formatSignals(matches, winner),
  };
}

/** `CMS:id` strings, winner's signals first, then the rest by descending weight. */
function formatSignals(matches: Match[], winner: DetectedCms | null): string[] {
  const ordered = [...matches].sort((a, b) => {
    if (winner !== null && a.cms !== b.cms) {
      if (a.cms === winner) return -1;
      if (b.cms === winner) return 1;
    }
    return b.weight - a.weight;
  });
  return ordered.map((match) => `${match.cms}:${match.id}`);
}
