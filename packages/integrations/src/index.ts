/**
 * Integrations barrel.
 *
 * Every provider in here is optional. Nothing throws at import time when a key is missing —
 * callers ask the `is*Configured()` predicates, and the functions that need a credential throw
 * `IntegrationNotConfiguredError` at call time so the UI can render a "not configured" state
 * with the exact environment variable to set.
 *
 * Note what is deliberately NOT exported: anything that hands out a raw credential. The sub-barrels
 * (notably `backlinks`) keep their env readers private for the same reason.
 */

export * from './types';

// Google: one OAuth grant, two read surfaces (Search Console, GA4).
export * from './google/index';

// Bing Webmaster Tools — modular by design; unsupported endpoints report themselves rather than throwing.
export * from './bing/index';

// SERP providers (DataForSEO / SerpApi / Serper) behind one interface, with graceful degradation
// to Search-Console-only data when none is configured.
export * from './serp/index';

// Backlinks: provider clients plus a CSV importer that works with no provider at all.
export * from './backlinks/index';

// Website adapters — the layer that deploys approved changes (WordPress, Git, webhook, Shopify, Webflow).
export * from './adapters/index';
