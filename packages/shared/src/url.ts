/**
 * URL normalisation and comparison helpers.
 *
 * Normalisation is the backbone of crawling and link graphs: two URLs that render the
 * same page must produce the same normalised key, or the crawler loops and the link
 * graph fragments.
 */

/** Query params that never change the rendered document. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'dclid', 'gbraid', 'wbraid', 'yclid', 'twclid',
  'mc_cid', 'mc_eid', '_ga', '_gl', 'ref', 'ref_src', 'igshid', 'vero_id', 'hsa_acc',
  'hsCtaTracking', 'source', 'campaignid', 'adgroupid',
]);

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

const NON_HTML_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tiff',
  'css', 'js', 'mjs', 'json', 'xml', 'rss', 'atom', 'txt', 'map',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', 'gz', 'tar', '7z',
  'mp3', 'mp4', 'avi', 'mov', 'wmv', 'webm', 'ogg', 'wav', 'm4a',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'exe', 'dmg', 'apk',
]);

export interface NormalizeOptions {
  /** Strip `www.` from the host so `example.com` and `www.example.com` unify. Default true. */
  stripWww?: boolean;
  /** Drop the URL fragment. Default true. */
  stripHash?: boolean;
  /** Remove known tracking parameters. Default true. */
  stripTracking?: boolean;
  /** Remove *all* query parameters. Default false. */
  stripAllQuery?: boolean;
  /** Lowercase the path. Default false — paths are case-sensitive on most servers. */
  lowercasePath?: boolean;
  /** Force this protocol (used to unify http/https duplicates). */
  forceProtocol?: 'http:' | 'https:';
}

/**
 * Produce a stable comparison key for a URL. Returns null for URLs that are not
 * crawlable web pages (mailto:, tel:, javascript:, data:, malformed).
 */
export function normalizeUrl(input: string, options: NormalizeOptions = {}): string | null {
  const {
    stripWww = true,
    stripHash = true,
    stripTracking = true,
    stripAllQuery = false,
    lowercasePath = false,
    forceProtocol,
  } = options;

  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;

  // Protocol-relative
  if (raw.startsWith('//')) raw = `https:${raw}`;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = `https://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (forceProtocol) url.protocol = forceProtocol;

  url.hostname = url.hostname.toLowerCase();
  if (stripWww && url.hostname.startsWith('www.')) url.hostname = url.hostname.slice(4);
  if (url.port === DEFAULT_PORTS[url.protocol]) url.port = '';
  if (stripHash) url.hash = '';

  if (stripAllQuery) {
    url.search = '';
  } else if (stripTracking) {
    const params = url.searchParams;
    for (const key of [...params.keys()]) {
      if (TRACKING_PARAMS.has(key) || key.toLowerCase().startsWith('utm_')) params.delete(key);
    }
    // Deterministic ordering so `?a=1&b=2` === `?b=2&a=1`
    const sorted = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    url.search = '';
    for (const [k, v] of sorted) url.searchParams.append(k, v);
  }

  // Collapse duplicate slashes and resolve `.`/`..` leftovers
  let path = url.pathname.replace(/\/{2,}/g, '/');
  if (lowercasePath) path = path.toLowerCase();
  // Drop a single trailing slash (but keep the root "/")
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  // Common index files resolve to the directory
  path = path.replace(/\/index\.(html?|php|aspx?)$/i, '') || '/';
  url.pathname = path;

  return url.toString();
}

/** Resolve a possibly relative href against a base URL. Returns null when unusable. */
export function resolveUrl(base: string, href: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('mailto:') ||
    lower.startsWith('tel:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('sms:') ||
    lower.startsWith('#')
  ) {
    return null;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/** Registrable-ish host without `www.`. Not PSL-aware; good enough for same-site checks. */
export function getHostname(input: string): string | null {
  try {
    const h = new URL(input.includes('://') ? input : `https://${input}`).hostname.toLowerCase();
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch {
    return null;
  }
}

/** Strip the leading `www.` and any scheme/path from a user-entered domain. */
export function cleanDomain(input: string): string {
  return (getHostname(input) ?? input.trim().toLowerCase()).replace(/\/+$/, '');
}

export function isSameDomain(a: string, b: string): boolean {
  const ha = getHostname(a);
  const hb = getHostname(b);
  return Boolean(ha && hb && ha === hb);
}

/** True when `url` is on `domain` or one of its subdomains. */
export function isSameSite(url: string, domain: string): boolean {
  const h = getHostname(url);
  const d = cleanDomain(domain);
  if (!h) return false;
  return h === d || h.endsWith(`.${d}`);
}

export function getPath(input: string): string {
  try {
    return new URL(input).pathname || '/';
  } catch {
    return '/';
  }
}

/** Directory depth of a URL: `/` is 0, `/blog` is 1, `/blog/post` is 2. */
export function urlDepth(input: string): number {
  const path = getPath(input);
  if (path === '/' || path === '') return 0;
  return path.split('/').filter(Boolean).length;
}

export function hasNonHtmlExtension(input: string): boolean {
  const path = getPath(input).toLowerCase();
  const match = /\.([a-z0-9]{1,6})$/.exec(path);
  if (!match || !match[1]) return false;
  return NON_HTML_EXTENSIONS.has(match[1]);
}

/** Heuristic detection of infinite-crawl patterns (calendars, faceted nav, repeated segments). */
export function looksLikeCrawlTrap(input: string): { trap: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { trap: false };
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 12) return { trap: true, reason: 'Path depth above 12 segments' };

  // Repeated segment sequences: /a/b/a/b/a/b
  const counts = new Map<string, number>();
  for (const seg of segments) counts.set(seg, (counts.get(seg) ?? 0) + 1);
  // A path segment repeating three or more times is the classic signature of a self-referential
  // link loop, regardless of the segment's length.
  for (const [seg, n] of counts) {
    if (n >= 3) return { trap: true, reason: `Segment "${seg}" repeats ${n} times` };
  }

  const paramCount = [...url.searchParams.keys()].length;
  if (paramCount >= 5) return { trap: true, reason: `${paramCount} query parameters (faceted navigation?)` };

  const facetKeys = ['sort', 'order', 'filter', 'facet', 'price', 'color', 'size', 'view', 'page_size'];
  const facets = [...url.searchParams.keys()].filter((k) =>
    facetKeys.some((f) => k.toLowerCase().includes(f)),
  );
  if (facets.length >= 3) return { trap: true, reason: `Faceted parameters: ${facets.join(', ')}` };

  if (/\/\d{4}\/\d{2}\/\d{2}\//.test(url.pathname) && url.searchParams.has('date')) {
    return { trap: true, reason: 'Calendar-style URL with date parameter' };
  }
  return { trap: false };
}

/** Match a URL against simple `*` glob patterns used in include/exclude settings. */
export function matchesPattern(url: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try {
      return new RegExp(`^${escaped}$`, 'i').test(url) || new RegExp(escaped, 'i').test(url);
    } catch {
      return url.includes(pattern);
    }
  });
}

export function toAbsolute(domain: string, path: string, protocol = 'https'): string {
  const d = cleanDomain(domain);
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${protocol}://${d}${p}`;
}

/** Best-effort slug from a URL path, e.g. `/blog/my-post` → `my-post`. */
export function slugFromUrl(input: string): string {
  const path = getPath(input).replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1]!.replace(/\.(html?|php|aspx?)$/i, '') : 'home';
}
