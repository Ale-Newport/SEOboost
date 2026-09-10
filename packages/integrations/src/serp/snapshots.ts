/**
 * SERP snapshot capture and SERP-derived competitor discovery.
 *
 * A snapshot is the raw, provider-neutral SERP for one query at one moment. We store it
 * verbatim (results, PAA, related searches, features) plus one derived field — `ourPosition`
 * — because recomputing our own rank later would need the site's domain history anyway.
 *
 * Both entry points degrade: with no SERP provider configured nothing is written and the
 * caller gets a typed "unavailable" result instead of an exception.
 */

import { NotFoundError, addDays, clamp, createLogger, isSameSite, mean, round } from '@seo/shared';
import { json, jsonOrNull, prisma } from '@seo/db';
import { mapResultType, toDomain } from './parse';
import { readArray, readNumber, readRecord, readString } from './http';
import { searchSerp } from './registry';
import type { SerpDevice, SerpResponse, SerpResult } from './types';

const log = createLogger('serp:snapshots');

/**
 * Hosts that appear in almost every SERP but are not organic competitors for a normal site.
 * Callers can override the list; it is exported so the UI can show what was filtered out.
 */
export const DEFAULT_NON_COMPETITOR_DOMAINS: readonly string[] = [
  'google.com', 'youtube.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'linkedin.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com', 'medium.com',
  'wikipedia.org', 'wikihow.com', 'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com',
  'apple.com', 'microsoft.com', 'yelp.com', 'tripadvisor.com', 'indeed.com', 'glassdoor.com',
  'github.com', 'stackoverflow.com', 'archive.org', 'bing.com', 'yahoo.com', 'duckduckgo.com',
];

export interface CaptureSerpSnapshotInput {
  websiteId: string;
  keywordId?: string | null;
  query: string;
  /** BCP-47; defaults to the website's first target locale. */
  locale?: string;
  device?: SerpDevice;
  /** Force a specific provider by name; otherwise the registry picks. */
  provider?: string;
}

export type CaptureSerpSnapshotResult =
  | {
      captured: true;
      snapshotId: string;
      provider: string;
      /** Our best organic position, or null when the site does not rank in the fetched depth. */
      ourPosition: number | null;
      resultCount: number;
    }
  | { captured: false; reason: string; requiredEnv?: string[] };

/** Our best position in a SERP: the first result on the site's own domain or a subdomain. */
export function findOurPosition(results: readonly SerpResult[], domain: string): number | null {
  let best: number | null = null;
  for (const result of results) {
    if (result.type !== 'organic' && result.type !== 'featured_snippet') continue;
    if (!isSameSite(result.url, domain)) continue;
    if (best === null || result.position < best) best = result.position;
  }
  return best;
}

/**
 * Fetch a SERP and persist it as a `SerpSnapshot` row.
 * Returns `{ captured: false }` when no SERP provider is configured — the platform is
 * designed to run without one.
 */
export async function captureSerpSnapshot(
  input: CaptureSerpSnapshotInput,
): Promise<CaptureSerpSnapshotResult> {
  const website = await prisma.website.findUnique({
    where: { id: input.websiteId },
    select: { id: true, domain: true, targetLocales: true },
  });
  if (!website) throw new NotFoundError('Website');

  const locale = input.locale ?? website.targetLocales[0] ?? 'en-US';
  const device: SerpDevice = input.device ?? 'desktop';

  const outcome = await searchSerp(input.query, {
    locale,
    device,
    provider: input.provider,
  });
  if (!outcome.available) {
    return { captured: false, reason: outcome.reason, requiredEnv: outcome.requiredEnv };
  }

  const response: SerpResponse = outcome.response;
  const ourPosition = findOurPosition(response.results, website.domain);

  const snapshot = await prisma.serpSnapshot.create({
    data: {
      websiteId: website.id,
      keywordId: input.keywordId ?? null,
      query: response.query,
      locale: response.locale,
      device: response.device,
      provider: response.provider,
      results: json(response.results),
      peopleAlsoAsk: json(response.peopleAlsoAsk),
      relatedSearches: response.relatedSearches,
      featuredSnippet: jsonOrNull(response.featuredSnippet),
      resultTypes: response.resultTypes,
      ourPosition,
      capturedAt: response.fetchedAt,
    },
    select: { id: true },
  });

  log.info('serp snapshot captured', {
    websiteId: website.id,
    query: response.query,
    provider: response.provider,
    ourPosition,
    results: response.results.length,
  });

  return {
    captured: true,
    snapshotId: snapshot.id,
    provider: response.provider,
    ourPosition,
    resultCount: response.results.length,
  };
}

/**
 * Read a `SerpSnapshot.results` JSON column back into typed results.
 * The column is written by us, but it is still JSON on disk: parse defensively so an old
 * row written by an earlier shape cannot crash an analysis pass.
 */
export function parseStoredSerpResults(value: unknown): SerpResult[] {
  const out: SerpResult[] = [];
  for (const raw of readArray(value)) {
    const item = readRecord(raw);
    if (!item) continue;
    const url = readString(item.url);
    const position = readNumber(item.position, 0);
    if (!url || position <= 0) continue;
    out.push({
      position,
      url,
      title: readString(item.title),
      snippet: readString(item.snippet),
      domain: readString(item.domain) || toDomain(url),
      type: mapResultType(readString(item.type, 'organic')),
    });
  }
  return out;
}

export interface CompetitorCandidate {
  domain: string;
  /** Number of snapshots the domain appeared in. */
  appearances: number;
  /** Distinct queries it ranked for. */
  queries: string[];
  avgPosition: number;
  bestPosition: number;
  top10Appearances: number;
  sampleUrls: string[];
  /** 0-1 blend of query coverage and position strength; the ranking key. */
  score: number;
}

export interface DiscoverCompetitorsOptions {
  /** Minimum snapshots a domain must appear in to be reported. Default 2. */
  minAppearances?: number;
  /** How far back to read snapshots. Default 30 days. */
  sinceDays?: number;
  /** Maximum candidates returned. Default 25. */
  limit?: number;
  /** Cap on snapshots read, newest first, to bound memory on busy sites. Default 500. */
  maxSnapshots?: number;
  /** Additional hosts to ignore on top of `DEFAULT_NON_COMPETITOR_DOMAINS`. */
  excludeDomains?: readonly string[];
  /** Only count results at or above this position. Default 20. */
  maxPosition?: number;
}

/**
 * Aggregate recent SERP snapshots into likely organic competitors.
 *
 * Ranking blends *coverage* (share of our tracked queries the domain shows up for) with
 * *position strength* (how high it ranks), because a domain that is always #1 on a handful
 * of queries and one that is #9 everywhere are competitors for different reasons.
 * Returns candidates only — persisting `Competitor` rows is the caller's decision.
 */
export async function discoverCompetitorsFromSerp(
  websiteId: string,
  opts: DiscoverCompetitorsOptions = {},
): Promise<CompetitorCandidate[]> {
  const {
    minAppearances = 2,
    sinceDays = 30,
    limit = 25,
    maxSnapshots = 500,
    maxPosition = 20,
  } = opts;

  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { domain: true },
  });
  if (!website) throw new NotFoundError('Website');

  const snapshots = await prisma.serpSnapshot.findMany({
    where: { websiteId, capturedAt: { gte: addDays(new Date(), -sinceDays) } },
    orderBy: { capturedAt: 'desc' },
    take: maxSnapshots,
    select: { query: true, results: true },
  });
  if (snapshots.length === 0) return [];

  const excluded = new Set(
    [...DEFAULT_NON_COMPETITOR_DOMAINS, ...(opts.excludeDomains ?? [])].map((d) => d.toLowerCase()),
  );

  interface Accumulator {
    appearances: number;
    positions: number[];
    queries: Set<string>;
    urls: Set<string>;
    top10: number;
  }
  const byDomain = new Map<string, Accumulator>();
  const allQueries = new Set<string>();

  for (const snapshot of snapshots) {
    allQueries.add(snapshot.query);
    // One appearance per (domain, snapshot): a domain holding three results on one SERP
    // should not look three times as competitive as one holding a single top spot.
    const seenInSnapshot = new Set<string>();

    for (const result of parseStoredSerpResults(snapshot.results)) {
      if (result.type !== 'organic' && result.type !== 'featured_snippet') continue;
      if (result.position > maxPosition) continue;
      const domain = result.domain.toLowerCase();
      if (!domain || seenInSnapshot.has(domain)) continue;
      if (isSameSite(`https://${domain}`, website.domain)) continue;
      if (excluded.has(domain) || isExcludedSubdomain(domain, excluded)) continue;

      seenInSnapshot.add(domain);
      const acc = byDomain.get(domain) ?? {
        appearances: 0,
        positions: [],
        queries: new Set<string>(),
        urls: new Set<string>(),
        top10: 0,
      };
      acc.appearances += 1;
      acc.positions.push(result.position);
      acc.queries.add(snapshot.query);
      if (acc.urls.size < 5) acc.urls.add(result.url);
      if (result.position <= 10) acc.top10 += 1;
      byDomain.set(domain, acc);
    }
  }

  const totalQueries = Math.max(1, allQueries.size);
  const candidates: CompetitorCandidate[] = [];

  for (const [domain, acc] of byDomain) {
    if (acc.appearances < minAppearances) continue;
    const avgPosition = mean(acc.positions);
    const coverage = clamp(acc.queries.size / totalQueries);
    // Position strength: #1 → 1, #20 (or `maxPosition`) → 0, linear in between.
    const positionStrength = clamp((maxPosition - avgPosition) / Math.max(1, maxPosition - 1));

    candidates.push({
      domain,
      appearances: acc.appearances,
      queries: [...acc.queries],
      avgPosition: round(avgPosition, 2),
      bestPosition: Math.min(...acc.positions),
      top10Appearances: acc.top10,
      sampleUrls: [...acc.urls],
      score: round(clamp(coverage * 0.6 + positionStrength * 0.4), 3),
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.avgPosition - b.avgPosition)
    .slice(0, limit);
}

/** `blog.reddit.com` should be filtered by the `reddit.com` entry too. */
function isExcludedSubdomain(domain: string, excluded: ReadonlySet<string>): boolean {
  for (const entry of excluded) {
    if (domain.endsWith(`.${entry}`)) return true;
  }
  return false;
}
