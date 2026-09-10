/**
 * The AI lane, plus the two jobs that share its shape: link intelligence and SERP/competitor
 * work.
 *
 * Two things are worth knowing before reading on.
 *
 * **Most of this is deterministic.** GEO scoring, entity extraction, internal-link suggestions
 * and gap analysis all run in `@seo/seo-engine` with no model involved; the LLM is used where
 * language is genuinely the task (prompt discovery, assistant answers). That keeps the product
 * useful on an install with no AI key at all — those jobs return a typed skip that names the
 * environment variable to set, and every other job here still runs.
 *
 * **Nothing is measured that was not observed.** AI-visibility runs record what a model
 * actually answered and which URLs it actually cited; the brand-mention analysis is string
 * matching over that answer, not a second model asked to guess.
 */

import {
  type Entity,
  EmbeddingOwner,
  type EntityType,
  NotificationSeverity,
  type Prisma,
  SuggestionStatus,
  createManyChunked,
  json,
  prisma,
} from '@seo/db';
import type { JobHandler } from '@seo/queue';
import {
  clamp,
  createLogger,
  errorMessage,
  getPath,
  isSameSite,
  round,
  toUtcDate,
  truncate,
} from '@seo/shared';
import {
  ai,
  aiVisibilityPromptDiscoveryPrompt,
  getAvailableProviders,
  isAiAvailable,
  isEmbeddingAvailable,
  upsertEmbeddingsBatch,
  type UpsertEmbeddingInput,
} from '@seo/ai';
import {
  applyChange,
  captureSerpSnapshot,
  discoverCompetitorsFromSerp,
  isSerpAvailable,
  listSerpProviders,
  parseStoredSerpResults,
  summariseChanges,
} from '@seo/integrations';
import {
  analyseKeywordGaps,
  auditAnchorText,
  auditSiteGeo,
  buildCompetitorOverview,
  extractEntities,
  scoreEntityCoverage,
  suggestInternalLinks,
  type CompetitorKeywordRow,
  type EntityCandidate,
  type GeoPageInput,
  type GeoSiteContext,
  type LinkCandidatePage,
  type OurKeywordRow,
} from '@seo/seo-engine';
import { z } from 'zod';
import { effectiveSettings, loadWebsite, type WebsiteWithSettings } from '../lib/website';
import { dispatchAgent } from '../lib/agent-runtime';
import { runChunked } from '../lib/batch';
import { skip } from '../lib/result';

const log = createLogger('worker:ai');

/** Pages loaded with their full text for a GEO or entity pass. Text is the memory cost here. */
const TEXT_PAGE_SAMPLE = 60;
const TEXT_PAGE_FULL = 300;

/** Pages considered for internal-link suggestions in one pass. */
const LINK_PAGE_LIMIT = 400;

/** Characters of page text handed to the deterministic analysers. */
const TEXT_SLICE = 12_000;

const AI_MISSING = 'No AI provider is configured.';
const AI_ENV = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_AI_API_KEY'];

// ─────────────────────────────────────────────────────────────
// Shared loaders
// ─────────────────────────────────────────────────────────────

interface PageWithText {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string | null;
  h1: string | null;
  metaDescription: string | null;
  pageType: string;
  wordCount: number;
  isIndexable: boolean;
  depth: number;
  impressions28d: number;
  internalLinksIn: number;
  internalLinksOut: number;
  schemaTypes: string[];
  textContent: string | null;
  headings: Array<{ level: number; text: string }>;
  structuredData: unknown[];
  crawlPageId: string | null;
}

function readHeadings(value: Prisma.JsonValue | null | undefined): Array<{ level: number; text: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ level: number; text: string }> = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.level === 'number' && typeof record.text === 'string') {
      out.push({ level: record.level, text: record.text });
    }
  }
  return out;
}

/**
 * Loads pages together with the text captured by the latest crawl.
 *
 * `Page` deliberately has no text column — the body lives on the immutable `CrawlPage` row —
 * so anything that reads content joins through the newest completed crawl.
 */
async function loadPagesWithText(
  websiteId: string,
  options: { limit: number; pageIds?: string[] | null; requireIndexable?: boolean },
): Promise<{ pages: PageWithText[]; crawlId: string | null }> {
  const crawl = await prisma.crawl.findFirst({
    where: { websiteId, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  const pages = await prisma.page.findMany({
    where: {
      websiteId,
      isActive: true,
      ...(options.requireIndexable === false ? {} : { isIndexable: true }),
      ...(options.pageIds?.length ? { id: { in: options.pageIds } } : {}),
    },
    orderBy: [{ impressions28d: 'desc' }, { depth: 'asc' }],
    take: options.limit,
    select: {
      id: true,
      url: true,
      normalizedUrl: true,
      title: true,
      h1: true,
      metaDescription: true,
      pageType: true,
      wordCount: true,
      isIndexable: true,
      depth: true,
      impressions28d: true,
      internalLinksIn: true,
      internalLinksOut: true,
      schemaTypes: true,
    },
  });

  if (pages.length === 0) return { pages: [], crawlId: crawl?.id ?? null };

  const textByPage = new Map<
    string,
    { id: string; textContent: string | null; headings: Prisma.JsonValue | null; structuredData: Prisma.JsonValue | null }
  >();

  if (crawl) {
    const ids = pages.map((page) => page.id);
    for (let i = 0; i < ids.length; i += 200) {
      const rows = await prisma.crawlPage.findMany({
        where: { crawlId: crawl.id, pageId: { in: ids.slice(i, i + 200) } },
        select: { id: true, pageId: true, textContent: true, headings: true, structuredData: true },
      });
      for (const row of rows) {
        if (!row.pageId) continue;
        textByPage.set(row.pageId, {
          id: row.id,
          textContent: row.textContent,
          headings: row.headings,
          structuredData: row.structuredData,
        });
      }
    }
  }

  return {
    crawlId: crawl?.id ?? null,
    pages: pages.map((page) => {
      const extra = textByPage.get(page.id);
      return {
        ...page,
        textContent: extra?.textContent ? extra.textContent.slice(0, TEXT_SLICE) : null,
        headings: readHeadings(extra?.headings),
        structuredData: Array.isArray(extra?.structuredData) ? extra.structuredData : [],
        crawlPageId: extra?.id ?? null,
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────
// agents.run
// ─────────────────────────────────────────────────────────────

export interface AgentJobResult {
  status: 'completed';
  agent: string;
  agentRunId: string | null;
  summary: string;
  confidence: number | null;
  actionsCreated: number;
  approvalsCreated: number;
  costUsd: number;
}

export const agentsRun: JobHandler<'agents.run'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, `Running ${payload.agent}`);

  const dispatch = await dispatchAgent({
    agent: payload.agent,
    websiteId: website.id,
    trigger: payload.trigger === 'schedule' ? 'scheduled' : 'manual',
    input: payload.input ?? {},
  });

  if (!dispatch.available) {
    return skip(dispatch.reason, ['Install the agents package on the worker']);
  }

  const outcome = dispatch.outcome;

  // The API can pre-create an AgentRun row so the UI has something to follow from the moment
  // of enqueue, but the agent runtime owns run rows. Reconcile the placeholder rather than
  // leaving a permanently RUNNING ghost on the runs screen.
  if (payload.agentRunId && payload.agentRunId !== outcome.runId) {
    await prisma.agentRun
      .update({
        where: { id: payload.agentRunId },
        data: {
          status: outcome.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
          summary: truncate(outcome.result?.summary ?? outcome.skipReason ?? outcome.error ?? '', 1_000),
          output: json({ supersededBy: outcome.runId, ...(outcome.result?.data ?? {}) }),
          error: outcome.error,
          finishedAt: new Date(),
          durationMs: outcome.durationMs,
        },
      })
      .catch((err: unknown) => {
        log.warn('could not reconcile the placeholder agent run', {
          agentRunId: payload.agentRunId,
          error: errorMessage(err),
        });
      });
  }

  if (outcome.skipped) {
    return skip(outcome.skipReason ?? `${payload.agent} had no prerequisites to work from.`, AI_ENV);
  }
  if (!outcome.ok) {
    const message = outcome.error ?? `${payload.agent} failed.`;
    if (outcome.retryable) throw new Error(message);
    return skip(message);
  }

  await ctx.updateProgress(100, 'Agent complete');
  const result: AgentJobResult = {
    status: 'completed',
    agent: outcome.agent,
    agentRunId: outcome.runId,
    summary: outcome.result?.summary ?? '',
    confidence: outcome.result?.confidence ?? null,
    actionsCreated: outcome.result?.actionsCreated.length ?? 0,
    approvalsCreated: outcome.result?.approvalsCreated.length ?? 0,
    costUsd: round(outcome.usage.costUsd, 4),
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// agents.manager-plan
// ─────────────────────────────────────────────────────────────

export const agentsManagerPlan: JobHandler<'agents.manager-plan'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, 'Planning');

  const dispatch = await dispatchAgent({
    agent: 'SEOManagerAgent',
    websiteId: website.id,
    trigger: payload.trigger === 'schedule' ? 'scheduled' : 'manual',
    input: { horizonDays: payload.horizonDays ?? 30 },
  });

  if (!dispatch.available) {
    return skip(dispatch.reason, ['Install the agents package on the worker']);
  }

  const outcome = dispatch.outcome;
  if (outcome.skipped) return skip(outcome.skipReason ?? 'The manager agent had nothing to plan from.', AI_ENV);
  if (!outcome.ok) {
    const message = outcome.error ?? 'The manager agent failed.';
    if (outcome.retryable) throw new Error(message);
    return skip(message);
  }

  const plan = await prisma.strategyPlan.findFirst({
    where: { websiteId: website.id, isCurrent: true },
    orderBy: { createdAt: 'desc' },
    select: { id: true, periodLabel: true },
  });

  await ctx.updateProgress(100, 'Plan ready');
  return {
    status: 'completed' as const,
    agentRunId: outcome.runId,
    summary: outcome.result?.summary ?? '',
    planId: plan?.id ?? null,
    periodLabel: plan?.periodLabel ?? null,
    actionsCreated: outcome.result?.actionsCreated.length ?? 0,
  };
};

// ─────────────────────────────────────────────────────────────
// geo.audit
// ─────────────────────────────────────────────────────────────

export interface GeoAuditResult {
  status: 'completed';
  auditId: string;
  score: number;
  pagesAudited: number;
  findings: number;
  sampled: boolean;
}

export const geoAudit: JobHandler<'geo.audit'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const limit = payload.full ? TEXT_PAGE_FULL : TEXT_PAGE_SAMPLE;

  await ctx.updateProgress(10, 'Loading pages');
  const { pages } = await loadPagesWithText(website.id, {
    limit,
    pageIds: payload.pageIds ?? null,
  });

  const withText = pages.filter((page) => page.textContent && page.wordCount > 100);
  if (withText.length === 0) {
    return skip(
      `No crawled page on ${website.domain} has enough stored text to audit for answer-engine readiness.`,
      ['Run a site crawl first'],
    );
  }

  await ctx.updateProgress(30, 'Reading site context');
  const site = await buildGeoContext(website, withText);

  const externalLinksByPage = await loadExternalLinks(
    withText.map((page) => page.crawlPageId).filter((id): id is string => id !== null),
  );

  const inputs: GeoPageInput[] = withText.map((page) => ({
    id: page.id,
    url: page.url,
    title: page.title,
    h1: page.h1,
    metaDescription: page.metaDescription,
    textContent: page.textContent,
    wordCount: page.wordCount,
    headings: page.headings,
    schemaTypes: page.schemaTypes,
    structuredData: page.structuredData,
    externalLinks: page.crawlPageId ? externalLinksByPage.get(page.crawlPageId) ?? [] : [],
    pageType: page.pageType,
    isIndexable: page.isIndexable,
  }));

  const weights = new Map(withText.map((page) => [page.id, Math.max(1, page.impressions28d)]));

  await ctx.updateProgress(55, `Scoring ${inputs.length} pages`);
  const audit = auditSiteGeo(inputs, site, weights);

  const record = await prisma.geoAudit.create({
    data: {
      websiteId: website.id,
      overallScore: audit.score,
      dimensions: json(audit.dimensions),
      findings: json(audit.findings),
      // Recommendations are the findings ranked by severity: each one already carries the
      // concrete change to make, so re-phrasing them through a model would add nothing but risk.
      recommendations: json(
        [...audit.findings]
          .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
          .slice(0, 25)
          .map((finding) => ({
            dimension: finding.dimension,
            severity: finding.severity,
            recommendation: finding.message,
            url: finding.url ?? null,
          })),
      ),
      pagesAudited: audit.pagesAudited,
      method: 'deterministic',
      summary: truncate(audit.summary, 2_000),
    },
    select: { id: true },
  });

  await ctx.updateProgress(80, 'Storing page scores');

  const pageAudits: Prisma.GeoPageAuditCreateManyInput[] = audit.pageScores.map((page) => ({
    auditId: record.id,
    pageId: page.pageId,
    score: page.score,
    dimensions: json(Object.fromEntries(page.factors.map((factor) => [factor.key, factor.value]))),
    findings: json(page.findings),
  }));
  if (pageAudits.length) await createManyChunked(prisma.geoPageAudit, pageAudits, 200);

  await runChunked(
    audit.pageScores.map((page) =>
      prisma.page.update({ where: { id: page.pageId }, data: { geoScore: page.score } }),
    ),
    100,
  );

  await prisma.website.update({ where: { id: website.id }, data: { geoScore: audit.score } });

  await ctx.updateProgress(100, 'GEO audit complete');
  const result: GeoAuditResult = {
    status: 'completed',
    auditId: record.id,
    score: audit.score,
    pagesAudited: audit.pagesAudited,
    findings: audit.findings.length,
    sampled: !payload.full,
  };
  return result;
};

function severityRank(severity: 'high' | 'medium' | 'low'): number {
  return severity === 'high' ? 3 : severity === 'medium' ? 2 : 1;
}

async function buildGeoContext(
  website: WebsiteWithSettings,
  pages: PageWithText[],
): Promise<GeoSiteContext> {
  const [knowledgeBase, verifiedFacts, entities, schemaTypes] = await Promise.all([
    prisma.knowledgeBase.findUnique({
      where: { websiteId: website.id },
      select: { businessDescription: true },
    }),
    prisma.brandFact.count({ where: { websiteId: website.id, verified: true } }),
    prisma.entity.findMany({
      where: { websiteId: website.id },
      orderBy: { mentionCount: 'desc' },
      take: 50,
      select: { name: true },
    }),
    prisma.page.findMany({
      where: { websiteId: website.id, isActive: true, schemaTypes: { isEmpty: false } },
      take: 500,
      select: { schemaTypes: true, pageType: true },
    }),
  ]);

  const allSchema = new Set(schemaTypes.flatMap((row) => row.schemaTypes));
  const types = new Set(schemaTypes.map((row) => row.pageType));
  const pageTypes = new Set(pages.map((page) => page.pageType));

  return {
    brandName: website.brandName ?? website.name,
    domain: website.domain,
    brandDescriptions: [
      website.description ?? '',
      knowledgeBase?.businessDescription ?? '',
      ...pages.slice(0, 5).map((page) => page.metaDescription ?? ''),
    ].filter(Boolean),
    hasAboutPage: pageTypes.has('ABOUT') || types.has('ABOUT'),
    hasContactPage: pageTypes.has('CONTACT') || types.has('CONTACT'),
    hasAuthorPages: pageTypes.has('AUTHOR') || types.has('AUTHOR'),
    organizationSchemaFound: allSchema.has('Organization') || allSchema.has('LocalBusiness'),
    websiteSchemaFound: allSchema.has('WebSite'),
    verifiedFactCount: verifiedFacts,
    knownEntities: entities.map((entity) => entity.name),
  };
}

/** Outbound external links per crawl page, for the citation/source-quality dimensions. */
async function loadExternalLinks(
  crawlPageIds: string[],
): Promise<Map<string, Array<{ href: string; anchorText: string; isNofollow: boolean }>>> {
  const map = new Map<string, Array<{ href: string; anchorText: string; isNofollow: boolean }>>();
  for (let i = 0; i < crawlPageIds.length; i += 100) {
    const rows = await prisma.linkEdge.findMany({
      where: { sourceCrawlPageId: { in: crawlPageIds.slice(i, i + 100) }, isInternal: false },
      take: 5_000,
      select: { sourceCrawlPageId: true, targetUrl: true, anchorText: true, isNofollow: true },
    });
    for (const row of rows) {
      const list = map.get(row.sourceCrawlPageId) ?? [];
      list.push({
        href: row.targetUrl,
        anchorText: row.anchorText ?? '',
        isNofollow: row.isNofollow,
      });
      map.set(row.sourceCrawlPageId, list);
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// entities.extract
// ─────────────────────────────────────────────────────────────

export interface EntityExtractResult {
  status: 'completed';
  entitiesFound: number;
  entitiesWritten: number;
  relationships: number;
  coverageScore: number;
  gaps: number;
}

export const entitiesExtract: JobHandler<'entities.extract'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, 'Loading pages');

  const { pages } = await loadPagesWithText(website.id, {
    limit: TEXT_PAGE_FULL,
    pageIds: payload.pageIds ?? null,
  });
  if (pages.length === 0) {
    return skip(`${website.domain} has no crawled pages to extract entities from.`, [
      'Run a site crawl first',
    ]);
  }

  const [knowledgeBase, clusters] = await Promise.all([
    prisma.knowledgeBase.findUnique({ where: { websiteId: website.id } }),
    prisma.keywordCluster.findMany({
      where: { websiteId: website.id },
      orderBy: { totalImpressions: 'desc' },
      take: 60,
      select: { name: true },
    }),
  ]);

  await ctx.updateProgress(35, 'Extracting entities');
  const extraction = extractEntities({
    brandName: website.brandName ?? null,
    domain: website.domain,
    siteName: website.name,
    knowledgeBase: {
      businessDescription: knowledgeBase?.businessDescription ?? null,
      products: readJsonArray<{ name: string; description?: string; url?: string }>(knowledgeBase?.products),
      terminology: readJsonArray<{ term: string; definition: string }>(knowledgeBase?.terminology),
      authorBios: readJsonArray<{ name: string; title?: string; bio?: string; url?: string }>(
        knowledgeBase?.authorBios,
      ),
    },
    pages: pages.map((page) => ({
      url: page.url,
      title: page.title,
      h1: page.h1,
      textContent: page.textContent,
      structuredData: page.structuredData,
      pageType: page.pageType,
    })),
    topicNames: clusters.map((cluster) => cluster.name),
  });

  const wanted = payload.types?.length
    ? extraction.entities.filter((entity) => (payload.types as string[]).includes(entity.type))
    : extraction.entities;

  await ctx.updateProgress(65, `Storing ${wanted.length} entities`);

  const idByKey = new Map<string, string>();
  let written = 0;
  for (const candidate of wanted) {
    const row = await upsertEntity(website.id, candidate);
    idByKey.set(`${candidate.name.toLowerCase()}|${candidate.type}`, row.id);
    written += 1;
  }

  let relationships = 0;
  for (const relation of extraction.relationships) {
    const fromId = findEntityId(idByKey, relation.from);
    const toId = findEntityId(idByKey, relation.to);
    if (!fromId || !toId || fromId === toId) continue;
    await prisma.entityRelationship
      .upsert({
        where: { fromId_toId_relation: { fromId, toId, relation: relation.relation } },
        create: {
          fromId,
          toId,
          relation: relation.relation,
          weight: relation.weight,
          evidence: relation.evidence ?? null,
        },
        update: { weight: relation.weight, evidence: relation.evidence ?? null },
      })
      .then(() => {
        relationships += 1;
      })
      .catch((err: unknown) => {
        log.warn('could not store an entity relationship', { error: errorMessage(err) });
      });
  }

  const coverage = scoreEntityCoverage(
    wanted,
    pages.map((page) => ({ url: page.url, pageType: page.pageType, textContent: page.textContent })),
  );

  await ctx.updateProgress(100, 'Entity extraction complete');
  const result: EntityExtractResult = {
    status: 'completed',
    entitiesFound: extraction.entities.length,
    entitiesWritten: written,
    relationships,
    coverageScore: coverage.score,
    gaps: coverage.gaps.length,
  };
  return result;
};

function readJsonArray<T>(value: Prisma.JsonValue | null | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function findEntityId(index: Map<string, string>, name: string): string | null {
  const needle = name.toLowerCase();
  for (const [key, id] of index) {
    if (key.startsWith(`${needle}|`)) return id;
  }
  return null;
}

async function upsertEntity(websiteId: string, candidate: EntityCandidate): Promise<Entity> {
  return prisma.entity.upsert({
    where: {
      websiteId_name_type: {
        websiteId,
        name: candidate.name,
        type: candidate.type as EntityType,
      },
    },
    create: {
      websiteId,
      name: candidate.name,
      type: candidate.type as EntityType,
      description: candidate.description ?? null,
      aliases: candidate.aliases,
      sameAs: candidate.sameAs ?? [],
      canonicalUrl: candidate.canonicalUrl ?? null,
      confidence: candidate.confidence,
      mentionCount: candidate.mentionCount,
      isPrimary: candidate.type === 'BRAND',
      source: candidate.source,
    },
    update: {
      description: candidate.description ?? undefined,
      aliases: candidate.aliases,
      sameAs: candidate.sameAs ?? [],
      canonicalUrl: candidate.canonicalUrl ?? undefined,
      confidence: candidate.confidence,
      mentionCount: candidate.mentionCount,
      source: candidate.source,
    },
  });
}

// ─────────────────────────────────────────────────────────────
// aivis.discover-prompts
// ─────────────────────────────────────────────────────────────

export const aivisDiscoverPrompts: JobHandler<'aivis.discover-prompts'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const settings = effectiveSettings(website);

  if (!isAiAvailable()) {
    return skip(
      `${AI_MISSING} AI-visibility prompts are written by a model, so this job cannot run without one.`,
      AI_ENV,
    );
  }

  const locale = payload.locale ?? website.targetLocales[0] ?? 'en-US';
  const count = payload.limit ?? 25;

  const [keywords, competitors, existing] = await Promise.all([
    prisma.keyword.findMany({
      where: { websiteId: website.id },
      orderBy: { opportunityScore: 'desc' },
      take: 60,
      select: { keyword: true },
    }),
    prisma.competitor.findMany({
      where: { websiteId: website.id, isActive: true },
      take: 20,
      select: { domain: true, name: true },
    }),
    prisma.aiVisibilityPrompt.findMany({
      where: { websiteId: website.id, locale },
      take: 200,
      select: { prompt: true },
    }),
  ]);

  await ctx.updateProgress(30, 'Writing the prompt set');

  const generated = await ai.generateStructured({
    task: aiVisibilityPromptDiscoveryPrompt.id,
    websiteId: website.id,
    settings: settings.models,
    system: aiVisibilityPromptDiscoveryPrompt.system,
    prompt: aiVisibilityPromptDiscoveryPrompt.render({
      siteName: website.name,
      domain: website.domain,
      brandName: website.brandName,
      businessCategory: website.businessCategory,
      audience: website.targetAudience,
      keywords: keywords.map((row) => row.keyword),
      competitors: competitors.map((row) => row.name ?? row.domain),
      existingPrompts: existing.map((row) => row.prompt),
      count,
    }),
    schema: z.object({
      prompts: z
        .array(
          z.object({
            prompt: z.string().min(8),
            category: z.string().nullable().optional(),
            buyerStage: z.string().nullable().optional(),
            brandMentionExpected: z.boolean().nullable().optional(),
            reasoning: z.string().nullable().optional(),
          }),
        )
        .max(60),
    }),
  });

  await ctx.updateProgress(70, 'Storing prompts');

  let created = 0;
  for (const [index, item] of generated.data.prompts.entries()) {
    const text = item.prompt.trim();
    if (!text) continue;
    try {
      await prisma.aiVisibilityPrompt.create({
        data: {
          websiteId: website.id,
          prompt: text,
          category: item.category ?? null,
          locale,
          // Ordered by the model's own ranking: earlier prompts matter more.
          priority: Math.max(1, 100 - index * 2),
          isActive: true,
          source: 'ai',
          expectedBrand:
            item.brandMentionExpected === false ? null : website.brandName ?? website.name,
        },
      });
      created += 1;
    } catch {
      // Unique on (websiteId, prompt, locale): the set already tracks this question.
    }
  }

  await ctx.updateProgress(100, `Stored ${created} prompts`);
  return {
    status: 'completed' as const,
    locale,
    suggested: generated.data.prompts.length,
    created,
    costUsd: round(generated.costUsd, 4),
  };
};

// ─────────────────────────────────────────────────────────────
// aivis.run-prompts
// ─────────────────────────────────────────────────────────────

const URL_PATTERN = /https?:\/\/[^\s<>()"'\]]+/gi;

export interface AiVisibilityRunResult {
  status: 'completed';
  promptsRun: number;
  providers: string[];
  runs: number;
  mentionRate: number;
  citationRate: number;
  failures: number;
}

export const aivisRunPrompts: JobHandler<'aivis.run-prompts'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const settings = effectiveSettings(website);

  const configured = getAvailableProviders().filter((provider) => provider.configured);
  const selected = payload.providers?.length
    ? configured.filter((provider) => payload.providers?.includes(provider.name))
    : configured;

  if (selected.length === 0) {
    return skip(
      `${AI_MISSING} AI visibility measures what assistants answer, so at least one provider key is required.`,
      AI_ENV,
    );
  }

  const locale = payload.locale ?? website.targetLocales[0] ?? 'en-US';
  const prompts = await prisma.aiVisibilityPrompt.findMany({
    where: {
      websiteId: website.id,
      isActive: true,
      locale,
      ...(payload.promptIds?.length ? { id: { in: payload.promptIds } } : {}),
    },
    orderBy: { priority: 'desc' },
    take: 50,
    select: { id: true, prompt: true, expectedBrand: true },
  });

  if (prompts.length === 0) {
    return skip(`No active AI-visibility prompts are tracked for ${website.domain} in ${locale}.`, [
      'Run prompt discovery first',
    ]);
  }

  const competitors = await prisma.competitor.findMany({
    where: { websiteId: website.id, isActive: true },
    take: 30,
    select: { domain: true, name: true },
  });
  const competitorNames = competitors.map((row) => row.name ?? row.domain);
  const brand = website.brandName ?? website.name;

  let runs = 0;
  let mentions = 0;
  let citations = 0;
  let failures = 0;
  let index = 0;

  for (const prompt of prompts) {
    index += 1;
    await ctx.updateProgress((index / prompts.length) * 90, `Asking ${prompts.length} prompts`);

    for (const provider of selected) {
      try {
        const answer = await ai.generate({
          task: 'ai-visibility-run',
          websiteId: website.id,
          settings: settings.models,
          providerOverride: provider.name,
          prompt: prompt.prompt,
          role: 'reasoning',
        });

        const analysis = analyseAnswer(answer.text, {
          brand: prompt.expectedBrand ?? brand,
          domain: website.domain,
          competitors: competitorNames,
        });

        const run = await prisma.aiVisibilityRun.create({
          data: {
            websiteId: website.id,
            promptId: prompt.id,
            provider: answer.provider,
            model: answer.model,
            method: 'api',
            answerText: truncate(answer.text, 20_000),
            brandMentioned: analysis.brandMentioned,
            brandPosition: analysis.brandPosition,
            citedUrls: analysis.citedUrls,
            ourUrlsCited: analysis.ourUrlsCited,
            competitorsMentioned: analysis.competitorsMentioned,
            tokensUsed: answer.tokensIn + answer.tokensOut,
            costUsd: answer.costUsd,
          },
          select: { id: true },
        });

        if (analysis.mentions.length) {
          await createManyChunked(
            prisma.aiVisibilityMention,
            analysis.mentions.map((mention) => ({
              runId: run.id,
              entityName: mention.name,
              isOurBrand: mention.isOurBrand,
              position: mention.position,
              context: mention.context,
              ...(mention.citedUrl ? { citedUrl: mention.citedUrl } : {}),
            })),
            100,
          );
        }

        runs += 1;
        if (analysis.brandMentioned) mentions += 1;
        if (analysis.ourUrlsCited.length > 0) citations += 1;
      } catch (err) {
        failures += 1;
        log.warn('ai visibility run failed', {
          websiteId: website.id,
          promptId: prompt.id,
          provider: provider.name,
          error: errorMessage(err),
        });
        await prisma.aiVisibilityRun
          .create({
            data: {
              websiteId: website.id,
              promptId: prompt.id,
              provider: provider.name,
              method: 'api',
              answerText: '',
              error: truncate(errorMessage(err), 1_000),
            },
          })
          .catch(() => undefined);
      }
    }

    await refreshPromptRates(prompt.id);
  }

  const mentionRate = runs > 0 ? round(mentions / runs, 4) : 0;
  const citationRate = runs > 0 ? round(citations / runs, 4) : 0;

  if (runs > 0) {
    // A published, simple composite: how often the brand is named, weighted with how often the
    // site is actually cited as a source. Both halves are counted from real answers.
    await prisma.website.update({
      where: { id: website.id },
      data: { aiVisibilityScore: round((mentionRate * 0.7 + citationRate * 0.3) * 100, 1) },
    });
  }

  await ctx.updateProgress(100, `Ran ${runs} prompt/provider combinations`);
  const result: AiVisibilityRunResult = {
    status: 'completed',
    promptsRun: prompts.length,
    providers: selected.map((provider) => provider.name),
    runs,
    mentionRate,
    citationRate,
    failures,
  };
  return result;
};

interface AnswerAnalysis {
  brandMentioned: boolean;
  brandPosition: number | null;
  citedUrls: string[];
  ourUrlsCited: string[];
  competitorsMentioned: string[];
  mentions: Array<{
    name: string;
    isOurBrand: boolean;
    position: number | null;
    context: string | null;
    citedUrl: string | null;
  }>;
}

/**
 * Reads an assistant answer without asking a second model about it.
 *
 * Everything here is observable in the text: whether the brand is named, in what order brands
 * appear, which URLs were cited and which of those are ours. A model-scored "sentiment" would
 * be a guess dressed as a measurement, so this returns none.
 */
function analyseAnswer(
  answer: string,
  context: { brand: string; domain: string; competitors: string[] },
): AnswerAnalysis {
  const text = answer ?? '';
  const lower = text.toLowerCase();
  const citedUrls = [...new Set(text.match(URL_PATTERN) ?? [])].map((url) =>
    url.replace(/[.,;)]+$/, ''),
  );
  const ourUrlsCited = citedUrls.filter((url) => isSameSite(url, context.domain));

  const named: Array<{ name: string; isOurBrand: boolean; index: number }> = [];
  const record = (name: string, isOurBrand: boolean): void => {
    const needle = name.trim().toLowerCase();
    if (needle.length < 2) return;
    const at = lower.indexOf(needle);
    if (at === -1) return;
    named.push({ name: name.trim(), isOurBrand, index: at });
  };

  record(context.brand, true);
  if (!named.length) {
    const bare = context.domain.replace(/^www\./, '');
    if (lower.includes(bare.toLowerCase())) named.push({ name: bare, isOurBrand: true, index: lower.indexOf(bare.toLowerCase()) });
  }
  for (const competitor of context.competitors) record(competitor, false);

  named.sort((a, b) => a.index - b.index);
  const brandIndex = named.findIndex((entry) => entry.isOurBrand);

  return {
    brandMentioned: brandIndex !== -1,
    brandPosition: brandIndex === -1 ? null : brandIndex + 1,
    citedUrls: citedUrls.slice(0, 50),
    ourUrlsCited,
    competitorsMentioned: named.filter((entry) => !entry.isOurBrand).map((entry) => entry.name),
    mentions: named.slice(0, 25).map((entry, position) => ({
      name: entry.name,
      isOurBrand: entry.isOurBrand,
      position: position + 1,
      context: truncate(text.slice(Math.max(0, entry.index - 80), entry.index + 120), 240),
      citedUrl:
        (entry.isOurBrand ? ourUrlsCited[0] : citedUrls.find((url) => url.toLowerCase().includes(entry.name.toLowerCase()))) ??
        null,
    })),
  };
}

/** Recomputes a prompt's observed rates from its own run history. */
async function refreshPromptRates(promptId: string): Promise<void> {
  const runs = await prisma.aiVisibilityRun.findMany({
    where: { promptId, error: null },
    orderBy: { runAt: 'desc' },
    take: 50,
    select: { brandMentioned: true, ourUrlsCited: true },
  });
  if (runs.length === 0) return;

  const mentioned = runs.filter((run) => run.brandMentioned).length;
  const cited = runs.filter((run) => run.ourUrlsCited.length > 0).length;

  await prisma.aiVisibilityPrompt.update({
    where: { id: promptId },
    data: {
      mentionRate: round(mentioned / runs.length, 4),
      citationRate: round(cited / runs.length, 4),
      lastRunAt: new Date(),
    },
  });
}

// ─────────────────────────────────────────────────────────────
// embeddings.backfill
// ─────────────────────────────────────────────────────────────

export const embeddingsBackfill: JobHandler<'embeddings.backfill'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const settings = effectiveSettings(website);

  if (!isEmbeddingAvailable()) {
    return skip(
      'No embedding-capable AI provider is configured, so clustering and link suggestions fall back to lexical similarity.',
      ['OPENAI_API_KEY', 'GOOGLE_AI_API_KEY'],
    );
  }

  const owners = payload.ownerTypes?.length
    ? payload.ownerTypes
    : [EmbeddingOwner.PAGE, EmbeddingOwner.KEYWORD];
  const limit = payload.limit ?? 500;

  const items: UpsertEmbeddingInput[] = [];

  if (owners.includes(EmbeddingOwner.PAGE)) {
    const { pages } = await loadPagesWithText(website.id, { limit });
    for (const page of pages) {
      const text = [page.title, page.h1, page.metaDescription, page.textContent]
        .filter(Boolean)
        .join('\n')
        .slice(0, 8_000);
      if (text.trim().length < 40) continue;
      items.push({
        websiteId: website.id,
        ownerType: EmbeddingOwner.PAGE,
        ownerId: page.id,
        pageId: page.id,
        text,
      });
    }
  }

  if (owners.includes(EmbeddingOwner.KEYWORD)) {
    const keywords = await prisma.keyword.findMany({
      where: { websiteId: website.id },
      orderBy: { impressions28d: 'desc' },
      take: limit,
      select: { id: true, keyword: true },
    });
    for (const keyword of keywords) {
      items.push({
        websiteId: website.id,
        ownerType: EmbeddingOwner.KEYWORD,
        ownerId: keyword.id,
        keywordId: keyword.id,
        text: keyword.keyword,
      });
    }
  }

  if (owners.includes(EmbeddingOwner.CLUSTER)) {
    const clusters = await prisma.keywordCluster.findMany({
      where: { websiteId: website.id },
      orderBy: { totalImpressions: 'desc' },
      take: limit,
      select: { id: true, name: true, description: true },
    });
    for (const cluster of clusters) {
      items.push({
        websiteId: website.id,
        ownerType: EmbeddingOwner.CLUSTER,
        ownerId: cluster.id,
        text: [cluster.name, cluster.description ?? ''].join(' ').trim(),
      });
    }
  }

  if (owners.includes(EmbeddingOwner.ENTITY)) {
    const entities = await prisma.entity.findMany({
      where: { websiteId: website.id },
      orderBy: { mentionCount: 'desc' },
      take: limit,
      select: { id: true, name: true, description: true },
    });
    for (const entity of entities) {
      items.push({
        websiteId: website.id,
        ownerType: EmbeddingOwner.ENTITY,
        ownerId: entity.id,
        text: [entity.name, entity.description ?? ''].join(' ').trim(),
      });
    }
  }

  if (owners.includes(EmbeddingOwner.DRAFT)) {
    const drafts = await prisma.contentDraft.findMany({
      where: { websiteId: website.id },
      orderBy: { updatedAt: 'desc' },
      take: limit,
      select: { id: true, title: true, bodyMarkdown: true },
    });
    for (const draft of drafts) {
      items.push({
        websiteId: website.id,
        ownerType: EmbeddingOwner.DRAFT,
        ownerId: draft.id,
        text: [draft.title, draft.bodyMarkdown.slice(0, 8_000)].join('\n'),
      });
    }
  }

  if (items.length === 0) {
    return skip('There is nothing to embed yet for this website.');
  }

  await ctx.updateProgress(30, `Embedding ${items.length} item(s)`);
  const batch = await upsertEmbeddingsBatch(items, {
    websiteId: website.id,
    settings: settings.models,
    task: 'embeddings.backfill',
  });

  await ctx.updateProgress(100, 'Embeddings up to date');
  return {
    status: 'completed' as const,
    requested: items.length,
    created: batch.created,
    updated: batch.updated,
    unchanged: batch.unchanged,
    skipped: batch.skipped,
    model: batch.model,
    costUsd: round(batch.costUsd, 4),
  };
};

// ─────────────────────────────────────────────────────────────
// links.analyse-internal
// ─────────────────────────────────────────────────────────────

export interface InternalLinkResult {
  status: 'completed';
  pagesConsidered: number;
  suggestions: number;
  created: number;
  updated: number;
  overOptimisedAnchors: number;
}

export const linksAnalyseInternal: JobHandler<'links.analyse-internal'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  await ctx.updateProgress(10, 'Loading pages');

  const { pages, crawlId } = await loadPagesWithText(website.id, {
    limit: LINK_PAGE_LIMIT,
    pageIds: payload.pageIds ?? null,
  });
  if (pages.length < 2) {
    return skip(`${website.domain} needs at least two crawled pages before links can be suggested.`, [
      'Run a site crawl first',
    ]);
  }

  const keywordsByPage = new Map<string, string[]>();
  const clusterByPage = new Map<string, string>();
  const keywords = await prisma.keyword.findMany({
    where: { websiteId: website.id, pageId: { in: pages.map((page) => page.id) } },
    orderBy: { impressions28d: 'desc' },
    take: pages.length * 5,
    select: { pageId: true, keyword: true, clusterId: true },
  });
  for (const keyword of keywords) {
    if (!keyword.pageId) continue;
    const list = keywordsByPage.get(keyword.pageId) ?? [];
    if (list.length < 5) list.push(keyword.keyword);
    keywordsByPage.set(keyword.pageId, list);
    // A page belongs to the cluster of its strongest keyword; `Page` itself has no cluster.
    if (keyword.clusterId && !clusterByPage.has(keyword.pageId)) {
      clusterByPage.set(keyword.pageId, keyword.clusterId);
    }
  }

  const embeddings = new Map<string, number[]>();
  for (let i = 0; i < pages.length; i += 200) {
    const rows = await prisma.embeddingRecord.findMany({
      where: {
        websiteId: website.id,
        ownerType: EmbeddingOwner.PAGE,
        pageId: { in: pages.slice(i, i + 200).map((page) => page.id) },
      },
      select: { pageId: true, vector: true },
    });
    for (const row of rows) if (row.pageId) embeddings.set(row.pageId, row.vector);
  }

  const candidates: LinkCandidatePage[] = pages.map((page) => ({
    id: page.id,
    url: page.url,
    normalizedUrl: page.normalizedUrl,
    title: page.title,
    h1: page.h1,
    metaDescription: page.metaDescription,
    textContent: page.textContent,
    wordCount: page.wordCount,
    isIndexable: page.isIndexable,
    depth: page.depth,
    targetKeywords: keywordsByPage.get(page.id) ?? [],
    embedding: embeddings.get(page.id) ?? null,
    inboundLinks: page.internalLinksIn,
    outboundLinks: page.internalLinksOut,
    clusterId: clusterByPage.get(page.id) ?? null,
  }));

  // Existing edges, translated from crawl URLs to durable page ids.
  const pageIdByUrl = new Map(pages.map((page) => [page.normalizedUrl, page.id]));
  const existingLinks: Array<{ sourceId: string; targetId: string; anchorText: string }> = [];

  if (crawlId) {
    const crawlPageIds = pages
      .map((page) => page.crawlPageId)
      .filter((id): id is string => id !== null);
    for (let i = 0; i < crawlPageIds.length; i += 100) {
      const rows = await prisma.linkEdge.findMany({
        where: {
          crawlId,
          isInternal: true,
          sourceCrawlPageId: { in: crawlPageIds.slice(i, i + 100) },
        },
        take: 20_000,
        select: { sourceCrawlPageId: true, normalizedTarget: true, anchorText: true },
      });
      const sourceByCrawlPage = new Map(
        pages.filter((page) => page.crawlPageId).map((page) => [page.crawlPageId as string, page.id]),
      );
      for (const row of rows) {
        const sourceId = sourceByCrawlPage.get(row.sourceCrawlPageId);
        const targetId = pageIdByUrl.get(row.normalizedTarget);
        if (!sourceId || !targetId) continue;
        existingLinks.push({ sourceId, targetId, anchorText: row.anchorText ?? '' });
      }
    }
  }

  await ctx.updateProgress(45, 'Looking for link opportunities');
  const suggestions = suggestInternalLinks(candidates, existingLinks, {
    ...(payload.maxSuggestionsPerPage ? { maxPerSourcePage: payload.maxSuggestionsPerPage } : {}),
  });

  let created = 0;
  let updated = 0;

  for (const suggestion of suggestions) {
    const existing = await prisma.internalLinkSuggestion.findUnique({
      where: {
        sourcePageId_targetPageId: {
          sourcePageId: suggestion.sourcePageId,
          targetPageId: suggestion.targetPageId,
        },
      },
      select: { id: true, status: true },
    });

    const data = {
      anchorText: suggestion.anchorText,
      placementHint: suggestion.placementHint,
      contextSnippet: suggestion.contextSnippet,
      reason: truncate(suggestion.reason, 1_000),
      relevanceScore: suggestion.relevanceScore,
      impactScore: suggestion.impactScore,
    };

    if (!existing) {
      await prisma.internalLinkSuggestion.create({
        data: {
          websiteId: website.id,
          sourcePageId: suggestion.sourcePageId,
          targetPageId: suggestion.targetPageId,
          status: SuggestionStatus.PENDING,
          ...data,
        },
      });
      created += 1;
      continue;
    }

    // A suggestion the operator already applied or rejected is left alone.
    if (existing.status === SuggestionStatus.PENDING) {
      await prisma.internalLinkSuggestion.update({ where: { id: existing.id }, data });
      updated += 1;
    }
  }

  const anchorAudit = auditAnchorText(candidates, existingLinks);
  const overOptimised = anchorAudit.filter((audit) => audit.severity === 'high');

  await ctx.updateProgress(100, `Suggested ${suggestions.length} internal links`);
  const result: InternalLinkResult = {
    status: 'completed',
    pagesConsidered: candidates.length,
    suggestions: suggestions.length,
    created,
    updated,
    overOptimisedAnchors: overOptimised.length,
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// links.apply-suggestion
// ─────────────────────────────────────────────────────────────

export interface ApplySuggestionResult {
  status: 'completed';
  dryRun: boolean;
  requested: number;
  applied: number;
  failed: number;
  failures: Array<{ suggestionId: string; reason: string }>;
}

/**
 * Applies approved link suggestions, one source page at a time.
 *
 * Grouping by source page matters: the adapter reads the page body once and inserts every
 * approved anchor in a single write, which is both cheaper and safer than N edits racing on
 * the same document.
 */
export const linksApplySuggestion: JobHandler<'links.apply-suggestion'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);
  const dryRun = payload.dryRun ?? false;

  const suggestions = await prisma.internalLinkSuggestion.findMany({
    where: {
      websiteId: website.id,
      id: { in: payload.suggestionIds },
      status: { in: [SuggestionStatus.PENDING, SuggestionStatus.APPROVED] },
    },
    select: {
      id: true,
      anchorText: true,
      sourcePage: { select: { id: true, url: true } },
      targetPage: { select: { id: true, url: true } },
    },
  });

  if (suggestions.length === 0) {
    return skip('None of those link suggestions are still pending.');
  }

  const bySource = new Map<string, typeof suggestions>();
  for (const suggestion of suggestions) {
    const list = bySource.get(suggestion.sourcePage.id) ?? [];
    list.push(suggestion);
    bySource.set(suggestion.sourcePage.id, list);
  }

  let applied = 0;
  let failed = 0;
  const failures: Array<{ suggestionId: string; reason: string }> = [];
  let done = 0;

  for (const [sourcePageId, group] of bySource) {
    done += 1;
    await ctx.updateProgress((done / bySource.size) * 90, 'Applying internal links');

    const first = group[0];
    const externalId = await resolveExternalId(website.id, sourcePageId, first.sourcePage.url);

    const result = await applyChange({
      websiteId: website.id,
      actionType: 'ADD_INTERNAL_LINKS',
      dryRun,
      ...(payload.actorUserId ? { approvedByUserId: payload.actorUserId } : {}),
      payload: {
        externalId,
        links: group.map((suggestion) => ({
          anchor: suggestion.anchorText,
          href: suggestion.targetPage.url,
        })),
      },
    });

    if (!result.ok) {
      failed += group.length;
      for (const suggestion of group) {
        failures.push({ suggestionId: suggestion.id, reason: result.error ?? 'Adapter refused the change' });
        await prisma.internalLinkSuggestion.update({
          where: { id: suggestion.id },
          data: {
            status: SuggestionStatus.FAILED,
            rejectedReason: truncate(result.error ?? 'Adapter refused the change', 500),
          },
        });
      }
      continue;
    }

    if (dryRun) {
      applied += group.length;
      continue;
    }

    for (const suggestion of group) {
      await prisma.internalLinkSuggestion.update({
        where: { id: suggestion.id },
        data: { status: SuggestionStatus.APPLIED, appliedAt: new Date() },
      });
    }
    applied += group.length;

    await prisma.changeLog.create({
      data: {
        websiteId: website.id,
        userId: payload.actorUserId ?? null,
        actor: payload.actorUserId ? 'user-approved' : 'platform',
        agent: 'InternalLinkAgent',
        changeType: 'ADD_INTERNAL_LINKS',
        targetUrl: first.sourcePage.url,
        summary:
          summariseChanges(result.changes) ||
          `Added ${group.length} internal link(s) to ${first.sourcePage.url}`,
        beforeState: json(result.before ?? {}),
        afterState: json(result.after ?? {}),
        reason: 'Approved internal-link suggestions from the link analysis.',
        approved: Boolean(payload.actorUserId),
        rollbackable: result.before !== null,
      },
    });
  }

  await ctx.updateProgress(100, `Applied ${applied} link(s)`);
  const result: ApplySuggestionResult = {
    status: 'completed',
    dryRun,
    requested: suggestions.length,
    applied,
    failed,
    failures,
  };
  return result;
};

/**
 * The id the CMS adapter needs to open a page for editing.
 *
 * Pages discovered by crawling carry no CMS identity, so we use the one place it is recorded —
 * a draft we published to that page — and fall back to the URL path, which is what the git and
 * webhook adapters address content by. When neither fits, the adapter's own error explains it.
 */
async function resolveExternalId(
  websiteId: string,
  pageId: string,
  url: string,
): Promise<string> {
  const draft = await prisma.contentDraft.findFirst({
    where: { websiteId, pageId, externalId: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { externalId: true },
  });
  return draft?.externalId ?? getPath(url);
}

// ─────────────────────────────────────────────────────────────
// serp.fetch
// ─────────────────────────────────────────────────────────────

export interface SerpFetchResult {
  status: 'completed';
  provider: string | null;
  keywords: number;
  captured: number;
  ranked: number;
  failures: number;
  /** Set when the run stopped before every keyword was fetched, with the reason. */
  stoppedEarly?: string;
}

export const serpFetch: JobHandler<'serp.fetch'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);

  if (!isSerpAvailable()) {
    const required = [...new Set(listSerpProviders().flatMap((entry) => entry.requiredEnv))];
    return skip(
      'No SERP provider is configured, so live rankings cannot be fetched. Search Console positions still populate the rankings view.',
      required,
    );
  }

  const locale = payload.locale ?? website.targetLocales[0] ?? 'en-US';
  const device = payload.device ?? 'desktop';
  const keywords = await prisma.keyword.findMany({
    where: {
      websiteId: website.id,
      ...(payload.keywordIds?.length ? { id: { in: payload.keywordIds } } : { isTracked: true }),
    },
    orderBy: { opportunityScore: 'desc' },
    take: payload.limit ?? 50,
    select: { id: true, keyword: true, currentPosition: true, bestPosition: true },
  });

  if (keywords.length === 0) {
    return skip(
      `No tracked keywords for ${website.domain}. Mark keywords as tracked, or pass explicit ids.`,
    );
  }

  const today = toUtcDate(new Date());
  let captured = 0;
  let ranked = 0;
  let failures = 0;
  let provider: string | null = null;
  let stopped: string | null = null;
  let index = 0;

  for (const keyword of keywords) {
    index += 1;
    await ctx.updateProgress((index / keywords.length) * 95, `Fetching SERPs (${index}/${keywords.length})`);

    try {
      const snapshot = await captureSerpSnapshot({
        websiteId: website.id,
        keywordId: keyword.id,
        query: keyword.keyword,
        locale,
        device,
      });

      if (!snapshot.captured) {
        // The provider became unavailable mid-run; keep what was already captured and say why.
        stopped = snapshot.reason;
        break;
      }

      captured += 1;
      provider = snapshot.provider;

      if (snapshot.ourPosition === null) continue;
      ranked += 1;

      await prisma.ranking.upsert({
        where: {
          keywordId_date_source_device: {
            keywordId: keyword.id,
            date: today,
            source: snapshot.provider,
            device,
          },
        },
        create: {
          websiteId: website.id,
          keywordId: keyword.id,
          date: today,
          position: snapshot.ourPosition,
          source: snapshot.provider,
          device,
        },
        update: { position: snapshot.ourPosition },
      });

      await prisma.keyword.update({
        where: { id: keyword.id },
        data: {
          previousPosition: keyword.currentPosition,
          currentPosition: snapshot.ourPosition,
          positionChange:
            keyword.currentPosition === null
              ? null
              : round(keyword.currentPosition - snapshot.ourPosition, 2),
          bestPosition:
            keyword.bestPosition === null
              ? snapshot.ourPosition
              : Math.min(keyword.bestPosition, snapshot.ourPosition),
        },
      });
    } catch (err) {
      failures += 1;
      log.warn('serp fetch failed', {
        websiteId: website.id,
        keyword: keyword.keyword,
        error: errorMessage(err),
      });
    }
  }

  await ctx.updateProgress(100, `Captured ${captured} SERPs`);
  if (captured === 0 && stopped) return skip(stopped);

  const result: SerpFetchResult = {
    status: 'completed',
    provider,
    keywords: keywords.length,
    captured,
    ranked,
    failures,
    ...(stopped ? { stoppedEarly: stopped } : {}),
  };
  return result;
};

// ─────────────────────────────────────────────────────────────
// competitors.analyse
// ─────────────────────────────────────────────────────────────

export interface CompetitorAnalysisResult {
  status: 'completed';
  discovered: number;
  analysed: number;
  gapsFound: number;
  keywordRowsWritten: number;
}

export const competitorsAnalyse: JobHandler<'competitors.analyse'> = async ({ payload, ctx }) => {
  const website = await loadWebsite(payload.websiteId);

  let discovered = 0;
  if (payload.discover) {
    await ctx.updateProgress(10, 'Looking for competitors in recent SERPs');
    const candidates = await discoverCompetitorsFromSerp(website.id, { limit: 10 });
    for (const candidate of candidates) {
      const created = await prisma.competitor.upsert({
        where: { websiteId_domain: { websiteId: website.id, domain: candidate.domain } },
        create: {
          websiteId: website.id,
          domain: candidate.domain,
          isManual: false,
          serpOverlapPct: round(candidate.score * 100, 1),
          avgPosition: candidate.avgPosition,
        },
        update: { serpOverlapPct: round(candidate.score * 100, 1), avgPosition: candidate.avgPosition },
        select: { createdAt: true, updatedAt: true },
      });
      if (created.createdAt.getTime() === created.updatedAt.getTime()) discovered += 1;
    }
  }

  const competitors = await prisma.competitor.findMany({
    where: {
      websiteId: website.id,
      isActive: true,
      ...(payload.competitorIds?.length ? { id: { in: payload.competitorIds } } : {}),
    },
    select: { id: true, domain: true },
  });

  if (competitors.length === 0) {
    return skip(
      `No competitors are tracked for ${website.domain}. Add one, or run this job with discovery enabled once SERP snapshots exist.`,
    );
  }

  // Competitor rankings come from SERP snapshots we captured — the only place we hold
  // observed competitor positions. With no snapshots there is nothing to compare against.
  await ctx.updateProgress(35, 'Reading SERP snapshots');
  const snapshots = await prisma.serpSnapshot.findMany({
    where: { websiteId: website.id },
    orderBy: { capturedAt: 'desc' },
    take: 500,
    select: { query: true, results: true, capturedAt: true },
  });

  if (snapshots.length === 0) {
    return skip(
      'No SERP snapshots have been captured yet, so competitor positions cannot be compared.',
      ['Run serp.fetch with a configured SERP provider'],
    );
  }

  const domains = new Map(competitors.map((competitor) => [competitor.domain.toLowerCase(), competitor.id]));
  const competitorRows: CompetitorKeywordRow[] = [];
  const seen = new Set<string>();

  for (const snapshot of snapshots) {
    for (const result of parseStoredSerpResults(snapshot.results)) {
      const competitorId = domains.get(result.domain.toLowerCase());
      if (!competitorId || result.type !== 'organic') continue;
      const key = `${competitorId}|${snapshot.query.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      competitorRows.push({
        competitorDomain: result.domain.toLowerCase(),
        keyword: snapshot.query,
        position: result.position,
        url: result.url,
        estimatedVolume: null,
      });
    }
  }

  const ourKeywords = await prisma.keyword.findMany({
    where: { websiteId: website.id },
    orderBy: { impressions28d: 'desc' },
    take: 2_000,
    select: { id: true, keyword: true, normalized: true, currentPosition: true, impressions28d: true, rankingUrl: true },
  });

  const ourRows: OurKeywordRow[] = ourKeywords.map((keyword) => ({
    keyword: keyword.keyword,
    position: keyword.currentPosition,
    impressions: keyword.impressions28d,
    url: keyword.rankingUrl,
  }));

  await ctx.updateProgress(60, 'Analysing gaps');
  const gaps = analyseKeywordGaps(ourRows, competitorRows);

  let keywordRowsWritten = 0;
  for (const competitor of competitors) {
    const overview = buildCompetitorOverview(competitor.domain.toLowerCase(), ourRows, competitorRows);
    await prisma.competitor.update({
      where: { id: competitor.id },
      data: {
        sharedKeywords: overview.sharedKeywords,
        gapKeywords: overview.gapKeywords,
        estimatedKeywords: overview.totalKeywords,
        avgPosition: overview.avgPosition,
        serpOverlapPct: overview.serpOverlapPct,
        topicalStrengths: overview.topicalStrengths,
        lastAnalysedAt: new Date(),
      },
    });

    const theirs = competitorRows.filter(
      (row) => row.competitorDomain === competitor.domain.toLowerCase(),
    );
    for (const row of theirs) {
      const gap = gaps.find((entry) => entry.keyword.toLowerCase() === row.keyword.toLowerCase());
      await prisma.competitorKeyword.upsert({
        where: { competitorId_keyword: { competitorId: competitor.id, keyword: row.keyword } },
        create: {
          competitorId: competitor.id,
          keyword: row.keyword,
          position: row.position,
          url: row.url,
          ourPosition: gap?.ourPosition ?? null,
          isGap: Boolean(gap),
          gapScore: gap?.gapScore ?? null,
        },
        update: {
          position: row.position,
          url: row.url,
          ourPosition: gap?.ourPosition ?? null,
          isGap: Boolean(gap),
          gapScore: gap?.gapScore ?? null,
          observedAt: new Date(),
        },
      });
      keywordRowsWritten += 1;
    }
  }

  // Mark our own keyword rows that the gap analysis proved we are missing.
  const gapKeywords = new Set(gaps.filter((gap) => gap.gapType === 'missing').map((gap) => gap.keyword.toLowerCase()));
  const ourGapIds = ourKeywords
    .filter((keyword) => gapKeywords.has(keyword.keyword.toLowerCase()))
    .map((keyword) => keyword.id);
  if (ourGapIds.length) {
    await prisma.keyword.updateMany({ where: { id: { in: ourGapIds } }, data: { isContentGap: true } });
  }

  if (gaps.length > 0) {
    await prisma.notification
      .create({
        data: {
          websiteId: website.id,
          type: 'competitor-gaps',
          severity: NotificationSeverity.INFO,
          title: `${gaps.length} keyword gap(s) against tracked competitors`,
          message: `Competitors rank for ${gaps.length} queries where ${website.domain} does not, based on captured SERPs.`,
          link: '/competitors',
          data: json({ gaps: gaps.slice(0, 20) }),
          dedupeKey: `competitor-gaps:${website.id}:${new Date().toISOString().slice(0, 10)}`,
        },
      })
      .catch(() => undefined);
  }

  await ctx.updateProgress(100, 'Competitor analysis complete');
  const result: CompetitorAnalysisResult = {
    status: 'completed',
    discovered,
    analysed: competitors.length,
    gapsFound: gaps.length,
    keywordRowsWritten,
  };
  return result;
};

/** Kept exported for the digest job, which reports how much link work is waiting. */
export async function countPendingLinkSuggestions(websiteId: string): Promise<number> {
  return prisma.internalLinkSuggestion.count({
    where: { websiteId, status: SuggestionStatus.PENDING },
  });
}

/** Clamp helper used by the visibility score; kept here so the formula stays in one file. */
export function visibilityScore(mentionRate: number, citationRate: number): number {
  return round(clamp(mentionRate * 0.7 + citationRate * 0.3) * 100, 1);
}
