import { ai, contentDecisionPrompt, isAiAvailable } from '@seo/ai';
import { type OpportunityType, json, prisma } from '@seo/db';
import {
  calculatePriority,
  decideContentAction,
  findCannibalization,
  riskLevelForActionType,
  type ContentDecision,
  type ExistingPageSummary,
  type QueryPageAggregate,
} from '@seo/seo-engine';
import { clamp, errorMessage, normalizeKeyword, round, safeDivide, truncate } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  GSC_NOT_CONNECTED,
  comparisonWindows,
  gscAggregates,
  hasSearchConsoleData,
  latestCrawl,
  loadSite,
  pluralise,
  propose,
  result,
  skipped,
  step,
  throwIfAborted,
  unique,
} from './shared';

const AGENT = 'ContentStrategyAgent' as const;
const ALLOWED_ACTION_TYPES = [
  'CREATE_CONTENT_BRIEF',
  'UPDATE_CONTENT',
  'UPDATE_META_DESCRIPTION',
  'CONSOLIDATE_PAGES',
] as const;

const DEFAULT_KEYWORD_LIMIT = 25;
const MAX_CANDIDATE_PAGES = 800;
const EXCERPT_CHARS = 3000;

// ── Decision reconciliation (pure, unit-testable) ─────────────────────────────

export type LlmContentDecision = 'CREATE_NEW' | 'UPDATE_EXISTING' | 'CONSOLIDATE' | 'REFRESH' | 'SKIP';

const NEW_PAGE_DECISIONS: ReadonlySet<ContentDecision> = new Set([
  'NEW_ARTICLE',
  'NEW_LANDING_PAGE',
  'NEW_COMPARISON_PAGE',
  'NEW_GLOSSARY_PAGE',
  'NEW_PRODUCT_PAGE',
]);

/**
 * Combine the deterministic decision with the model's opinion.
 *
 * The engine has veto power in one direction only: the model may talk the platform *out* of
 * publishing a page, never into it. This is the rule that stops "the LLM said it was fine" from
 * becoming the mechanism by which a site accumulates near-duplicate pages, and it is why the
 * gate runs before the model is ever called.
 */
export function reconcileDecision(
  deterministic: ContentDecision,
  llm: LlmContentDecision | null,
): { type: OpportunityType; note: string } {
  const base = deterministic as OpportunityType;
  if (llm === null) return { type: base, note: 'Deterministic decision only — no model review.' };

  if (llm === 'SKIP') {
    return {
      type: 'NO_ACTION',
      note: `The decision engine proposed ${deterministic}; the model argued against pursuing this keyword, so it was dropped.`,
    };
  }

  if (deterministic === 'CONSOLIDATE_CANNIBALISATION' || deterministic === 'IMPROVE_EXISTING_PAGE') {
    // Locked: the engine found an existing page or a cannibalisation group. Nothing the model
    // says can turn that into a new URL.
    return {
      type: base,
      note:
        llm === 'CREATE_NEW'
          ? `The model suggested a new page, but the decision engine found existing coverage — kept as ${deterministic}.`
          : `Model agreed with ${deterministic}.`,
    };
  }

  if (NEW_PAGE_DECISIONS.has(deterministic)) {
    if (llm === 'UPDATE_EXISTING') {
      return { type: 'IMPROVE_EXISTING_PAGE', note: 'Model found existing coverage the similarity search ranked lower — downgraded to an improvement.' };
    }
    if (llm === 'CONSOLIDATE') {
      return { type: 'CONSOLIDATE_CANNIBALISATION', note: 'Model identified competing pages — downgraded to a consolidation.' };
    }
    if (llm === 'REFRESH') {
      return { type: 'CONTENT_REFRESH', note: 'Model judged the existing page structurally right but stale.' };
    }
  }

  return { type: base, note: `Model agreed with ${deterministic}.` };
}

const EFFORT_BY_TYPE: Record<string, number> = {
  NEW_ARTICLE: 4,
  NEW_LANDING_PAGE: 4,
  NEW_COMPARISON_PAGE: 4,
  NEW_GLOSSARY_PAGE: 3,
  NEW_PRODUCT_PAGE: 4,
  IMPROVE_EXISTING_PAGE: 3,
  CONTENT_REFRESH: 3,
  ADD_FAQ_SECTION: 2,
  CTR_OPTIMISATION: 1,
  CONSOLIDATE_CANNIBALISATION: 4,
  NO_ACTION: 1,
};

const ACTION_BY_TYPE: Record<string, (typeof ALLOWED_ACTION_TYPES)[number] | null> = {
  NEW_ARTICLE: 'CREATE_CONTENT_BRIEF',
  NEW_LANDING_PAGE: 'CREATE_CONTENT_BRIEF',
  NEW_COMPARISON_PAGE: 'CREATE_CONTENT_BRIEF',
  NEW_GLOSSARY_PAGE: 'CREATE_CONTENT_BRIEF',
  NEW_PRODUCT_PAGE: 'CREATE_CONTENT_BRIEF',
  IMPROVE_EXISTING_PAGE: 'UPDATE_CONTENT',
  CONTENT_REFRESH: 'UPDATE_CONTENT',
  ADD_FAQ_SECTION: 'UPDATE_CONTENT',
  CTR_OPTIMISATION: 'UPDATE_META_DESCRIPTION',
  CONSOLIDATE_CANNIBALISATION: 'CONSOLIDATE_PAGES',
  NO_ACTION: null,
};

const decisionSchema = z.object({
  decision: z.enum(['CREATE_NEW', 'UPDATE_EXISTING', 'CONSOLIDATE', 'REFRESH', 'SKIP']),
  targetUrl: z.string().nullable(),
  rationale: z.string(),
  whatIsMissing: z.array(z.string()),
  suggestedTitle: z.string().nullable(),
  secondaryKeywords: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  additionalDataNeeded: z.string().nullable(),
});

// ── Agent ─────────────────────────────────────────────────────────────────────

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);

  if (!(await hasSearchConsoleData(ctx.websiteId))) {
    return skipped('No Search Console data for this site.', GSC_NOT_CONNECTED);
  }

  const limit =
    typeof ctx.input.limit === 'number' ? Math.max(1, Math.min(100, ctx.input.limit)) : DEFAULT_KEYWORD_LIMIT;

  const keywords = await step(
    ctx,
    'list_keyword_opportunities',
    { limit },
    () =>
      prisma.keyword.findMany({
        where: { websiteId: ctx.websiteId, opportunityScore: { not: null } },
        orderBy: { opportunityScore: 'desc' },
        take: limit,
        select: {
          id: true,
          keyword: true,
          normalized: true,
          intent: true,
          funnelStage: true,
          clusterId: true,
          pageId: true,
          clicks28d: true,
          impressions28d: true,
          currentPosition: true,
          searchVolume: true,
          opportunityScore: true,
          businessValue: true,
        },
      }),
    (rows) => ({ keywords: rows.length }),
  );

  if (keywords.length === 0) {
    return skipped(
      'No scored keywords to work from.',
      'No keyword has an opportunity score yet. Run the Keyword agent first — it turns Search Console queries into scored keywords.',
    );
  }

  const windows = comparisonWindows();
  const gscRows = await step(
    ctx,
    'get_search_console_queries',
    { window: '28d' },
    () => gscAggregates(ctx.websiteId, windows.current, 5000),
    (rows) => ({ rows: rows.length }),
  );

  const cannibalization = findCannibalization(gscRows);
  const cannibalizedPages = new Map<string, string[]>();
  for (const group of cannibalization) {
    cannibalizedPages.set(
      normalizeKeyword(group.query),
      group.pages.map((page) => page.page),
    );
  }

  const pages = await loadCandidatePages(ctx);
  if (pages.length === 0) {
    return skipped(
      'No pages to compare keywords against.',
      'This site has no crawled pages yet, so the decision engine cannot tell a content gap from an existing page. Run a crawl first.',
    );
  }

  const metricsByQueryPage = indexQueryPageMetrics(gscRows);
  const aiAvailable = isAiAvailable();
  const actions = new ActionCollector();
  const findings: unknown[] = [];
  let opportunitiesCreated = 0;
  let noAction = 0;
  let modelReviews = 0;

  for (const keyword of keywords) {
    throwIfAborted(ctx);

    const perPage = metricsByQueryPage.get(keyword.normalized) ?? new Map<string, PageMetrics>();
    const existingPages: ExistingPageSummary[] = pages.map((page) => {
      const metrics = perPage.get(page.url) ?? null;
      return {
        ...page.summary,
        position: metrics?.position ?? null,
        impressions: metrics?.impressions ?? 0,
        clicks: metrics?.clicks ?? 0,
        ctr: metrics?.ctr ?? null,
        clicksTrendPct: page.clicksTrendPct,
      };
    });

    const decision = decideContentAction({
      keyword: keyword.keyword,
      intent: keyword.intent,
      funnelStage: keyword.funnelStage,
      impressions: keyword.impressions28d,
      clicks: keyword.clicks28d,
      searchVolume: keyword.searchVolume,
      currentPosition: keyword.currentPosition,
      existingPages,
      cannibalizingUrls: cannibalizedPages.get(keyword.normalized) ?? [],
      thinContentWords: site.settings?.thinContentWords ?? 300,
    });

    if (decision.decision === 'NO_ACTION') {
      noAction++;
      findings.push({
        kind: 'content-decision',
        keyword: keyword.keyword,
        decision: 'NO_ACTION',
        reasoning: decision.reasoning,
      });
      continue;
    }

    // ── Only what cleared the gate reaches the model ──────────────────────────
    let llmDecision: LlmContentDecision | null = null;
    let llmRationale: string | null = null;
    let llmSecondary: string[] = [];
    let llmTitle: string | null = null;

    if (aiAvailable) {
      try {
        const review = await step(
          ctx,
          'review_content_decision',
          { keyword: keyword.keyword, deterministic: decision.decision },
          () =>
            ai.generateStructured({
              task: contentDecisionPrompt.id,
              websiteId: ctx.websiteId,
              agent: AGENT,
              role: contentDecisionPrompt.defaultRole ?? 'reasoning',
              system: contentDecisionPrompt.system,
              prompt: contentDecisionPrompt.render({
                siteName: site.name,
                targetKeyword: keyword.keyword,
                intent: keyword.intent,
                candidatePages: decision.candidates.map((candidate) => {
                  const page = pages.find((entry) => entry.summary.id === candidate.id);
                  const metrics = perPage.get(candidate.url) ?? null;
                  return {
                    url: candidate.url,
                    title: candidate.title,
                    wordCount: page?.summary.wordCount ?? null,
                    currentPosition: metrics?.position ?? null,
                    impressions: metrics?.impressions ?? null,
                    clicks: metrics?.clicks ?? null,
                    similarity: candidate.similarity,
                    excerpt: page?.excerpt ?? null,
                  };
                }),
              }),
              schema: decisionSchema,
              schemaName: 'content_decision',
              settings: site.settings,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            }),
          (value) => ({ decision: value.data.decision, confidence: value.data.confidence }),
        );
        llmDecision = review.data.decision;
        llmRationale = review.data.rationale;
        llmSecondary = review.data.secondaryKeywords.slice(0, 10);
        llmTitle = review.data.suggestedTitle;
        modelReviews++;
      } catch (err) {
        ctx.log('content decision review failed', { keyword: keyword.keyword, error: errorMessage(err) });
      }
    }

    const reconciled = reconcileDecision(decision.decision, llmDecision);
    if (reconciled.type === 'NO_ACTION') {
      noAction++;
      findings.push({
        kind: 'content-decision',
        keyword: keyword.keyword,
        decision: 'NO_ACTION',
        reasoning: reconciled.note,
      });
      continue;
    }

    const existing = await prisma.contentOpportunity.findFirst({
      where: {
        websiteId: ctx.websiteId,
        keywordId: keyword.id,
        type: reconciled.type,
        status: { in: ['IDENTIFIED', 'ACCEPTED', 'IN_PROGRESS'] },
      },
      select: { id: true },
    });
    if (existing) continue;

    const impact = clamp((keyword.opportunityScore ?? 50) / 100);
    const businessValue = clamp(keyword.businessValue ?? 0.5);
    const effort = EFFORT_BY_TYPE[reconciled.type] ?? 3;
    const actionType = ACTION_BY_TYPE[reconciled.type] ?? null;
    const priority = calculatePriority({
      impact,
      confidence: decision.confidence,
      businessValue,
      effort,
      risk: actionType ? riskLevelForActionType(actionType) : 2,
    });

    const title =
      llmTitle ??
      decision.suggestedTitle ??
      (decision.targetPage ? `Improve ${decision.targetPage.url} for "${keyword.keyword}"` : `Cover "${keyword.keyword}"`);

    const opportunity = await prisma.contentOpportunity.create({
      data: {
        websiteId: ctx.websiteId,
        keywordId: keyword.id,
        clusterId: keyword.clusterId,
        pageId: decision.targetPage?.id ?? null,
        type: reconciled.type,
        status: 'IDENTIFIED',
        title,
        targetKeyword: keyword.keyword,
        secondaryKeywords: unique(llmSecondary).slice(0, 10),
        suggestedUrl: decision.suggestedUrl,
        reasoning: [decision.reasoning, reconciled.note, llmRationale].filter(Boolean).join(' '),
        evidence: json({
          ...decision.evidence,
          deterministicDecision: decision.decision,
          modelDecision: llmDecision,
          candidates: decision.candidates,
          priorityFactors: priority.factors,
          priorityExplanation: priority.summary,
        }),
        impactScore: round(impact, 3),
        effortScore: effort,
        confidenceScore: round(decision.confidence, 3),
        priorityScore: priority.score,
        cannibalizationChecked: true,
        cannibalizationRisk: round(decision.cannibalizationRisk, 3),
        existingPageMatch: decision.targetPage?.url ?? null,
      },
      select: { id: true },
    });
    opportunitiesCreated++;

    findings.push({
      kind: 'content-opportunity',
      id: opportunity.id,
      keyword: keyword.keyword,
      type: reconciled.type,
      priority: priority.score,
      targetPage: decision.targetPage?.url ?? null,
      reasoning: decision.reasoning,
    });

    if (actionType) {
      await propose(ctx, actions, {
        type: actionType,
        title,
        reasoning: [decision.reasoning, reconciled.note].filter(Boolean).join(' '),
        evidence: {
          keyword: keyword.keyword,
          opportunityType: reconciled.type,
          opportunityId: opportunity.id,
          decision: decision.decision,
          cannibalizationRisk: decision.cannibalizationRisk,
          candidates: decision.candidates.slice(0, 3),
        },
        affectedUrls: decision.targetPage ? [decision.targetPage.url] : [],
        payload: {
          opportunityId: opportunity.id,
          keywordId: keyword.id,
          targetPageId: decision.targetPage?.id ?? null,
          suggestedUrl: decision.suggestedUrl,
        },
        impact,
        confidence: decision.confidence,
        businessValue,
        effort,
        sourceType: 'ContentOpportunity',
        sourceId: opportunity.id,
        // Content work always produces a draft a human approves; nothing here writes to the site.
        advisory:
          actionType === 'CONSOLIDATE_PAGES'
            ? 'Consolidation needs redirects and editorial judgement, so it always waits for a person.'
            : 'The work itself runs through the content pipeline, which ends in an approval.',
      });
    }
  }

  return result({
    summary:
      `Reviewed ${keywords.length} top ${pluralise(keywords.length, 'keyword')}: ${opportunitiesCreated} content ` +
      `${pluralise(opportunitiesCreated, 'opportunity', 'opportunities')} created, ${noAction} judged not worth acting on. ` +
      (aiAvailable
        ? `${modelReviews} decisions were reviewed by the model after clearing the deterministic gate.`
        : 'No AI provider is configured, so decisions are deterministic only.'),
    confidence: aiAvailable ? 0.72 : 0.65,
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings,
    data: {
      keywordsReviewed: keywords.length,
      opportunitiesCreated,
      noAction,
      modelReviews,
      cannibalisationGroups: cannibalization.length,
      guardrail:
        'A new page is only ever proposed when the deterministic decision engine found no existing page that could rank. ' +
        'The model can veto a new page but can never create one.',
    },
  });
}

interface CandidatePage {
  url: string;
  clicksTrendPct: number | null;
  excerpt: string | null;
  summary: Omit<ExistingPageSummary, 'position' | 'impressions' | 'clicks' | 'ctr' | 'clicksTrendPct'>;
}

/** Site pages plus the crawler's page text, which is what makes the similarity match meaningful. */
async function loadCandidatePages(ctx: AgentContext): Promise<CandidatePage[]> {
  const pages = await step(
    ctx,
    'list_pages',
    { websiteId: ctx.websiteId },
    () =>
      prisma.page.findMany({
        where: { websiteId: ctx.websiteId, isActive: true, isIndexable: true },
        orderBy: { impressions28d: 'desc' },
        take: MAX_CANDIDATE_PAGES,
        select: {
          id: true,
          url: true,
          normalizedUrl: true,
          title: true,
          h1: true,
          metaDescription: true,
          wordCount: true,
          pageType: true,
          clicksTrendPct: true,
          isIndexable: true,
          keywords: { select: { keyword: true }, take: 5, orderBy: { impressions28d: 'desc' } },
        },
      }),
    (rows) => ({ pages: rows.length }),
  );

  const crawl = await latestCrawl(ctx.websiteId);
  const textByPageId = new Map<string, string>();
  if (crawl) {
    const crawlPages = await prisma.crawlPage.findMany({
      where: { crawlId: crawl.id, pageId: { in: pages.map((page) => page.id) } },
      select: { pageId: true, textContent: true },
    });
    for (const row of crawlPages) {
      if (row.pageId && row.textContent) textByPageId.set(row.pageId, truncate(row.textContent, EXCERPT_CHARS, ''));
    }
  }

  return pages.map((page) => ({
    url: page.url,
    clicksTrendPct: page.clicksTrendPct,
    excerpt: textByPageId.get(page.id) ? truncate(textByPageId.get(page.id) ?? '', 400, '…') : null,
    summary: {
      id: page.id,
      url: page.url,
      title: page.title,
      h1: page.h1,
      metaDescription: page.metaDescription,
      textContent: textByPageId.get(page.id) ?? null,
      wordCount: page.wordCount,
      pageType: page.pageType,
      targetKeywords: page.keywords.map((keyword) => keyword.keyword),
      isIndexable: page.isIndexable,
    },
  }));
}

interface PageMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** normalized query → page URL → that query's metrics on that page. */
function indexQueryPageMetrics(rows: readonly QueryPageAggregate[]): Map<string, Map<string, PageMetrics>> {
  const out = new Map<string, Map<string, PageMetrics>>();
  for (const row of rows) {
    const key = normalizeKeyword(row.query);
    let byPage = out.get(key);
    if (!byPage) {
      byPage = new Map();
      out.set(key, byPage);
    }
    const existing = byPage.get(row.page);
    if (existing) {
      const impressions = existing.impressions + row.impressions;
      const clicks = existing.clicks + row.clicks;
      byPage.set(row.page, {
        clicks,
        impressions,
        ctr: round(safeDivide(clicks, impressions), 4),
        position: round(
          safeDivide(existing.position * existing.impressions + row.position * row.impressions, impressions),
          2,
        ),
      });
    } else {
      byPage.set(row.page, { clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position });
    }
  }
  return out;
}

export const contentStrategyAgent: AgentDefinition = {
  name: AGENT,
  label: 'Content strategy',
  description:
    'Decides what to create, improve or consolidate for the highest-opportunity keywords, with a deterministic gate before any model call.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: ['list_keyword_opportunities', 'get_search_console_queries', 'list_pages', 'review_content_decision'],
  requiresAi: false,
  run,
};

registerAgent(contentStrategyAgent);
