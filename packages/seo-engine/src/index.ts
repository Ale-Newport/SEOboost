// Types
export * from './types';

// Technical SEO
export { RULES, RULE_LIST, getRule, type RuleId } from './technical/catalogue';
export { runTechnicalAudit, type AuditResult } from './technical/audit';

// Scoring (health, page, keyword opportunity, action priority)
export * from './scoring';

// Keyword intelligence
export * from './keywords/analysis';
export * from './keywords/clustering';

// Internal linking & architecture
export * from './links/graph';
export * from './links/suggestions';

// Content intelligence
export * from './content/decision';

// GEO
export * from './geo/audit';

// Structured data
export * from './structured-data/validate';
export * from './structured-data/generate';

// Entity graph
export * from './entities/graph';

// Competitors
export * from './competitors/gap';

// Experiments & feedback loop
export * from './experiments/evaluate';

// Portfolio intelligence
export * from './portfolio/intelligence';
