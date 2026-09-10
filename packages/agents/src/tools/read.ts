import { z } from 'zod';
import { buildPaginated, paginate, prisma } from '@seo/db';
import type { Prisma } from '@seo/db';
import { embedTexts, findSimilar, isEmbeddingAvailable } from '@seo/ai';
import {
  analyseKeywordGaps,
  buildCompetitorOverview,
  buildLinkGraph,
  summariseActionOutcomes,
  type CompetitorKeywordRow,
  type GraphInputEdge,
  type GraphInputPage,
  type OurKeywordRow,
} from '@seo/seo-engine';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  NotFoundError,
  ValidationError,
  errorMessage,
  isConfigured,
  lastNDays,
  lexicalCosine,
  normalizeKeyword,
  normalizeUrl,
  previousPeriod,
  round,
  safeDivide,
  tokenize,
  truncate,
  type Paginated,
} from '@seo/shared';
import type { AgentContext } from '../types';
import { getBoundAgentName } from '../runtime/registry';
import { defineTool, type AnyToolDefinition } from './define';

/**
 * Read tools — the only way an agent obtains context.
 *
 * Each one answers a specific question with a bounded, already-aggregated result. That shape is
 * the point: an agent that could `SELECT *` would put a hundred thousand rows into a prompt,
 * which is both ruinously expensive and worse at reasoning than fifty well-chosen ones. Every
 * query here is scoped to `context.websiteId`, and anything that depends on an integration that
 * is not connected returns `{ available: false, reason }` rather than an invented number.
 */

const PAGE_TYPES = [
  'HOMEPAGE', 'ARTICLE', 'BLOG_INDEX', 'LANDING', 'PRODUCT', 'CATEGORY', 'COMPARISON',
  'GLOSSARY', 'FAQ', 'ABOUT', 'CONTACT', 'LEGAL', 'AUTHOR', 'OTHER',
] as const;

const ISSUE_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;
const ISSUE_STATUSES = ['OPEN', 'IGNORED', 'IN_PROGRESS', 'RESOLVED', 'REGRESSED'] as const;
const ISSUE_CATEGORIES = [
  'CRAWLABILITY', 'INDEXABILITY', 'METADATA', 'CONTENT', 'LINKS', 'ARCHITECTURE',
  'STRUCTURED_DATA', 'PERFORMANCE', 'SECURITY', 'INTERNATIONAL', 'GEO',
] as const;
const SEARCH_INTENTS = [
  'INFORMATIONAL', 'NAVIGATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'LOCAL', 'UNKNOWN',
] as const;
const FUNNEL_STAGES = ['AWARENESS', 'CONSIDERATION', 'DECISION', 'UNKNOWN'] as const;
const ACTION_STATUSES = [
  'PROPOSED', 'QUEUED', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING',
  'COMPLETED', 'FAILED', 'ROLLED_BACK', 'CANCELLED', 'MEASURING', 'EVALUATED',
] as const;
const ACTION_TYPES = [
  'FIX_TECHNICAL_ISSUE', 'UPDATE_TITLE', 'UPDATE_META_DESCRIPTION', 'UPDATE_CONTENT',
  'PUBLISH_CONTENT', 'CREATE_CONTENT_BRIEF', 'ADD_INTERNAL_LINKS', 'ADD_STRUCTURED_DATA',
  'CREATE_REDIRECT', 'REFRESH_CONTENT', 'CONSOLIDATE_PAGES', 'SUBMIT_URL_INDEXING',
  'GEO_IMPROVEMENT', 'OUTREACH_DRAFT', 'CUSTOM',
] as const;

/** Search Console data lands ~2-3 days late; every default window accounts for that. */
const GSC_LAG_DAYS = 3;

const pageSizeField = z.number().int().min(1).max(MAX_PAGE_SIZE).optional();
const pageField = z.number().int().min(1).optional();

function clampPageSize(value: number | undefined): number {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, value ?? DEFAULT_PAGE_SIZE));
}

/** Resolve a page by id or URL, always inside the context's site. */
async function resolvePageId(
  context: AgentContext,
  args: { pageId?: string; url?: string },
): Promise<string> {
  if (args.pageId) {
    const row = await prisma.page.findFirst({
      where: { id: args.pageId, websiteId: context.websiteId },
      select: { id: true },
    });
    if (!row) throw new NotFoundError('Page');
    return row.id;
  }
  if (args.url) {
    const normalized = normalizeUrl(args.url) ?? args.url;
    const row = await prisma.page.findFirst({
      where: { websiteId: context.websiteId, OR: [{ normalizedUrl: normalized }, { url: args.url }] },
      select: { id: true },
    });
    if (!row) throw new NotFoundError('Page');
    return row.id;
  }
  throw new ValidationError('Provide either pageId or url.');
}

// ── getWebsite ───────────────────────────────────────────────

export interface GetWebsiteResult {
  website: {
    id: string;
    name: string;
    domain: string;
    protocol: string;
    status: string;
    description: string | null;
    businessCategory: string | null;
    targetAudience: string | null;
    conversionGoal: string | null;
    brandName: string | null;
    cmsType: string;
    primaryLanguage: string;
    targetLocales: string[];
    targetCountry: string;
    healthScore: number | null;
    geoScore: number | null;
    aiVisibilityScore: number | null;
    contentScore: number | null;
    lastCrawlAt: Date | null;
    lastAnalysisAt: Date | null;
  };
  settings: {
    autonomyLevel: string;
    autoApproveSafe: boolean;
    thinContentWords: number;
    strikingDistanceMin: number;
    strikingDistanceMax: number;
    ctrOpportunityMinImpressions: number;
    monthlyAiBudgetUsd: number | null;
  } | null;
  /** Connection state only — credentials never leave the server. */
  integrations: Array<{ provider: string; status: string; lastSyncAt: Date | null; lastError: string | null }>;
  counts: {
    pages: number;
    indexablePages: number;
    orphanPages: number;
    keywords: number;
    openIssues: number;
    criticalIssues: number;
    competitors: number;
  };
  lastCrawl: { id: string; status: string; pagesCrawled: number; finishedAt: Date | null } | null;
}

const getWebsite = defineTool({
  name: 'getWebsite',
  description: 'The site profile, its automation settings, integration connection state and headline counts.',
  readOnly: true,
  schema: z.object({}),
  async execute(_args, context): Promise<GetWebsiteResult> {
    const [website, settings, integrations, lastCrawl, pages, indexable, orphans, keywords, openIssues, criticalIssues, competitors] =
      await Promise.all([
        prisma.website.findUnique({ where: { id: context.websiteId } }),
        prisma.websiteSettings.findUnique({ where: { websiteId: context.websiteId } }),
        prisma.integration.findMany({
          where: { websiteId: context.websiteId },
          select: { provider: true, status: true, lastSyncAt: true, lastError: true },
        }),
        prisma.crawl.findFirst({
          where: { websiteId: context.websiteId, status: 'COMPLETED' },
          orderBy: { finishedAt: 'desc' },
          select: { id: true, status: true, pagesCrawled: true, finishedAt: true },
        }),
        prisma.page.count({ where: { websiteId: context.websiteId, isActive: true } }),
        prisma.page.count({ where: { websiteId: context.websiteId, isActive: true, isIndexable: true } }),
        prisma.page.count({ where: { websiteId: context.websiteId, isActive: true, isOrphan: true } }),
        prisma.keyword.count({ where: { websiteId: context.websiteId } }),
        prisma.technicalIssue.count({ where: { websiteId: context.websiteId, status: 'OPEN' } }),
        prisma.technicalIssue.count({
          where: { websiteId: context.websiteId, status: 'OPEN', severity: 'CRITICAL' },
        }),
        prisma.competitor.count({ where: { websiteId: context.websiteId, isActive: true } }),
      ]);

    if (!website) throw new NotFoundError('Website');

    return {
      website: {
        id: website.id,
        name: website.name,
        domain: website.domain,
        protocol: website.protocol,
        status: website.status,
        description: website.description,
        businessCategory: website.businessCategory,
        targetAudience: website.targetAudience,
        conversionGoal: website.conversionGoal,
        brandName: website.brandName,
        cmsType: website.cmsType,
        primaryLanguage: website.primaryLanguage,
        targetLocales: website.targetLocales,
        targetCountry: website.targetCountry,
        healthScore: website.healthScore,
        geoScore: website.geoScore,
        aiVisibilityScore: website.aiVisibilityScore,
        contentScore: website.contentScore,
        lastCrawlAt: website.lastCrawlAt,
        lastAnalysisAt: website.lastAnalysisAt,
      },
      settings: settings
        ? {
            autonomyLevel: settings.autonomyLevel,
            autoApproveSafe: settings.autoApproveSafe,
            thinContentWords: settings.thinContentWords,
            strikingDistanceMin: settings.strikingDistanceMin,
            strikingDistanceMax: settings.strikingDistanceMax,
            ctrOpportunityMinImpressions: settings.ctrOpportunityMinImpressions,
            monthlyAiBudgetUsd: settings.monthlyAiBudgetUsd,
          }
        : null,
      integrations,
      counts: {
        pages,
        indexablePages: indexable,
        orphanPages: orphans,
        keywords,
        openIssues,
        criticalIssues,
        competitors,
      },
      lastCrawl,
    };
  },
});

// ── getWebsiteKnowledge ──────────────────────────────────────

export interface GetWebsiteKnowledgeResult {
  knowledgeBase: {
    businessDescription: string | null;
    products: unknown;
    audience: string | null;
    toneOfVoice: string | null;
    brandStyle: string | null;
    terminology: unknown;
    preferredCta: string | null;
    prohibitedClaims: string[];
    writingGuidelines: string | null;
    uniqueValueProps: string[];
    authorBios: unknown;
  } | null;
  /** Only facts a human marked verified and that have not expired. */
  verifiedFacts: Array<{ fact: string; category: string | null; source: string; sourceUrl: string | null; verifiedAt: Date | null }>;
  unverifiedFactCount: number;
  note: string;
}

const getWebsiteKnowledge = defineTool({
  name: 'getWebsiteKnowledge',
  description:
    'The operator-maintained knowledge base plus VERIFIED brand facts. Unverified facts are never returned — writers may not assert them.',
  readOnly: true,
  schema: z.object({ factLimit: z.number().int().min(1).max(200).optional() }),
  async execute(args, context): Promise<GetWebsiteKnowledgeResult> {
    const now = new Date();
    const [knowledge, facts, unverifiedFactCount] = await Promise.all([
      prisma.knowledgeBase.findUnique({ where: { websiteId: context.websiteId } }),
      prisma.brandFact.findMany({
        where: {
          websiteId: context.websiteId,
          verified: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: { updatedAt: 'desc' },
        take: args.factLimit ?? 100,
        select: { fact: true, category: true, source: true, sourceUrl: true, verifiedAt: true },
      }),
      prisma.brandFact.count({ where: { websiteId: context.websiteId, verified: false } }),
    ]);

    return {
      knowledgeBase: knowledge
        ? {
            businessDescription: knowledge.businessDescription,
            products: knowledge.products,
            audience: knowledge.audience,
            toneOfVoice: knowledge.toneOfVoice,
            brandStyle: knowledge.brandStyle,
            terminology: knowledge.terminology,
            preferredCta: knowledge.preferredCta,
            prohibitedClaims: knowledge.prohibitedClaims,
            writingGuidelines: knowledge.writingGuidelines,
            uniqueValueProps: knowledge.uniqueValueProps,
            authorBios: knowledge.authorBios,
          }
        : null,
      verifiedFacts: facts,
      unverifiedFactCount,
      note:
        'Only the facts listed here may be asserted as true about this business. Anything else must be ' +
        'attributed to a cited external source or left out.',
    };
  },
});

// ── getPage ──────────────────────────────────────────────────

export interface GetPageResult {
  page: {
    id: string;
    url: string;
    path: string;
    pageType: string;
    title: string | null;
    metaDescription: string | null;
    h1: string | null;
    canonicalUrl: string | null;
    wordCount: number;
    statusCode: number | null;
    depth: number;
    isIndexable: boolean;
    indexabilityReason: string | null;
    inSitemap: boolean;
    schemaTypes: string[];
    internalLinksIn: number;
    internalLinksOut: number;
    isOrphan: boolean;
    clicks28d: number;
    impressions28d: number;
    ctr28d: number | null;
    position28d: number | null;
    clicksTrendPct: number | null;
    seoScore: number | null;
    geoScore: number | null;
    opportunityScore: number | null;
    readabilityScore: number | null;
    publishedAt: Date | null;
    contentUpdatedAt: Date | null;
    lastCrawledAt: Date | null;
  };
  issues: Array<{ id: string; ruleId: string; title: string; severity: string; category: string; recommendation: string }>;
  topQueries: Array<{ query: string; clicks: number; impressions: number; ctr: number; position: number }>;
  structuredData: Array<{ id: string; schemaType: string; validationStatus: string; deploymentStatus: string }>;
  /** Latest crawled body text, truncated. Null when the page has never been crawled. */
  contentPreview: string | null;
}

const getPage = defineTool({
  name: 'getPage',
  description: 'Everything known about one page: metadata, scores, open issues, top queries and structured data.',
  readOnly: true,
  schema: z.object({
    pageId: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    contentChars: z.number().int().min(0).max(20000).optional(),
  }),
  async execute(args, context): Promise<GetPageResult> {
    const pageId = await resolvePageId(context, args);
    const page = await prisma.page.findUniqueOrThrow({ where: { id: pageId } });

    const range = lastNDays(28, GSC_LAG_DAYS);
    const [issues, queryRows, structuredData, latestCrawlPage] = await Promise.all([
      prisma.technicalIssue.findMany({
        where: { pageId, status: { in: ['OPEN', 'REGRESSED'] } },
        orderBy: [{ severity: 'asc' }, { estimatedImpact: 'desc' }],
        take: 25,
        select: { id: true, ruleId: true, title: true, severity: true, category: true, recommendation: true },
      }),
      prisma.gscQueryMetric.groupBy({
        by: ['query'],
        where: {
          websiteId: context.websiteId,
          date: { gte: range.start, lte: range.end },
          OR: [{ pageId }, { page: page.url }],
        },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { _sum: { impressions: 'desc' } },
        take: 20,
      }),
      prisma.structuredDataItem.findMany({
        where: { pageId },
        select: { id: true, schemaType: true, validationStatus: true, deploymentStatus: true },
      }),
      prisma.crawlPage.findFirst({
        where: { pageId },
        orderBy: { crawledAt: 'desc' },
        select: { textContent: true },
      }),
    ]);

    const contentChars = args.contentChars ?? 4000;

    return {
      page: {
        id: page.id,
        url: page.url,
        path: page.path,
        pageType: page.pageType,
        title: page.title,
        metaDescription: page.metaDescription,
        h1: page.h1,
        canonicalUrl: page.canonicalUrl,
        wordCount: page.wordCount,
        statusCode: page.statusCode,
        depth: page.depth,
        isIndexable: page.isIndexable,
        indexabilityReason: page.indexabilityReason,
        inSitemap: page.inSitemap,
        schemaTypes: page.schemaTypes,
        internalLinksIn: page.internalLinksIn,
        internalLinksOut: page.internalLinksOut,
        isOrphan: page.isOrphan,
        clicks28d: page.clicks28d,
        impressions28d: page.impressions28d,
        ctr28d: page.ctr28d,
        position28d: page.position28d,
        clicksTrendPct: page.clicksTrendPct,
        seoScore: page.seoScore,
        geoScore: page.geoScore,
        opportunityScore: page.opportunityScore,
        readabilityScore: page.readabilityScore,
        publishedAt: page.publishedAt,
        contentUpdatedAt: page.contentUpdatedAt,
        lastCrawledAt: page.lastCrawledAt,
      },
      issues,
      topQueries: queryRows.map((row) => {
        const clicks = row._sum.clicks ?? 0;
        const impressions = row._sum.impressions ?? 0;
        return {
          query: row.query,
          clicks,
          impressions,
          ctr: round(safeDivide(clicks, impressions), 5),
          position: round(row._avg.position ?? 0, 2),
        };
      }),
      structuredData,
      contentPreview:
        contentChars > 0 && latestCrawlPage?.textContent
          ? truncate(latestCrawlPage.textContent, contentChars)
          : null,
    };
  },
});

// ── listPages ────────────────────────────────────────────────

export interface PageSummary {
  id: string;
  url: string;
  path: string;
  pageType: string;
  title: string | null;
  wordCount: number;
  isIndexable: boolean;
  isOrphan: boolean;
  depth: number;
  internalLinksIn: number;
  clicks28d: number;
  impressions28d: number;
  position28d: number | null;
  seoScore: number | null;
  opportunityScore: number | null;
  contentUpdatedAt: Date | null;
}

const PAGE_SORTS = [
  'opportunityScore', 'seoScore', 'clicks28d', 'impressions28d', 'position28d',
  'wordCount', 'depth', 'internalLinksIn', 'contentUpdatedAt',
] as const;

const listPages = defineTool({
  name: 'listPages',
  description: 'Filterable, paginated page list. Use filters instead of pulling the whole site.',
  readOnly: true,
  schema: z.object({
    page: pageField,
    pageSize: pageSizeField,
    pageType: z.enum(PAGE_TYPES).optional(),
    isIndexable: z.boolean().optional(),
    isOrphan: z.boolean().optional(),
    minWordCount: z.number().int().min(0).optional(),
    maxWordCount: z.number().int().min(0).optional(),
    minImpressions: z.number().int().min(0).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    sortBy: z.enum(PAGE_SORTS).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  }),
  async execute(args, context): Promise<Paginated<PageSummary>> {
    const pageNumber = args.page ?? 1;
    const pageSize = clampPageSize(args.pageSize);
    const sortBy = args.sortBy ?? 'opportunityScore';
    const order = args.order ?? 'desc';

    const where: Prisma.PageWhereInput = {
      websiteId: context.websiteId,
      isActive: true,
      ...(args.pageType ? { pageType: args.pageType } : {}),
      ...(args.isIndexable === undefined ? {} : { isIndexable: args.isIndexable }),
      ...(args.isOrphan === undefined ? {} : { isOrphan: args.isOrphan }),
      ...(args.minWordCount === undefined && args.maxWordCount === undefined
        ? {}
        : {
            wordCount: {
              ...(args.minWordCount === undefined ? {} : { gte: args.minWordCount }),
              ...(args.maxWordCount === undefined ? {} : { lte: args.maxWordCount }),
            },
          }),
      ...(args.minImpressions === undefined ? {} : { impressions28d: { gte: args.minImpressions } }),
      ...(args.search
        ? {
            OR: [
              { url: { contains: args.search, mode: 'insensitive' } },
              { title: { contains: args.search, mode: 'insensitive' } },
              { h1: { contains: args.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.page.findMany({
        where,
        orderBy: [{ [sortBy]: { sort: order, nulls: 'last' } }, { id: 'asc' }],
        ...paginate(pageNumber, pageSize),
        select: {
          id: true, url: true, path: true, pageType: true, title: true, wordCount: true,
          isIndexable: true, isOrphan: true, depth: true, internalLinksIn: true,
          clicks28d: true, impressions28d: true, position28d: true, seoScore: true,
          opportunityScore: true, contentUpdatedAt: true,
        },
      }),
      prisma.page.count({ where }),
    ]);

    return buildPaginated(items, total, pageNumber, pageSize);
  },
});

// ── searchSiteContent ────────────────────────────────────────

export interface SiteSearchMatch {
  pageId: string;
  url: string;
  title: string | null;
  score: number;
  wordCount: number;
  pageType: string;
}

export interface SearchSiteContentResult {
  method: 'semantic' | 'lexical';
  matches: SiteSearchMatch[];
  /** Why this method was used — so an operator can tell why results look shallow. */
  note: string;
}

const searchSiteContent = defineTool({
  name: 'searchSiteContent',
  description:
    'Find pages related to a query. Uses stored embeddings when available, otherwise a lexical match over crawled text.',
  readOnly: true,
  schema: z.object({
    query: z.string().trim().min(2).max(400),
    limit: z.number().int().min(1).max(50).optional(),
    minScore: z.number().min(0).max(1).optional(),
  }),
  async execute(args, context): Promise<SearchSiteContentResult> {
    const limit = args.limit ?? 10;
    const embeddingAvailable = isEmbeddingAvailable();
    const embeddedPages = embeddingAvailable
      ? await prisma.embeddingRecord.count({ where: { websiteId: context.websiteId, ownerType: 'PAGE' } })
      : 0;
    let providerFailure: string | null = null;

    if (embeddedPages > 0) {
      try {
        // The site's own embedding model has to be honoured: the stored vectors were produced
        // with it, and querying with a different model compares vectors that do not live in the
        // same space (or even have the same width).
        const settings = await prisma.websiteSettings.findUnique({
          where: { websiteId: context.websiteId },
          select: { embeddingModel: true, aiProvider: true },
        });
        const embedded = await embedTexts([args.query], {
          websiteId: context.websiteId,
          ...(settings ? { settings } : {}),
          task: 'agent:searchSiteContent',
          agent: getBoundAgentName(context.runId) ?? null,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        const vector = embedded.vectors[0];
        if (vector) {
          const matches = await findSimilar({
            websiteId: context.websiteId,
            ownerType: 'PAGE',
            vector,
            limit,
            minScore: args.minScore ?? 0.6,
          });
          const pageIds = matches.map((match) => match.pageId ?? match.ownerId);
          const pages = await prisma.page.findMany({
            where: { id: { in: pageIds }, websiteId: context.websiteId },
            select: { id: true, url: true, title: true, wordCount: true, pageType: true },
          });
          const byId = new Map(pages.map((page) => [page.id, page]));
          return {
            method: 'semantic',
            matches: matches.flatMap((match) => {
              const page = byId.get(match.pageId ?? match.ownerId);
              if (!page) return [];
              return [{
                pageId: page.id,
                url: page.url,
                title: page.title,
                score: match.score,
                wordCount: page.wordCount,
                pageType: page.pageType,
              }];
            }),
            note: `Cosine similarity over ${embeddedPages} stored page embeddings.`,
          };
        }
      } catch (err) {
        // Fall through to lexical rather than failing the agent: a provider hiccup should not
        // stop a run that can still do useful work with a weaker signal.
        providerFailure = errorMessage(err);
        context.log('embedding search failed, falling back to lexical', { error: providerFailure });
      }
    }

    const terms = tokenize(args.query, { minLength: 3 }).slice(0, 8);
    const orFilters: Prisma.PageWhereInput[] = [
      { title: { contains: args.query, mode: 'insensitive' } },
      { h1: { contains: args.query, mode: 'insensitive' } },
      { metaDescription: { contains: args.query, mode: 'insensitive' } },
      ...terms.map((term): Prisma.PageWhereInput => ({ title: { contains: term, mode: 'insensitive' } })),
      ...terms.map((term): Prisma.PageWhereInput => ({ url: { contains: term, mode: 'insensitive' } })),
    ];

    const candidates = await prisma.page.findMany({
      where: { websiteId: context.websiteId, isActive: true, OR: orFilters },
      take: Math.max(limit * 5, 50),
      select: { id: true, url: true, title: true, h1: true, metaDescription: true, wordCount: true, pageType: true },
    });

    const scored = candidates
      .map((page) => ({
        pageId: page.id,
        url: page.url,
        title: page.title,
        wordCount: page.wordCount,
        pageType: page.pageType,
        score: round(
          lexicalCosine(
            args.query,
            [page.title ?? '', page.h1 ?? '', page.metaDescription ?? '', page.url].join('. '),
          ),
          4,
        ),
      }))
      .filter((match) => match.score >= (args.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // The note has to name the real reason: "no provider configured" sends an operator to the
    // env file when the actual problem was a provider error or a missing embedding backfill.
    const note = !embeddingAvailable
      ? 'No embedding provider configured (set OPENAI_API_KEY or GOOGLE_AI_API_KEY). Matched on metadata text instead.'
      : providerFailure
        ? `The embedding provider failed (${truncate(providerFailure, 200)}). Matched on metadata text instead.`
        : embeddedPages === 0
          ? 'No page embeddings stored yet — run the embedding job for semantic search. Matched on metadata text instead.'
          : 'The query could not be embedded, so pages were matched on metadata text instead.';

    return { method: 'lexical', matches: scored, note };
  },
});

// ── keywords ─────────────────────────────────────────────────

export interface GetKeywordMetricsResult {
  keyword: {
    id: string;
    keyword: string;
    intent: string;
    funnelStage: string;
    locale: string;
    isTracked: boolean;
    isBranded: boolean;
    searchVolume: number | null;
    difficulty: number | null;
    currentPosition: number | null;
    bestPosition: number | null;
    previousPosition: number | null;
    rankingUrl: string | null;
    clicks28d: number;
    impressions28d: number;
    ctr28d: number | null;
    position28d: number | null;
    opportunityScore: number | null;
    opportunityReason: string | null;
    isContentGap: boolean;
    hasCannibalization: boolean;
  };
  /** Daily metric history, oldest first. Empty when nothing has been imported yet. */
  history: Array<{ date: Date; clicks: number | null; impressions: number | null; position: number | null; source: string }>;
  rankingPages: Array<{ page: string; clicks: number; impressions: number; position: number }>;
}

const getKeywordMetrics = defineTool({
  name: 'getKeywordMetrics',
  description: 'One keyword with its position history and the pages currently ranking for it.',
  readOnly: true,
  schema: z.object({
    keywordId: z.string().min(1).optional(),
    keyword: z.string().trim().min(1).max(300).optional(),
    days: z.number().int().min(7).max(480).optional(),
  }),
  async execute(args, context): Promise<GetKeywordMetricsResult> {
    const days = args.days ?? 90;
    const range = lastNDays(days, GSC_LAG_DAYS);

    const row = args.keywordId
      ? await prisma.keyword.findFirst({ where: { id: args.keywordId, websiteId: context.websiteId } })
      : args.keyword
        ? await prisma.keyword.findFirst({
            // `normalized` is written with normalizeKeyword(), which strips punctuation and
            // diacritics — a plain lowercase would miss every keyword that has either.
            where: { websiteId: context.websiteId, normalized: normalizeKeyword(args.keyword) },
          })
        : null;

    if (!row) {
      throw args.keywordId || args.keyword
        ? new NotFoundError('Keyword')
        : new ValidationError('Provide either keywordId or keyword.');
    }

    const [history, pages] = await Promise.all([
      prisma.keywordMetric.findMany({
        where: { keywordId: row.id, date: { gte: range.start, lte: range.end } },
        orderBy: { date: 'asc' },
        select: { date: true, clicks: true, impressions: true, position: true, source: true },
      }),
      prisma.gscQueryMetric.groupBy({
        by: ['page'],
        where: {
          websiteId: context.websiteId,
          query: row.keyword,
          date: { gte: range.start, lte: range.end },
        },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { _sum: { impressions: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      keyword: {
        id: row.id,
        keyword: row.keyword,
        intent: row.intent,
        funnelStage: row.funnelStage,
        locale: row.locale,
        isTracked: row.isTracked,
        isBranded: row.isBranded,
        searchVolume: row.searchVolume,
        difficulty: row.difficulty,
        currentPosition: row.currentPosition,
        bestPosition: row.bestPosition,
        previousPosition: row.previousPosition,
        rankingUrl: row.rankingUrl,
        clicks28d: row.clicks28d,
        impressions28d: row.impressions28d,
        ctr28d: row.ctr28d,
        position28d: row.position28d,
        opportunityScore: row.opportunityScore,
        opportunityReason: row.opportunityReason,
        isContentGap: row.isContentGap,
        hasCannibalization: row.hasCannibalization,
      },
      history,
      rankingPages: pages.map((entry) => ({
        page: entry.page,
        clicks: entry._sum.clicks ?? 0,
        impressions: entry._sum.impressions ?? 0,
        position: round(entry._avg.position ?? 0, 2),
      })),
    };
  },
});

export interface KeywordSummary {
  id: string;
  keyword: string;
  intent: string;
  funnelStage: string;
  clusterId: string | null;
  pageId: string | null;
  currentPosition: number | null;
  clicks28d: number;
  impressions28d: number;
  ctr28d: number | null;
  position28d: number | null;
  searchVolume: number | null;
  opportunityScore: number | null;
  opportunityReason: string | null;
  isContentGap: boolean;
  hasCannibalization: boolean;
}

const KEYWORD_SORTS = [
  'opportunityScore', 'impressions28d', 'clicks28d', 'position28d', 'currentPosition', 'searchVolume',
] as const;

const listKeywords = defineTool({
  name: 'listKeywords',
  description: 'Filterable, paginated keyword list — striking distance, gaps, clusters, intent.',
  readOnly: true,
  schema: z.object({
    page: pageField,
    pageSize: pageSizeField,
    clusterId: z.string().min(1).optional(),
    intent: z.enum(SEARCH_INTENTS).optional(),
    funnelStage: z.enum(FUNNEL_STAGES).optional(),
    isTracked: z.boolean().optional(),
    isBranded: z.boolean().optional(),
    isContentGap: z.boolean().optional(),
    hasCannibalization: z.boolean().optional(),
    minImpressions: z.number().int().min(0).optional(),
    minPosition: z.number().min(1).max(200).optional(),
    maxPosition: z.number().min(1).max(200).optional(),
    search: z.string().trim().min(1).max(200).optional(),
    sortBy: z.enum(KEYWORD_SORTS).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  }),
  async execute(args, context): Promise<Paginated<KeywordSummary>> {
    const pageNumber = args.page ?? 1;
    const pageSize = clampPageSize(args.pageSize);
    const sortBy = args.sortBy ?? 'opportunityScore';
    const order = args.order ?? 'desc';

    const where: Prisma.KeywordWhereInput = {
      websiteId: context.websiteId,
      ...(args.clusterId ? { clusterId: args.clusterId } : {}),
      ...(args.intent ? { intent: args.intent } : {}),
      ...(args.funnelStage ? { funnelStage: args.funnelStage } : {}),
      ...(args.isTracked === undefined ? {} : { isTracked: args.isTracked }),
      ...(args.isBranded === undefined ? {} : { isBranded: args.isBranded }),
      ...(args.isContentGap === undefined ? {} : { isContentGap: args.isContentGap }),
      ...(args.hasCannibalization === undefined ? {} : { hasCannibalization: args.hasCannibalization }),
      ...(args.minImpressions === undefined ? {} : { impressions28d: { gte: args.minImpressions } }),
      ...(args.minPosition === undefined && args.maxPosition === undefined
        ? {}
        : {
            position28d: {
              ...(args.minPosition === undefined ? {} : { gte: args.minPosition }),
              ...(args.maxPosition === undefined ? {} : { lte: args.maxPosition }),
            },
          }),
      ...(args.search ? { keyword: { contains: args.search, mode: 'insensitive' } } : {}),
    };

    const [items, total] = await Promise.all([
      prisma.keyword.findMany({
        where,
        orderBy: [{ [sortBy]: { sort: order, nulls: 'last' } }, { id: 'asc' }],
        ...paginate(pageNumber, pageSize),
        select: {
          id: true, keyword: true, intent: true, funnelStage: true, clusterId: true, pageId: true,
          currentPosition: true, clicks28d: true, impressions28d: true, ctr28d: true,
          position28d: true, searchVolume: true, opportunityScore: true, opportunityReason: true,
          isContentGap: true, hasCannibalization: true,
        },
      }),
      prisma.keyword.count({ where }),
    ]);

    return buildPaginated(items, total, pageNumber, pageSize);
  },
});

export interface KeywordClusterSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parentTopic: string | null;
  intent: string;
  pillarPageId: string | null;
  keywordCount: number;
  totalVolume: number;
  totalImpressions: number;
  totalClicks: number;
  avgPosition: number | null;
  coverageScore: number | null;
  opportunityScore: number | null;
  sampleKeywords: string[];
}

const getKeywordClusters = defineTool({
  name: 'getKeywordClusters',
  description: 'Topic clusters with coverage and opportunity, plus a sample of member keywords.',
  readOnly: true,
  schema: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    keywordsPerCluster: z.number().int().min(0).max(50).optional(),
  }),
  async execute(args, context): Promise<{ clusters: KeywordClusterSummary[] }> {
    const perCluster = args.keywordsPerCluster ?? 8;
    const clusters = await prisma.keywordCluster.findMany({
      where: { websiteId: context.websiteId },
      orderBy: [{ opportunityScore: { sort: 'desc', nulls: 'last' } }, { keywordCount: 'desc' }],
      take: args.limit ?? 50,
      select: {
        id: true, name: true, slug: true, description: true, parentTopic: true, intent: true,
        pillarPageId: true, keywordCount: true, totalVolume: true, totalImpressions: true,
        totalClicks: true, avgPosition: true, coverageScore: true, opportunityScore: true,
        keywords: {
          orderBy: { impressions28d: 'desc' },
          take: perCluster,
          select: { keyword: true },
        },
      },
    });

    return {
      clusters: clusters.map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        slug: cluster.slug,
        description: cluster.description,
        parentTopic: cluster.parentTopic,
        intent: cluster.intent,
        pillarPageId: cluster.pillarPageId,
        keywordCount: cluster.keywordCount,
        totalVolume: cluster.totalVolume,
        totalImpressions: cluster.totalImpressions,
        totalClicks: cluster.totalClicks,
        avgPosition: cluster.avgPosition,
        coverageScore: cluster.coverageScore,
        opportunityScore: cluster.opportunityScore,
        sampleKeywords: cluster.keywords.map((keyword) => keyword.keyword),
      })),
    };
  },
});

// ── Search Console ───────────────────────────────────────────

export interface GscAggregateRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export type GetSearchConsoleDataResult =
  | { available: false; reason: string }
  | {
      available: true;
      dimension: 'query' | 'page' | 'date';
      range: { start: string; end: string };
      totals: { clicks: number; impressions: number; ctr: number; position: number };
      rows: GscAggregateRow[];
    };

const getSearchConsoleData = defineTool({
  name: 'getSearchConsoleData',
  description:
    'Search Console query/page/date aggregates for a window. Returns available:false when no data has been imported.',
  readOnly: true,
  schema: z.object({
    days: z.number().int().min(1).max(480).optional(),
    lagDays: z.number().int().min(0).max(30).optional(),
    dimension: z.enum(['query', 'page', 'date']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    pageId: z.string().min(1).optional(),
    query: z.string().trim().min(1).max(300).optional(),
    minImpressions: z.number().int().min(0).optional(),
  }),
  async execute(args, context): Promise<GetSearchConsoleDataResult> {
    const dimension = args.dimension ?? 'query';
    const range = lastNDays(args.days ?? 28, args.lagDays ?? GSC_LAG_DAYS);
    const limit = args.limit ?? 100;

    const where: Prisma.GscQueryMetricWhereInput = {
      websiteId: context.websiteId,
      date: { gte: range.start, lte: range.end },
      ...(args.pageId ? { pageId: args.pageId } : {}),
      ...(args.query ? { query: args.query } : {}),
    };

    const totals = await prisma.gscQueryMetric.aggregate({
      where,
      _sum: { clicks: true, impressions: true },
      _avg: { position: true },
      _count: { _all: true },
    });

    if (totals._count._all === 0) {
      const integration = await prisma.integration.findFirst({
        where: { websiteId: context.websiteId, provider: 'GOOGLE_SEARCH_CONSOLE' },
        select: { status: true },
      });
      return {
        available: false,
        reason:
          integration?.status === 'CONNECTED'
            ? `Search Console is connected but no rows exist for ${range.start.toISOString().slice(0, 10)} → ${range.end
                .toISOString()
                .slice(0, 10)}. Run a Search Console sync, or widen the window.`
            : 'Google Search Console is not connected for this site. Connect it in Settings → Integrations before asking for search data.',
      };
    }

    const clicks = totals._sum.clicks ?? 0;
    const impressions = totals._sum.impressions ?? 0;
    const having: Prisma.GscQueryMetricScalarWhereWithAggregatesInput | undefined =
      args.minImpressions === undefined
        ? undefined
        : { impressions: { _sum: { gte: args.minImpressions } } };

    let rows: GscAggregateRow[];
    if (dimension === 'page') {
      const grouped = await prisma.gscQueryMetric.groupBy({
        by: ['page'],
        where,
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { _sum: { clicks: 'desc' } },
        take: limit,
        having,
      });
      rows = grouped.map((row) => toAggregateRow(row.page, row));
    } else if (dimension === 'date') {
      const grouped = await prisma.gscQueryMetric.groupBy({
        by: ['date'],
        where,
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { date: 'asc' },
        take: limit,
      });
      rows = grouped.map((row) => toAggregateRow(row.date.toISOString().slice(0, 10), row));
    } else {
      const grouped = await prisma.gscQueryMetric.groupBy({
        by: ['query'],
        where,
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { _sum: { clicks: 'desc' } },
        take: limit,
        having,
      });
      rows = grouped.map((row) => toAggregateRow(row.query, row));
    }

    return {
      available: true,
      dimension,
      range: { start: range.start.toISOString().slice(0, 10), end: range.end.toISOString().slice(0, 10) },
      totals: {
        clicks,
        impressions,
        ctr: round(safeDivide(clicks, impressions), 5),
        position: round(totals._avg.position ?? 0, 2),
      },
      rows,
    };
  },
});

interface GroupedMetric {
  _sum: { clicks: number | null; impressions: number | null };
  _avg: { position: number | null };
}

function toAggregateRow(key: string, row: GroupedMetric): GscAggregateRow {
  const clicks = row._sum.clicks ?? 0;
  const impressions = row._sum.impressions ?? 0;
  return {
    key,
    clicks,
    impressions,
    ctr: round(safeDivide(clicks, impressions), 5),
    position: round(row._avg.position ?? 0, 2),
  };
}

export type GetPagePerformanceResult =
  | { available: false; reason: string; pageId: string; url: string }
  | {
      available: true;
      pageId: string;
      url: string;
      range: { start: string; end: string };
      current: { clicks: number; impressions: number; ctr: number; position: number };
      previous: { clicks: number; impressions: number; ctr: number; position: number };
      deltaPct: { clicks: number | null; impressions: number | null; position: number | null };
      topQueries: GscAggregateRow[];
    };

const getPagePerformance = defineTool({
  name: 'getPagePerformance',
  description: 'Search performance for one page, current window versus the preceding one.',
  readOnly: true,
  schema: z.object({
    pageId: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    days: z.number().int().min(7).max(480).optional(),
  }),
  async execute(args, context): Promise<GetPagePerformanceResult> {
    const pageId = await resolvePageId(context, args);
    const page = await prisma.page.findUniqueOrThrow({
      where: { id: pageId },
      select: { id: true, url: true },
    });

    const range = lastNDays(args.days ?? 28, GSC_LAG_DAYS);
    const prior = previousPeriod(range);
    const pageFilter: Prisma.GscQueryMetricWhereInput = {
      websiteId: context.websiteId,
      OR: [{ pageId }, { page: page.url }],
    };

    const [current, previous, queries] = await Promise.all([
      prisma.gscQueryMetric.aggregate({
        where: { ...pageFilter, date: { gte: range.start, lte: range.end } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        _count: { _all: true },
      }),
      prisma.gscQueryMetric.aggregate({
        where: { ...pageFilter, date: { gte: prior.start, lte: prior.end } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
      }),
      prisma.gscQueryMetric.groupBy({
        by: ['query'],
        where: { ...pageFilter, date: { gte: range.start, lte: range.end } },
        _sum: { clicks: true, impressions: true },
        _avg: { position: true },
        orderBy: { _sum: { impressions: 'desc' } },
        take: 25,
      }),
    ]);

    if (current._count._all === 0) {
      return {
        available: false,
        pageId,
        url: page.url,
        reason:
          'No Search Console rows for this page in the window. Either the page has no impressions, or Search Console has not been synced.',
      };
    }

    const cur = summariseAggregate(current);
    const prev = summariseAggregate(previous);

    return {
      available: true,
      pageId,
      url: page.url,
      range: { start: range.start.toISOString().slice(0, 10), end: range.end.toISOString().slice(0, 10) },
      current: cur,
      previous: prev,
      deltaPct: {
        clicks: prev.clicks === 0 ? null : round(((cur.clicks - prev.clicks) / prev.clicks) * 100, 1),
        impressions:
          prev.impressions === 0 ? null : round(((cur.impressions - prev.impressions) / prev.impressions) * 100, 1),
        // Position improves as it falls, so the sign is inverted to keep "positive means better".
        position: prev.position === 0 ? null : round(((prev.position - cur.position) / prev.position) * 100, 1),
      },
      topQueries: queries.map((row) => toAggregateRow(row.query, row)),
    };
  },
});

function summariseAggregate(row: GroupedMetric): { clicks: number; impressions: number; ctr: number; position: number } {
  const clicks = row._sum.clicks ?? 0;
  const impressions = row._sum.impressions ?? 0;
  return {
    clicks,
    impressions,
    ctr: round(safeDivide(clicks, impressions), 5),
    position: round(row._avg.position ?? 0, 2),
  };
}

// ── technical ────────────────────────────────────────────────

export interface GetTechnicalIssuesResult {
  total: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  issues: Array<{
    id: string;
    ruleId: string;
    title: string;
    category: string;
    severity: string;
    status: string;
    url: string | null;
    pageId: string | null;
    description: string;
    recommendation: string;
    estimatedImpact: number;
    confidence: number;
    autoFixable: boolean;
    evidence: unknown;
    lastSeenAt: Date;
  }>;
}

const getTechnicalIssues = defineTool({
  name: 'getTechnicalIssues',
  description: 'Open technical issues with severity/category roll-ups. Defaults to OPEN + REGRESSED.',
  readOnly: true,
  schema: z.object({
    status: z.enum(ISSUE_STATUSES).optional(),
    severity: z.enum(ISSUE_SEVERITIES).optional(),
    category: z.enum(ISSUE_CATEGORIES).optional(),
    ruleId: z.string().min(1).optional(),
    pageId: z.string().min(1).optional(),
    autoFixableOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(300).optional(),
  }),
  async execute(args, context): Promise<GetTechnicalIssuesResult> {
    const where: Prisma.TechnicalIssueWhereInput = {
      websiteId: context.websiteId,
      ...(args.status ? { status: args.status } : { status: { in: ['OPEN', 'REGRESSED'] } }),
      ...(args.severity ? { severity: args.severity } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(args.ruleId ? { ruleId: args.ruleId } : {}),
      ...(args.pageId ? { pageId: args.pageId } : {}),
      ...(args.autoFixableOnly ? { autoFixable: true } : {}),
    };

    const [issues, total, bySeverity, byCategory] = await Promise.all([
      prisma.technicalIssue.findMany({
        where,
        orderBy: [{ severity: 'asc' }, { estimatedImpact: 'desc' }],
        take: args.limit ?? 100,
        select: {
          id: true, ruleId: true, title: true, category: true, severity: true, status: true,
          url: true, pageId: true, description: true, recommendation: true, estimatedImpact: true,
          confidence: true, autoFixable: true, evidence: true, lastSeenAt: true,
        },
      }),
      prisma.technicalIssue.count({ where }),
      prisma.technicalIssue.groupBy({ by: ['severity'], where, _count: { _all: true } }),
      prisma.technicalIssue.groupBy({ by: ['category'], where, _count: { _all: true } }),
    ]);

    return {
      total,
      bySeverity: Object.fromEntries(bySeverity.map((row) => [row.severity, row._count._all])),
      byCategory: Object.fromEntries(byCategory.map((row) => [row.category, row._count._all])),
      issues,
    };
  },
});

// ── competitors ──────────────────────────────────────────────

export interface GetCompetitorsResult {
  competitors: Array<{
    id: string;
    domain: string;
    name: string | null;
    isManual: boolean;
    sharedKeywords: number;
    gapKeywords: number;
    estimatedKeywords: number;
    serpOverlapPct: number;
    avgPosition: number | null;
    topicalStrengths: string[];
    contentVelocity: number | null;
    lastAnalysedAt: Date | null;
    topPages: Array<{ url: string; title: string | null; keywordCount: number }>;
  }>;
}

const getCompetitors = defineTool({
  name: 'getCompetitors',
  description: 'Tracked competitors with overlap stats and their strongest observed pages.',
  readOnly: true,
  schema: z.object({
    limit: z.number().int().min(1).max(50).optional(),
    pagesPerCompetitor: z.number().int().min(0).max(20).optional(),
  }),
  async execute(args, context): Promise<GetCompetitorsResult> {
    const competitors = await prisma.competitor.findMany({
      where: { websiteId: context.websiteId, isActive: true },
      orderBy: { serpOverlapPct: 'desc' },
      take: args.limit ?? 20,
      select: {
        id: true, domain: true, name: true, isManual: true, sharedKeywords: true,
        gapKeywords: true, estimatedKeywords: true, serpOverlapPct: true, avgPosition: true,
        topicalStrengths: true, contentVelocity: true, lastAnalysedAt: true,
        pages: {
          orderBy: { keywordCount: 'desc' },
          take: args.pagesPerCompetitor ?? 5,
          select: { url: true, title: true, keywordCount: true },
        },
      },
    });

    return {
      competitors: competitors.map((competitor) => ({
        id: competitor.id,
        domain: competitor.domain,
        name: competitor.name,
        isManual: competitor.isManual,
        sharedKeywords: competitor.sharedKeywords,
        gapKeywords: competitor.gapKeywords,
        estimatedKeywords: competitor.estimatedKeywords,
        serpOverlapPct: competitor.serpOverlapPct,
        avgPosition: competitor.avgPosition,
        topicalStrengths: competitor.topicalStrengths,
        contentVelocity: competitor.contentVelocity,
        lastAnalysedAt: competitor.lastAnalysedAt,
        topPages: competitor.pages,
      })),
    };
  },
});

export type GetCompetitorGapsResult =
  | { available: false; reason: string }
  | {
      available: true;
      gaps: ReturnType<typeof analyseKeywordGaps>;
      overviews: Array<ReturnType<typeof buildCompetitorOverview>>;
      /** Set when a cap trimmed the input, so the caller knows the comparison is partial. */
      note?: string;
    };

/** Row caps for the gap comparison. Both sides are held in memory, so both are bounded. */
const MAX_COMPETITOR_KEYWORDS = 5000;
const MAX_OWN_KEYWORDS = 10000;

const getCompetitorGaps = defineTool({
  name: 'getCompetitorGaps',
  description: 'Keyword gaps: what tracked competitors rank for that we do not, ranked by worth pursuing.',
  readOnly: true,
  schema: z.object({
    limit: z.number().int().min(1).max(300).optional(),
    competitorDomain: z.string().trim().min(3).max(255).optional(),
  }),
  async execute(args, context): Promise<GetCompetitorGapsResult> {
    const competitorKeywords = await prisma.competitorKeyword.findMany({
      where: {
        competitor: {
          websiteId: context.websiteId,
          isActive: true,
          ...(args.competitorDomain ? { domain: args.competitorDomain } : {}),
        },
      },
      select: {
        keyword: true,
        position: true,
        url: true,
        estimatedVolume: true,
        competitor: { select: { domain: true } },
      },
      // Best-ranking first so a capped comparison keeps the keywords competitors actually win on
      // rather than an arbitrary slice of the table.
      orderBy: [{ position: 'asc' }],
      take: MAX_COMPETITOR_KEYWORDS,
    });

    if (competitorKeywords.length === 0) {
      return {
        available: false,
        reason:
          'No competitor keyword data has been collected for this site. Add competitors and run a competitor analysis (needs a SERP provider) first.',
      };
    }

    const ourKeywords = await prisma.keyword.findMany({
      where: { websiteId: context.websiteId },
      select: { keyword: true, position28d: true, currentPosition: true, impressions28d: true, rankingUrl: true },
      // Our most visible keywords first: they are the ones whose absence from the gap list must
      // be right, because a false "gap" sends an agent to write a page we already rank for.
      orderBy: [{ impressions28d: 'desc' }],
      take: MAX_OWN_KEYWORDS,
    });

    const ours: OurKeywordRow[] = ourKeywords.map((row) => ({
      keyword: row.keyword,
      position: row.position28d ?? row.currentPosition,
      impressions: row.impressions28d,
      url: row.rankingUrl,
    }));
    const theirs: CompetitorKeywordRow[] = competitorKeywords.map((row) => ({
      competitorDomain: row.competitor.domain,
      keyword: row.keyword,
      position: row.position,
      url: row.url,
      estimatedVolume: row.estimatedVolume,
    }));

    const domains = [...new Set(theirs.map((row) => row.competitorDomain))];

    const truncated: string[] = [];
    if (competitorKeywords.length === MAX_COMPETITOR_KEYWORDS) {
      truncated.push(`the best-ranking ${MAX_COMPETITOR_KEYWORDS} competitor keywords`);
    }
    if (ourKeywords.length === MAX_OWN_KEYWORDS) {
      truncated.push(`our ${MAX_OWN_KEYWORDS} highest-impression keywords`);
    }

    return {
      available: true,
      gaps: analyseKeywordGaps(ours, theirs, { maxResults: args.limit ?? 100 }),
      overviews: domains.map((domain) => buildCompetitorOverview(domain, ours, theirs)),
      ...(truncated.length
        ? { note: `Comparison was capped to ${truncated.join(' and ')}; a keyword outside that slice may be reported as a gap incorrectly.` }
        : {}),
    };
  },
});

// ── internal links ───────────────────────────────────────────

export type GetInternalLinkGraphResult =
  | { available: false; reason: string }
  | {
      available: true;
      stats: ReturnType<typeof buildLinkGraph>['stats'];
      /** Trimmed on purpose — a full node/edge dump belongs in the UI, not in a prompt. */
      topAuthorities: Array<{ id: string; url: string; inboundLinks: number; authority: number }>;
      topHubs: Array<{ id: string; url: string; outboundLinks: number }>;
      orphans: Array<{ id: string; url: string; wordCount: number }>;
      /** Set when the graph was built from a capped slice of the site. */
      note?: string;
    };

/**
 * Caps on the graph build. PageRank runs in process over everything loaded here, so a site with
 * 200k pages and a few million edges would otherwise take the worker down rather than merely be
 * slow. Both slices are ordered so the structurally important part of the site survives the cut.
 * These mirror the caps the web app's graph endpoint uses.
 */
const MAX_GRAPH_PAGES = 5000;
const MAX_GRAPH_EDGES = 40000;

const getInternalLinkGraph = defineTool({
  name: 'getInternalLinkGraph',
  description: 'Internal link graph statistics with PageRank-weighted authorities, hubs and orphans.',
  readOnly: true,
  schema: z.object({
    topN: z.number().int().min(1).max(200).optional(),
    orphanLimit: z.number().int().min(1).max(500).optional(),
  }),
  async execute(args, context): Promise<GetInternalLinkGraphResult> {
    const crawl = await prisma.crawl.findFirst({
      where: { websiteId: context.websiteId, status: 'COMPLETED' },
      orderBy: { finishedAt: 'desc' },
      select: { id: true },
    });
    if (!crawl) {
      return {
        available: false,
        reason: 'No completed crawl for this site yet. Run a crawl before asking about internal links.',
      };
    }

    const [pages, totalPages] = await Promise.all([
      prisma.page.findMany({
        where: { websiteId: context.websiteId, isActive: true },
        // Most-linked, shallowest first: a truncated graph keeps the site's skeleton.
        orderBy: [{ internalLinksIn: 'desc' }, { depth: 'asc' }],
        take: MAX_GRAPH_PAGES,
        select: {
          id: true, url: true, normalizedUrl: true, title: true, depth: true,
          isIndexable: true, wordCount: true,
        },
      }),
      prisma.page.count({ where: { websiteId: context.websiteId, isActive: true } }),
    ]);

    if (pages.length === 0) {
      return { available: false, reason: 'The crawl recorded no pages for this site.' };
    }

    const linkEdges = await prisma.linkEdge.findMany({
      where: { crawlId: crawl.id, isInternal: true },
      take: MAX_GRAPH_EDGES,
      select: {
        normalizedTarget: true, anchorText: true, isNofollow: true, inMainContent: true,
        // Joined rather than loaded as a second full table: the source URL is the only thing
        // needed from CrawlPage, and a separate findMany over every crawl page is unbounded.
        sourceCrawlPage: { select: { normalizedUrl: true } },
      },
    });

    const graphPages: GraphInputPage[] = pages.map((page) => ({
      id: page.id,
      url: page.url,
      normalizedUrl: page.normalizedUrl,
      title: page.title,
      depth: page.depth,
      isIndexable: page.isIndexable,
      wordCount: page.wordCount,
    }));
    const graphEdges: GraphInputEdge[] = linkEdges.map((edge) => ({
      sourceNormalized: edge.sourceCrawlPage.normalizedUrl,
      targetNormalized: edge.normalizedTarget,
      anchorText: edge.anchorText ?? '',
      isNofollow: edge.isNofollow,
      inMainContent: edge.inMainContent,
    }));

    const graph = buildLinkGraph(graphPages, graphEdges);
    const topN = args.topN ?? 25;
    const orphanLimit = args.orphanLimit ?? 100;
    const pagesTruncated = totalPages > pages.length;

    // The page slice is ordered by inbound links, so on a truncated site the orphans — zero
    // inbound by definition — are exactly the rows that were cut. Reading them from the
    // denormalised column keeps this tool answering the question it was asked.
    const orphans = pagesTruncated
      ? (
          await prisma.page.findMany({
            where: { websiteId: context.websiteId, isActive: true, isOrphan: true },
            orderBy: { wordCount: 'desc' },
            take: orphanLimit,
            select: { id: true, url: true, wordCount: true },
          })
        ).map((page) => ({ id: page.id, url: page.url, wordCount: page.wordCount }))
      : graph.nodes
          .filter((node) => node.isOrphan)
          .slice(0, orphanLimit)
          .map((node) => ({ id: node.id, url: node.url, wordCount: node.wordCount }));

    const capped: string[] = [];
    if (pagesTruncated) capped.push(`${pages.length} of ${totalPages} pages`);
    if (linkEdges.length === MAX_GRAPH_EDGES) capped.push(`the first ${MAX_GRAPH_EDGES} internal links`);

    return {
      available: true,
      stats: graph.stats,
      topAuthorities: graph.stats.authorities.slice(0, topN),
      topHubs: graph.stats.hubs.slice(0, topN),
      orphans,
      ...(capped.length
        ? {
            note:
              `Graph built from ${capped.join(' and ')}. Authority figures describe that slice, not ` +
              'the whole site; orphans were read from the stored per-page flag instead.',
          }
        : {}),
    };
  },
});

// ── GEO & AI visibility ──────────────────────────────────────

export type GetGeoAuditResult =
  | { available: false; reason: string }
  | {
      available: true;
      auditId: string;
      overallScore: number;
      dimensions: unknown;
      findings: unknown;
      recommendations: unknown;
      pagesAudited: number;
      summary: string | null;
      createdAt: Date;
      weakestPages: Array<{ pageId: string; url: string; score: number }>;
      strongestPages: Array<{ pageId: string; url: string; score: number }>;
    };

const getGeoAudit = defineTool({
  name: 'getGeoAudit',
  description: 'The most recent GEO (generative engine optimisation) audit with its weakest and strongest pages.',
  readOnly: true,
  schema: z.object({ pageLimit: z.number().int().min(1).max(100).optional() }),
  async execute(args, context): Promise<GetGeoAuditResult> {
    const audit = await prisma.geoAudit.findFirst({
      where: { websiteId: context.websiteId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, overallScore: true, dimensions: true, findings: true, recommendations: true,
        pagesAudited: true, summary: true, createdAt: true,
      },
    });
    if (!audit) {
      return { available: false, reason: 'No GEO audit has been run for this site yet.' };
    }

    const limit = args.pageLimit ?? 10;
    const [weakest, strongest] = await Promise.all([
      prisma.geoPageAudit.findMany({
        where: { auditId: audit.id },
        orderBy: { score: 'asc' },
        take: limit,
        select: { pageId: true, score: true, page: { select: { url: true } } },
      }),
      prisma.geoPageAudit.findMany({
        where: { auditId: audit.id },
        orderBy: { score: 'desc' },
        take: limit,
        select: { pageId: true, score: true, page: { select: { url: true } } },
      }),
    ]);

    const shape = (rows: typeof weakest) =>
      rows.map((row) => ({ pageId: row.pageId, url: row.page.url, score: row.score }));

    return {
      available: true,
      auditId: audit.id,
      overallScore: audit.overallScore,
      dimensions: audit.dimensions,
      findings: audit.findings,
      recommendations: audit.recommendations,
      pagesAudited: audit.pagesAudited,
      summary: audit.summary,
      createdAt: audit.createdAt,
      weakestPages: shape(weakest),
      strongestPages: shape(strongest),
    };
  },
});

export type GetAiVisibilitySummaryResult =
  | { available: false; reason: string }
  | {
      available: true;
      windowDays: number;
      promptsTracked: number;
      runs: number;
      mentionRate: number;
      citationRate: number;
      topCompetitorsMentioned: Array<{ name: string; mentions: number }>;
      weakestPrompts: Array<{ prompt: string; mentionRate: number | null; citationRate: number | null; lastRunAt: Date | null }>;
    };

const getAiVisibilitySummary = defineTool({
  name: 'getAiVisibilitySummary',
  description: 'How often the brand is mentioned and cited by AI assistants, from recorded visibility runs.',
  readOnly: true,
  schema: z.object({ days: z.number().int().min(1).max(365).optional() }),
  async execute(args, context): Promise<GetAiVisibilitySummaryResult> {
    const days = args.days ?? 30;
    const range = lastNDays(days);

    const [promptsTracked, runs] = await Promise.all([
      prisma.aiVisibilityPrompt.count({ where: { websiteId: context.websiteId, isActive: true } }),
      prisma.aiVisibilityRun.findMany({
        where: { websiteId: context.websiteId, runAt: { gte: range.start } },
        select: { brandMentioned: true, ourUrlsCited: true, competitorsMentioned: true },
        take: 5000,
      }),
    ]);

    if (runs.length === 0) {
      return {
        available: false,
        reason:
          promptsTracked === 0
            ? 'No AI visibility prompts are configured for this site, so nothing has been measured.'
            : `No AI visibility runs in the last ${days} days. Run the AI visibility job to collect answers.`,
      };
    }

    const mentioned = runs.filter((run) => run.brandMentioned).length;
    const cited = runs.filter((run) => run.ourUrlsCited.length > 0).length;
    const competitorCounts = new Map<string, number>();
    for (const run of runs) {
      for (const name of run.competitorsMentioned) {
        competitorCounts.set(name, (competitorCounts.get(name) ?? 0) + 1);
      }
    }

    const weakestPrompts = await prisma.aiVisibilityPrompt.findMany({
      where: { websiteId: context.websiteId, isActive: true, lastRunAt: { not: null } },
      orderBy: [{ mentionRate: { sort: 'asc', nulls: 'last' } }],
      take: 10,
      select: { prompt: true, mentionRate: true, citationRate: true, lastRunAt: true },
    });

    return {
      available: true,
      windowDays: days,
      promptsTracked,
      runs: runs.length,
      mentionRate: round(safeDivide(mentioned, runs.length), 4),
      citationRate: round(safeDivide(cited, runs.length), 4),
      topCompetitorsMentioned: [...competitorCounts.entries()]
        .map(([name, mentions]) => ({ name, mentions }))
        .sort((a, b) => b.mentions - a.mentions)
        .slice(0, 10),
      weakestPrompts,
    };
  },
});

// ── actions & experiments ────────────────────────────────────

export interface GetRecentActionsResult {
  actions: Array<{
    id: string;
    type: string;
    title: string;
    status: string;
    risk: string;
    priorityScore: number;
    affectedUrls: string[];
    requiredAgent: string | null;
    reasoning: string;
    proposedAt: Date;
    completedAt: Date | null;
    error: string | null;
  }>;
}

const getRecentActions = defineTool({
  name: 'getRecentActions',
  description: 'Recently proposed or executed actions for this site — check before proposing something again.',
  readOnly: true,
  schema: z.object({
    limit: z.number().int().min(1).max(200).optional(),
    status: z.enum(ACTION_STATUSES).optional(),
    type: z.enum(ACTION_TYPES).optional(),
    agent: z.string().min(1).optional(),
    days: z.number().int().min(1).max(365).optional(),
  }),
  async execute(args, context): Promise<GetRecentActionsResult> {
    const where: Prisma.SeoActionWhereInput = {
      websiteId: context.websiteId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.type ? { type: args.type } : {}),
      ...(args.agent ? { requiredAgent: args.agent } : {}),
      ...(args.days ? { proposedAt: { gte: lastNDays(args.days).start } } : {}),
    };

    const actions = await prisma.seoAction.findMany({
      where,
      orderBy: { proposedAt: 'desc' },
      take: args.limit ?? 50,
      select: {
        id: true, type: true, title: true, status: true, risk: true, priorityScore: true,
        affectedUrls: true, requiredAgent: true, reasoning: true, proposedAt: true,
        completedAt: true, error: true,
      },
    });

    return { actions };
  },
});

export interface GetExperimentOutcomesResult {
  experiments: Array<{
    id: string;
    name: string;
    actionType: string | null;
    metric: string;
    status: string;
    outcome: string;
    deltaPct: number | null;
    significance: number | null;
    interpretation: string | null;
    measureStart: Date;
    evaluatedAt: Date | null;
  }>;
  /** Per-action-type roll-up — the feedback loop that should change what gets proposed next. */
  summaries: ReturnType<typeof summariseActionOutcomes>;
}

const getExperimentOutcomes = defineTool({
  name: 'getExperimentOutcomes',
  description: 'Measured results of past changes on this site, rolled up per action type.',
  readOnly: true,
  schema: z.object({ limit: z.number().int().min(1).max(300).optional() }),
  async execute(args, context): Promise<GetExperimentOutcomesResult> {
    const experiments = await prisma.experiment.findMany({
      where: { websiteId: context.websiteId },
      orderBy: { createdAt: 'desc' },
      take: args.limit ?? 100,
      select: {
        id: true, name: true, metric: true, status: true, outcome: true, deltaPct: true,
        significance: true, interpretation: true, measureStart: true, evaluatedAt: true,
        action: { select: { type: true } },
      },
    });

    return {
      experiments: experiments.map((experiment) => ({
        id: experiment.id,
        name: experiment.name,
        actionType: experiment.action?.type ?? null,
        metric: experiment.metric,
        status: experiment.status,
        outcome: experiment.outcome,
        deltaPct: experiment.deltaPct,
        significance: experiment.significance,
        interpretation: experiment.interpretation,
        measureStart: experiment.measureStart,
        evaluatedAt: experiment.evaluatedAt,
      })),
      summaries: summariseActionOutcomes(
        experiments
          .filter((experiment) => experiment.action !== null)
          .map((experiment) => ({
            actionType: experiment.action?.type ?? 'CUSTOM',
            outcome: experiment.outcome,
            deltaPct: experiment.deltaPct,
          })),
      ),
    };
  },
});

// ── SERP ─────────────────────────────────────────────────────

export type GetSerpSnapshotResult =
  | { available: false; reason: string }
  | {
      available: true;
      query: string;
      locale: string;
      device: string;
      provider: string;
      capturedAt: Date;
      ourPosition: number | null;
      resultTypes: string[];
      results: unknown;
      peopleAlsoAsk: unknown;
      relatedSearches: string[];
      featuredSnippet: unknown;
    };

const getSerpSnapshot = defineTool({
  name: 'getSerpSnapshot',
  description:
    'The most recent stored SERP snapshot for a query. Returns available:false when no SERP provider is configured or nothing has been captured.',
  readOnly: true,
  schema: z.object({
    query: z.string().trim().min(1).max(300),
    locale: z.string().trim().min(2).max(10).optional(),
    device: z.enum(['desktop', 'mobile']).optional(),
    maxAgeDays: z.number().int().min(1).max(365).optional(),
  }),
  async execute(args, context): Promise<GetSerpSnapshotResult> {
    const maxAgeDays = args.maxAgeDays ?? 30;
    const snapshot = await prisma.serpSnapshot.findFirst({
      where: {
        websiteId: context.websiteId,
        query: args.query,
        ...(args.locale ? { locale: args.locale } : {}),
        ...(args.device ? { device: args.device } : {}),
        capturedAt: { gte: lastNDays(maxAgeDays).start },
      },
      orderBy: { capturedAt: 'desc' },
    });

    if (!snapshot) {
      // This tool never calls a provider itself: live SERP fetches cost money and belong in a job
      // the operator can budget, not in a read a reasoning loop can trigger repeatedly.
      return {
        available: false,
        reason: isConfigured.anySerp()
          ? `No SERP snapshot for "${truncate(args.query, 80)}" in the last ${maxAgeDays} days. Queue a SERP fetch for this query first.`
          : 'No SERP provider is configured. Set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD, SERPAPI_KEY or SERPER_API_KEY to collect SERP data.',
      };
    }

    return {
      available: true,
      query: snapshot.query,
      locale: snapshot.locale,
      device: snapshot.device,
      provider: snapshot.provider,
      capturedAt: snapshot.capturedAt,
      ourPosition: snapshot.ourPosition,
      resultTypes: snapshot.resultTypes,
      results: snapshot.results,
      peopleAlsoAsk: snapshot.peopleAlsoAsk,
      relatedSearches: snapshot.relatedSearches,
      featuredSnippet: snapshot.featuredSnippet,
    };
  },
});

export const readTools: AnyToolDefinition[] = [
  getWebsite,
  getWebsiteKnowledge,
  getPage,
  listPages,
  searchSiteContent,
  getKeywordMetrics,
  listKeywords,
  getKeywordClusters,
  getSearchConsoleData,
  getPagePerformance,
  getTechnicalIssues,
  getCompetitors,
  getCompetitorGaps,
  getInternalLinkGraph,
  getGeoAudit,
  getAiVisibilitySummary,
  getRecentActions,
  getExperimentOutcomes,
  getSerpSnapshot,
];

/** Tool names in this module, for an agent definition's `tools` list. */
export const READ_TOOL_NAMES = readTools.map((tool) => tool.name);
