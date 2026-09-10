/** Thresholds and weights that drive deterministic SEO scoring. Documented so scores are explainable. */

export const SEO_THRESHOLDS = {
  title: { min: 30, max: 60, hardMax: 70 },
  metaDescription: { min: 70, max: 155, hardMax: 165 },
  content: { thin: 300, shallow: 600, healthy: 900 },
  h1: { max: 1 },
  pageSizeBytes: { warn: 2_000_000, critical: 5_000_000 },
  responseTimeMs: { warn: 1500, critical: 3000 },
  crawlDepth: { warn: 4, critical: 6 },
  internalLinksIn: { orphanThreshold: 0, lowThreshold: 3 },
  redirectChain: { warn: 2, critical: 4 },
  duplicateSimhashDistance: 6,
  strikingDistance: { min: 8, max: 20 },
  ctrOpportunity: { minImpressions: 100, maxPosition: 10, minDeltaRatio: -0.25 },
  decay: { minClicksBefore: 20, dropPct: -25 },
  cannibalization: { minPages: 2, minImpressions: 50, maxPositionSpread: 30 },
} as const;

/** How much each severity contributes to the health-score penalty. */
export const SEVERITY_WEIGHT = {
  CRITICAL: 10,
  HIGH: 5,
  MEDIUM: 2,
  LOW: 0.7,
  INFO: 0.1,
} as const;

export const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

/** Health-score weights per category — sums to 1. Shown in the UI methodology panel. */
export const HEALTH_CATEGORY_WEIGHT = {
  CRAWLABILITY: 0.2,
  INDEXABILITY: 0.2,
  METADATA: 0.15,
  CONTENT: 0.15,
  LINKS: 0.12,
  ARCHITECTURE: 0.08,
  STRUCTURED_DATA: 0.05,
  PERFORMANCE: 0.03,
  SECURITY: 0.01,
  INTERNATIONAL: 0.01,
  GEO: 0,
} as const;

/** Keyword opportunity score weights — sums to 1. Every factor is reported alongside the score. */
export const KEYWORD_OPPORTUNITY_WEIGHTS = {
  rankingPotential: 0.24,
  impressionVolume: 0.18,
  relevance: 0.15,
  businessValue: 0.13,
  competitionGap: 0.1,
  contentGap: 0.08,
  topicalAuthority: 0.06,
  geoPotential: 0.06,
} as const;

/** GEO score dimension weights — sums to 1. */
export const GEO_DIMENSION_WEIGHTS = {
  entityClarity: 0.13,
  structuredData: 0.13,
  factDensity: 0.11,
  contentStructure: 0.11,
  expertiseSignals: 0.1,
  citationWorthiness: 0.1,
  brandConsistency: 0.08,
  definitions: 0.08,
  comparativeContent: 0.06,
  firstPartyData: 0.06,
  sourceQuality: 0.04,
} as const;

export const GEO_DIMENSION_LABELS: Record<keyof typeof GEO_DIMENSION_WEIGHTS, string> = {
  entityClarity: 'Entity clarity',
  structuredData: 'Structured data',
  factDensity: 'Fact density',
  contentStructure: 'Content structure',
  expertiseSignals: 'Expertise signals',
  citationWorthiness: 'Citation worthiness',
  brandConsistency: 'Brand consistency',
  definitions: 'Definitions & terminology',
  comparativeContent: 'Comparisons & tables',
  firstPartyData: 'First-party data',
  sourceQuality: 'Source quality',
};

/** Page SEO score weights — sums to 1. */
export const PAGE_SEO_WEIGHTS = {
  title: 0.16,
  metaDescription: 0.1,
  headings: 0.12,
  contentDepth: 0.18,
  indexability: 0.14,
  internalLinks: 0.12,
  structuredData: 0.08,
  images: 0.05,
  technicalIssues: 0.05,
} as const;

/** Risk classification for automated actions (§41 of the product spec). */
export const ACTION_RISK_BY_TYPE = {
  FIX_TECHNICAL_ISSUE: 'MEDIUM',
  UPDATE_TITLE: 'MEDIUM',
  UPDATE_META_DESCRIPTION: 'SAFE',
  UPDATE_CONTENT: 'MEDIUM',
  PUBLISH_CONTENT: 'MEDIUM',
  CREATE_CONTENT_BRIEF: 'SAFE',
  ADD_INTERNAL_LINKS: 'SAFE',
  ADD_STRUCTURED_DATA: 'SAFE',
  CREATE_REDIRECT: 'HIGH',
  REFRESH_CONTENT: 'MEDIUM',
  CONSOLIDATE_PAGES: 'HIGH',
  SUBMIT_URL_INDEXING: 'SAFE',
  GEO_IMPROVEMENT: 'SAFE',
  OUTREACH_DRAFT: 'SAFE',
  CUSTOM: 'HIGH',
} as const;

/**
 * Actions that must NEVER execute without an explicit human approval, at any
 * autonomy level. Enforced in the guardrail layer, not just the UI.
 */
export const ALWAYS_REQUIRES_APPROVAL = [
  'CREATE_REDIRECT',
  'CONSOLIDATE_PAGES',
  'CUSTOM',
] as const;

export const AUTONOMY_DESCRIPTIONS = {
  L0_INSIGHTS_ONLY: {
    label: 'Level 0 — Insights only',
    description: 'Analyse and report. The platform never proposes executable actions.',
    autoExecutes: [] as string[],
  },
  L1_DRAFTS_ONLY: {
    label: 'Level 1 — Drafts, you approve everything',
    description: 'AI prepares drafts and suggestions. Every change waits for your approval.',
    autoExecutes: [] as string[],
  },
  L2_SAFE_TECHNICAL: {
    label: 'Level 2 — Safe technical changes automatic',
    description: 'Low-risk technical work applies automatically. Content always needs approval.',
    autoExecutes: ['ADD_STRUCTURED_DATA', 'SUBMIT_URL_INDEXING', 'UPDATE_META_DESCRIPTION'],
  },
  L3_MOST_REVERSIBLE: {
    label: 'Level 3 — Most reversible changes automatic',
    description: 'Reversible changes apply automatically. High-risk actions still need approval.',
    autoExecutes: [
      'ADD_STRUCTURED_DATA', 'SUBMIT_URL_INDEXING', 'UPDATE_META_DESCRIPTION',
      'ADD_INTERNAL_LINKS', 'UPDATE_TITLE', 'FIX_TECHNICAL_ISSUE', 'CREATE_CONTENT_BRIEF',
    ],
  },
  L4_HIGH_AUTONOMY: {
    label: 'Level 4 — High autonomy',
    description:
      'The platform runs itself for everything reversible, including publishing content. Redirects, consolidations and custom actions still require approval.',
    autoExecutes: [
      'ADD_STRUCTURED_DATA', 'SUBMIT_URL_INDEXING', 'UPDATE_META_DESCRIPTION',
      'ADD_INTERNAL_LINKS', 'UPDATE_TITLE', 'FIX_TECHNICAL_ISSUE', 'CREATE_CONTENT_BRIEF',
      'UPDATE_CONTENT', 'PUBLISH_CONTENT', 'REFRESH_CONTENT', 'GEO_IMPROVEMENT', 'OUTREACH_DRAFT',
    ],
  },
} as const;

export const SCHEMA_TYPES = [
  'Organization', 'WebSite', 'WebPage', 'Article', 'BlogPosting', 'NewsArticle',
  'BreadcrumbList', 'Person', 'Product', 'SoftwareApplication', 'FAQPage', 'HowTo',
  'VideoObject', 'Review', 'AggregateRating', 'LocalBusiness', 'Service', 'Course',
  'Recipe', 'Event', 'ItemList', 'CollectionPage', 'AboutPage', 'ContactPage', 'ProfilePage',
] as const;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;
