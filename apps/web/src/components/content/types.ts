import type { ExplainableScore } from '@seo/shared';

/**
 * Serialisable shapes the content screens hand to their client components.
 *
 * The Prisma enums and `Prisma.JsonValue` never cross the server/client boundary: `@seo/db`
 * pulls the generated client (and `@seo/shared` pulls `node:crypto`) into whatever bundle
 * imports it. The server pages narrow every JSON column into the types below once — see
 * `normalize.ts` — so the client never has to re-guess what an agent wrote.
 */

// ── enums, mirrored as string unions ─────────────────────────

/** The 14 stages a draft is actually worked through (spec §20). */
export const PIPELINE_STAGES = [
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
] as const;

/** Terminal states. Nothing runs in these — they are outcomes, not work. */
export const TERMINAL_STAGES = ['APPROVED', 'PUBLISHED', 'REJECTED'] as const;

export const CONTENT_STAGES = [...PIPELINE_STAGES, ...TERMINAL_STAGES] as const;

export type ContentStageValue = (typeof CONTENT_STAGES)[number];
export type PipelineStageValue = (typeof PIPELINE_STAGES)[number];

export const CONTENT_STAGE_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED'] as const;
export type ContentStageStatusValue = (typeof CONTENT_STAGE_STATUSES)[number];

export const OPPORTUNITY_TYPES = [
  'IMPROVE_EXISTING_PAGE',
  'NEW_ARTICLE',
  'NEW_LANDING_PAGE',
  'NEW_COMPARISON_PAGE',
  'NEW_GLOSSARY_PAGE',
  'NEW_PRODUCT_PAGE',
  'ADD_FAQ_SECTION',
  'CONTENT_REFRESH',
  'CTR_OPTIMISATION',
  'CONSOLIDATE_CANNIBALISATION',
  'NO_ACTION',
] as const;
export type OpportunityTypeValue = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_STATUSES = [
  'IDENTIFIED',
  'ACCEPTED',
  'IN_PROGRESS',
  'COMPLETED',
  'REJECTED',
  'EXPIRED',
] as const;
export type OpportunityStatusValue = (typeof OPPORTUNITY_STATUSES)[number];

// ── opportunities ────────────────────────────────────────────

/** One of the existing pages the decision engine weighed before proposing anything. */
export interface OpportunityCandidate {
  url: string;
  title: string | null;
  similarity: number | null;
  reason: string | null;
}

/**
 * What the discovery pass actually saw. Every field is nullable because it is read back out of a
 * JSON column an agent wrote: a missing measurement renders as “not measured”, never as a zero.
 */
export interface OpportunityEvidence {
  impressions: number | null;
  clicks: number | null;
  currentPosition: number | null;
  pagesEvaluated: number | null;
  bestMatchUrl: string | null;
  bestMatchSimilarity: number | null;
  cannibalizingUrls: string[];
  candidates: OpportunityCandidate[];
  deterministicDecision: string | null;
  modelDecision: string | null;
  rejectionReason: string | null;
  rejectedAt: string | null;
  acceptanceNote: string | null;
}

export interface OpportunityItem {
  id: string;
  type: OpportunityTypeValue;
  status: OpportunityStatusValue;
  title: string;
  targetKeyword: string | null;
  secondaryKeywords: string[];
  suggestedUrl: string | null;
  reasoning: string;
  priorityScore: number;
  impactScore: number;
  effortScore: number;
  confidenceScore: number;
  estimatedTrafficGain: number | null;
  cannibalizationChecked: boolean;
  cannibalizationRisk: number | null;
  existingPageMatch: string | null;
  discoveredAt: string;
  expiresAt: string | null;
  briefCount: number;
  /** Built from `evidence.priorityFactors` — absent when the pass recorded no factors. */
  priority: ExplainableScore | null;
  evidence: OpportunityEvidence;
  keyword: { id: string; keyword: string; intent: string; funnelStage: string; searchVolume: number | null } | null;
  page: { id: string; url: string; title: string | null } | null;
  cluster: { id: string; name: string } | null;
}

export interface OpportunityFacetCount {
  value: string;
  count: number;
}

// ── pipeline ─────────────────────────────────────────────────

export interface DraftRow {
  id: string;
  title: string;
  slug: string | null;
  kind: string;
  stage: ContentStageValue;
  stageStatus: ContentStageStatusValue;
  targetKeyword: string | null;
  wordCount: number;
  qualityScore: number | null;
  seoScore: number | null;
  geoScore: number | null;
  readabilityScore: number | null;
  unverifiedClaimCount: number;
  blockingFlagCount: number;
  scheduledFor: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  updatedAt: string;
  pageUrl: string | null;
}

export interface BriefRow {
  id: string;
  title: string;
  targetKeyword: string;
  secondaryKeywords: string[];
  intent: string;
  funnelStage: string;
  status: string;
  outlineLength: number;
  questionCount: number;
  targetWordCount: number | null;
  suggestedUrl: string | null;
  draftCount: number;
  createdAt: string;
}

export interface StageCount {
  stage: ContentStageValue;
  count: number;
}

// ── draft detail ─────────────────────────────────────────────

export type ClaimSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface UnverifiedClaim {
  /** Positional id — the JSON rows carry no identity of their own. */
  id: string;
  quote: string;
  classification: string;
  severity: ClaimSeverity;
  why: string | null;
  suggestedFix: string | null;
  source: string | null;
}

export interface QualityFlagItem {
  id: string;
  code: string;
  severity: 'BLOCKING' | 'WARNING' | 'INFO';
  message: string;
}

export interface DraftSource {
  id: string;
  url: string | null;
  title: string | null;
  publisher: string | null;
  retrievedAt: string | null;
}

export interface InternalLinkSuggestionItem {
  id: string;
  targetUrl: string;
  anchorText: string;
  reason: string | null;
  /** False once the anchor no longer appears verbatim in the body — it cannot be inserted. */
  anchorPresent: boolean;
  /** True when the body already links this anchor to this URL. */
  alreadyLinked: boolean;
}

export interface KeywordCoverage {
  density: number | null;
  inFirstParagraph: boolean | null;
  inHeading: boolean | null;
  headingCount: number | null;
  secondaryPresent: string[];
}

export interface StageRunItem {
  id: string;
  stage: ContentStageValue;
  status: ContentStageStatusValue;
  attempt: number;
  notes: string | null;
  error: string | null;
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface DraftVersion {
  id: string;
  version: number;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  bodyMarkdown: string;
  authorType: string;
  authorName: string | null;
  changeSummary: string | null;
  createdAt: string;
}

export interface DraftBriefSummary {
  id: string;
  title: string;
  targetKeyword: string;
  secondaryKeywords: string[];
  outline: string[];
  questions: string[];
  targetWordCount: number | null;
}

export interface LivePageSummary {
  id: string;
  url: string;
  title: string | null;
  wordCount: number;
  seoScore: number | null;
  /** Extracted text from the most recent crawl snapshot; null when nothing was captured. */
  textContent: string | null;
  capturedAt: string | null;
}

export interface DraftDetail {
  id: string;
  websiteId: string;
  websiteName: string;
  kind: string;
  title: string;
  slug: string | null;
  metaTitle: string | null;
  metaDescription: string | null;
  excerpt: string | null;
  targetKeyword: string | null;
  secondaryKeywords: string[];
  bodyMarkdown: string;
  wordCount: number;
  stage: ContentStageValue;
  stageStatus: ContentStageStatusValue;
  seoScore: number | null;
  geoScore: number | null;
  readabilityScore: number | null;
  qualityScore: number | null;
  keywordCoverage: KeywordCoverage | null;
  qualityFlags: QualityFlagItem[];
  unverifiedClaims: UnverifiedClaim[];
  sources: DraftSource[];
  internalLinks: InternalLinkSuggestionItem[];
  scheduledFor: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  updatedAt: string;
  brief: DraftBriefSummary | null;
  livePage: LivePageSummary | null;
  stages: StageRunItem[];
  versions: DraftVersion[];
}
