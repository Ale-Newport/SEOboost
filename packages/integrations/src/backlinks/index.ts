/**
 * Backlinks barrel.
 *
 * The feature works with no provider key at all: `importBacklinksCsv` covers ingestion and
 * `analyseBacklinks` / `findLinkOpportunities` run entirely off stored rows. Paid providers
 * only automate the ingestion step.
 */

export type {
  BacklinkRow,
  ReferringDomainRow,
  BacklinkFetchOptions,
  BacklinkProvider,
  BacklinkProviderInfo,
} from './types';

// `backlinkEnv` is deliberately NOT re-exported: it hands out raw API keys, and the package
// barrel is what a server action or route imports from. Callers ask `isAhrefsConfigured()`
// (and friends, below) instead — the answer they actually need, without the secret.

export {
  parseCsv,
  parseCsvTable,
  parseBacklinksCsv,
  detectBacklinkColumns,
  importBacklinksCsv,
  upsertBacklinks,
  BACKLINK_STATUS_ACTIVE,
  BACKLINK_STATUS_LOST,
  MAX_CSV_ROWS,
} from './csv';
export type {
  CsvParseOptions,
  CsvTable,
  BacklinkCsvField,
  BacklinkCsvMapping,
  BacklinkCsvParseResult,
  BacklinkPersistResult,
  ImportBacklinksCsvResult,
} from './csv';

export {
  getBacklinkProvider,
  isBacklinkProviderAvailable,
  listBacklinkProviders,
  fetchBacklinks,
  fetchReferringDomains,
  fetchCompetitorBacklinks,
  importProviderBacklinks,
  backlinkIntegrationHealth,
} from './registry';
export type {
  BacklinkUnavailable,
  BacklinkFetchOutcome,
  ReferringDomainOutcome,
  BacklinkImportOutcome,
} from './registry';

export {
  analyseBacklinks,
  findLinkOpportunities,
  detectSuspiciousLinks,
  isExactMatchAnchor,
  DEFAULT_ANALYSIS_WINDOW_DAYS,
  DEFAULT_SUSPICIOUS_THRESHOLDS,
  MAX_ANALYSED_LINKS,
} from './analysis';
export type {
  AnalysableLink,
  AnalyseBacklinksOptions,
  AnchorProfileEntry,
  BacklinkAnalysis,
  BacklinkTotals,
  BacklinkVelocity,
  LinkOpportunities,
  LinkOpportunity,
  OpportunityKind,
  ReferringDomainSummary,
  SkippedCheck,
  SuspiciousContext,
  SuspiciousFinding,
  SuspiciousReason,
  SuspiciousSeverity,
  SuspiciousThresholds,
} from './analysis';

export { dataForSeoBacklinkProvider, isDataForSeoBacklinksConfigured } from './providers/dataforseo';
export { ahrefsBacklinkProvider, isAhrefsConfigured } from './providers/ahrefs';
export { semrushBacklinkProvider, isSemrushConfigured } from './providers/semrush';
export { mozBacklinkProvider, isMozConfigured } from './providers/moz';
