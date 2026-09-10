/**
 * `@seo/agents` — the agent framework and the specialised SEO agents built on it.
 *
 * Importing this module registers every agent as a side effect, which is why the agent imports
 * below look unused. Anything calling `getAgent`/`listAgents`/`runAgent` must import from here
 * (or from `@seo/agents`) rather than from `./runtime/registry` directly, or the registry will be
 * empty at the moment of lookup — the same pattern the prompt registry uses in `@seo/ai`.
 */

export * from './types';
export * from './runtime/registry';
export * from './runtime/run';
export * from './runtime/memory';
export * from './tools/index';

// Registration side effects. Order is irrelevant; the registry is keyed by agent name.
import './agents/technical-seo-agent';
import './agents/keyword-agent';
import './agents/content-strategy-agent';
import './agents/content-writer-agent';
import './agents/content-refresh-agent';
import './agents/internal-link-agent';
import './agents/schema-agent';
import './agents/competitor-agent';
import './agents/geo-agent';
import './agents/ai-visibility-agent';
import './agents/indexation-agent';
import './agents/analytics-agent';
import './agents/seo-manager-agent';

// Typed re-exports: import the definition when a caller wants one specific agent rather than a
// registry lookup by name.
export { technicalSeoAgent, groupTechnicalIssues, clusterEffort } from './agents/technical-seo-agent';
export type { ClusterableIssue, IssueCluster } from './agents/technical-seo-agent';
export { keywordAgent, rollupQueries, topicalAuthorityIndex } from './agents/keyword-agent';
export type { QueryRollup } from './agents/keyword-agent';
export { contentStrategyAgent, reconcileDecision } from './agents/content-strategy-agent';
export type { LlmContentDecision } from './agents/content-strategy-agent';
export {
  contentWriterAgent,
  STAGE_ORDER,
  nextStage,
  isPipelineStage,
  extractVerifyMarkers,
  deterministicQualityFlags,
} from './agents/content-writer-agent';
export type { QualityFlag } from './agents/content-writer-agent';
export { contentRefreshAgent, diagnoseDecay, refreshImpact } from './agents/content-refresh-agent';
export type { DecayCause, DecayDiagnosis } from './agents/content-refresh-agent';
export { internalLinkAgent, linkImpact } from './agents/internal-link-agent';
export { schemaAgent, schemaImpact } from './agents/schema-agent';
export { competitorAgent } from './agents/competitor-agent';
export { geoAgent, groupFindings, GEO_DISCLAIMER } from './agents/geo-agent';
export { aiVisibilityAgent, aiVisibilityScore } from './agents/ai-visibility-agent';
export type { VisibilityTotals } from './agents/ai-visibility-agent';
export { indexationAgent, reconcileIndexation, GOOGLE_INDEXING_REALITY } from './agents/indexation-agent';
export type { IndexationBuckets, ReconcilablePage } from './agents/indexation-agent';
export { analyticsAgent } from './agents/analytics-agent';
export { seoManagerAgent, planActionsToProposals } from './agents/seo-manager-agent';
export type { ConvertedAction, ConversionResult, PlanHorizon, PlanItem } from './agents/seo-manager-agent';

// Shared agent plumbing, exported so the worker and API layer can build the same typed results.
export {
  skipped,
  result,
  proposeAction,
  notifyOnce,
  loadSite,
  loadActionHistory,
  loadVerifiedFacts,
  gscAggregates,
  comparisonWindows,
  hasSearchConsoleData,
  latestCrawl,
  toPromptKnowledgeBase,
  GSC_NOT_CONNECTED,
  NO_CRAWL,
} from './agents/shared';
export type { ActionProposal, ActionHistory, SiteContext } from './agents/shared';
