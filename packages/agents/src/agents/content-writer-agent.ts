import {
  ai,
  contentBrandReviewPrompt,
  contentBriefPrompt,
  contentDraftPrompt,
  contentFactCheckPrompt,
  contentOutlinePrompt,
  contentQualityReviewPrompt,
  contentSeoOptimisePrompt,
  internalLinkAnchorPrompt,
  isAiAvailable,
  keywordIntentPrompt,
  schemaSuggestionPrompt,
} from '@seo/ai';
import { type ContentStage, type Prisma, json, prisma } from '@seo/db';
import { findCannibalization, validateJsonLd } from '@seo/seo-engine';
import {
  SCHEMA_TYPES,
  clamp,
  countWords,
  errorMessage,
  extractMarkdownHeadings,
  fleschReadingEase,
  keywordDensity,
  lexicalCosine,
  markdownToText,
  normalizeKeyword,
  round,
  truncate,
} from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  comparisonWindows,
  gscAggregates,
  jsonArray,
  jsonObject,
  jsonStrings,
  loadSite,
  loadVerifiedFacts,
  result,
  skipped,
  step,
  toPromptKnowledgeBase,
  unique,
  type SiteContext,
} from './shared';

const AGENT = 'ContentWriterAgent' as const;

const NO_AI =
  'The content pipeline needs a language model. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or ' +
  'GOOGLE_AI_API_KEY (Settings → AI) and re-run this stage.';

/** The pipeline, in order. One invocation runs exactly one of these. */
export const STAGE_ORDER: readonly ContentStage[] = [
  'RESEARCH',
  'INTENT_ANALYSIS',
  'CANNIBALISATION_CHECK',
  'COMPETITOR_ANALYSIS',
  'BRIEF',
  'OUTLINE',
  'DRAFT',
  'FACT_CHECK',
  'SEO_OPTIMISATION',
  'BRAND_REVIEW',
  'INTERNAL_LINKING',
  'STRUCTURED_DATA',
  'QUALITY_REVIEW',
  'READY_FOR_APPROVAL',
];

/**
 * The stage after `stage`, or null at the end of the pipeline.
 *
 * Re-running an earlier stage deliberately rewinds the draft to just after it: everything
 * downstream was derived from output that has now changed, so leaving the draft marked
 * "quality reviewed" would be a lie.
 */
export function nextStage(stage: ContentStage): ContentStage | null {
  const index = STAGE_ORDER.indexOf(stage);
  if (index < 0 || index >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[index + 1] ?? null;
}

/** Claims the drafting step could not support; the writer marks them inline. */
export function extractVerifyMarkers(markdown: string): string[] {
  const matches = markdown.matchAll(/\[VERIFY:\s*([^\]]+)\]/gi);
  return unique([...matches].map((match) => (match[1] ?? '').trim()).filter(Boolean));
}

/**
 * Anti-spam gate applied to every draft before it can be marked ready.
 *
 * These are the checks that must not depend on a model's opinion: a model that has just written
 * a page is not a reliable judge of whether that page is keyword-stuffed.
 */
export interface QualityFlag {
  code: string;
  severity: 'BLOCKING' | 'WARNING';
  message: string;
}

export function deterministicQualityFlags(input: {
  markdown: string;
  targetKeyword: string | null;
  unverifiedClaims: number;
  minWords: number;
}): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const text = markdownToText(input.markdown);
  const words = countWords(text);

  if (words < input.minWords) {
    flags.push({
      code: 'THIN_CONTENT',
      severity: 'BLOCKING',
      message: `The draft is ${words} words, below this site's ${input.minWords}-word threshold. Publishing thin pages at scale is exactly the pattern search engines penalise.`,
    });
  }

  if (input.targetKeyword) {
    const density = keywordDensity(text, input.targetKeyword);
    if (density > 0.03) {
      flags.push({
        code: 'KEYWORD_STUFFING',
        severity: 'BLOCKING',
        message: `"${input.targetKeyword}" accounts for ${(density * 100).toFixed(1)}% of the words. Above ~3% the repetition reads as manipulation and hurts both ranking and readability.`,
      });
    }
  }

  const markers = extractVerifyMarkers(input.markdown);
  if (markers.length > 0) {
    flags.push({
      code: 'VERIFY_MARKERS',
      severity: 'BLOCKING',
      message: `${markers.length} [VERIFY: …] marker(s) are still in the body. Each one is a fact the writer refused to invent and a person must supply.`,
    });
  }

  if (input.unverifiedClaims > 0) {
    flags.push({
      code: 'UNVERIFIED_CLAIMS',
      severity: 'WARNING',
      message: `${input.unverifiedClaims} claim(s) are not supported by the verified brand facts or any supplied source. Verify or remove them before publishing.`,
    });
  }

  const headings = extractMarkdownHeadings(input.markdown);
  const duplicateHeadings = headings.length - new Set(headings.map((heading) => normalizeKeyword(heading.text))).size;
  if (duplicateHeadings > 0) {
    flags.push({
      code: 'DUPLICATE_HEADINGS',
      severity: 'WARNING',
      message: `${duplicateHeadings} heading(s) repeat an earlier heading, which usually means the outline doubled back on itself.`,
    });
  }

  return flags;
}

// ── Structured output schemas ─────────────────────────────────────────────────

const intentSchema = z.object({
  keywords: z.array(
    z.object({
      keyword: z.string(),
      intent: z.enum(['INFORMATIONAL', 'NAVIGATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'LOCAL', 'UNKNOWN']),
      funnelStage: z.enum(['AWARENESS', 'CONSIDERATION', 'DECISION', 'RETENTION', 'UNKNOWN']),
      pageType: z.string().nullable(),
      commercialValue: z.number().min(0).max(1),
      difficultySignal: z.string().nullable(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const briefSchema = z.object({
  angle: z.string(),
  searcherJob: z.string(),
  titleIdeas: z.array(z.string()),
  metaDescription: z.string().nullable(),
  mustCoverPoints: z.array(z.object({ point: z.string(), whyItMatters: z.string() })),
  questionsToAnswer: z.array(z.string()),
  entities: z.array(z.string()),
  competitorWeaknesses: z.array(z.string()),
  internalLinkTargets: z.array(z.string()),
  schemaOpportunity: z.array(z.string()),
  targetWordCount: z.number().int().positive().nullable(),
  cta: z.string().nullable(),
  differentiationRisk: z.string().nullable(),
  factsNeededFromBusiness: z.array(z.string()),
});

const outlineSchema = z.object({
  sections: z.array(
    z.object({
      heading: z.string(),
      level: z.number().int().min(2).max(4),
      questionAnswered: z.string(),
      keyPoints: z.array(z.string()),
      elements: z.array(z.string()),
      wordBudget: z.number().int().nonnegative().nullable(),
      evidenceNeeded: z.string().nullable(),
    }),
  ),
  suggestedTitle: z.string().nullable(),
  totalWordBudget: z.number().int().nonnegative().nullable(),
  notes: z.string().nullable(),
});

const factCheckSchema = z.object({
  claims: z.array(
    z.object({
      quote: z.string(),
      classification: z.enum(['SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED', 'PROHIBITED', 'NEEDS_ATTRIBUTION']),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      why: z.string(),
      suggestedFix: z.string(),
      supportingText: z.string().nullable(),
    }),
  ),
  openVerifyItems: z.array(z.string()),
  verdict: z.enum(['PASS', 'PASS_WITH_EDITS', 'BLOCK']),
  verdictReason: z.string(),
});

const seoSchema = z.object({
  suggestions: z.array(
    z.object({
      area: z.string(),
      issue: z.string(),
      change: z.string(),
      severity: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    }),
  ),
  suggestedTitle: z.string().nullable(),
  suggestedMetaDescription: z.string().nullable(),
  missingEntities: z.array(z.string()),
  overOptimisation: z.array(z.string()),
  intentMatch: z.enum(['STRONG', 'PARTIAL', 'WEAK']),
});

const brandSchema = z.object({
  scores: z.object({
    toneMatch: z.number().min(0).max(100),
    terminology: z.number().min(0).max(100),
    audienceFit: z.number().min(0).max(100),
    claimsCompliance: z.number().min(0).max(100),
    ctaFit: z.number().min(0).max(100),
    consistency: z.number().min(0).max(100),
  }),
  issues: z.array(
    z.object({
      quote: z.string(),
      dimension: z.string(),
      severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
      why: z.string(),
      rewrite: z.string(),
    }),
  ),
  verdict: z.enum(['PASS', 'PASS_WITH_EDITS', 'BLOCK']),
});

const linkSchema = z.object({
  links: z.array(
    z.object({
      targetUrl: z.string(),
      anchorText: z.string(),
      /** Must be a verbatim substring of the draft; validated before anything is stored. */
      sentence: z.string(),
      reason: z.string(),
    }),
  ),
  skipped: z.array(z.object({ targetUrl: z.string(), reason: z.string() })),
});

const schemaSuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      schemaType: z.string(),
      jsonLd: z.record(z.unknown()),
      propertySources: z.array(z.string()),
      replacesExisting: z.boolean(),
      expectedBenefit: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
  declined: z.array(z.object({ schemaType: z.string(), reason: z.string() })),
});

const qualitySchema = z.object({
  scores: z.object({
    intentSatisfaction: z.number().min(0).max(100),
    originality: z.number().min(0).max(100),
    depth: z.number().min(0).max(100),
    evidence: z.number().min(0).max(100),
    clarity: z.number().min(0).max(100),
    scannability: z.number().min(0).max(100),
    engagement: z.number().min(0).max(100),
  }),
  aiTells: z.array(z.object({ quote: z.string(), tell: z.string() })),
  topFixes: z.array(z.string()),
  verdict: z.enum(['PUBLISH', 'REVISE', 'REJECT']),
  verdictReason: z.string(),
});

// ── Stage plumbing ────────────────────────────────────────────────────────────

type DraftRow = Awaited<ReturnType<typeof loadDraft>>;

async function loadDraft(draftId: string) {
  return prisma.contentDraft.findUnique({
    where: { id: draftId },
    include: { brief: true, page: { select: { id: true, url: true } } },
  });
}

interface StageInput {
  ctx: AgentContext;
  site: SiteContext;
  draft: NonNullable<DraftRow>;
  knowledgeBase: ReturnType<typeof toPromptKnowledgeBase>;
  facts: Array<{ fact: string; category: string | null; source: string; sourceUrl: string | null; verified: boolean }>;
  keyword: string;
}

interface StageOutcome {
  output: Record<string, unknown>;
  draftUpdate?: Prisma.ContentDraftUpdateInput;
  summary: string;
  confidence: number;
  notes?: string;
  /** Set when the stage refuses to advance (a blocking quality gate, for example). */
  hold?: boolean;
  approvalsCreated?: string[];
  findings?: unknown[];
}

// ── Agent ─────────────────────────────────────────────────────────────────────

const inputSchema = z.object({
  draftId: z.string().min(1),
  stage: z.string().optional(),
});

/** Only the writing stages can be executed by this agent; APPROVED/PUBLISHED are downstream states. */
export function isPipelineStage(value: unknown): value is ContentStage {
  return typeof value === 'string' && (STAGE_ORDER as readonly string[]).includes(value);
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const parsed = inputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return skipped(
      'No draft to work on.',
      'This agent runs one stage of one content draft: pass `draftId` (and optionally `stage`) as input.',
    );
  }
  if (parsed.data.stage !== undefined && !isPipelineStage(parsed.data.stage)) {
    return skipped(
      'Unknown pipeline stage.',
      `"${parsed.data.stage}" is not a content pipeline stage. Valid stages: ${STAGE_ORDER.join(', ')}.`,
    );
  }

  if (!isAiAvailable()) return skipped('No AI provider configured.', NO_AI);

  const draft = await step(ctx, 'get_content_draft', { draftId: parsed.data.draftId }, () =>
    loadDraft(parsed.data.draftId),
  );
  if (!draft) {
    return skipped('Draft not found.', `No content draft with id ${parsed.data.draftId} exists.`);
  }
  if (draft.websiteId !== ctx.websiteId) {
    return skipped('Draft belongs to another site.', 'The supplied draft does not belong to this website.');
  }

  const stage: ContentStage = isPipelineStage(parsed.data.stage) ? parsed.data.stage : draft.stage;
  if (!isPipelineStage(stage)) {
    return result({
      summary: `Draft "${draft.title}" is at ${draft.stage}, which is past the writing pipeline.`,
      confidence: 1,
      data: { draftId: draft.id, stage: draft.stage },
    });
  }

  const site = await loadSite(ctx.websiteId);
  const facts = await loadVerifiedFacts(ctx.websiteId);
  const keyword = draft.targetKeyword ?? draft.brief?.targetKeyword ?? draft.title;

  const attempt =
    (await prisma.contentStageRun.count({ where: { draftId: draft.id, stage } })) + 1;
  const stageRun = await prisma.contentStageRun.create({
    data: {
      draftId: draft.id,
      stage,
      status: 'RUNNING',
      attempt,
      input: json({ keyword, briefId: draft.briefId, rerun: attempt > 1, agentRunId: ctx.runId }),
      agentRunId: ctx.runId,
      startedAt: new Date(),
    },
    select: { id: true, startedAt: true },
  });

  const startedAt = Date.now();
  const stageInput: StageInput = {
    ctx,
    site,
    draft,
    knowledgeBase: toPromptKnowledgeBase(site.knowledgeBase),
    facts,
    keyword,
  };

  try {
    const outcome = await runStage(stage, stageInput);
    const durationMs = Date.now() - startedAt;

    await prisma.contentStageRun.update({
      where: { id: stageRun.id },
      data: {
        status: 'COMPLETED',
        output: json(outcome.output),
        notes: outcome.notes ?? null,
        finishedAt: new Date(),
        durationMs,
      },
    });

    const advance = outcome.hold ? null : nextStage(stage);
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: {
        ...(outcome.draftUpdate ?? {}),
        ...(advance ? { stage: advance } : {}),
        currentStageStatus: outcome.hold ? 'FAILED' : 'COMPLETED',
      },
    });

    return result({
      summary: outcome.summary,
      confidence: outcome.confidence,
      approvalsCreated: outcome.approvalsCreated ?? [],
      findings: outcome.findings ?? [],
      data: {
        draftId: draft.id,
        stage,
        attempt,
        nextStage: advance,
        held: outcome.hold === true,
        durationMs,
        output: outcome.output,
      },
    });
  } catch (err) {
    await prisma.contentStageRun.update({
      where: { id: stageRun.id },
      data: {
        status: 'FAILED',
        error: errorMessage(err),
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { currentStageStatus: 'FAILED' },
    });
    throw err;
  }
}

function runStage(stage: ContentStage, input: StageInput): Promise<StageOutcome> {
  switch (stage) {
    case 'RESEARCH':
      return stageResearch(input);
    case 'INTENT_ANALYSIS':
      return stageIntent(input);
    case 'CANNIBALISATION_CHECK':
      return stageCannibalisation(input);
    case 'COMPETITOR_ANALYSIS':
      return stageCompetitors(input);
    case 'BRIEF':
      return stageBrief(input);
    case 'OUTLINE':
      return stageOutline(input);
    case 'DRAFT':
      return stageDraft(input);
    case 'FACT_CHECK':
      return stageFactCheck(input);
    case 'SEO_OPTIMISATION':
      return stageSeo(input);
    case 'BRAND_REVIEW':
      return stageBrandReview(input);
    case 'INTERNAL_LINKING':
      return stageInternalLinking(input);
    case 'STRUCTURED_DATA':
      return stageStructuredData(input);
    case 'QUALITY_REVIEW':
      return stageQualityReview(input);
    default:
      return stageReadyForApproval(input);
  }
}

// ── Stage: RESEARCH (deterministic) ───────────────────────────────────────────

async function stageResearch(input: StageInput): Promise<StageOutcome> {
  const { ctx, keyword } = input;
  const windows = comparisonWindows();
  const rows = await step(ctx, 'get_search_console_queries', { window: '28d' }, () =>
    gscAggregates(ctx.websiteId, windows.current, 5000),
  );

  const tokens = normalizeKeyword(keyword).split(/\s+/).filter((token) => token.length > 3);
  const related = rows
    .filter((row) => tokens.some((token) => row.query.toLowerCase().includes(token)))
    .slice(0, 40)
    .map((row) => ({ query: row.query, page: row.page, clicks: row.clicks, impressions: row.impressions, position: row.position }));

  const snapshot = await latestSnapshot(ctx.websiteId, keyword);
  const questions = snapshot ? peopleAlsoAsk(snapshot.peopleAlsoAsk) : [];

  const pages = await prisma.page.findMany({
    where: { websiteId: ctx.websiteId, isActive: true, isIndexable: true },
    select: { id: true, url: true, title: true, h1: true, wordCount: true },
    orderBy: { impressions28d: 'desc' },
    take: 300,
  });
  const relatedPages = pages
    .map((page) => ({
      url: page.url,
      title: page.title,
      wordCount: page.wordCount,
      similarity: round(lexicalCosine(keyword, [page.title, page.h1].filter(Boolean).join(' ')), 3),
    }))
    .filter((page) => page.similarity > 0.15)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 10);

  return {
    output: {
      keyword,
      relatedQueries: related,
      peopleAlsoAsk: questions,
      relatedPages,
      verifiedFacts: input.facts.length,
      serpDataAvailable: snapshot !== null,
      note: snapshot
        ? 'People Also Ask questions come from a stored SERP snapshot.'
        : 'No SERP snapshot exists for this keyword — questions come from Search Console queries only. Configure a SERP provider for richer research.',
    },
    summary: `Research gathered: ${related.length} related queries, ${questions.length} questions, ${relatedPages.length} related pages on the site.`,
    confidence: 0.8,
  };
}

// ── Stage: INTENT_ANALYSIS ────────────────────────────────────────────────────

async function stageIntent(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, keyword } = input;
  const snapshot = await latestSnapshot(ctx.websiteId, keyword);
  const serpTitles = snapshot ? organicTitles(snapshot.results) : [];

  const answer = await step(ctx, 'analyse_intent', { keyword }, () =>
    ai.generateStructured({
      task: keywordIntentPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: keywordIntentPrompt.defaultRole ?? 'fast',
      system: keywordIntentPrompt.system,
      prompt: keywordIntentPrompt.render({
        siteName: site.name,
        domain: site.domain,
        businessCategory: site.businessCategory,
        targetCountry: site.targetCountry,
        keywords: [{ keyword, serpTitles }],
      }),
      schema: intentSchema,
      schemaName: 'content_intent',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  );

  const entry = answer.data.keywords[0] ?? null;
  return {
    output: { keyword, classification: entry, serpTitlesUsed: serpTitles.length },
    summary: entry
      ? `Intent for "${keyword}": ${entry.intent} / ${entry.funnelStage}${entry.pageType ? ` (${entry.pageType})` : ''}.`
      : `The model returned no classification for "${keyword}".`,
    confidence: entry?.confidence ?? 0.4,
  };
}

// ── Stage: CANNIBALISATION_CHECK (deterministic) ──────────────────────────────

async function stageCannibalisation(input: StageInput): Promise<StageOutcome> {
  const { ctx, keyword, draft } = input;
  const windows = comparisonWindows();
  const rows = await step(ctx, 'get_search_console_queries', { window: '28d' }, () =>
    gscAggregates(ctx.websiteId, windows.current, 5000),
  );

  const normalized = normalizeKeyword(keyword);
  const groups = findCannibalization(rows.filter((row) => normalizeKeyword(row.query) === normalized));
  const group = groups[0] ?? null;
  const competing = group ? group.pages.map((page) => page.page) : [];

  // A draft that will publish onto an existing URL is not cannibalising itself.
  const ownUrl = draft.page?.url ?? null;
  const others = competing.filter((url) => url !== ownUrl);
  const risky = others.length >= 2;

  return {
    output: {
      keyword,
      competingUrls: others,
      severity: group?.severity ?? 'none',
      recommendation: group?.recommendation ?? null,
      verdict: risky ? 'CONSOLIDATE_FIRST' : 'CLEAR',
    },
    ...(risky
      ? {
          draftUpdate: {
            qualityFlags: json([
              ...jsonArray(draft.qualityFlags),
              {
                code: 'CANNIBALISATION_RISK',
                severity: 'WARNING',
                message: `${others.length} existing URLs already compete for "${keyword}". Consolidate them before publishing another page targeting the same query.`,
              },
            ]),
          },
        }
      : {}),
    summary: risky
      ? `${others.length} existing URLs already rank for "${keyword}" — flagged for consolidation before publishing.`
      : `No cannibalisation detected for "${keyword}".`,
    confidence: 0.85,
  };
}

// ── Stage: COMPETITOR_ANALYSIS (deterministic, SERP-dependent) ────────────────

async function stageCompetitors(input: StageInput): Promise<StageOutcome> {
  const { ctx, keyword } = input;
  const snapshot = await latestSnapshot(ctx.websiteId, keyword);
  if (!snapshot) {
    return {
      output: {
        available: false,
        reason:
          'No SERP snapshot exists for this keyword. Connect a SERP provider (DataForSEO, Serper or SerpApi) to ' +
          'capture what actually ranks; the brief will be built without competitor structure until then.',
      },
      summary: 'No SERP data available — competitor analysis skipped rather than guessed.',
      confidence: 0.3,
      notes: 'Degraded: no SERP provider configured.',
    };
  }

  const results = jsonArray(snapshot.results)
    .filter((entry) => entry.type === 'organic' || entry.type === undefined)
    .slice(0, 10)
    .map((entry) => ({
      position: typeof entry.position === 'number' ? entry.position : null,
      url: typeof entry.url === 'string' ? entry.url : null,
      title: typeof entry.title === 'string' ? entry.title : null,
      snippet: typeof entry.snippet === 'string' ? truncate(entry.snippet, 300, '…') : null,
    }))
    .filter((entry) => entry.url !== null);

  return {
    output: {
      available: true,
      capturedAt: snapshot.capturedAt,
      provider: snapshot.provider,
      results,
      peopleAlsoAsk: peopleAlsoAsk(snapshot.peopleAlsoAsk),
      relatedSearches: snapshot.relatedSearches.slice(0, 15),
      resultTypes: snapshot.resultTypes,
    },
    summary: `Analysed ${results.length} ranking results captured by ${snapshot.provider}.`,
    confidence: 0.75,
  };
}

// ── Stage: BRIEF ──────────────────────────────────────────────────────────────

async function stageBrief(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft, keyword } = input;
  const competitorOutput = await stageOutputOf(draft.id, 'COMPETITOR_ANALYSIS');
  const researchOutput = await stageOutputOf(draft.id, 'RESEARCH');
  const intentOutput = await stageOutputOf(draft.id, 'INTENT_ANALYSIS');

  const competitors = jsonArray(competitorOutput?.results).flatMap((entry) =>
    typeof entry.url === 'string'
      ? [{ url: entry.url, title: typeof entry.title === 'string' ? entry.title : null }]
      : [],
  );
  const questions = jsonStrings(researchOutput?.peopleAlsoAsk);
  const internalTargets = jsonArray(researchOutput?.relatedPages).flatMap((entry) =>
    typeof entry.url === 'string' ? [entry.url] : [],
  );
  const classification = jsonObject(intentOutput?.classification);

  const answer = await step(ctx, 'write_brief', { keyword }, () =>
    ai.generateStructured({
      task: contentBriefPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: contentBriefPrompt.defaultRole ?? 'reasoning',
      system: contentBriefPrompt.system,
      prompt: contentBriefPrompt.render({
        siteName: site.name,
        domain: site.domain,
        targetKeyword: keyword,
        intent: typeof classification.intent === 'string' ? classification.intent : null,
        funnelStage: typeof classification.funnelStage === 'string' ? classification.funnelStage : null,
        contentType: typeof classification.pageType === 'string' ? classification.pageType : null,
        audience: site.targetAudience,
        competitors,
        questions,
        internalLinkTargets: internalTargets.slice(0, 15),
        knowledgeBase: input.knowledgeBase,
        brandFacts: input.facts,
      }),
      schema: briefSchema,
      schemaName: 'content_brief',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  );

  const brief = answer.data;
  const briefData = {
    title: brief.titleIdeas[0] ?? draft.title,
    targetKeyword: keyword,
    secondaryKeywords: [] as string[],
    intent: isIntent(classification.intent) ? classification.intent : ('UNKNOWN' as const),
    audience: site.targetAudience,
    titleIdeas: brief.titleIdeas.slice(0, 8),
    metaDescription: brief.metaDescription,
    outline: json([]),
    entities: brief.entities.slice(0, 30),
    questions: brief.questionsToAnswer.slice(0, 30),
    competitorWeaknesses: brief.competitorWeaknesses.slice(0, 15),
    originalAngle: brief.angle,
    supportingEvidence: json(brief.mustCoverPoints),
    internalLinkTargets: json(brief.internalLinkTargets.slice(0, 15)),
    schemaOpportunity: brief.schemaOpportunity.slice(0, 8),
    cta: brief.cta,
    targetWordCount: brief.targetWordCount,
    status: 'READY',
  };

  let briefId = draft.briefId;
  if (briefId) {
    await prisma.contentBrief.update({ where: { id: briefId }, data: briefData });
  } else {
    const created = await prisma.contentBrief.create({
      data: { ...briefData, websiteId: ctx.websiteId },
      select: { id: true },
    });
    briefId = created.id;
  }

  return {
    output: { ...brief, briefId },
    draftUpdate: { brief: { connect: { id: briefId } } },
    summary: `Brief written: "${brief.angle}". ${brief.mustCoverPoints.length} must-cover points, ${brief.questionsToAnswer.length} questions.`,
    confidence: 0.75,
    ...(brief.differentiationRisk ? { notes: brief.differentiationRisk } : {}),
  };
}

// ── Stage: OUTLINE ────────────────────────────────────────────────────────────

async function stageOutline(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft, keyword } = input;
  const briefOutput = await stageOutputOf(draft.id, 'BRIEF');

  const answer = await step(ctx, 'write_outline', { keyword }, () =>
    ai.generateStructured({
      task: contentOutlinePrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: contentOutlinePrompt.defaultRole ?? 'writing',
      system: contentOutlinePrompt.system,
      prompt: contentOutlinePrompt.render({
        targetKeyword: keyword,
        secondaryKeywords: draft.brief?.secondaryKeywords ?? [],
        angle: typeof briefOutput?.angle === 'string' ? briefOutput.angle : null,
        questionsToAnswer: draft.brief?.questions ?? [],
        mustCoverPoints: jsonArray(briefOutput?.mustCoverPoints).flatMap((entry) =>
          typeof entry.point === 'string' ? [entry.point] : [],
        ),
        targetWordCount: draft.brief?.targetWordCount ?? null,
        knowledgeBase: input.knowledgeBase,
        brandFacts: input.facts,
      }),
      schema: outlineSchema,
      schemaName: 'content_outline',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  );

  if (draft.briefId) {
    await prisma.contentBrief.update({
      where: { id: draft.briefId },
      data: { outline: json(answer.data.sections) },
    });
  }

  return {
    output: answer.data,
    ...(answer.data.suggestedTitle ? { draftUpdate: { title: answer.data.suggestedTitle } } : {}),
    summary: `Outline written: ${answer.data.sections.length} sections${answer.data.totalWordBudget ? `, ~${answer.data.totalWordBudget} words` : ''}.`,
    confidence: 0.75,
  };
}

// ── Stage: DRAFT ──────────────────────────────────────────────────────────────

async function stageDraft(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft, keyword } = input;
  const outlineOutput = await stageOutputOf(draft.id, 'OUTLINE');
  const briefOutput = await stageOutputOf(draft.id, 'BRIEF');

  const outlineMarkdown = jsonArray(outlineOutput?.sections)
    .map((section) => {
      const level = typeof section.level === 'number' ? section.level : 2;
      const heading = typeof section.heading === 'string' ? section.heading : '';
      const points = Array.isArray(section.keyPoints)
        ? section.keyPoints.filter((point): point is string => typeof point === 'string')
        : [];
      return [`${'#'.repeat(level)} ${heading}`, ...points.map((point) => `- ${point}`)].join('\n');
    })
    .join('\n\n');

  const generated = await step(ctx, 'write_draft', { keyword }, () =>
    ai.generate({
      task: contentDraftPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: contentDraftPrompt.defaultRole ?? 'writing',
      system: contentDraftPrompt.system,
      prompt: contentDraftPrompt.render({
        targetKeyword: keyword,
        secondaryKeywords: draft.brief?.secondaryKeywords ?? [],
        audience: site.targetAudience,
        outline: outlineMarkdown || null,
        brief: typeof briefOutput?.angle === 'string' ? briefOutput.angle : null,
        targetWordCount: draft.brief?.targetWordCount ?? null,
        internalLinks: jsonStrings(draft.brief?.internalLinkTargets).slice(0, 12),
        existingDraft: draft.bodyMarkdown || null,
        knowledgeBase: input.knowledgeBase,
        brandFacts: input.facts,
      }),
      settings: site.settings,
      maxTokens: 8000,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
    (value) => ({ chars: value.text.length, finishReason: value.finishReason }),
  );

  const markdown = generated.text.trim();
  const text = markdownToText(markdown);
  const words = countWords(text);
  const markers = extractVerifyMarkers(markdown);

  const lastVersion = await prisma.contentVersion.findFirst({
    where: { draftId: draft.id },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  await prisma.contentVersion.create({
    data: {
      draftId: draft.id,
      version: (lastVersion?.version ?? 0) + 1,
      title: draft.title,
      bodyMarkdown: markdown,
      metaTitle: draft.metaTitle,
      metaDescription: draft.metaDescription,
      authorType: 'ai',
      authorName: `${generated.provider}/${generated.model}`,
      changeSummary: `Draft generated by ${AGENT}.`,
    },
  });

  return {
    output: {
      wordCount: words,
      verifyMarkers: markers,
      finishReason: generated.finishReason,
      truncated: generated.finishReason === 'length',
    },
    draftUpdate: {
      bodyMarkdown: markdown,
      wordCount: words,
      readabilityScore: round(fleschReadingEase(text), 1),
      excerpt: truncate(text, 200, '…'),
    },
    summary: `Draft written: ${words} words${markers.length ? `, ${markers.length} claim(s) marked for verification` : ''}.`,
    confidence: generated.finishReason === 'length' ? 0.4 : 0.7,
    ...(generated.finishReason === 'length'
      ? { notes: 'The model hit the output limit — the draft is truncated and should be re-run or continued.' }
      : {}),
  };
}

// ── Stage: FACT_CHECK ─────────────────────────────────────────────────────────

async function stageFactCheck(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft, keyword } = input;
  if (!draft.bodyMarkdown.trim()) {
    return {
      output: { skipped: true, reason: 'The draft body is empty — run the DRAFT stage first.' },
      summary: 'Nothing to fact-check: the draft body is empty.',
      confidence: 0,
      hold: true,
    };
  }

  const researchOutput = await stageOutputOf(draft.id, 'RESEARCH');
  const answer = await step(ctx, 'fact_check_draft', { draftId: draft.id }, () =>
    ai.generateStructured({
      task: contentFactCheckPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: contentFactCheckPrompt.defaultRole ?? 'reasoning',
      system: contentFactCheckPrompt.system,
      prompt: contentFactCheckPrompt.render({
        draft: draft.bodyMarkdown,
        targetKeyword: keyword,
        sourceMaterial: researchOutput ? JSON.stringify(researchOutput).slice(0, 8000) : null,
        knowledgeBase: input.knowledgeBase,
        brandFacts: input.facts,
      }),
      schema: factCheckSchema,
      schemaName: 'fact_check',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
    (value) => ({ claims: value.data.claims.length, verdict: value.data.verdict }),
  );

  // Everything not positively supported becomes an open item. The inline [VERIFY:] markers are
  // added deterministically so a model that overlooked one cannot quietly drop it.
  const unsupported = answer.data.claims.filter((claim) => claim.classification !== 'SUPPORTED');
  const markers = extractVerifyMarkers(draft.bodyMarkdown);
  const unverifiedClaims = [
    ...unsupported.map((claim) => ({
      quote: claim.quote,
      classification: claim.classification,
      severity: claim.severity,
      why: claim.why,
      suggestedFix: claim.suggestedFix,
      source: 'fact-check',
    })),
    ...markers.map((marker) => ({
      quote: `[VERIFY: ${marker}]`,
      classification: 'NEEDS_ATTRIBUTION' as const,
      severity: 'HIGH' as const,
      why: 'The writer refused to invent this and left an explicit marker.',
      suggestedFix: 'Supply the fact, cite a source, or remove the sentence.',
      source: 'draft-marker',
    })),
  ];

  const blocking = answer.data.verdict === 'BLOCK' || unsupported.some((claim) => claim.severity === 'CRITICAL');

  return {
    output: {
      verdict: answer.data.verdict,
      verdictReason: answer.data.verdictReason,
      claims: answer.data.claims,
      openVerifyItems: [...answer.data.openVerifyItems, ...markers],
      unsupportedCount: unsupported.length,
    },
    draftUpdate: { unverifiedClaims: json(unverifiedClaims) },
    summary:
      `Fact check ${answer.data.verdict}: ${answer.data.claims.length} claims examined, ` +
      `${unverifiedClaims.length} need human verification. ${answer.data.verdictReason}`,
    confidence: blocking ? 0.5 : 0.75,
    ...(blocking
      ? { notes: 'Blocking fact-check findings — resolve them before the quality gate will pass.' }
      : {}),
  };
}

// ── Stage: SEO_OPTIMISATION ───────────────────────────────────────────────────

async function stageSeo(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft, keyword } = input;
  const researchOutput = await stageOutputOf(draft.id, 'RESEARCH');
  const internalTargets = jsonArray(researchOutput?.relatedPages).flatMap((entry) =>
    typeof entry.url === 'string' ? [entry.url] : [],
  );

  const answer = await step(ctx, 'optimise_draft', { draftId: draft.id }, () =>
    ai.generateStructured({
      task: contentSeoOptimisePrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: contentSeoOptimisePrompt.defaultRole ?? 'reasoning',
      system: contentSeoOptimisePrompt.system,
      prompt: contentSeoOptimisePrompt.render({
        draft: draft.bodyMarkdown,
        targetKeyword: keyword,
        secondaryKeywords: draft.brief?.secondaryKeywords ?? [],
        currentTitle: draft.metaTitle ?? draft.title,
        currentMetaDescription: draft.metaDescription,
        url: draft.page?.url ?? draft.slug,
        internalLinkTargets: internalTargets.slice(0, 15),
      }),
      schema: seoSchema,
      schemaName: 'seo_optimisation',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
    (value) => ({ suggestions: value.data.suggestions.length }),
  );

  const text = markdownToText(draft.bodyMarkdown);
  const headings = extractMarkdownHeadings(draft.bodyMarkdown);
  const coverage = {
    density: round(keywordDensity(text, keyword), 4),
    inFirstParagraph: text.slice(0, 400).toLowerCase().includes(keyword.toLowerCase()),
    inHeading: headings.some((heading) => heading.text.toLowerCase().includes(keyword.toLowerCase())),
    headingCount: headings.length,
    secondaryPresent: (draft.brief?.secondaryKeywords ?? []).filter((secondary) =>
      text.toLowerCase().includes(secondary.toLowerCase()),
    ),
  };

  // Title/meta suggestions are applied only when they fit the length the SERP will render.
  const title = answer.data.suggestedTitle?.trim();
  const meta = answer.data.suggestedMetaDescription?.trim();

  return {
    output: { ...answer.data, keywordCoverage: coverage },
    draftUpdate: {
      keywordCoverage: json(coverage),
      ...(title && title.length >= 20 && title.length <= 70 ? { metaTitle: title } : {}),
      ...(meta && meta.length >= 60 && meta.length <= 165 ? { metaDescription: meta } : {}),
    },
    summary:
      `${answer.data.suggestions.length} on-page suggestions, intent match ${answer.data.intentMatch}. ` +
      `Keyword density ${(coverage.density * 100).toFixed(2)}%.` +
      (answer.data.overOptimisation.length ? ` ${answer.data.overOptimisation.length} over-optimisation warning(s).` : ''),
    confidence: 0.7,
  };
}

// ── Stage: BRAND_REVIEW ───────────────────────────────────────────────────────

async function stageBrandReview(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft } = input;
  const answer = await step(ctx, 'brand_review', { draftId: draft.id }, () =>
    ai.generateStructured({
      task: contentBrandReviewPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: contentBrandReviewPrompt.defaultRole ?? 'fast',
      system: contentBrandReviewPrompt.system,
      prompt: contentBrandReviewPrompt.render({
        draft: draft.bodyMarkdown,
        knowledgeBase: input.knowledgeBase,
        brandFacts: input.facts,
      }),
      schema: brandSchema,
      schemaName: 'brand_review',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
    (value) => ({ verdict: value.data.verdict, issues: value.data.issues.length }),
  );

  const critical = answer.data.issues.filter((issue) => issue.severity === 'CRITICAL' || issue.severity === 'HIGH');
  const flags = critical.map((issue) => ({
    code: 'BRAND_VIOLATION',
    severity: issue.severity === 'CRITICAL' ? 'BLOCKING' : 'WARNING',
    message: `${issue.dimension}: ${issue.why} — "${truncate(issue.quote, 120, '…')}"`,
  }));

  return {
    output: answer.data,
    ...(flags.length
      ? { draftUpdate: { qualityFlags: json([...jsonArray(draft.qualityFlags), ...flags]) } }
      : {}),
    summary: `Brand review ${answer.data.verdict}: ${answer.data.issues.length} issue(s), ${critical.length} serious.`,
    confidence: 0.7,
  };
}

// ── Stage: INTERNAL_LINKING ───────────────────────────────────────────────────

async function stageInternalLinking(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft, keyword } = input;
  const pages = await prisma.page.findMany({
    where: { websiteId: ctx.websiteId, isActive: true, isIndexable: true, NOT: { id: draft.pageId ?? '' } },
    select: { id: true, url: true, title: true, metaDescription: true, h1: true },
    orderBy: { impressions28d: 'desc' },
    take: 200,
  });

  const candidates = pages
    .map((page) => ({
      page,
      similarity: round(lexicalCosine(keyword, [page.title, page.h1, page.metaDescription].filter(Boolean).join(' ')), 3),
    }))
    .filter((entry) => entry.similarity > 0.12)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 12);

  if (candidates.length === 0 || !draft.bodyMarkdown.trim()) {
    return {
      output: { links: [], reason: 'No sufficiently related pages on the site, or the draft body is empty.' },
      summary: 'No internal links proposed — no related page passed the relevance floor.',
      confidence: 0.5,
    };
  }

  const answer = await step(ctx, 'suggest_internal_links', { candidates: candidates.length }, () =>
    ai.generateStructured({
      task: internalLinkAnchorPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: internalLinkAnchorPrompt.defaultRole ?? 'fast',
      system: internalLinkAnchorPrompt.system,
      prompt: internalLinkAnchorPrompt.render({
        sourceUrl: draft.page?.url ?? draft.slug ?? draft.title,
        sourceTitle: draft.title,
        sourceContent: truncate(draft.bodyMarkdown, 12_000, ''),
        candidates: candidates.map((entry) => ({
          targetUrl: entry.page.url,
          targetTitle: entry.page.title,
          targetSummary: entry.page.metaDescription,
          similarity: entry.similarity,
        })),
        maxLinks: 6,
      }),
      schema: linkSchema,
      schemaName: 'internal_links',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
    (value) => ({ links: value.data.links.length }),
  );

  // The applier does a literal replacement, so an anchor the model paraphrased would corrupt the
  // sentence. Anything not present verbatim is dropped rather than "fixed".
  const validUrls = new Set(candidates.map((entry) => entry.page.url));
  const accepted = answer.data.links.filter(
    (link) => validUrls.has(link.targetUrl) && draft.bodyMarkdown.includes(link.anchorText),
  );
  const rejected = answer.data.links.length - accepted.length;

  return {
    output: { accepted, rejected, skipped: answer.data.skipped },
    draftUpdate: {
      internalLinks: json(
        accepted.map((link) => ({ targetUrl: link.targetUrl, anchorText: link.anchorText, reason: link.reason })),
      ),
    },
    summary: `${accepted.length} internal link placement(s) accepted${rejected ? `, ${rejected} rejected because the anchor was not a verbatim substring of the draft` : ''}.`,
    confidence: 0.7,
  };
}

// ── Stage: STRUCTURED_DATA ────────────────────────────────────────────────────

async function stageStructuredData(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft } = input;
  const markdown = draft.bodyMarkdown;
  const headings = extractMarkdownHeadings(markdown);
  const hasQuestionHeadings = headings.filter((heading) => heading.text.trim().endsWith('?')).length >= 2;

  const answer = await step(ctx, 'suggest_schema', { draftId: draft.id }, () =>
    ai.generateStructured({
      task: schemaSuggestionPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: schemaSuggestionPrompt.defaultRole ?? 'fast',
      system: schemaSuggestionPrompt.system,
      prompt: schemaSuggestionPrompt.render({
        url: draft.page?.url ?? draft.slug ?? '',
        title: draft.metaTitle ?? draft.title,
        content: truncate(markdownToText(markdown), 12_000, ''),
        existingSchemaTypes: [],
        supportedTypes: [...SCHEMA_TYPES],
        organizationName: site.brandName ?? site.name,
      }),
      schema: schemaSuggestionSchema,
      schemaName: 'schema_suggestion',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
    (value) => ({ suggestions: value.data.suggestions.length }),
  );

  const rejected: Array<{ schemaType: string; reason: string }> = [];
  const accepted: Array<{ schemaType: string; jsonLd: Record<string, unknown>; validation: unknown }> = [];

  for (const suggestion of answer.data.suggestions) {
    // FAQPage without visible Q&A on the page is the most commonly abused markup there is.
    if (suggestion.schemaType === 'FAQPage' && !hasQuestionHeadings) {
      rejected.push({
        schemaType: suggestion.schemaType,
        reason: 'The draft does not contain visible question-and-answer content, so FAQPage markup would describe content that is not on the page.',
      });
      continue;
    }
    if (['Review', 'AggregateRating'].includes(suggestion.schemaType)) {
      rejected.push({
        schemaType: suggestion.schemaType,
        reason: 'Review and rating markup must come from real reviews stored by the business, never from generated content.',
      });
      continue;
    }
    const validation = validateJsonLd(suggestion.jsonLd);
    if (validation.status === 'INVALID') {
      rejected.push({ schemaType: suggestion.schemaType, reason: validation.issues.map((issue) => issue.message).join('; ') });
      continue;
    }
    accepted.push({ schemaType: suggestion.schemaType, jsonLd: suggestion.jsonLd, validation });
  }

  return {
    output: { accepted, rejected, declined: answer.data.declined },
    draftUpdate: { structuredData: json(accepted.map((entry) => entry.jsonLd)) },
    summary: `${accepted.length} schema block(s) accepted, ${rejected.length} rejected as unsupported by the page content.`,
    confidence: 0.75,
  };
}

// ── Stage: QUALITY_REVIEW ─────────────────────────────────────────────────────

async function stageQualityReview(input: StageInput): Promise<StageOutcome> {
  const { ctx, site, draft, keyword } = input;
  const text = markdownToText(draft.bodyMarkdown);
  const readability = round(fleschReadingEase(text), 1);
  const words = countWords(text);

  const answer = await step(ctx, 'quality_review', { draftId: draft.id }, () =>
    ai.generateStructured({
      task: contentQualityReviewPrompt.id,
      websiteId: ctx.websiteId,
      agent: AGENT,
      role: contentQualityReviewPrompt.defaultRole ?? 'reasoning',
      system: contentQualityReviewPrompt.system,
      prompt: contentQualityReviewPrompt.render({
        draft: draft.bodyMarkdown,
        targetKeyword: keyword,
        audience: site.targetAudience,
        fleschReadingEase: readability,
        wordCount: words,
      }),
      schema: qualitySchema,
      schemaName: 'quality_review',
      settings: site.settings,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
    (value) => ({ verdict: value.data.verdict, tells: value.data.aiTells.length }),
  );

  const deterministic = deterministicQualityFlags({
    markdown: draft.bodyMarkdown,
    targetKeyword: keyword,
    unverifiedClaims: jsonArray(draft.unverifiedClaims).length,
    minWords: site.settings?.thinContentWords ?? 300,
  });

  const modelFlags: QualityFlag[] =
    answer.data.verdict === 'REJECT'
      ? [{ code: 'EDITORIAL_REJECT', severity: 'BLOCKING', message: answer.data.verdictReason }]
      : answer.data.aiTells.length >= 5
        ? [
            {
              code: 'AI_TELLS',
              severity: 'WARNING',
              message: `${answer.data.aiTells.length} generic-AI phrasing patterns were found. Rewrite them before publishing.`,
            },
          ]
        : [];

  const flags = [...jsonArray(draft.qualityFlags), ...deterministic, ...modelFlags];
  const scores = Object.values(answer.data.scores);
  const modelScore = scores.reduce((total, score) => total + score, 0) / Math.max(1, scores.length);
  const blockingCount = [...deterministic, ...modelFlags].filter((flag) => flag.severity === 'BLOCKING').length;
  // Each blocking flag costs 15 points: a page that trips the anti-spam gate must not be able to
  // score well on style alone.
  const qualityScore = round(clamp(modelScore / 100 - blockingCount * 0.15) * 100, 1);

  return {
    output: { ...answer.data, deterministicFlags: deterministic, qualityScore, readability, wordCount: words },
    draftUpdate: {
      qualityFlags: json(flags),
      qualityScore,
      readabilityScore: readability,
      wordCount: words,
    },
    summary:
      `Quality review ${answer.data.verdict}: score ${qualityScore}/100, ${blockingCount} blocking flag(s), ` +
      `${answer.data.aiTells.length} AI tell(s).`,
    confidence: 0.7,
    hold: blockingCount > 0,
    ...(blockingCount > 0
      ? { notes: 'Held at QUALITY_REVIEW: blocking flags must be cleared before the draft can be marked ready.' }
      : {}),
    findings: [...deterministic, ...modelFlags],
  };
}

// ── Stage: READY_FOR_APPROVAL (deterministic gate) ────────────────────────────

async function stageReadyForApproval(input: StageInput): Promise<StageOutcome> {
  const { ctx, draft } = input;
  const flags = jsonArray(draft.qualityFlags);
  const blocking = flags.filter((flag) => flag.severity === 'BLOCKING');

  if (blocking.length > 0 || !draft.bodyMarkdown.trim()) {
    return {
      output: { ready: false, blocking },
      summary: `Not ready for approval: ${blocking.length} blocking quality flag(s) remain.`,
      confidence: 0.9,
      hold: true,
    };
  }

  const approval = await prisma.approval.create({
    data: {
      websiteId: ctx.websiteId,
      userId: ctx.userId ?? null,
      kind: 'CONTENT_DRAFT',
      title: `Publish "${draft.title}"`,
      description:
        `${draft.wordCount} words targeting "${draft.targetKeyword ?? draft.title}". ` +
        `${jsonArray(draft.unverifiedClaims).length} claim(s) still need human verification.`,
      risk: 'MEDIUM',
      status: 'PENDING',
      payload: json({
        draftId: draft.id,
        title: draft.title,
        metaTitle: draft.metaTitle,
        metaDescription: draft.metaDescription,
        unverifiedClaims: jsonArray(draft.unverifiedClaims),
        qualityScore: draft.qualityScore,
      }),
    },
    select: { id: true },
  });

  return {
    output: { ready: true, approvalId: approval.id },
    draftUpdate: { currentStageStatus: 'COMPLETED' },
    summary: `Draft "${draft.title}" is ready for approval and an approval request has been raised.`,
    confidence: 0.85,
    approvalsCreated: [approval.id],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The most recent successful output of a previous stage, so stages compose without re-asking. */
async function stageOutputOf(draftId: string, stage: ContentStage): Promise<Record<string, unknown> | null> {
  const row = await prisma.contentStageRun.findFirst({
    where: { draftId, stage, status: 'COMPLETED' },
    orderBy: { createdAt: 'desc' },
    select: { output: true },
  });
  if (!row?.output || typeof row.output !== 'object' || Array.isArray(row.output)) return null;
  return row.output;
}

async function latestSnapshot(websiteId: string, query: string) {
  return prisma.serpSnapshot.findFirst({
    where: { websiteId, query: { equals: query, mode: 'insensitive' } },
    orderBy: { capturedAt: 'desc' },
    select: {
      provider: true,
      capturedAt: true,
      results: true,
      peopleAlsoAsk: true,
      relatedSearches: true,
      resultTypes: true,
    },
  });
}

function peopleAlsoAsk(value: unknown): string[] {
  return jsonArray(value).flatMap((entry) => (typeof entry.question === 'string' ? [entry.question] : []));
}

function organicTitles(value: unknown): string[] {
  return jsonArray(value)
    .flatMap((entry) => (typeof entry.title === 'string' ? [entry.title] : []))
    .slice(0, 10);
}

function isIntent(value: unknown): value is 'INFORMATIONAL' | 'NAVIGATIONAL' | 'COMMERCIAL' | 'TRANSACTIONAL' | 'LOCAL' | 'UNKNOWN' {
  return (
    value === 'INFORMATIONAL' ||
    value === 'NAVIGATIONAL' ||
    value === 'COMMERCIAL' ||
    value === 'TRANSACTIONAL' ||
    value === 'LOCAL' ||
    value === 'UNKNOWN'
  );
}

export const contentWriterAgent: AgentDefinition = {
  name: AGENT,
  label: 'Content writer',
  description:
    'Runs one stage of the content pipeline for a draft, from research through the anti-spam quality gate to approval.',
  allowedActionTypes: [],
  tools: [
    'get_content_draft',
    'get_search_console_queries',
    'analyse_intent',
    'write_brief',
    'write_outline',
    'write_draft',
    'fact_check_draft',
    'optimise_draft',
    'brand_review',
    'suggest_internal_links',
    'suggest_schema',
    'quality_review',
  ],
  requiresAi: true,
  inputSchema,
  run,
};

registerAgent(contentWriterAgent);
