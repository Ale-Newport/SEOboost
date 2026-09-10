import { z } from 'zod';
import { prisma } from '@seo/db';
import { readQuery, route } from '@/lib/api';
import { intParam } from '@/server/queries/filters';

/**
 * Global search for the command palette.
 *
 * Built for keystroke latency, not completeness: every entity is capped at a handful of rows,
 * each query is anchored on an indexed `websiteId` before the text match narrows it, and the
 * seven lookups run concurrently. Anything that needs ranking, facets or paging belongs on the
 * entity's own list screen — which is exactly what these results link to.
 */

export type SearchGroup =
  | 'site'
  | 'page'
  | 'keyword'
  | 'issue'
  | 'action'
  | 'competitor'
  | 'content';

export interface SearchResult {
  group: SearchGroup;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** Null for portfolio-level hits; the palette uses it to show which site a result belongs to. */
  websiteId: string | null;
}

const querySchema = z.object({
  q: z.string().trim().max(200).default(''),
  /** Restrict to one site — the palette passes this when opened from inside a site. */
  websiteId: z.string().trim().max(60).optional(),
  limit: intParam.min(1).max(10).optional(),
});

/** Below two characters a substring search matches most of the database; not worth the scan. */
const MIN_QUERY_LENGTH = 2;

function truncateSubtitle(value: string, max = 120): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const q = query.q.trim();
  const limit = query.limit ?? 5;

  if (q.length < MIN_QUERY_LENGTH) {
    return { query: q, results: [] as SearchResult[], counts: {}, tooShort: true };
  }

  const websites = await prisma.website.findMany({
    where: {
      userId: user.id,
      ...(query.websiteId ? { id: query.websiteId } : {}),
    },
    select: { id: true, name: true, domain: true },
  });

  if (websites.length === 0) {
    return { query: q, results: [] as SearchResult[], counts: {}, tooShort: false };
  }

  const websiteIds = websites.map((website) => website.id);
  const scope = { websiteId: { in: websiteIds } };
  const nameOf = new Map(websites.map((website) => [website.id, website.name]));
  const insensitive = { contains: q, mode: 'insensitive' as const };

  const [pages, keywords, issues, actions, competitors, drafts] = await Promise.all([
    prisma.page.findMany({
      where: {
        ...scope,
        isActive: true,
        OR: [{ url: insensitive }, { title: insensitive }],
      },
      select: { id: true, websiteId: true, url: true, title: true, clicks28d: true },
      orderBy: { clicks28d: 'desc' },
      take: limit,
    }),
    prisma.keyword.findMany({
      where: { ...scope, keyword: insensitive },
      select: {
        id: true,
        websiteId: true,
        keyword: true,
        currentPosition: true,
        impressions28d: true,
      },
      orderBy: { impressions28d: 'desc' },
      take: limit,
    }),
    prisma.technicalIssue.findMany({
      where: {
        ...scope,
        status: { in: ['OPEN', 'REGRESSED'] },
        OR: [{ title: insensitive }, { ruleId: insensitive }, { url: insensitive }],
      },
      select: { id: true, websiteId: true, title: true, ruleId: true, severity: true, url: true },
      orderBy: [{ severity: 'asc' }, { estimatedImpact: 'desc' }],
      take: limit,
    }),
    prisma.seoAction.findMany({
      where: { ...scope, title: insensitive },
      select: { id: true, websiteId: true, title: true, status: true, type: true, priorityScore: true },
      orderBy: { priorityScore: 'desc' },
      take: limit,
    }),
    prisma.competitor.findMany({
      where: {
        ...scope,
        OR: [{ domain: insensitive }, { name: insensitive }],
      },
      select: { id: true, websiteId: true, domain: true, name: true, serpOverlapPct: true },
      orderBy: { serpOverlapPct: 'desc' },
      take: limit,
    }),
    prisma.contentDraft.findMany({
      where: {
        ...scope,
        OR: [{ title: insensitive }, { targetKeyword: insensitive }],
      },
      select: { id: true, websiteId: true, title: true, stage: true, targetKeyword: true },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
  ]);

  const lower = q.toLowerCase();
  const siteResults: SearchResult[] = websites
    .filter(
      (website) =>
        website.name.toLowerCase().includes(lower) || website.domain.toLowerCase().includes(lower),
    )
    .slice(0, limit)
    .map((website) => ({
      group: 'site',
      id: website.id,
      title: website.name,
      subtitle: website.domain,
      href: `/sites/${website.id}`,
      websiteId: website.id,
    }));

  const siteLabel = (websiteId: string) => nameOf.get(websiteId) ?? '';

  const results: SearchResult[] = [
    ...siteResults,
    ...pages.map<SearchResult>((page) => ({
      group: 'page',
      id: page.id,
      title: page.title ?? page.url,
      subtitle: truncateSubtitle(`${siteLabel(page.websiteId)} · ${page.url}`),
      href: `/sites/${page.websiteId}/pages/${page.id}`,
      websiteId: page.websiteId,
    })),
    ...keywords.map<SearchResult>((keyword) => ({
      group: 'keyword',
      id: keyword.id,
      title: keyword.keyword,
      subtitle: truncateSubtitle(
        [
          siteLabel(keyword.websiteId),
          keyword.currentPosition === null
            ? 'not ranking'
            : `position ${keyword.currentPosition.toFixed(1)}`,
          `${keyword.impressions28d.toLocaleString()} impressions / 28d`,
        ].join(' · '),
      ),
      href: `/sites/${keyword.websiteId}/keywords?search=${encodeURIComponent(keyword.keyword)}`,
      websiteId: keyword.websiteId,
    })),
    ...issues.map<SearchResult>((issue) => ({
      group: 'issue',
      id: issue.id,
      title: issue.title,
      subtitle: truncateSubtitle(
        [siteLabel(issue.websiteId), issue.severity, issue.url ?? issue.ruleId].join(' · '),
      ),
      href: `/sites/${issue.websiteId}/technical?rule=${encodeURIComponent(issue.ruleId)}`,
      websiteId: issue.websiteId,
    })),
    ...actions.map<SearchResult>((action) => ({
      group: 'action',
      id: action.id,
      title: action.title,
      subtitle: truncateSubtitle(
        [siteLabel(action.websiteId), action.type, action.status].join(' · '),
      ),
      href: `/actions?focus=${action.id}`,
      websiteId: action.websiteId,
    })),
    ...competitors.map<SearchResult>((competitor) => ({
      group: 'competitor',
      id: competitor.id,
      title: competitor.name ?? competitor.domain,
      subtitle: truncateSubtitle(`${siteLabel(competitor.websiteId)} · ${competitor.domain}`),
      href: `/sites/${competitor.websiteId}/competitors?search=${encodeURIComponent(competitor.domain)}`,
      websiteId: competitor.websiteId,
    })),
    ...drafts.map<SearchResult>((draft) => ({
      group: 'content',
      id: draft.id,
      title: draft.title,
      subtitle: truncateSubtitle(
        [siteLabel(draft.websiteId), draft.stage, draft.targetKeyword ?? ''].filter(Boolean).join(' · '),
      ),
      href: `/sites/${draft.websiteId}/content?focus=${draft.id}`,
      websiteId: draft.websiteId,
    })),
  ];

  const counts = results.reduce<Record<string, number>>((acc, result) => {
    acc[result.group] = (acc[result.group] ?? 0) + 1;
    return acc;
  }, {});

  return { query: q, results, counts, tooShort: false };
});
