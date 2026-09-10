/**
 * Prompt registry entry point.
 *
 * Importing this module registers every template as a side effect, which is why the template
 * imports below look unused. Anything that calls `getPrompt`/`listPrompts` must import from
 * here (or from `@seo/ai`) rather than from `./registry` directly, or the registry will be
 * empty at the moment of lookup.
 */

export * from './types';
export * from './registry';
export * from './shared';

import './templates/keyword-intent';
import './templates/keyword-expansion';
import './templates/topic-clustering';
import './templates/content-decision';
import './templates/content-brief';
import './templates/content-outline';
import './templates/content-draft';
import './templates/content-fact-check';
import './templates/content-seo-optimise';
import './templates/content-brand-review';
import './templates/content-quality-review';
import './templates/title-alternatives';
import './templates/meta-description';
import './templates/internal-link-anchor';
import './templates/entity-extraction';
import './templates/geo-audit';
import './templates/geo-recommendations';
import './templates/ai-visibility-prompt-discovery';
import './templates/ai-visibility-answer-analysis';
import './templates/competitor-gap-analysis';
import './templates/seo-manager-strategy';
import './templates/site-summary';
import './templates/page-analysis';
import './templates/outreach-draft';
import './templates/schema-suggestion';

// Typed re-exports: import the template const when the caller knows its variable shape and
// wants `render()` to be type-checked.
export { keywordIntentPrompt } from './templates/keyword-intent';
export type { KeywordIntentVars, KeywordIntentKeyword } from './templates/keyword-intent';
export { keywordExpansionPrompt } from './templates/keyword-expansion';
export type { KeywordExpansionVars } from './templates/keyword-expansion';
export { topicClusteringPrompt } from './templates/topic-clustering';
export type { TopicClusteringVars, TopicClusteringKeyword } from './templates/topic-clustering';
export { contentDecisionPrompt } from './templates/content-decision';
export type {
  ContentDecisionVars,
  ContentDecisionExistingPage,
} from './templates/content-decision';
export { contentBriefPrompt } from './templates/content-brief';
export type { ContentBriefVars, ContentBriefCompetitor } from './templates/content-brief';
export { contentOutlinePrompt } from './templates/content-outline';
export type { ContentOutlineVars } from './templates/content-outline';
export { contentDraftPrompt } from './templates/content-draft';
export type { ContentDraftVars } from './templates/content-draft';
export { contentFactCheckPrompt } from './templates/content-fact-check';
export type { ContentFactCheckVars } from './templates/content-fact-check';
export { contentSeoOptimisePrompt } from './templates/content-seo-optimise';
export type { ContentSeoOptimiseVars } from './templates/content-seo-optimise';
export { contentBrandReviewPrompt } from './templates/content-brand-review';
export type { ContentBrandReviewVars } from './templates/content-brand-review';
export { contentQualityReviewPrompt } from './templates/content-quality-review';
export type { ContentQualityReviewVars } from './templates/content-quality-review';
export { titleAlternativesPrompt } from './templates/title-alternatives';
export type { TitleAlternativesVars } from './templates/title-alternatives';
export { metaDescriptionPrompt } from './templates/meta-description';
export type { MetaDescriptionVars } from './templates/meta-description';
export { internalLinkAnchorPrompt } from './templates/internal-link-anchor';
export type {
  InternalLinkAnchorVars,
  InternalLinkCandidate,
} from './templates/internal-link-anchor';
export { entityExtractionPrompt } from './templates/entity-extraction';
export type { EntityExtractionVars } from './templates/entity-extraction';
export { geoAuditPrompt } from './templates/geo-audit';
export type { GeoAuditVars } from './templates/geo-audit';
export { geoRecommendationsPrompt } from './templates/geo-recommendations';
export type { GeoRecommendationsVars, GeoDimensionScore } from './templates/geo-recommendations';
export { aiVisibilityPromptDiscoveryPrompt } from './templates/ai-visibility-prompt-discovery';
export type { AiVisibilityPromptDiscoveryVars } from './templates/ai-visibility-prompt-discovery';
export { aiVisibilityAnswerAnalysisPrompt } from './templates/ai-visibility-answer-analysis';
export type { AiVisibilityAnswerAnalysisVars } from './templates/ai-visibility-answer-analysis';
export { competitorGapAnalysisPrompt } from './templates/competitor-gap-analysis';
export type {
  CompetitorGapAnalysisVars,
  CompetitorGapKeyword,
  CompetitorGapTopic,
} from './templates/competitor-gap-analysis';
export { seoManagerStrategyPrompt } from './templates/seo-manager-strategy';
export type { SeoManagerStrategyVars } from './templates/seo-manager-strategy';
export { siteSummaryPrompt } from './templates/site-summary';
export type { SiteSummaryVars } from './templates/site-summary';
export { pageAnalysisPrompt } from './templates/page-analysis';
export type { PageAnalysisVars } from './templates/page-analysis';
export { outreachDraftPrompt } from './templates/outreach-draft';
export type { OutreachDraftVars } from './templates/outreach-draft';
export { schemaSuggestionPrompt } from './templates/schema-suggestion';
export type { SchemaSuggestionVars } from './templates/schema-suggestion';

/** Every prompt id this package ships, for exhaustiveness checks in tests and the UI. */
export const PROMPT_IDS = [
  'keyword-intent',
  'keyword-expansion',
  'topic-clustering',
  'content-decision',
  'content-brief',
  'content-outline',
  'content-draft',
  'content-fact-check',
  'content-seo-optimise',
  'content-brand-review',
  'content-quality-review',
  'title-alternatives',
  'meta-description',
  'internal-link-anchor',
  'entity-extraction',
  'geo-audit',
  'geo-recommendations',
  'ai-visibility-prompt-discovery',
  'ai-visibility-answer-analysis',
  'competitor-gap-analysis',
  'seo-manager-strategy',
  'site-summary',
  'page-analysis',
  'outreach-draft',
  'schema-suggestion',
] as const;

export type PromptId = (typeof PROMPT_IDS)[number];
