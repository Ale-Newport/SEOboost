import { z } from 'zod';
import { EntityType, prisma, readJson } from '@seo/db';
import { scoreEntityCoverage, type EntityCandidate, type EntityTypeValue } from '@seo/seo-engine';
import { readQuery, route } from '@/lib/api';
import {
  multiValueParam,
  parseEnumList,
  requireScopedWebsite,
  websiteScopeSchema,
} from '@/app/api/_lib/common';

/**
 * `GET /api/entities?websiteId=` — the entity graph plus its coverage gaps.
 *
 * Coverage is scored against the pages' own text, so the gap list says "the site never explains
 * this" with evidence rather than as an opinion. Page text lives on `CrawlPage`, not on `Page`,
 * so a bounded sample of the most recent crawl's text is loaded for the check — the goal is to
 * find entities that are *never* explained anywhere prominent, which a sample of the site's
 * most linked pages answers well.
 */

const querySchema = websiteScopeSchema.extend({
  type: multiValueParam,
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(300),
});

/** How many pages of text the coverage check reads. Bounded so the request stays predictable. */
const COVERAGE_PAGE_SAMPLE = 200;

/** `Entity.source` is a free-form column; the engine's candidate type is a closed set. */
function toCandidateSource(source: string): EntityCandidate['source'] {
  return source === 'schema' || source === 'knowledge-base' || source === 'content' ? source : 'ai';
}

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireScopedWebsite(user, query.websiteId);

  const types = parseEnumList(query.type, Object.values(EntityType));
  const search = query.search?.trim();

  const entities = await prisma.entity.findMany({
    where: {
      websiteId: website.id,
      ...(types?.length ? { type: { in: types } } : {}),
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
    },
    orderBy: [{ isPrimary: 'desc' }, { mentionCount: 'desc' }, { name: 'asc' }],
    take: query.limit,
    select: {
      id: true,
      name: true,
      type: true,
      description: true,
      aliases: true,
      sameAs: true,
      canonicalUrl: true,
      attributes: true,
      confidence: true,
      mentionCount: true,
      isPrimary: true,
      source: true,
      updatedAt: true,
    },
  });

  const entityIds = entities.map((entity) => entity.id);
  const relationships = entityIds.length
    ? await prisma.entityRelationship.findMany({
        where: { OR: [{ fromId: { in: entityIds } }, { toId: { in: entityIds } }] },
        select: {
          id: true,
          fromId: true,
          toId: true,
          relation: true,
          weight: true,
          evidence: true,
          from: { select: { id: true, name: true, type: true } },
          to: { select: { id: true, name: true, type: true } },
        },
        take: 2_000,
      })
    : [];

  const latestCrawl = await prisma.crawl.findFirst({
    where: { websiteId: website.id, status: 'COMPLETED' },
    orderBy: { finishedAt: 'desc' },
    select: { id: true, finishedAt: true },
  });

  const samplePages = latestCrawl
    ? await prisma.crawlPage.findMany({
        where: { crawlId: latestCrawl.id, textContent: { not: null } },
        orderBy: { depth: 'asc' },
        take: COVERAGE_PAGE_SAMPLE,
        select: { url: true, textContent: true, page: { select: { pageType: true } } },
      })
    : [];

  const candidates: EntityCandidate[] = entities.map((entity) => ({
    name: entity.name,
    // The Prisma enum and the engine's union are the same set of names by construction.
    type: entity.type as EntityTypeValue,
    description: entity.description,
    aliases: entity.aliases,
    confidence: entity.confidence,
    mentionCount: entity.mentionCount,
    source: toCandidateSource(entity.source),
    canonicalUrl: entity.canonicalUrl,
    sameAs: entity.sameAs,
  }));

  // With no crawled text there is nothing to measure coverage *against*, and scoring anyway
  // would report every entity as unexplained. Report "not measured" instead.
  const coverage =
    samplePages.length > 0
      ? scoreEntityCoverage(
          candidates,
          samplePages.map((page) => ({
            url: page.url,
            pageType: page.page?.pageType ?? 'OTHER',
            textContent: page.textContent,
          })),
        )
      : { score: null, gaps: [] };

  const byType: Record<string, number> = {};
  for (const entity of entities) byType[entity.type] = (byType[entity.type] ?? 0) + 1;

  return {
    websiteId: website.id,
    entities: entities.map((entity) => ({
      ...entity,
      attributes: readJson<Record<string, unknown>>(entity.attributes, {}),
    })),
    relationships,
    coverage: {
      ...coverage,
      // Without a crawl there is no text to check against, so the score would be meaningless.
      measured: samplePages.length > 0,
      pagesSampled: samplePages.length,
      crawlId: latestCrawl?.id ?? null,
      crawledAt: latestCrawl?.finishedAt ?? null,
    },
    summary: { total: entities.length, byType },
  };
});
