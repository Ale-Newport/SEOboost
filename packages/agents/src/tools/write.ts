import { z } from 'zod';
import { createManyChunked, json, prisma } from '@seo/db';
import type { Prisma, SchemaValidationStatus } from '@seo/db';
import {
  estimateGeoPotential,
  inferBusinessValue,
  inferFunnelStage,
  inferIntent,
  validateJsonLd,
} from '@seo/seo-engine';
import { NotFoundError, ValidationError, chunk, createLogger, normalizeKeyword, truncate } from '@seo/shared';
import { sha256 } from '@seo/shared/hash';
import type { AgentContext } from '../types';
import { createActionFromAgent, type CreatedActionResult } from '../runtime/run';
import { defineTool, type AnyToolDefinition } from './define';

const log = createLogger('agents:tools:write');

/**
 * Write tools — the only way an agent changes platform state.
 *
 * Three invariants hold for every tool in this file:
 *  1. `websiteId` always comes from the run context, never from arguments, so an agent cannot
 *     write into another operator's site by passing a different id.
 *  2. Writes are idempotent wherever the schema gives a natural key, because agents re-run on a
 *     schedule over findings that have not changed and must not accumulate duplicates.
 *  3. Nothing here touches the live website. These rows are proposals, drafts and suggestions;
 *     execution happens later, behind `canAutoExecute` and the approval queue.
 */

const ACTION_TYPES = [
  'FIX_TECHNICAL_ISSUE', 'UPDATE_TITLE', 'UPDATE_META_DESCRIPTION', 'UPDATE_CONTENT',
  'PUBLISH_CONTENT', 'CREATE_CONTENT_BRIEF', 'ADD_INTERNAL_LINKS', 'ADD_STRUCTURED_DATA',
  'CREATE_REDIRECT', 'REFRESH_CONTENT', 'CONSOLIDATE_PAGES', 'SUBMIT_URL_INDEXING',
  'GEO_IMPROVEMENT', 'OUTREACH_DRAFT', 'CUSTOM',
] as const;

const OPPORTUNITY_TYPES = [
  'IMPROVE_EXISTING_PAGE', 'NEW_ARTICLE', 'NEW_LANDING_PAGE', 'NEW_COMPARISON_PAGE',
  'NEW_GLOSSARY_PAGE', 'NEW_PRODUCT_PAGE', 'ADD_FAQ_SECTION', 'CONTENT_REFRESH',
  'CTR_OPTIMISATION', 'CONSOLIDATE_CANNIBALISATION', 'NO_ACTION',
] as const;

const SEARCH_INTENTS = [
  'INFORMATIONAL', 'NAVIGATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'LOCAL', 'UNKNOWN',
] as const;
const FUNNEL_STAGES = ['AWARENESS', 'CONSIDERATION', 'DECISION', 'UNKNOWN'] as const;
const KEYWORD_SOURCES = [
  'SEARCH_CONSOLE', 'BING', 'SITE_CONTENT', 'COMPETITOR', 'SERP_PROVIDER', 'AI_EXPANSION',
  'MANUAL', 'CSV_IMPORT',
] as const;
const ENTITY_TYPES = [
  'BRAND', 'WEBSITE', 'COMPANY', 'PRODUCT', 'SERVICE', 'PERSON', 'TOPIC', 'ORGANIZATION',
  'LOCATION', 'SOFTWARE', 'FEATURE', 'EVENT', 'CONCEPT',
] as const;
type EntityTypeName = (typeof ENTITY_TYPES)[number];
const NOTIFICATION_SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'CRITICAL'] as const;

/** Guard every foreign key an agent supplies: it must belong to the context's site. */
async function assertPagesOwned(context: AgentContext, pageIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(pageIds.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const rows = await prisma.page.findMany({
    where: { id: { in: unique }, websiteId: context.websiteId },
    select: { id: true },
  });
  const owned = new Set(rows.map((row) => row.id));
  const missing = unique.filter((id) => !owned.has(id));
  if (missing.length) {
    throw new ValidationError(
      `These page ids do not belong to this website: ${missing.slice(0, 5).join(', ')}`,
      { missing },
    );
  }
  return owned;
}

/**
 * The same guard for the other site-scoped foreign keys an agent can supply.
 *
 * Without it a row created for *this* site could point at another operator's keyword or cluster:
 * the parent row is scoped by the context, but the relation column is whatever the agent passed.
 */
async function assertScopedIds(
  context: AgentContext,
  model: { findMany: (args: { where: { id: { in: string[] }; websiteId: string }; select: { id: true } }) => Promise<Array<{ id: string }>> },
  label: string,
  ids: Array<string | null | undefined>,
): Promise<void> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return;
  const rows = await model.findMany({
    where: { id: { in: unique }, websiteId: context.websiteId },
    select: { id: true },
  });
  const owned = new Set(rows.map((row) => row.id));
  const missing = unique.filter((id) => !owned.has(id));
  if (missing.length) {
    throw new ValidationError(
      `These ${label} ids do not belong to this website: ${missing.slice(0, 5).join(', ')}`,
      { missing },
    );
  }
}

// ── createSeoAction ──────────────────────────────────────────

const createSeoAction = defineTool({
  name: 'createSeoAction',
  description:
    'Propose an SEO action. Priority, risk and whether it can run without approval are decided by the platform, not by the agent.',
  readOnly: false,
  schema: z.object({
    type: z.enum(ACTION_TYPES),
    title: z.string().trim().min(3).max(300),
    reasoning: z.string().trim().min(10).max(5000),
    evidence: z.record(z.unknown()).optional(),
    affectedUrls: z.array(z.string().min(1)).max(200).optional(),
    payload: z.record(z.unknown()).optional(),
    impact: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    businessValue: z.number().min(0).max(1),
    effort: z.number().min(1).max(5),
    sourceType: z.string().min(1).max(60).optional(),
    sourceId: z.string().min(1).max(100).optional(),
    requiredAgent: z.string().min(1).max(60).optional(),
    measureAfterDays: z.number().int().min(1).max(180).optional(),
  }),
  async execute(args, context): Promise<CreatedActionResult> {
    return createActionFromAgent(context, {
      type: args.type,
      title: args.title,
      reasoning: args.reasoning,
      ...(args.evidence ? { evidence: args.evidence } : {}),
      ...(args.affectedUrls ? { affectedUrls: args.affectedUrls } : {}),
      ...(args.payload ? { payload: args.payload } : {}),
      impact: args.impact,
      confidence: args.confidence,
      businessValue: args.businessValue,
      effort: args.effort,
      ...(args.sourceType ? { sourceType: args.sourceType } : {}),
      ...(args.sourceId ? { sourceId: args.sourceId } : {}),
      ...(args.requiredAgent ? { requiredAgent: args.requiredAgent } : {}),
      ...(args.measureAfterDays ? { measureAfterDays: args.measureAfterDays } : {}),
    });
  },
});

// ── createContentOpportunity ─────────────────────────────────

export interface UpsertResult {
  id: string;
  created: boolean;
}

const OPEN_OPPORTUNITY_STATUSES = ['IDENTIFIED', 'ACCEPTED', 'IN_PROGRESS'] as const;

const createContentOpportunity = defineTool({
  name: 'createContentOpportunity',
  description: 'Record a content opportunity (new page, refresh, consolidation…). Idempotent per type + target keyword.',
  readOnly: false,
  schema: z.object({
    type: z.enum(OPPORTUNITY_TYPES),
    title: z.string().trim().min(3).max(300),
    reasoning: z.string().trim().min(10).max(5000),
    pageId: z.string().min(1).optional(),
    keywordId: z.string().min(1).optional(),
    clusterId: z.string().min(1).optional(),
    targetKeyword: z.string().trim().min(1).max(300).optional(),
    secondaryKeywords: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
    suggestedUrl: z.string().trim().min(1).max(2000).optional(),
    evidence: z.record(z.unknown()).optional(),
    impactScore: z.number().min(0).max(1).optional(),
    effortScore: z.number().min(0).max(5).optional(),
    confidenceScore: z.number().min(0).max(1).optional(),
    priorityScore: z.number().min(0).max(100).optional(),
    estimatedTrafficGain: z.number().int().min(0).optional(),
    cannibalizationRisk: z.number().min(0).max(1).optional(),
    existingPageMatch: z.string().max(2000).optional(),
  }),
  async execute(args, context): Promise<UpsertResult> {
    await Promise.all([
      args.pageId ? assertPagesOwned(context, [args.pageId]) : Promise.resolve(),
      assertScopedIds(context, prisma.keyword, 'keyword', [args.keywordId]),
      assertScopedIds(context, prisma.keywordCluster, 'keyword cluster', [args.clusterId]),
    ]);

    const existing = await prisma.contentOpportunity.findFirst({
      where: {
        websiteId: context.websiteId,
        type: args.type,
        status: { in: [...OPEN_OPPORTUNITY_STATUSES] },
        ...(args.targetKeyword ? { targetKeyword: args.targetKeyword } : { title: args.title }),
        ...(args.pageId ? { pageId: args.pageId } : {}),
      },
      select: { id: true },
    });

    const data = {
      title: truncate(args.title, 300),
      reasoning: args.reasoning,
      ...(args.keywordId ? { keywordId: args.keywordId } : {}),
      ...(args.clusterId ? { clusterId: args.clusterId } : {}),
      ...(args.targetKeyword ? { targetKeyword: args.targetKeyword } : {}),
      ...(args.secondaryKeywords ? { secondaryKeywords: args.secondaryKeywords } : {}),
      ...(args.suggestedUrl ? { suggestedUrl: args.suggestedUrl } : {}),
      evidence: json(args.evidence ?? {}),
      impactScore: args.impactScore ?? 0,
      effortScore: args.effortScore ?? 0,
      confidenceScore: args.confidenceScore ?? 0,
      priorityScore: args.priorityScore ?? 0,
      ...(args.estimatedTrafficGain === undefined ? {} : { estimatedTrafficGain: args.estimatedTrafficGain }),
      ...(args.cannibalizationRisk === undefined
        ? {}
        : { cannibalizationRisk: args.cannibalizationRisk, cannibalizationChecked: true }),
      ...(args.existingPageMatch ? { existingPageMatch: args.existingPageMatch } : {}),
    };

    if (existing) {
      await prisma.contentOpportunity.update({ where: { id: existing.id }, data });
      return { id: existing.id, created: false };
    }

    const row = await prisma.contentOpportunity.create({
      data: {
        websiteId: context.websiteId,
        type: args.type,
        ...(args.pageId ? { pageId: args.pageId } : {}),
        ...data,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  },
});

// ── createContentBrief ───────────────────────────────────────

const outlineNodeSchema = z.object({
  heading: z.string().trim().min(1).max(300),
  level: z.number().int().min(2).max(4),
  points: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
});

const createContentBrief = defineTool({
  name: 'createContentBrief',
  description: 'Persist a content brief. Idempotent per opportunity, or per target keyword + title when standalone.',
  readOnly: false,
  schema: z.object({
    title: z.string().trim().min(3).max(300),
    targetKeyword: z.string().trim().min(1).max(300),
    opportunityId: z.string().min(1).optional(),
    secondaryKeywords: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
    intent: z.enum(SEARCH_INTENTS).optional(),
    funnelStage: z.enum(FUNNEL_STAGES).optional(),
    audience: z.string().trim().max(500).optional(),
    suggestedUrl: z.string().trim().max(2000).optional(),
    titleIdeas: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    metaDescription: z.string().trim().max(400).optional(),
    outline: z.array(outlineNodeSchema).max(60).optional(),
    entities: z.array(z.string().trim().min(1).max(200)).max(60).optional(),
    questions: z.array(z.string().trim().min(1).max(500)).max(40).optional(),
    competitorWeaknesses: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    originalAngle: z.string().trim().max(2000).optional(),
    supportingEvidence: z.array(z.record(z.unknown())).max(40).optional(),
    internalLinkTargets: z.array(z.record(z.unknown())).max(40).optional(),
    schemaOpportunity: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
    cta: z.string().trim().max(500).optional(),
    geoRecommendations: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    targetWordCount: z.number().int().min(100).max(20000).optional(),
    serpAnalysis: z.record(z.unknown()).optional(),
  }),
  async execute(args, context): Promise<UpsertResult> {
    if (args.opportunityId) {
      const opportunity = await prisma.contentOpportunity.findFirst({
        where: { id: args.opportunityId, websiteId: context.websiteId },
        select: { id: true },
      });
      if (!opportunity) throw new NotFoundError('ContentOpportunity');
    }

    const data = {
      title: truncate(args.title, 300),
      targetKeyword: args.targetKeyword,
      ...(args.secondaryKeywords ? { secondaryKeywords: args.secondaryKeywords } : {}),
      ...(args.intent ? { intent: args.intent } : {}),
      ...(args.funnelStage ? { funnelStage: args.funnelStage } : {}),
      ...(args.audience ? { audience: args.audience } : {}),
      ...(args.suggestedUrl ? { suggestedUrl: args.suggestedUrl } : {}),
      ...(args.titleIdeas ? { titleIdeas: args.titleIdeas } : {}),
      ...(args.metaDescription ? { metaDescription: args.metaDescription } : {}),
      ...(args.outline ? { outline: json(args.outline) } : {}),
      ...(args.entities ? { entities: args.entities } : {}),
      ...(args.questions ? { questions: args.questions } : {}),
      ...(args.competitorWeaknesses ? { competitorWeaknesses: args.competitorWeaknesses } : {}),
      ...(args.originalAngle ? { originalAngle: args.originalAngle } : {}),
      ...(args.supportingEvidence ? { supportingEvidence: json(args.supportingEvidence) } : {}),
      ...(args.internalLinkTargets ? { internalLinkTargets: json(args.internalLinkTargets) } : {}),
      ...(args.schemaOpportunity ? { schemaOpportunity: args.schemaOpportunity } : {}),
      ...(args.cta ? { cta: args.cta } : {}),
      ...(args.geoRecommendations ? { geoRecommendations: args.geoRecommendations } : {}),
      ...(args.targetWordCount === undefined ? {} : { targetWordCount: args.targetWordCount }),
      ...(args.serpAnalysis ? { serpAnalysis: json(args.serpAnalysis) } : {}),
    };

    const existing = await prisma.contentBrief.findFirst({
      where: {
        websiteId: context.websiteId,
        ...(args.opportunityId
          ? { opportunityId: args.opportunityId }
          : { targetKeyword: args.targetKeyword, title: truncate(args.title, 300) }),
      },
      select: { id: true },
    });

    if (existing) {
      await prisma.contentBrief.update({ where: { id: existing.id }, data });
      return { id: existing.id, created: false };
    }

    const row = await prisma.contentBrief.create({
      data: {
        websiteId: context.websiteId,
        ...(args.opportunityId ? { opportunityId: args.opportunityId } : {}),
        ...data,
      },
      select: { id: true },
    });
    return { id: row.id, created: true };
  },
});

// ── createInternalLinkSuggestions ────────────────────────────

export interface BulkWriteResult {
  requested: number;
  created: number;
  skipped: number;
  /** Why rows were skipped, so an agent does not silently lose half its output. */
  notes: string[];
}

const createInternalLinkSuggestions = defineTool({
  name: 'createInternalLinkSuggestions',
  description:
    'Persist internal link suggestions in bulk. Existing source→target pairs are left untouched (unique key).',
  readOnly: false,
  schema: z.object({
    suggestions: z
      .array(
        z.object({
          sourcePageId: z.string().min(1),
          targetPageId: z.string().min(1),
          anchorText: z.string().trim().min(1).max(300),
          reason: z.string().trim().min(5).max(2000),
          placementHint: z.string().trim().max(500).optional(),
          contextSnippet: z.string().trim().max(2000).optional(),
          relevanceScore: z.number().min(0).max(1).optional(),
          impactScore: z.number().min(0).max(1).optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
  async execute(args, context): Promise<BulkWriteResult> {
    const notes: string[] = [];
    const pageIds = args.suggestions.flatMap((row) => [row.sourcePageId, row.targetPageId]);
    await assertPagesOwned(context, pageIds);

    const selfLinks = args.suggestions.filter((row) => row.sourcePageId === row.targetPageId).length;
    if (selfLinks > 0) notes.push(`${selfLinks} self-link(s) dropped.`);

    // Collapse repeats inside the call as well as against the table: the unique key is
    // (source, target), so two suggestions for the same pair are one row however they arrive,
    // and counting them separately would make `created` disagree with `requested - skipped`.
    const byPair = new Map<string, (typeof args.suggestions)[number]>();
    for (const row of args.suggestions) {
      if (row.sourcePageId === row.targetPageId) continue;
      byPair.set(`${row.sourcePageId}→${row.targetPageId}`, row);
    }
    const candidates = [...byPair.values()];
    const duplicatePairs = args.suggestions.length - selfLinks - candidates.length;
    if (duplicatePairs > 0) notes.push(`${duplicatePairs} duplicate source→target pair(s) collapsed.`);

    const rows: Prisma.InternalLinkSuggestionCreateManyInput[] = candidates.map((row) => ({
      websiteId: context.websiteId,
      sourcePageId: row.sourcePageId,
      targetPageId: row.targetPageId,
      anchorText: truncate(row.anchorText, 300),
      reason: row.reason,
      ...(row.placementHint ? { placementHint: row.placementHint } : {}),
      ...(row.contextSnippet ? { contextSnippet: row.contextSnippet } : {}),
      relevanceScore: row.relevanceScore ?? 0,
      impactScore: row.impactScore ?? 0,
    }));

    const created = await createManyChunked(prisma.internalLinkSuggestion, rows);
    const skipped = args.suggestions.length - created;
    const alreadyExisted = candidates.length - created;
    if (alreadyExisted > 0) {
      notes.push(`${alreadyExisted} suggestion(s) already existed for that source→target pair.`);
    }

    return { requested: args.suggestions.length, created, skipped, notes };
  },
});

// ── createStructuredDataItem ─────────────────────────────────

export interface CreateStructuredDataResult extends UpsertResult {
  schemaType: string;
  validationStatus: string;
  issues: Array<{ severity: string; path: string; message: string }>;
}

const createStructuredDataItem = defineTool({
  name: 'createStructuredDataItem',
  description:
    'Store a JSON-LD block for a page. The markup is validated first and stored with its validation status.',
  readOnly: false,
  schema: z.object({
    jsonLd: z.record(z.unknown()),
    pageId: z.string().min(1).optional(),
    schemaType: z.string().trim().min(1).max(100).optional(),
    source: z.string().trim().min(1).max(60).optional(),
    notes: z.string().trim().max(2000).optional(),
  }),
  async execute(args, context): Promise<CreateStructuredDataResult> {
    if (args.pageId) await assertPagesOwned(context, [args.pageId]);

    const validation = validateJsonLd(args.jsonLd);
    const schemaType = args.schemaType ?? validation.types[0] ?? 'Thing';
    const validationStatus: SchemaValidationStatus =
      validation.status === 'VALID' ? 'VALID' : validation.status === 'WARNING' ? 'WARNING' : 'INVALID';

    const existing = await prisma.structuredDataItem.findFirst({
      where: {
        websiteId: context.websiteId,
        schemaType,
        ...(args.pageId ? { pageId: args.pageId } : { pageId: null }),
      },
      select: { id: true },
    });

    const data = {
      jsonLd: json(args.jsonLd),
      validationStatus,
      validationErrors: json(validation.issues),
      source: args.source ?? 'generated',
      ...(args.notes ? { notes: args.notes } : {}),
    };

    if (existing) {
      await prisma.structuredDataItem.update({ where: { id: existing.id }, data });
      return {
        id: existing.id,
        created: false,
        schemaType,
        validationStatus,
        issues: validation.issues,
      };
    }

    const row = await prisma.structuredDataItem.create({
      data: {
        websiteId: context.websiteId,
        ...(args.pageId ? { pageId: args.pageId } : {}),
        schemaType,
        ...data,
      },
      select: { id: true },
    });

    return { id: row.id, created: true, schemaType, validationStatus, issues: validation.issues };
  },
});

// ── upsertKeywords ───────────────────────────────────────────

export interface UpsertKeywordsResult {
  requested: number;
  created: number;
  updated: number;
  /** Metrics are never invented: a keyword with no supplied volume keeps whatever it already had. */
  note: string;
}

const upsertKeywords = defineTool({
  name: 'upsertKeywords',
  description:
    'Create or update keywords by (keyword, locale). Intent, funnel stage and business value are inferred deterministically when omitted.',
  readOnly: false,
  schema: z.object({
    keywords: z
      .array(
        z.object({
          keyword: z.string().trim().min(1).max(300),
          locale: z.string().trim().min(2).max(10).optional(),
          language: z.string().trim().min(2).max(10).optional(),
          country: z.string().trim().min(2).max(60).optional(),
          intent: z.enum(SEARCH_INTENTS).optional(),
          funnelStage: z.enum(FUNNEL_STAGES).optional(),
          source: z.enum(KEYWORD_SOURCES).optional(),
          isTracked: z.boolean().optional(),
          isBranded: z.boolean().optional(),
          isContentGap: z.boolean().optional(),
          searchVolume: z.number().int().min(0).optional(),
          difficulty: z.number().min(0).max(100).optional(),
          volumeSource: z.string().trim().max(60).optional(),
          clusterId: z.string().min(1).optional(),
          pageId: z.string().min(1).optional(),
          relevanceScore: z.number().min(0).max(1).optional(),
          opportunityScore: z.number().min(0).max(100).optional(),
          opportunityReason: z.string().trim().max(2000).optional(),
        }),
      )
      .min(1)
      .max(500),
  }),
  async execute(args, context): Promise<UpsertKeywordsResult> {
    await Promise.all([
      assertPagesOwned(context, args.keywords.map((row) => row.pageId).filter((id): id is string => Boolean(id))),
      assertScopedIds(context, prisma.keywordCluster, 'keyword cluster', args.keywords.map((row) => row.clusterId)),
    ]);

    const now = new Date();
    // Prepared once so the same normalisation decides both the lookup key and what is written.
    const prepared = args.keywords.flatMap((row) => {
      const normalized = normalizeKeyword(row.keyword);
      if (!normalized) return [];
      const locale = row.locale ?? 'en-US';
      const intent = row.intent ?? inferIntent(row.keyword);
      const funnelStage = row.funnelStage ?? inferFunnelStage(intent);
      return [{
        key: `${normalized}::${locale}`,
        keyword: row.keyword.trim(),
        normalized,
        locale,
        source: row.source ?? ('AI_EXPANSION' as const),
        data: {
          intent,
          funnelStage,
          ...(row.language ? { language: row.language } : {}),
          ...(row.country ? { country: row.country } : {}),
          ...(row.source ? { source: row.source } : {}),
          ...(row.isTracked === undefined ? {} : { isTracked: row.isTracked }),
          ...(row.isBranded === undefined ? {} : { isBranded: row.isBranded }),
          ...(row.isContentGap === undefined ? {} : { isContentGap: row.isContentGap }),
          ...(row.searchVolume === undefined ? {} : { searchVolume: row.searchVolume }),
          ...(row.difficulty === undefined ? {} : { difficulty: row.difficulty }),
          ...(row.volumeSource ? { volumeSource: row.volumeSource } : {}),
          ...(row.clusterId ? { clusterId: row.clusterId } : {}),
          ...(row.pageId ? { pageId: row.pageId } : {}),
          ...(row.relevanceScore === undefined ? {} : { relevanceScore: row.relevanceScore }),
          ...(row.opportunityScore === undefined ? {} : { opportunityScore: row.opportunityScore }),
          ...(row.opportunityReason ? { opportunityReason: row.opportunityReason } : {}),
          businessValue: inferBusinessValue(row.keyword, intent),
          geoPotential: estimateGeoPotential(row.keyword, intent),
          lastSeenAt: now,
        },
      }];
    });

    // Last write wins for a keyword repeated inside one call, so the batch cannot fight itself.
    const byKey = new Map(prepared.map((row) => [row.key, row]));
    const entries = [...byKey.values()];
    if (entries.length === 0) {
      return {
        requested: args.keywords.length,
        created: 0,
        updated: 0,
        note: 'Nothing was written: no supplied keyword normalised to a non-empty string.',
      };
    }

    // One lookup for the whole batch instead of a findUnique per keyword: 500 keywords used to
    // mean 1000 sequential round trips.
    const existing = new Map<string, string>();
    for (const slice of chunk(entries, 500)) {
      const found = await prisma.keyword.findMany({
        where: { websiteId: context.websiteId, normalized: { in: slice.map((row) => row.normalized) } },
        select: { id: true, normalized: true, locale: true },
      });
      for (const row of found) existing.set(`${row.normalized}::${row.locale}`, row.id);
    }

    const toCreate = entries.filter((row) => !existing.has(row.key));
    const toUpdate = entries.filter((row) => existing.has(row.key));

    const created = await createManyChunked<Prisma.KeywordCreateManyInput>(
      prisma.keyword,
      toCreate.map((row) => ({
        websiteId: context.websiteId,
        keyword: row.keyword,
        normalized: row.normalized,
        locale: row.locale,
        source: row.source,
        firstSeenAt: now,
        ...row.data,
      })),
    );

    let updated = 0;
    for (const slice of chunk(toUpdate, 100)) {
      const writes = slice.flatMap((row) => {
        const id = existing.get(row.key);
        return id ? [prisma.keyword.update({ where: { id }, data: row.data })] : [];
      });
      if (writes.length) {
        await prisma.$transaction(writes);
        updated += writes.length;
      }
    }

    // `createMany skipDuplicates` silently drops rows a concurrent writer inserted first. Which
    // ones is not reported, so on a race the whole insert slice is written again as updates —
    // the data is identical for the rows we did create, and the contended ones get the metadata
    // they would otherwise have lost. Only the contended count is reported as updated so the
    // returned totals still add up to what was requested.
    const raced = toCreate.length - created;
    if (raced > 0) {
      const rows = await prisma.keyword.findMany({
        where: {
          websiteId: context.websiteId,
          normalized: { in: toCreate.map((row) => row.normalized) },
        },
        select: { id: true, normalized: true, locale: true },
      });
      const idByKey = new Map(rows.map((row) => [`${row.normalized}::${row.locale}`, row.id]));
      const retries = toCreate.flatMap((row) => {
        const id = idByKey.get(row.key);
        return id ? [prisma.keyword.update({ where: { id }, data: row.data })] : [];
      });
      for (const slice of chunk(retries, 100)) await prisma.$transaction(slice);
      updated += raced;
    }

    return {
      requested: args.keywords.length,
      created,
      updated,
      note: 'Search volume and difficulty are only set when supplied by a provider; they are never estimated here.',
    };
  },
});

// ── upsertEntities ───────────────────────────────────────────

export interface UpsertEntitiesResult {
  requested: number;
  created: number;
  updated: number;
  /** Relationship rows written (created or refreshed). */
  relationshipsCreated: number;
  /** Relationships whose endpoints could not be resolved to entities on this site. */
  relationshipsSkipped: number;
}

const upsertEntities = defineTool({
  name: 'upsertEntities',
  description: 'Create or update entities (and optional relationships) for the site entity graph, keyed by name + type.',
  readOnly: false,
  schema: z.object({
    entities: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(300),
          type: z.enum(ENTITY_TYPES),
          description: z.string().trim().max(2000).optional(),
          aliases: z.array(z.string().trim().min(1).max(200)).max(30).optional(),
          sameAs: z.array(z.string().trim().min(1).max(2000)).max(30).optional(),
          canonicalUrl: z.string().trim().max(2000).optional(),
          attributes: z.record(z.unknown()).optional(),
          confidence: z.number().min(0).max(1).optional(),
          mentionCount: z.number().int().min(0).optional(),
          isPrimary: z.boolean().optional(),
          source: z.string().trim().max(60).optional(),
        }),
      )
      .min(1)
      .max(300),
    relationships: z
      .array(
        z.object({
          fromName: z.string().trim().min(1).max(300),
          fromType: z.enum(ENTITY_TYPES),
          toName: z.string().trim().min(1).max(300),
          toType: z.enum(ENTITY_TYPES),
          relation: z.string().trim().min(1).max(100),
          weight: z.number().min(0).max(10).optional(),
          evidence: z.string().trim().max(2000).optional(),
        }),
      )
      .max(500)
      .optional(),
  }),
  async execute(args, context): Promise<UpsertEntitiesResult> {
    const relationships = args.relationships ?? [];
    const keyOf = (name: string, type: string) => `${type}:${name}`;

    // One lookup covers both "did this exist already" (so the created/updated split is real
    // rather than inferred from timestamps) and "does this relationship endpoint exist on this
    // site" (so a relationship to an entity written by an earlier run is not silently dropped).
    const wanted = new Map<string, { name: string; type: EntityTypeName }>();
    for (const entity of args.entities) wanted.set(keyOf(entity.name, entity.type), entity);
    for (const relation of relationships) {
      wanted.set(keyOf(relation.fromName, relation.fromType), {
        name: relation.fromName,
        type: relation.fromType,
      });
      wanted.set(keyOf(relation.toName, relation.toType), { name: relation.toName, type: relation.toType });
    }

    const idByKey = new Map<string, string>();
    for (const slice of chunk([...wanted.values()], 200)) {
      const found = await prisma.entity.findMany({
        where: {
          websiteId: context.websiteId,
          OR: slice.map((row) => ({ name: row.name, type: row.type })),
        },
        select: { id: true, name: true, type: true },
      });
      for (const row of found) idByKey.set(keyOf(row.name, row.type), row.id);
    }

    const existingBefore = new Set(idByKey.keys());

    // Batched rather than awaited one at a time: 300 entities used to be 300 sequential round
    // trips. Upsert is still per row (there is no bulk upsert), but a transaction sends the whole
    // chunk in one go and makes the chunk atomic.
    for (const slice of chunk(args.entities, 50)) {
      const writes = slice.map((entity) => {
        const data = {
          ...(entity.description ? { description: entity.description } : {}),
          ...(entity.aliases ? { aliases: entity.aliases } : {}),
          ...(entity.sameAs ? { sameAs: entity.sameAs } : {}),
          ...(entity.canonicalUrl ? { canonicalUrl: entity.canonicalUrl } : {}),
          ...(entity.attributes ? { attributes: json(entity.attributes) } : {}),
          ...(entity.confidence === undefined ? {} : { confidence: entity.confidence }),
          ...(entity.mentionCount === undefined ? {} : { mentionCount: entity.mentionCount }),
          ...(entity.isPrimary === undefined ? {} : { isPrimary: entity.isPrimary }),
          ...(entity.source ? { source: entity.source } : {}),
        };
        return prisma.entity.upsert({
          where: {
            websiteId_name_type: {
              websiteId: context.websiteId,
              name: entity.name,
              type: entity.type,
            },
          },
          create: { websiteId: context.websiteId, name: entity.name, type: entity.type, ...data },
          update: data,
          select: { id: true, name: true, type: true },
        });
      });
      const rows = await prisma.$transaction(writes);
      for (const row of rows) idByKey.set(keyOf(row.name, row.type), row.id);
    }

    let created = 0;
    let updated = 0;
    const counted = new Set<string>();
    for (const entity of args.entities) {
      const key = keyOf(entity.name, entity.type);
      if (counted.has(key)) continue;
      counted.add(key);
      if (existingBefore.has(key)) updated += 1;
      else created += 1;
    }

    let relationshipsCreated = 0;
    let relationshipsSkipped = 0;
    const resolved = relationships.flatMap((relation) => {
      const fromId = idByKey.get(keyOf(relation.fromName, relation.fromType));
      const toId = idByKey.get(keyOf(relation.toName, relation.toType));
      if (!fromId || !toId || fromId === toId) {
        relationshipsSkipped += 1;
        return [];
      }
      return [{ ...relation, fromId, toId }];
    });

    for (const slice of chunk(resolved, 50)) {
      const writes = slice.map((relation) =>
        prisma.entityRelationship.upsert({
          where: {
            fromId_toId_relation: {
              fromId: relation.fromId,
              toId: relation.toId,
              relation: relation.relation,
            },
          },
          create: {
            fromId: relation.fromId,
            toId: relation.toId,
            relation: relation.relation,
            weight: relation.weight ?? 1,
            ...(relation.evidence ? { evidence: relation.evidence } : {}),
          },
          update: {
            weight: relation.weight ?? 1,
            ...(relation.evidence ? { evidence: relation.evidence } : {}),
          },
        }),
      );
      await prisma.$transaction(writes);
      relationshipsCreated += writes.length;
    }

    return {
      requested: args.entities.length,
      created,
      updated,
      relationshipsCreated,
      relationshipsSkipped,
    };
  },
});

// ── createNotification ───────────────────────────────────────

const createNotification = defineTool({
  name: 'createNotification',
  description:
    'Tell the operator something happened. Supply a dedupeKey so a recurring detection does not spam the inbox.',
  readOnly: false,
  schema: z.object({
    type: z.string().trim().min(1).max(60),
    title: z.string().trim().min(3).max(200),
    message: z.string().trim().min(3).max(2000),
    severity: z.enum(NOTIFICATION_SEVERITIES).optional(),
    link: z.string().trim().max(2000).optional(),
    data: z.record(z.unknown()).optional(),
    dedupeKey: z.string().trim().min(1).max(200).optional(),
    userId: z.string().min(1).optional(),
  }),
  async execute(args, context): Promise<UpsertResult> {
    // `Notification.dedupeKey` is unique across the whole table, not per site, so a caller-supplied
    // key like "gsc-drop" would collide between websites and one site's upsert would rewrite
    // another's row. Every key is therefore namespaced with the website id before it is used.
    // Without a supplied key, site + type + title is stable enough to collapse repeat detections.
    const dedupeKey = args.dedupeKey
      ? `${context.websiteId}:${truncate(args.dedupeKey, 150, '')}`
      : sha256(`${context.websiteId}|${args.type}|${args.title}`).slice(0, 40);

    const data = {
      type: args.type,
      title: truncate(args.title, 200),
      message: args.message,
      severity: args.severity ?? 'INFO',
      ...(args.link ? { link: args.link } : {}),
      data: json(args.data ?? {}),
    };

    const existing = await prisma.notification.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });

    const userId = args.userId ?? context.userId ?? null;
    const row = await prisma.notification.upsert({
      where: { dedupeKey },
      create: {
        websiteId: context.websiteId,
        ...(userId ? { userId } : {}),
        dedupeKey,
        ...data,
      },
      // A repeat detection is worth re-surfacing, so the row is marked unread again.
      update: { ...data, isRead: false, readAt: null },
      select: { id: true },
    });

    log.debug('notification upserted', { websiteId: context.websiteId, type: args.type });
    return { id: row.id, created: existing === null };
  },
});

export const writeTools: AnyToolDefinition[] = [
  createSeoAction,
  createContentBrief,
  createContentOpportunity,
  createInternalLinkSuggestions,
  createStructuredDataItem,
  upsertKeywords,
  createNotification,
  upsertEntities,
];

/** Tool names in this module, for an agent definition's `tools` list. */
export const WRITE_TOOL_NAMES = writeTools.map((tool) => tool.name);
