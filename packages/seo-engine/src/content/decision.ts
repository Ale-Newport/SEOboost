import {
  clamp,
  containsPhrase,
  cosineSimilarity,
  lexicalCosine,
  normalizeKeyword,
  round,
  slugify,
  tokenize,
} from '@seo/shared';

export type ContentDecision =
  | 'IMPROVE_EXISTING_PAGE'
  | 'NEW_ARTICLE'
  | 'NEW_LANDING_PAGE'
  | 'NEW_COMPARISON_PAGE'
  | 'NEW_GLOSSARY_PAGE'
  | 'NEW_PRODUCT_PAGE'
  | 'ADD_FAQ_SECTION'
  | 'CONTENT_REFRESH'
  | 'CTR_OPTIMISATION'
  | 'CONSOLIDATE_CANNIBALISATION'
  | 'NO_ACTION';

export interface ExistingPageSummary {
  id: string;
  url: string;
  title: string | null;
  h1: string | null;
  metaDescription: string | null;
  textContent: string | null;
  wordCount: number;
  pageType: string;
  targetKeywords: string[];
  embedding?: number[] | null;
  /** Current performance for the keyword under consideration, if any. */
  position: number | null;
  impressions: number;
  clicks: number;
  ctr: number | null;
  clicksTrendPct: number | null;
  isIndexable: boolean;
}

export interface ContentDecisionInput {
  keyword: string;
  intent: string;
  funnelStage: string;
  impressions: number;
  clicks: number;
  searchVolume: number | null;
  currentPosition: number | null;
  /** Every page on the site, or a pre-filtered candidate set for large sites. */
  existingPages: ExistingPageSummary[];
  /** Embedding for the keyword, when available. */
  keywordEmbedding?: number[] | null;
  /** Pages already competing for this exact query (from the cannibalisation analysis). */
  cannibalizingUrls?: string[];
  /** Site-wide thin-content threshold. */
  thinContentWords: number;
}

export interface ContentDecisionResult {
  decision: ContentDecision;
  confidence: number;
  /** The page to improve, when the decision is not "create new". */
  targetPage: { id: string; url: string; similarity: number } | null;
  /** Best semantic matches considered, for transparency in the UI. */
  candidates: Array<{ id: string; url: string; title: string | null; similarity: number; reason: string }>;
  cannibalizationRisk: number;
  suggestedUrl: string | null;
  suggestedTitle: string | null;
  reasoning: string;
  /** Everything the caller should show the user before acting. */
  evidence: Record<string, unknown>;
}

/**
 * Decide what — if anything — should be produced for a keyword.
 *
 * This is the guard that stops the platform from mass-producing pages. It runs BEFORE any LLM
 * call and is deliberately conservative: creating a new URL requires clearing several bars, while
 * improving an existing page is the default whenever a reasonable match exists.
 *
 * Order of checks mirrors the product spec:
 *   1. search existing site content
 *   2. compare semantic intent
 *   3. check for cannibalisation
 *   4. only propose a new URL when nothing existing can plausibly rank
 */
export function decideContentAction(input: ContentDecisionInput): ContentDecisionResult {
  const keyword = input.keyword.trim();
  const normalizedKeyword = normalizeKeyword(keyword);

  // 1-2. Rank existing pages by semantic + lexical match to the keyword.
  const scored = input.existingPages
    .filter((page) => page.isIndexable)
    .map((page) => {
      const similarity = keywordPageSimilarity(keyword, normalizedKeyword, page, input.keywordEmbedding);
      return { page, similarity };
    })
    .sort((a, b) => b.similarity - a.similarity);

  const candidates = scored.slice(0, 5).map(({ page, similarity }) => ({
    id: page.id,
    url: page.url,
    title: page.title,
    similarity: round(similarity, 3),
    reason: explainMatch(keyword, page, similarity),
  }));

  const best = scored[0];
  const cannibalizingUrls = input.cannibalizingUrls ?? [];
  const cannibalizationRisk = estimateCannibalizationRisk(scored, cannibalizingUrls);

  const evidence: Record<string, unknown> = {
    keyword,
    intent: input.intent,
    impressions: input.impressions,
    clicks: input.clicks,
    currentPosition: input.currentPosition,
    pagesEvaluated: input.existingPages.length,
    bestMatch: best ? { url: best.page.url, similarity: round(best.similarity, 3) } : null,
    cannibalizingUrls,
  };

  // 3. Existing cannibalisation always takes priority — adding a page would make it worse.
  if (cannibalizingUrls.length >= 2) {
    return {
      decision: 'CONSOLIDATE_CANNIBALISATION',
      confidence: 0.85,
      targetPage: best ? { id: best.page.id, url: best.page.url, similarity: round(best.similarity, 3) } : null,
      candidates,
      cannibalizationRisk: 1,
      suggestedUrl: null,
      suggestedTitle: null,
      reasoning:
        `${cannibalizingUrls.length} existing URLs already compete for "${keyword}". Publishing another page would ` +
        'deepen the split. Consolidate onto one page first, then re-evaluate.',
      evidence,
    };
  }

  if (best && best.similarity >= 0.55) {
    const page = best.page;

    // A page that ranks but is under-clicked needs a title/meta rewrite, not more words.
    if (
      page.position !== null &&
      page.position <= 10 &&
      page.impressions >= 100 &&
      page.ctr !== null &&
      page.ctr < 0.02
    ) {
      return {
        decision: 'CTR_OPTIMISATION',
        confidence: 0.8,
        targetPage: { id: page.id, url: page.url, similarity: round(best.similarity, 3) },
        candidates,
        cannibalizationRisk,
        suggestedUrl: null,
        suggestedTitle: null,
        reasoning:
          `${page.url} already ranks at position ${page.position.toFixed(1)} for "${keyword}" with ` +
          `${page.impressions.toLocaleString()} impressions but only ${((page.ctr ?? 0) * 100).toFixed(2)}% CTR. ` +
          'The ranking is fine — the snippet is not earning the click. Rewrite the title and meta description.',
        evidence,
      };
    }

    // A page losing traffic needs a refresh, which is a different job from an expansion.
    if (page.clicksTrendPct !== null && page.clicksTrendPct <= -25 && page.clicks > 0) {
      return {
        decision: 'CONTENT_REFRESH',
        confidence: 0.78,
        targetPage: { id: page.id, url: page.url, similarity: round(best.similarity, 3) },
        candidates,
        cannibalizationRisk,
        suggestedUrl: null,
        suggestedTitle: null,
        reasoning:
          `${page.url} already targets "${keyword}" but clicks are down ${Math.abs(Math.round(page.clicksTrendPct))}% ` +
          'period over period. Refresh it — update facts, close new sub-topics competitors now cover, and re-verify claims.',
        evidence,
      };
    }

    // A strong match that is thin or off page one is an improvement job.
    const needsWork =
      page.wordCount < input.thinContentWords * 2 ||
      (page.position !== null && page.position > 5) ||
      page.position === null;

    if (needsWork) {
      return {
        decision: 'IMPROVE_EXISTING_PAGE',
        confidence: clamp(0.6 + best.similarity * 0.3),
        targetPage: { id: page.id, url: page.url, similarity: round(best.similarity, 3) },
        candidates,
        cannibalizationRisk,
        suggestedUrl: null,
        suggestedTitle: null,
        reasoning:
          `${page.url} is a ${Math.round(best.similarity * 100)}% match for "${keyword}"` +
          (page.position !== null ? ` and already ranks at position ${page.position.toFixed(1)}` : ' but is not ranking yet') +
          `. With ${page.wordCount} words it has room to cover the query properly. Improving it beats creating a new URL: ` +
          'it inherits the existing authority and avoids splitting relevance signals.',
        evidence,
      };
    }

    // Strong match, already strong page: an FAQ block may still capture the sub-intent.
    if (input.intent === 'INFORMATIONAL' && isQuestionQuery(keyword)) {
      return {
        decision: 'ADD_FAQ_SECTION',
        confidence: 0.65,
        targetPage: { id: page.id, url: page.url, similarity: round(best.similarity, 3) },
        candidates,
        cannibalizationRisk,
        suggestedUrl: null,
        suggestedTitle: null,
        reasoning:
          `${page.url} already covers this topic well and ranks at position ${page.position?.toFixed(1) ?? 'n/a'}. ` +
          `"${keyword}" is a specific question best answered as an FAQ block on that page rather than a new URL.`,
        evidence,
      };
    }

    return {
      decision: 'NO_ACTION',
      confidence: 0.7,
      targetPage: { id: page.id, url: page.url, similarity: round(best.similarity, 3) },
      candidates,
      cannibalizationRisk,
      suggestedUrl: null,
      suggestedTitle: null,
      reasoning:
        `${page.url} already covers "${keyword}" well` +
        (page.position !== null ? ` at position ${page.position.toFixed(1)}` : '') +
        '. No content work is justified right now.',
      evidence,
    };
  }

  // 4. Nothing existing matches. Is a new page actually warranted?
  const hasDemand = input.impressions >= 30 || (input.searchVolume ?? 0) >= 50;
  const moderateMatch = best && best.similarity >= 0.35;

  if (!hasDemand && !moderateMatch) {
    return {
      decision: 'NO_ACTION',
      confidence: 0.6,
      targetPage: null,
      candidates,
      cannibalizationRisk,
      suggestedUrl: null,
      suggestedTitle: null,
      reasoning:
        `No existing page covers "${keyword}", but demand is unproven ` +
        `(${input.impressions} impressions${input.searchVolume ? `, ~${input.searchVolume} monthly searches` : ', no volume data'}). ` +
        'Creating a page for a query with no measured demand is how thin content accumulates.',
      evidence,
    };
  }

  if (moderateMatch && best) {
    // A partial match is usually better expanded than duplicated.
    return {
      decision: 'IMPROVE_EXISTING_PAGE',
      confidence: 0.55,
      targetPage: { id: best.page.id, url: best.page.url, similarity: round(best.similarity, 3) },
      candidates,
      cannibalizationRisk,
      suggestedUrl: null,
      suggestedTitle: null,
      reasoning:
        `${best.page.url} is a partial match (${Math.round(best.similarity * 100)}%) for "${keyword}". Expanding it to cover ` +
        'this query directly is lower risk than a new URL that would compete with it.',
      evidence,
    };
  }

  const pageType = inferNewPageType(keyword, input.intent, input.funnelStage);
  return {
    decision: pageType.decision,
    confidence: clamp(0.5 + (hasDemand ? 0.2 : 0) + (input.currentPosition !== null ? 0.1 : 0)),
    targetPage: null,
    candidates,
    cannibalizationRisk,
    suggestedUrl: `/${slugify(keyword)}`,
    suggestedTitle: pageType.title(keyword),
    reasoning:
      `No page on the site targets "${keyword}" (best match ${best ? Math.round(best.similarity * 100) : 0}%), ` +
      `and there is measured demand (${input.impressions.toLocaleString()} impressions` +
      `${input.searchVolume ? `, ~${input.searchVolume.toLocaleString()} monthly searches` : ''}). ` +
      `${pageType.rationale} Cannibalisation risk is ${Math.round(cannibalizationRisk * 100)}%.`,
    evidence,
  };
}

function keywordPageSimilarity(
  keyword: string,
  normalizedKeyword: string,
  page: ExistingPageSummary,
  keywordEmbedding?: number[] | null,
): number {
  // An explicit target-keyword assignment is definitive.
  if (page.targetKeywords.some((k) => normalizeKeyword(k) === normalizedKeyword)) return 1;

  let score = 0;

  // Title/H1 containment is the strongest cheap signal.
  if (page.title && containsPhrase(page.title, keyword)) score = Math.max(score, 0.85);
  if (page.h1 && containsPhrase(page.h1, keyword)) score = Math.max(score, 0.82);

  // Embedding similarity when available.
  if (keywordEmbedding?.length && page.embedding?.length && keywordEmbedding.length === page.embedding.length) {
    const cos = cosineSimilarity(keywordEmbedding, page.embedding);
    // Keyword↔document cosine runs lower than doc↔doc; rescale into a usable range.
    score = Math.max(score, clamp((cos - 0.25) / 0.6));
  }

  // Lexical fallback across the page's most representative text.
  const haystack = `${page.title ?? ''} ${page.h1 ?? ''} ${page.metaDescription ?? ''} ${(page.textContent ?? '').slice(0, 3000)}`;
  const lexical = lexicalCosine(keyword, haystack);
  const tokens = tokenize(normalizedKeyword);
  const lower = haystack.toLowerCase();
  const tokenHits = tokens.filter((t) => lower.includes(t)).length;
  const coverage = tokens.length ? tokenHits / tokens.length : 0;
  score = Math.max(score, lexical * 0.4 + coverage * 0.5);

  // Body containment of the full phrase is meaningful but weaker than a title match.
  if (page.textContent && containsPhrase(page.textContent.slice(0, 8000), keyword)) {
    score = Math.max(score, 0.6);
  }

  return clamp(score);
}

function explainMatch(keyword: string, page: ExistingPageSummary, similarity: number): string {
  if (similarity >= 0.9) return `Explicitly targets "${keyword}".`;
  if (page.title && containsPhrase(page.title, keyword)) return 'The title contains the exact query.';
  if (similarity >= 0.55) return `Covers closely related material (${Math.round(similarity * 100)}% match).`;
  if (similarity >= 0.35) return `Partially related (${Math.round(similarity * 100)}% match).`;
  return `Weak overlap (${Math.round(similarity * 100)}%).`;
}

function estimateCannibalizationRisk(
  scored: Array<{ page: ExistingPageSummary; similarity: number }>,
  cannibalizingUrls: string[],
): number {
  if (cannibalizingUrls.length >= 2) return 1;
  // Several pages all matching strongly means a new page would join a crowded field.
  const strong = scored.filter((s) => s.similarity >= 0.5).length;
  if (strong >= 3) return 0.85;
  if (strong === 2) return 0.6;
  if (strong === 1) return 0.35;
  return 0.1;
}

function isQuestionQuery(keyword: string): boolean {
  const q = keyword.toLowerCase().trim();
  return /^(what|how|why|when|where|who|which|can|does|do|is|are|should|will)\b/.test(q) || q.endsWith('?');
}

function inferNewPageType(
  keyword: string,
  intent: string,
  funnelStage: string,
): { decision: ContentDecision; title: (kw: string) => string; rationale: string } {
  const q = keyword.toLowerCase();

  if (/\bvs\b|\bversus\b|\bcompared? to\b|\balternatives?\b|\bcomparison\b/.test(q)) {
    return {
      decision: 'NEW_COMPARISON_PAGE',
      title: (kw) => toTitle(kw),
      rationale: 'The query is explicitly comparative, so a structured comparison page with a real table is the right format.',
    };
  }
  if (/^what is |^what are |\bdefinition\b|\bmeaning\b|\bglossary\b/.test(q)) {
    return {
      decision: 'NEW_GLOSSARY_PAGE',
      title: (kw) => toTitle(kw),
      rationale: 'The query is definitional — a concise, citable definition page serves it (and answer engines) best.',
    };
  }
  if (intent === 'TRANSACTIONAL' || (intent === 'COMMERCIAL' && funnelStage === 'DECISION')) {
    return {
      decision: /\b(pricing|price|buy|plan|subscription)\b/.test(q) ? 'NEW_LANDING_PAGE' : 'NEW_PRODUCT_PAGE',
      title: (kw) => toTitle(kw),
      rationale: 'The query carries purchase intent, so a conversion-oriented page beats an article.',
    };
  }
  if (intent === 'COMMERCIAL') {
    return {
      decision: 'NEW_LANDING_PAGE',
      title: (kw) => toTitle(kw),
      rationale: 'Commercial-investigation intent is served by a focused landing page, not a general article.',
    };
  }
  return {
    decision: 'NEW_ARTICLE',
    title: (kw) => toTitle(kw),
    rationale: 'Informational intent with no existing coverage — a dedicated article is justified.',
  };
}

function toTitle(text: string): string {
  const minor = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'vs']);
  return text
    .split(/\s+/)
    .map((w, i) => (i > 0 && minor.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
