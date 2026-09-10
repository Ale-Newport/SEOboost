/**
 * Backlink profile analysis and *ethical* link-opportunity discovery.
 *
 * Two halves:
 *   `analyseBacklinks`      — what the link profile did over a window (new/lost links,
 *                             referring-domain growth) and which links look manipulative.
 *   `findLinkOpportunities` — where a link could legitimately be earned.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ETHICS — read before extending this file.
 *
 * Nothing here performs, schedules or drafts outreach. `findLinkOpportunities` returns a
 * *research* list: pages that already mention the brand without linking, dead resources our
 * own crawl found, resource pages of the kind that already link to us, and our own content
 * worth promoting. A human decides whether to contact anyone, and does so themselves.
 *
 * Explicitly out of scope, per the repo's no-black-hat rule: bulk or automated email, contact
 * scraping, link buying/exchange schemes, PBN discovery, comment/forum/profile link injection,
 * and any "send N emails" helper. If a future task asks for those, it is the wrong feature.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The heuristics operate on evidence, never on a purchased "toxicity" number, and every
 * finding carries the evidence that produced it so a human can overrule it. A flag means
 * "look at this", not "disavow this" — the disavow decision is always manual.
 */

import { prisma, IssueStatus } from '@seo/db';
import {
  NotFoundError,
  clamp,
  cleanDomain,
  createLogger,
  errorMessage,
  formatDateKey,
  getHostname,
  isSameSite,
  lastNDays,
  normalizeKeyword,
  normalizeUrl,
  percentChange,
  round,
  safeDivide,
} from '@seo/shared';
import type { ExplainableScore, ScoreFactor } from '@seo/shared';
import { searchSerp } from '../serp/registry';
import { BACKLINK_STATUS_LOST } from './csv';

const log = createLogger('backlinks:analysis');

export const DEFAULT_ANALYSIS_WINDOW_DAYS = 30;

/**
 * Ceiling on the rows one analysis pass holds in memory. The CSV importer accepts up to
 * 500 000 rows per file, so an unbounded `findMany` here is a worker OOM waiting for a big
 * site; the analysis degrades to "the newest N links" and says so via `truncated`.
 */
export const MAX_ANALYSED_LINKS = 100_000;
/** Rows per database round trip while loading the profile. */
const LINK_PAGE_SIZE = 10_000;

// ── Suspicious-link heuristics (pure) ────────────────────────

export type SuspiciousReason =
  | 'EXACT_MATCH_ANCHOR_OVER_OPTIMISATION'
  | 'SPAM_TLD'
  | 'SPAM_DOMAIN_PATTERN'
  | 'SITEWIDE_LINK'
  | 'LINK_BURST';

export type SuspiciousSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

/** The minimum a heuristic needs to know about a link. Mirrors `Backlink` minus the noise. */
export interface AnalysableLink {
  id: string;
  referringDomain: string;
  sourceUrl: string;
  targetUrl: string;
  anchorText: string | null;
  isFollow: boolean;
  firstSeenAt: Date;
}

export interface SuspiciousFinding {
  referringDomain: string;
  reasons: SuspiciousReason[];
  severity: SuspiciousSeverity;
  /** Ids of the links this finding covers, so the caller can flag exactly those rows. */
  linkIds: string[];
  /** Human-readable evidence — what was counted, not just the verdict. */
  evidence: string[];
}

export interface SuspiciousThresholds {
  /**
   * Share of a domain's *followed* links using an exact-match commercial anchor before the
   * domain is flagged. Natural profiles are dominated by brand and URL anchors, so a domain
   * pushing money anchors on nearly every link is the classic paid-link footprint.
   */
  exactMatchAnchorShare: number;
  /** A domain needs at least this many links before the anchor share means anything. */
  minLinksForAnchorShare: number;
  /** Distinct source pages from one domain to one target that make a link "sitewide". */
  sitewideSourcePages: number;
  /** Links from one domain first seen inside `burstWindowDays` that count as a burst. */
  burstLinks: number;
  burstWindowDays: number;
}

export const DEFAULT_SUSPICIOUS_THRESHOLDS: SuspiciousThresholds = {
  exactMatchAnchorShare: 0.5,
  minLinksForAnchorShare: 4,
  sitewideSourcePages: 15,
  burstLinks: 20,
  burstWindowDays: 3,
};

/**
 * TLDs with a well-documented abuse rate — cheap or free registration made them the default
 * home of link farms. Presence is a *signal*, never a verdict: plenty of legitimate sites use
 * `.xyz`, which is why this only ever contributes one reason among several.
 */
const SPAM_TLDS: ReadonlySet<string> = new Set([
  'tk', 'ml', 'ga', 'cf', 'gq', 'xyz', 'top', 'loan', 'win', 'bid', 'click', 'link',
  'work', 'date', 'faith', 'science', 'party', 'racing', 'stream', 'download', 'review',
  'accountant', 'cricket', 'trade', 'webcam', 'men', 'mom', 'rest', 'quest', 'sbs', 'cyou',
]);

/** Substrings that appear in the hostname of link-scheme sites far more often than by chance. */
const SPAM_DOMAIN_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|[.-])(pbn|linkfarm|linkbuild|linkbuilding|buybacklinks?|backlinks?)([.-]|$)/i, label: 'link-scheme keyword in domain' },
  { pattern: /(^|[.-])(guestpost|guest-post|articlesubmission|pressrelease)([.-]|$)/i, label: 'paid-placement keyword in domain' },
  { pattern: /(^|[.-])(casino|poker|betting|escort|payday|viagra|replica)([.-]|$)/i, label: 'high-abuse vertical keyword in domain' },
];

function hostLabels(domain: string): string[] {
  return cleanDomain(domain).split('.').filter(Boolean);
}

function tldOf(domain: string): string {
  const labels = hostLabels(domain);
  return labels.length > 0 ? labels[labels.length - 1].toLowerCase() : '';
}

/**
 * Structural spam tells in a hostname: an unusual number of hyphens or digits, or an
 * absurdly long second-level label. Each is weak alone, so two are required to fire.
 */
function domainLooksGenerated(domain: string): string | null {
  const labels = hostLabels(domain);
  if (labels.length < 2) return null;
  const sld = labels[labels.length - 2] ?? '';
  const signals: string[] = [];
  const hyphens = (sld.match(/-/g) ?? []).length;
  const digits = (sld.match(/\d/g) ?? []).length;
  if (hyphens >= 3) signals.push(`${hyphens} hyphens`);
  if (digits >= 4) signals.push(`${digits} digits`);
  if (sld.length >= 28) signals.push(`${sld.length}-character name`);
  if (labels.length >= 5) signals.push(`${labels.length} subdomain levels`);
  return signals.length >= 2 ? signals.join(', ') : null;
}

/**
 * Is this anchor an exact commercial match?
 *
 * Exact-match means the anchor *is* a tracked keyword — not that it merely contains one.
 * Brand names and bare URLs are excluded because a natural profile is full of them and
 * counting them would flag every healthy site.
 */
export function isExactMatchAnchor(
  anchor: string | null,
  keywords: ReadonlySet<string>,
  brandTerms: ReadonlySet<string>,
): boolean {
  if (!anchor) return false;
  const normalized = normalizeKeyword(anchor);
  if (!normalized || brandTerms.has(normalized)) return false;
  if (/^https?:\/\//i.test(anchor.trim()) || normalizeUrl(anchor.trim()) !== null) return false;
  return keywords.has(normalized);
}

export interface SuspiciousContext {
  /** Normalised keywords the site tracks — the anchors that would be "money" anchors. */
  keywords: ReadonlySet<string>;
  /** Normalised brand terms, excluded from exact-match counting. */
  brandTerms: ReadonlySet<string>;
  thresholds?: Partial<SuspiciousThresholds>;
}

const SEVERITY_RANK: Record<SuspiciousSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function severityFor(reasons: readonly SuspiciousReason[]): SuspiciousSeverity {
  // A single weak tell is worth a look; two independent ones is a pattern; the classic paid
  // footprint (money anchors from a spam-pattern domain) is the strong case.
  if (reasons.length >= 3) return 'HIGH';
  if (reasons.length === 2) {
    return reasons.includes('EXACT_MATCH_ANCHOR_OVER_OPTIMISATION') ? 'HIGH' : 'MEDIUM';
  }
  return reasons[0] === 'EXACT_MATCH_ANCHOR_OVER_OPTIMISATION' ? 'MEDIUM' : 'LOW';
}

/**
 * Group links by referring domain and apply the four heuristics.
 *
 * Pure and synchronous on purpose: this is the part worth unit-testing, and keeping the
 * database out of it means the thresholds can be tuned against fixtures.
 */
export function detectSuspiciousLinks(
  links: readonly AnalysableLink[],
  context: SuspiciousContext,
): SuspiciousFinding[] {
  const thresholds: SuspiciousThresholds = { ...DEFAULT_SUSPICIOUS_THRESHOLDS, ...context.thresholds };
  const byDomain = new Map<string, AnalysableLink[]>();
  for (const link of links) {
    const domain = cleanDomain(link.referringDomain || link.sourceUrl);
    if (!domain) continue;
    const bucket = byDomain.get(domain);
    if (bucket) bucket.push(link);
    else byDomain.set(domain, [link]);
  }

  const findings: SuspiciousFinding[] = [];

  for (const [domain, domainLinks] of byDomain) {
    const reasons: SuspiciousReason[] = [];
    const evidence: string[] = [];

    // 1. Exact-match anchor over-optimisation, measured on followed links only —
    //    a nofollow money anchor passes no equity and is not a manipulation signal.
    const followed = domainLinks.filter((l) => l.isFollow);
    if (followed.length >= thresholds.minLinksForAnchorShare) {
      const exact = followed.filter((l) =>
        isExactMatchAnchor(l.anchorText, context.keywords, context.brandTerms),
      );
      const share = exact.length / followed.length;
      if (share >= thresholds.exactMatchAnchorShare) {
        reasons.push('EXACT_MATCH_ANCHOR_OVER_OPTIMISATION');
        evidence.push(
          `${exact.length}/${followed.length} followed links (${Math.round(share * 100)}%) use an exact-match keyword anchor`,
        );
      }
    }

    // 2. Abuse-heavy TLD.
    const tld = tldOf(domain);
    if (SPAM_TLDS.has(tld)) {
      reasons.push('SPAM_TLD');
      evidence.push(`referring domain uses the .${tld} TLD, which has a high abuse rate`);
    }

    // 3. Spam-shaped hostname (keyword footprint or generated-looking name).
    const patternMatch = SPAM_DOMAIN_PATTERNS.find((p) => p.pattern.test(domain));
    const generated = domainLooksGenerated(domain);
    if (patternMatch || generated) {
      reasons.push('SPAM_DOMAIN_PATTERN');
      evidence.push(patternMatch ? `${patternMatch.label}: ${domain}` : `machine-generated domain shape (${generated})`);
    }

    // 4. Sitewide placement: one domain linking to the same target from many distinct pages
    //    with one anchor is a template link (footer/sidebar/blogroll), not editorial.
    //    Backlink exports carry no DOM position, so the footprint is what identifies it.
    const byTargetAnchor = new Map<string, Set<string>>();
    for (const link of domainLinks) {
      const key = `${link.targetUrl} ${normalizeKeyword(link.anchorText ?? '')}`;
      const set = byTargetAnchor.get(key) ?? new Set<string>();
      set.add(link.sourceUrl);
      byTargetAnchor.set(key, set);
    }
    const widest = [...byTargetAnchor.values()].reduce((max, set) => Math.max(max, set.size), 0);
    if (widest >= thresholds.sitewideSourcePages) {
      reasons.push('SITEWIDE_LINK');
      evidence.push(
        `${widest} distinct pages on ${domain} link to the same URL with the same anchor (sitewide/template placement)`,
      );
    }

    // 5. Burst: many links from one domain appearing at once. Natural link acquisition from a
    //    single site is spread over time; a same-day spike is an injection or a scraper.
    const burst = largestBurst(domainLinks, thresholds.burstWindowDays);
    if (burst.count >= thresholds.burstLinks) {
      reasons.push('LINK_BURST');
      evidence.push(
        `${burst.count} links from ${domain} first seen within ${thresholds.burstWindowDays} days (from ${formatDateKey(burst.start)})`,
      );
    }

    if (reasons.length === 0) continue;
    findings.push({
      referringDomain: domain,
      reasons,
      severity: severityFor(reasons),
      linkIds: domainLinks.map((l) => l.id),
      evidence,
    });
  }

  return findings.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.linkIds.length - a.linkIds.length,
  );
}

/** Largest count of links whose `firstSeenAt` falls inside any `windowDays`-wide window. */
function largestBurst(
  links: readonly AnalysableLink[],
  windowDays: number,
): { count: number; start: Date } {
  const times = links.map((l) => l.firstSeenAt.getTime()).sort((a, b) => a - b);
  if (times.length === 0) return { count: 0, start: new Date(0) };
  const windowMs = windowDays * 86_400_000;
  let best = 1;
  let bestStart = times[0];
  let left = 0;
  for (let right = 0; right < times.length; right += 1) {
    while (times[right] - times[left] > windowMs) left += 1;
    const count = right - left + 1;
    if (count > best) {
      best = count;
      bestStart = times[left];
    }
  }
  return { count: best, start: new Date(bestStart) };
}

// ── Profile analysis ─────────────────────────────────────────

export interface BacklinkTotals {
  backlinks: number;
  referringDomains: number;
  followed: number;
  nofollowed: number;
  lost: number;
}

export interface BacklinkVelocity {
  newLinks: number;
  lostLinks: number;
  netLinks: number;
  newReferringDomains: number;
  lostReferringDomains: number;
  /** Referring-domain growth over the window, in percent. Null when we started from zero. */
  referringDomainGrowthPct: number | null;
}

export interface ReferringDomainSummary {
  domain: string;
  backlinks: number;
  domainAuthority: number | null;
  followed: boolean;
  firstSeenAt: Date;
  isSuspicious: boolean;
}

export interface AnchorProfileEntry {
  anchor: string;
  count: number;
  /** Share of all followed links, 0-1. */
  share: number;
  isExactMatch: boolean;
}

export interface BacklinkAnalysis {
  websiteId: string;
  window: { from: string; to: string; days: number };
  totals: BacklinkTotals;
  velocity: BacklinkVelocity;
  topReferringDomains: ReferringDomainSummary[];
  anchorProfile: AnchorProfileEntry[];
  suspicious: SuspiciousFinding[];
  /**
   * True when the site has more than `MAX_ANALYSED_LINKS` stored links and only that many
   * were read. Totals and heuristics then describe that subset, not the whole profile — the
   * UI must say so rather than present a partial count as the full picture.
   */
  truncated: boolean;
  /** Links whose `isSuspicious` flag was changed by this run. */
  flagged: number;
  unflagged: number;
  /** 0-100 risk read on the profile, with the factors that produced it. */
  risk: ExplainableScore;
}

export interface AnalyseBacklinksOptions {
  windowDays?: number;
  /** Referring domains to include in `topReferringDomains`. Default 25. */
  topDomains?: number;
  thresholds?: Partial<SuspiciousThresholds>;
  /** Write `Backlink.isSuspicious` back to the database. Default true. */
  persistFlags?: boolean;
}

/**
 * Analyse a website's stored link profile.
 *
 * Reads only what is already in `Backlink` — it never calls a provider — so it works
 * identically whether the rows came from a paid API or a CSV upload.
 */
export async function analyseBacklinks(
  websiteId: string,
  options: AnalyseBacklinksOptions = {},
): Promise<BacklinkAnalysis> {
  const windowDays = Math.max(1, options.windowDays ?? DEFAULT_ANALYSIS_WINDOW_DAYS);
  const topDomains = Math.max(1, options.topDomains ?? 25);
  const range = lastNDays(windowDays);

  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, domain: true, brandName: true, name: true },
  });
  if (!website) throw new NotFoundError('Website');

  const [loaded, keywordRows] = await Promise.all([
    loadStoredLinks(websiteId),
    prisma.keyword.findMany({ where: { websiteId }, select: { normalized: true } }),
  ]);
  const { links, truncated } = loaded;
  if (truncated) {
    log.warn('backlink profile truncated for analysis', { websiteId, limit: MAX_ANALYSED_LINKS });
  }

  const keywords = new Set(keywordRows.map((k) => k.normalized).filter(Boolean));
  const brandTerms = brandTermSet(website.brandName, website.name, website.domain);

  // ── totals ──
  const live = links.filter((l) => l.status !== BACKLINK_STATUS_LOST && !l.lostAt);
  const domains = new Map<string, ReferringDomainSummary>();
  for (const link of live) {
    const domain = domainOf(link);
    if (!domain) continue;
    const existing = domains.get(domain);
    if (existing) {
      existing.backlinks += 1;
      existing.followed = existing.followed || link.isFollow;
      existing.isSuspicious = existing.isSuspicious || link.isSuspicious;
      if (link.domainAuthority !== null && (existing.domainAuthority ?? -1) < link.domainAuthority) {
        existing.domainAuthority = link.domainAuthority;
      }
      if (link.firstSeenAt < existing.firstSeenAt) existing.firstSeenAt = link.firstSeenAt;
    } else {
      domains.set(domain, {
        domain,
        backlinks: 1,
        domainAuthority: link.domainAuthority,
        followed: link.isFollow,
        firstSeenAt: link.firstSeenAt,
        isSuspicious: link.isSuspicious,
      });
    }
  }

  const totals: BacklinkTotals = {
    backlinks: live.length,
    referringDomains: domains.size,
    followed: live.filter((l) => l.isFollow).length,
    nofollowed: live.filter((l) => !l.isFollow).length,
    lost: links.length - live.length,
  };

  // ── velocity ──
  const inWindow = (date: Date | null): boolean =>
    date !== null && date >= range.start && date <= endOfDay(range.end);

  const newLinks = links.filter((l) => inWindow(l.firstSeenAt));
  const lostLinks = links.filter((l) => inWindow(l.lostAt));
  // `domainOf` everywhere, so a row with a blank referringDomain column falls back to its
  // source URL here exactly as it does in the totals — otherwise it would count as domain "".
  const domainsBefore = new Set(
    links
      .filter((l) => l.firstSeenAt < range.start)
      .map(domainOf)
      .filter(Boolean),
  );
  const newDomains = new Set(newLinks.map(domainOf).filter((d) => d && !domainsBefore.has(d)));
  // A domain counts as lost only when *every* link from it went away.
  const lostDomains = new Set(lostLinks.map(domainOf).filter((d) => d && !domains.has(d)));

  const velocity: BacklinkVelocity = {
    newLinks: newLinks.length,
    lostLinks: lostLinks.length,
    netLinks: newLinks.length - lostLinks.length,
    newReferringDomains: newDomains.size,
    lostReferringDomains: lostDomains.size,
    referringDomainGrowthPct: percentChange(domainsBefore.size, domains.size),
  };

  // ── anchors ──
  const anchorProfile = buildAnchorProfile(live, keywords, brandTerms);
  // Measured over every followed link rather than over `anchorProfile`, which keeps only the
  // 50 most common anchors — a profile whose money anchors are all long-tail would otherwise
  // score as clean.
  const followedLive = live.filter((l) => l.isFollow);
  const exactMatchShare = safeDivide(
    followedLive.filter((l) => isExactMatchAnchor(l.anchorText, keywords, brandTerms)).length,
    followedLive.length,
    0,
  );

  // ── suspicious ──
  const analysable: AnalysableLink[] = live.map((l) => ({
    id: l.id,
    referringDomain: l.referringDomain,
    sourceUrl: l.sourceUrl,
    targetUrl: l.targetUrl,
    anchorText: l.anchorText,
    isFollow: l.isFollow,
    firstSeenAt: l.firstSeenAt,
  }));
  const suspicious = detectSuspiciousLinks(analysable, {
    keywords,
    brandTerms,
    ...(options.thresholds ? { thresholds: options.thresholds } : {}),
  });

  let flagged = 0;
  let unflagged = 0;
  if (options.persistFlags !== false) {
    const result = await persistSuspiciousFlags(websiteId, links, suspicious);
    flagged = result.flagged;
    unflagged = result.unflagged;
  }

  const risk = scoreRisk(totals, exactMatchShare, suspicious);

  log.info('backlink analysis complete', {
    websiteId,
    backlinks: totals.backlinks,
    referringDomains: totals.referringDomains,
    suspiciousDomains: suspicious.length,
  });

  return {
    websiteId,
    window: { from: formatDateKey(range.start), to: formatDateKey(range.end), days: windowDays },
    totals,
    velocity,
    topReferringDomains: [...domains.values()]
      .sort((a, b) => (b.domainAuthority ?? 0) - (a.domainAuthority ?? 0) || b.backlinks - a.backlinks)
      .slice(0, topDomains),
    anchorProfile,
    suspicious,
    truncated,
    flagged,
    unflagged,
    risk,
  };
}

interface StoredBacklink {
  id: string;
  referringDomain: string;
  sourceUrl: string;
  targetUrl: string;
  anchorText: string | null;
  isFollow: boolean;
  domainAuthority: number | null;
  firstSeenAt: Date;
  lostAt: Date | null;
  status: string;
  isSuspicious: boolean;
}

/**
 * Read the stored profile in keyset pages, stopping at `MAX_ANALYSED_LINKS`.
 *
 * Paging rather than one `findMany` keeps the Postgres result set (and the driver's row
 * buffer) bounded; the cap keeps *this* process bounded. Keyset on the primary key rather
 * than `skip`/`take` so each page is an index range scan and no row can be read twice or
 * missed when rows are inserted mid-walk.
 */
async function loadStoredLinks(
  websiteId: string,
): Promise<{ links: StoredBacklink[]; truncated: boolean }> {
  const select = {
    id: true,
    referringDomain: true,
    sourceUrl: true,
    targetUrl: true,
    anchorText: true,
    isFollow: true,
    domainAuthority: true,
    firstSeenAt: true,
    lostAt: true,
    status: true,
    isSuspicious: true,
  } as const;

  const links: StoredBacklink[] = [];
  let cursor: string | undefined;

  while (links.length < MAX_ANALYSED_LINKS) {
    const take = Math.min(LINK_PAGE_SIZE, MAX_ANALYSED_LINKS - links.length);
    const batch = await prisma.backlink.findMany({
      where: { websiteId, ...(cursor ? { id: { gt: cursor } } : {}) },
      select,
      orderBy: { id: 'asc' },
      take,
    });
    links.push(...batch);
    if (batch.length < take) return { links, truncated: false };
    cursor = batch[batch.length - 1]?.id;
    if (!cursor) break;
  }

  // Only pay for the count when the cap was actually reached.
  const total = await prisma.backlink.count({ where: { websiteId } });
  return { links, truncated: total > links.length };
}

/** Referring domain of a link, falling back to its source URL when the column is blank. */
function domainOf(link: { referringDomain: string; sourceUrl: string }): string {
  return cleanDomain(link.referringDomain || link.sourceUrl);
}

/** Brand terms are excluded from exact-match anchor counting; a brand anchor is the healthy case. */
function brandTermSet(brandName: string | null, name: string, domain: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of [brandName, name, cleanDomain(domain), cleanDomain(domain).split('.')[0]]) {
    const normalized = normalizeKeyword(raw ?? '');
    if (normalized) terms.add(normalized);
  }
  return terms;
}

/** Midnight-UTC ranges are inclusive of the end day; extend to its last millisecond. */
function endOfDay(date: Date): Date {
  return new Date(date.getTime() + 86_399_999);
}

interface LiveLink {
  anchorText: string | null;
  isFollow: boolean;
}

function buildAnchorProfile(
  links: readonly LiveLink[],
  keywords: ReadonlySet<string>,
  brandTerms: ReadonlySet<string>,
): AnchorProfileEntry[] {
  const followed = links.filter((l) => l.isFollow);
  const counts = new Map<string, number>();
  for (const link of followed) {
    const anchor = (link.anchorText ?? '').trim();
    // Empty anchors are image links; grouping them under one label keeps the profile honest.
    const label = anchor === '' ? '(image or empty anchor)' : anchor;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([anchor, count]) => ({
      anchor,
      count,
      share: round(safeDivide(count, followed.length, 0), 4),
      isExactMatch: isExactMatchAnchor(anchor, keywords, brandTerms),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 50);
}

interface StoredLink {
  id: string;
  isSuspicious: boolean;
}

/**
 * Sync `Backlink.isSuspicious` with the current findings — including *clearing* it for links
 * that no longer trip a heuristic, so a fixed profile (or a tuned threshold) actually shows
 * as fixed instead of leaving stale red flags behind.
 */
async function persistSuspiciousFlags(
  websiteId: string,
  links: readonly StoredLink[],
  findings: readonly SuspiciousFinding[],
): Promise<{ flagged: number; unflagged: number }> {
  const shouldFlag = new Set(findings.flatMap((f) => f.linkIds));
  const toFlag = links.filter((l) => !l.isSuspicious && shouldFlag.has(l.id)).map((l) => l.id);
  const toClear = links.filter((l) => l.isSuspicious && !shouldFlag.has(l.id)).map((l) => l.id);

  let flagged = 0;
  let unflagged = 0;
  if (toFlag.length > 0) {
    const res = await prisma.backlink.updateMany({
      where: { websiteId, id: { in: toFlag } },
      data: { isSuspicious: true },
    });
    flagged = res.count;
  }
  if (toClear.length > 0) {
    const res = await prisma.backlink.updateMany({
      where: { websiteId, id: { in: toClear } },
      data: { isSuspicious: false },
    });
    unflagged = res.count;
  }
  return { flagged, unflagged };
}

/**
 * Risk read on the link profile, 0 (healthy) to 100 (looks manipulated).
 *
 * Returned as an `ExplainableScore` because a bare "toxicity 62" is exactly the kind of
 * number nobody can act on — and because a wrong flag here can cost a site a disavow it
 * did not need. Each factor names what was counted.
 */
function scoreRisk(
  totals: BacklinkTotals,
  /** Share of *followed* links using an exact-match keyword anchor, 0-1. */
  exactMatchShare: number,
  findings: readonly SuspiciousFinding[],
): ExplainableScore {
  const suspiciousLinks = new Set(findings.flatMap((f) => f.linkIds)).size;
  const suspiciousShare = safeDivide(suspiciousLinks, totals.backlinks, 0);
  const highSeverity = findings.filter((f) => f.severity === 'HIGH').length;
  const burstShare = safeDivide(
    findings.filter((f) => f.reasons.includes('LINK_BURST')).length,
    Math.max(1, totals.referringDomains),
    0,
  );

  const factors: ScoreFactor[] = [
    factor(
      'suspicious_link_share',
      'Links flagged by a heuristic',
      clamp(suspiciousShare * 2.5),
      0.4,
      `${suspiciousLinks} of ${totals.backlinks} live links sit on a flagged domain`,
    ),
    factor(
      'exact_match_anchors',
      'Exact-match anchor share',
      // Roughly 20% money anchors is already unusual; treat that as the top of the scale.
      clamp(exactMatchShare / 0.2),
      0.3,
      `${Math.round(exactMatchShare * 100)}% of followed links use an exact-match keyword anchor`,
    ),
    factor(
      'high_severity_domains',
      'Domains with multiple spam signals',
      clamp(highSeverity / 5),
      0.2,
      `${highSeverity} referring domain(s) tripped several heuristics at once`,
    ),
    factor(
      'acquisition_bursts',
      'Bursty link acquisition',
      clamp(burstShare * 4),
      0.1,
      `${findings.filter((f) => f.reasons.includes('LINK_BURST')).length} domain(s) delivered a same-window burst of links`,
    ),
  ];

  const score = round(factors.reduce((n, f) => n + f.contribution, 0), 1);
  const summary =
    totals.backlinks === 0
      ? 'No backlinks stored yet — import a CSV export or configure a provider.'
      : score >= 60
        ? `${findings.length} referring domain(s) show manipulation patterns; review them before they are counted against the site.`
        : score >= 25
          ? `${findings.length} referring domain(s) are worth a look, but the profile is broadly natural.`
          : 'No meaningful manipulation signals in the stored link profile.';

  return { score, factors, summary };
}

function factor(
  key: string,
  label: string,
  value: number,
  weight: number,
  explanation: string,
): ScoreFactor {
  return { key, label, value, weight, contribution: round(value * weight * 100, 2), explanation };
}

// ── Link opportunities (ethical only) ────────────────────────

export type OpportunityKind =
  | 'UNLINKED_MENTION'
  | 'BROKEN_INBOUND_LINK'
  | 'DEAD_EXTERNAL_RESOURCE'
  | 'RESOURCE_PAGE'
  | 'LINKABLE_ASSET';

export interface LinkOpportunity {
  kind: OpportunityKind;
  /** The page or asset the opportunity is about. */
  url: string;
  domain: string;
  title: string;
  /** Why this is an opportunity, in a sentence a human can act on. */
  rationale: string;
  /** What a person could do next. Never executed automatically. */
  suggestedAction: string;
  /** Rough priority 0-100 from the evidence available; not a guarantee of a link. */
  priority: number;
}

export interface SkippedCheck {
  check: string;
  reason: string;
  requiredEnv?: string[];
}

export interface LinkOpportunities {
  websiteId: string;
  generatedAt: Date;
  opportunities: LinkOpportunity[];
  /** Checks that could not run, so the UI explains the gap instead of showing a short list. */
  skipped: SkippedCheck[];
}

/** Cap each check so one noisy site cannot produce a thousand "opportunities". */
const MAX_PER_CHECK = 25;

/**
 * Find places a link could legitimately be earned.
 *
 * NO OUTREACH IS PERFORMED. This function reads our own crawl, our own link table and (when a
 * SERP provider is configured) public search results. It produces a research list for a human;
 * it sends nothing, drafts nothing and contacts nobody. See the ethics note at the top of the
 * file before adding anything here.
 */
export async function findLinkOpportunities(websiteId: string): Promise<LinkOpportunities> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, domain: true, brandName: true, name: true },
  });
  if (!website) throw new NotFoundError('Website');

  const skipped: SkippedCheck[] = [];
  const opportunities: LinkOpportunity[] = [];
  const linkingDomains = new Set(
    (
      await prisma.backlink.findMany({
        where: { websiteId, status: { not: BACKLINK_STATUS_LOST } },
        select: { referringDomain: true },
        distinct: ['referringDomain'],
      })
    ).map((row) => cleanDomain(row.referringDomain)),
  );

  opportunities.push(...(await findUnlinkedMentions(website, linkingDomains, skipped)));
  opportunities.push(...(await findBrokenInboundLinks(websiteId)));
  opportunities.push(...(await findDeadExternalResources(websiteId, cleanDomain(website.domain))));
  opportunities.push(...(await findResourcePageCandidates(websiteId)));
  opportunities.push(...(await findLinkableAssets(websiteId)));

  return {
    websiteId,
    generatedAt: new Date(),
    opportunities: opportunities.sort((a, b) => b.priority - a.priority),
    skipped,
  };
}

interface WebsiteRef {
  id: string;
  domain: string;
  brandName: string | null;
  name: string;
}

/**
 * Pages that name the brand in public search results but are not in our referring-domain set.
 *
 * Needs a SERP provider; without one the check is reported as skipped rather than quietly
 * returning nothing. The `-site:` operator keeps our own pages out of the results.
 */
async function findUnlinkedMentions(
  website: WebsiteRef,
  linkingDomains: ReadonlySet<string>,
  skipped: SkippedCheck[],
): Promise<LinkOpportunity[]> {
  const brand = (website.brandName ?? website.name).trim();
  const domain = cleanDomain(website.domain);
  if (!brand) {
    skipped.push({
      check: 'UNLINKED_MENTION',
      reason: 'The website has no brand name set, so brand mentions cannot be searched for.',
    });
    return [];
  }

  // `searchSerp` degrades for a *missing* provider but still throws when a configured one
  // fails (quota, bad key). One optional check must not take the whole research list with it.
  let outcome: Awaited<ReturnType<typeof searchSerp>>;
  try {
    outcome = await searchSerp(`"${brand}" -site:${domain}`, { limit: 50 });
  } catch (err) {
    const reason = errorMessage(err);
    log.warn('unlinked-mention check failed', { domain, error: reason });
    skipped.push({
      check: 'UNLINKED_MENTION',
      reason: `The SERP provider could not be reached: ${reason}`,
    });
    return [];
  }
  if (!outcome.available) {
    skipped.push({
      check: 'UNLINKED_MENTION',
      reason: outcome.reason,
      requiredEnv: outcome.requiredEnv,
    });
    return [];
  }

  const seen = new Set<string>();
  const out: LinkOpportunity[] = [];
  for (const result of outcome.response.results) {
    const resultDomain = cleanDomain(result.domain || getHostname(result.url) || '');
    if (!resultDomain || resultDomain === domain) continue;
    if (linkingDomains.has(resultDomain) || seen.has(resultDomain)) continue;
    seen.add(resultDomain);
    out.push({
      kind: 'UNLINKED_MENTION',
      url: result.url,
      domain: resultDomain,
      title: result.title || result.url,
      rationale: `${resultDomain} ranks for "${brand}" but is not in the referring-domain list, so the mention is probably unlinked.`,
      suggestedAction: 'Open the page, confirm the brand is mentioned without a link, and decide whether it is worth asking the author.',
      // Earlier results mention the brand more prominently; decay gently by position.
      priority: Math.max(30, 90 - result.position * 2),
    });
    if (out.length >= MAX_PER_CHECK) break;
  }
  return out;
}

/**
 * Links pointing at our own dead URLs. The highest-value opportunity there is: the link
 * already exists and a redirect recovers it without contacting anyone.
 */
async function findBrokenInboundLinks(websiteId: string): Promise<LinkOpportunity[]> {
  const deadPages = await prisma.page.findMany({
    where: {
      websiteId,
      OR: [{ statusCode: { gte: 400 } }, { isActive: false }],
    },
    select: { url: true, normalizedUrl: true, statusCode: true },
    take: 2000,
  });
  if (deadPages.length === 0) return [];

  const deadByNormalized = new Map(deadPages.map((p) => [p.normalizedUrl, p]));
  const links = await prisma.backlink.findMany({
    where: { websiteId, status: { not: BACKLINK_STATUS_LOST } },
    select: { targetUrl: true, referringDomain: true, sourceUrl: true, domainAuthority: true },
    take: 20_000,
  });

  const byTarget = new Map<string, { links: number; bestAuthority: number; example: string }>();
  for (const link of links) {
    const normalized = normalizeUrl(link.targetUrl);
    if (!normalized || !deadByNormalized.has(normalized)) continue;
    const entry = byTarget.get(normalized) ?? { links: 0, bestAuthority: 0, example: link.sourceUrl };
    entry.links += 1;
    entry.bestAuthority = Math.max(entry.bestAuthority, link.domainAuthority ?? 0);
    byTarget.set(normalized, entry);
  }

  return [...byTarget.entries()]
    .sort((a, b) => b[1].links - a[1].links)
    .slice(0, MAX_PER_CHECK)
    .map(([normalized, entry]) => {
      const page = deadByNormalized.get(normalized);
      return {
        kind: 'BROKEN_INBOUND_LINK' as const,
        url: page?.url ?? normalized,
        domain: cleanDomain(normalized),
        title: `${entry.links} inbound link(s) point at a dead URL`,
        rationale: `${entry.links} live backlink(s) target ${page?.url ?? normalized}, which returns ${page?.statusCode ?? 'an error'}.`,
        suggestedAction: 'Restore the page or 301-redirect it to the closest equivalent; the equity returns with no outreach at all.',
        priority: Math.min(100, 55 + entry.links * 3 + entry.bestAuthority / 4),
      };
    });
}

/**
 * Dead external resources our own crawl found (the `BROKEN_EXTERNAL_LINK` technical issue).
 *
 * A resource that is gone but still linked from our site is usually still linked from other
 * sites too — which makes a replacement of our own a genuinely useful thing to publish.
 */
async function findDeadExternalResources(
  websiteId: string,
  siteDomain: string,
): Promise<LinkOpportunity[]> {
  const issues = await prisma.technicalIssue.findMany({
    where: { websiteId, ruleId: 'BROKEN_EXTERNAL_LINK', status: IssueStatus.OPEN },
    select: { url: true, evidence: true },
    take: MAX_PER_CHECK * 20,
  });

  const byUrl = new Map<string, number>();
  for (const issue of issues) {
    // `TechnicalIssue.url` is by convention *our* page carrying the problem, with the dead
    // outbound target in `evidence`. Prefer the evidence URL and never treat a URL on our own
    // site as an external resource — otherwise this check would recommend replacing our pages.
    const target = readEvidenceUrl(issue.evidence) ?? issue.url;
    if (!target) continue;
    const normalized = normalizeUrl(target);
    if (!normalized || isSameSite(normalized, siteDomain)) continue;
    byUrl.set(normalized, (byUrl.get(normalized) ?? 0) + 1);
  }

  return [...byUrl.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PER_CHECK)
    .map(([url, count]) => ({
      kind: 'DEAD_EXTERNAL_RESOURCE' as const,
      url,
      domain: cleanDomain(getHostname(url) ?? url),
      title: `Dead resource referenced ${count} time(s) from this site`,
      rationale: `Our crawl found ${url} returning an error while ${count} of our pages still link to it — other sites are likely linking to it too.`,
      suggestedAction: 'Fix our own link, and consider publishing a replacement resource that pages still citing the dead URL could point to instead.',
      priority: Math.min(80, 40 + count * 5),
    }));
}

/** Keys the technical-audit rules use for the URL a broken outbound link pointed at. */
const EVIDENCE_URL_KEYS = ['target', 'targetUrl', 'href', 'link', 'externalUrl', 'url'] as const;

/** Pull the dead outbound URL out of a `TechnicalIssue.evidence` blob, if it carries one. */
function readEvidenceUrl(evidence: unknown): string | null {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) return null;
  const record = evidence as Record<string, unknown>;
  for (const key of EVIDENCE_URL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/** Path fragments that identify a curated link/resource page. */
const RESOURCE_PATH_PATTERN = /\/(resources?|links?|tools?|directory|recommend(ed|ations)?|useful|library|blogroll)(\/|$|\.)/i;

/**
 * Resource pages of the kind that already link to us.
 *
 * Rather than guessing at footprints, this starts from proof: URLs in our own backlink table
 * whose path looks like a curated resource list. Those are the page types that demonstrably
 * accept sites like ours, and each one names a domain worth checking for similar pages.
 */
async function findResourcePageCandidates(websiteId: string): Promise<LinkOpportunity[]> {
  const links = await prisma.backlink.findMany({
    where: { websiteId, status: { not: BACKLINK_STATUS_LOST }, isFollow: true },
    select: { sourceUrl: true, referringDomain: true, domainAuthority: true, targetUrl: true },
    take: 20_000,
  });

  const seen = new Set<string>();
  const out: LinkOpportunity[] = [];
  for (const link of links) {
    if (!RESOURCE_PATH_PATTERN.test(link.sourceUrl)) continue;
    const domain = cleanDomain(link.referringDomain || link.sourceUrl);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push({
      kind: 'RESOURCE_PAGE',
      url: link.sourceUrl,
      domain,
      title: `Resource page on ${domain}`,
      rationale: `${domain} curates a resource list that already links to ${link.targetUrl}, so this page type accepts sites like ours.`,
      suggestedAction: 'Check the list is current and look for comparable resource pages in the same niche; any contact is a manual, individual decision.',
      priority: Math.min(75, 40 + (link.domainAuthority ?? 0) / 3),
    });
    if (out.length >= MAX_PER_CHECK) break;
  }
  return out;
}

/**
 * Our own content worth promoting: pages that already earn search traffic but almost no
 * links. Those have proven demand and are the cheapest assets to turn into linkable ones.
 */
async function findLinkableAssets(websiteId: string): Promise<LinkOpportunity[]> {
  const pages = await prisma.page.findMany({
    where: { websiteId, isActive: true, isIndexable: true, impressions28d: { gt: 0 } },
    select: { url: true, normalizedUrl: true, title: true, clicks28d: true, impressions28d: true },
    orderBy: { impressions28d: 'desc' },
    take: 200,
  });
  if (pages.length === 0) return [];

  const links = await prisma.backlink.findMany({
    where: { websiteId, status: { not: BACKLINK_STATUS_LOST } },
    select: { targetUrl: true, referringDomain: true },
    take: 20_000,
  });

  const domainsByTarget = new Map<string, Set<string>>();
  for (const link of links) {
    const normalized = normalizeUrl(link.targetUrl);
    if (!normalized) continue;
    const set = domainsByTarget.get(normalized) ?? new Set<string>();
    set.add(cleanDomain(link.referringDomain));
    domainsByTarget.set(normalized, set);
  }

  const maxImpressions = pages[0]?.impressions28d ?? 1;
  return pages
    .map((page) => ({ page, domains: domainsByTarget.get(page.normalizedUrl)?.size ?? 0 }))
    // Two or fewer referring domains on a page with real impressions is an under-linked asset.
    .filter((entry) => entry.domains <= 2)
    .slice(0, MAX_PER_CHECK)
    .map(({ page, domains }) => ({
      kind: 'LINKABLE_ASSET' as const,
      url: page.url,
      domain: cleanDomain(page.url),
      title: page.title ?? page.url,
      rationale: `${page.impressions28d} impressions and ${page.clicks28d} clicks in 28 days from only ${domains} referring domain(s) — proven demand, almost no links.`,
      suggestedAction: 'Consider deepening this page into a genuinely citable asset (original data, a tool, a definitive guide) so it earns links on its merits.',
      priority: Math.min(85, 35 + Math.round(safeDivide(page.impressions28d, maxImpressions, 0) * 50)),
    }));
}
