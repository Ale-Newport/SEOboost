import 'server-only';
import { Prisma, prisma } from '@seo/db';
import { ForbiddenError, NotFoundError, cleanDomain, round } from '@seo/shared';
import {
  BACKLINK_STATUS_LOST,
  MAX_CSV_ROWS,
  analyseBacklinks,
  listBacklinkProviders,
  type BacklinkAnalysis,
  type BacklinkProviderInfo,
} from '@seo/integrations/backlinks/index';

/**
 * Read model for the backlinks screen.
 *
 * The profile analysis (`analyseBacklinks`) reads only stored `Backlink` rows, so it behaves
 * identically whether those rows arrived from a paid API or a CSV the operator dropped in —
 * which is why this feature has no hard dependency on a provider key.
 *
 * Flags are *not* persisted from here: a page render is a read. The worker owns writing
 * `Backlink.isSuspicious`; this recomputes the same heuristics for display.
 */

export type BacklinkFollowFilter = 'all' | 'follow' | 'nofollow';
export type BacklinkStatusFilter = 'all' | 'active' | 'lost';

export interface BacklinkRowView {
  id: string;
  referringDomain: string;
  sourceUrl: string;
  targetUrl: string;
  anchorText: string | null;
  isFollow: boolean;
  domainAuthority: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lostAt: Date | null;
  status: string;
  isSuspicious: boolean;
  /** Slug of whatever produced the row (`csv`, `ahrefs`, …). */
  provider: string;
}

export interface SuspiciousDomainView {
  referringDomain: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  reasons: string[];
  /** The heuristic's own evidence — what was counted, not just the verdict. */
  evidence: string[];
  links: number;
}

export interface BacklinksQueryOptions {
  windowDays?: number;
  page?: number;
  pageSize?: number;
  search?: string;
  follow?: BacklinkFollowFilter;
  status?: BacklinkStatusFilter;
  suspiciousOnly?: boolean;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface BacklinksData {
  website: { id: string; name: string; domain: string; protocol: string };
  /** True once at least one row has ever been stored for this site. */
  hasData: boolean;
  storedLinks: number;
  analysis: BacklinkAnalysis | null;
  suspicious: SuspiciousDomainView[];
  links: {
    rows: BacklinkRowView[];
    total: number;
    page: number;
    pageSize: number;
    sort: string;
    order: 'asc' | 'desc';
  };
  /** Links first seen inside the window. */
  newLinks: BacklinkRowView[];
  /** Links reported lost inside the window. */
  lostLinks: BacklinkRowView[];
  providers: BacklinkProviderInfo[];
  anyProviderConfigured: boolean;
  /** Ceiling the CSV importer enforces, surfaced so the upload panel can state it. */
  maxCsvRows: number;
}

const LINK_SELECT = {
  id: true,
  referringDomain: true,
  sourceUrl: true,
  targetUrl: true,
  anchorText: true,
  isFollow: true,
  domainAuthority: true,
  firstSeenAt: true,
  lastSeenAt: true,
  lostAt: true,
  status: true,
  isSuspicious: true,
  provider: true,
} satisfies Prisma.BacklinkSelect;

const SORTABLE = new Set(['referringDomain', 'anchorText', 'domainAuthority', 'firstSeenAt', 'lastSeenAt', 'status']);

/** Human labels for the suspicious-link heuristics, so the table never shows a raw enum. */
const REASON_LABELS: Record<string, string> = {
  EXACT_MATCH_ANCHOR_OVER_OPTIMISATION: 'Exact-match anchor over-optimisation',
  SPAM_TLD: 'Abuse-heavy TLD',
  SPAM_DOMAIN_PATTERN: 'Spam-shaped domain name',
  SITEWIDE_LINK: 'Sitewide / template placement',
  LINK_BURST: 'Sudden burst of links',
};

export function backlinkReasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

function orderByFor(sort: string, order: 'asc' | 'desc'): Prisma.BacklinkOrderByWithRelationInput {
  switch (sort) {
    case 'referringDomain':
      return { referringDomain: order };
    case 'anchorText':
      return { anchorText: order };
    case 'domainAuthority':
      // Nulls last in both directions: "no metric reported" is not "the weakest domain".
      return { domainAuthority: { sort: order, nulls: 'last' } };
    case 'lastSeenAt':
      return { lastSeenAt: order };
    case 'status':
      return { status: order };
    default:
      return { firstSeenAt: order };
  }
}

/** Everything the backlinks screen renders, in one pass. */
export async function getBacklinksData(
  userId: string,
  websiteId: string,
  options: BacklinksQueryOptions = {},
): Promise<BacklinksData> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, userId: true, name: true, domain: true, protocol: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const windowDays = Math.min(365, Math.max(1, Math.floor(options.windowDays ?? 30)));
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.min(200, Math.max(10, Math.floor(options.pageSize ?? 50)));
  const sort = options.sort && SORTABLE.has(options.sort) ? options.sort : 'firstSeenAt';
  const order = options.order === 'asc' ? 'asc' : 'desc';
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const storedLinks = await prisma.backlink.count({ where: { websiteId } });
  const providers = listBacklinkProviders();

  if (storedLinks === 0) {
    return {
      website: { id: website.id, name: website.name, domain: website.domain, protocol: website.protocol },
      hasData: false,
      storedLinks: 0,
      analysis: null,
      suspicious: [],
      links: { rows: [], total: 0, page: 1, pageSize, sort, order },
      newLinks: [],
      lostLinks: [],
      providers,
      anyProviderConfigured: providers.some((provider) => provider.configured),
      maxCsvRows: MAX_CSV_ROWS,
    };
  }

  const search = options.search?.trim() ?? '';
  const where: Prisma.BacklinkWhereInput = {
    websiteId,
    ...(options.follow === 'follow' ? { isFollow: true } : {}),
    ...(options.follow === 'nofollow' ? { isFollow: false } : {}),
    ...(options.status === 'lost' ? { status: BACKLINK_STATUS_LOST } : {}),
    ...(options.status === 'active' ? { status: { not: BACKLINK_STATUS_LOST } } : {}),
    ...(options.suspiciousOnly ? { isSuspicious: true } : {}),
    ...(search
      ? {
          OR: [
            { referringDomain: { contains: search, mode: 'insensitive' } },
            { sourceUrl: { contains: search, mode: 'insensitive' } },
            { targetUrl: { contains: search, mode: 'insensitive' } },
            { anchorText: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [analysis, total, rows, newLinks, lostLinks] = await Promise.all([
    // persistFlags:false — rendering a page must not write to the database.
    analyseBacklinks(websiteId, { windowDays, topDomains: 50, persistFlags: false }),
    prisma.backlink.count({ where }),
    prisma.backlink.findMany({
      where,
      select: LINK_SELECT,
      orderBy: orderByFor(sort, order),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.backlink.findMany({
      where: { websiteId, firstSeenAt: { gte: since } },
      select: LINK_SELECT,
      orderBy: { firstSeenAt: 'desc' },
      take: 50,
    }),
    prisma.backlink.findMany({
      where: { websiteId, lostAt: { gte: since } },
      select: LINK_SELECT,
      orderBy: { lostAt: 'desc' },
      take: 50,
    }),
  ]);

  const suspicious: SuspiciousDomainView[] = analysis.suspicious.slice(0, 100).map((finding) => ({
    referringDomain: cleanDomain(finding.referringDomain),
    severity: finding.severity,
    reasons: finding.reasons.map(backlinkReasonLabel),
    evidence: finding.evidence,
    links: finding.linkIds.length,
  }));

  return {
    website: { id: website.id, name: website.name, domain: website.domain, protocol: website.protocol },
    hasData: true,
    storedLinks,
    analysis: {
      ...analysis,
      risk: { ...analysis.risk, score: round(analysis.risk.score, 1) },
    },
    suspicious,
    links: { rows, total, page, pageSize, sort, order },
    newLinks,
    lostLinks,
    providers,
    anyProviderConfigured: providers.some((provider) => provider.configured),
    maxCsvRows: MAX_CSV_ROWS,
  };
}
