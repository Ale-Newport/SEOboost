/**
 * Backlink provider registry.
 *
 * ## Degradation contract
 * Every backlink API is **optional**. With none configured the feature is still fully usable
 * through `importBacklinksCsv` — every vendor exports CSV, and the analysis layer works off
 * the `Backlink` table regardless of how rows got there. So nothing here throws for a missing
 * key: callers get `{ available: false, reason, requiredEnv }` and render a hint next to the
 * CSV upload instead of an error.
 */

import { createLogger, errorMessage } from '@seo/shared';
import type { IntegrationHealth } from '@seo/shared';
import { upsertBacklinks } from './csv';
import { ahrefsBacklinkProvider } from './providers/ahrefs';
import { dataForSeoBacklinkProvider } from './providers/dataforseo';
import { mozBacklinkProvider } from './providers/moz';
import { semrushBacklinkProvider } from './providers/semrush';
import type {
  BacklinkFetchOptions,
  BacklinkProvider,
  BacklinkProviderInfo,
  BacklinkRow,
  ReferringDomainRow,
} from './types';

const log = createLogger('backlinks:registry');

/**
 * Preference order. DataForSEO first because it reuses the SERP credentials most installs
 * already have (no extra subscription), then Ahrefs and Semrush for link-graph depth, then
 * Moz, whose 50-rows-per-page endpoint makes large exports slow.
 */
const PROVIDERS: readonly BacklinkProvider[] = [
  dataForSeoBacklinkProvider,
  ahrefsBacklinkProvider,
  semrushBacklinkProvider,
  mozBacklinkProvider,
];

export interface BacklinkUnavailable {
  available: false;
  reason: string;
  /** Any one of these env sets enables automatic backlink fetching. */
  requiredEnv: string[];
}

export type BacklinkFetchOutcome =
  | { available: true; provider: string; rows: BacklinkRow[] }
  | BacklinkUnavailable;

export type ReferringDomainOutcome =
  | { available: true; provider: string; domains: ReferringDomainRow[] }
  | BacklinkUnavailable;

export type BacklinkImportOutcome =
  | { available: true; provider: string; fetched: number; inserted: number; updated: number }
  | BacklinkUnavailable;

function unavailable(reason: string): BacklinkUnavailable {
  return { available: false, reason, requiredEnv: PROVIDERS.flatMap((p) => [...p.requiredEnv]) };
}

const NO_PROVIDER_REASON =
  'No backlink provider is configured. Import a CSV export from Ahrefs, Semrush or Majestic instead.';

/** Every known provider and whether its keys are present — drives the settings UI. */
export function listBacklinkProviders(): BacklinkProviderInfo[] {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    label: provider.label,
    configured: safeIsConfigured(provider),
    requiredEnv: [...provider.requiredEnv],
    supportsReferringDomains: typeof provider.fetchReferringDomains === 'function',
    supportsCompetitorGap: typeof provider.fetchCompetitorBacklinks === 'function',
  }));
}

/**
 * The provider to use, or null when none is configured.
 * `preferred` (a provider name) wins when that provider is configured; otherwise the first
 * configured provider in preference order is returned.
 */
export function getBacklinkProvider(preferred?: string): BacklinkProvider | null {
  if (preferred) {
    const match = PROVIDERS.find((p) => p.name === preferred && safeIsConfigured(p));
    if (match) return match;
  }
  return PROVIDERS.find((p) => safeIsConfigured(p)) ?? null;
}

export function isBacklinkProviderAvailable(): boolean {
  return PROVIDERS.some((p) => safeIsConfigured(p));
}

/** `isConfigured` only reads env, but a settings page must never fail because of it. */
function safeIsConfigured(provider: BacklinkProvider): boolean {
  try {
    return provider.isConfigured();
  } catch (err) {
    log.warn('provider isConfigured threw', { provider: provider.name, error: errorMessage(err) });
    return false;
  }
}

/**
 * Fetch links for a domain from the best configured provider.
 * Provider *failures* still throw so the queue can retry them — a configured-but-broken key is
 * an operational problem, not an empty state.
 */
export async function fetchBacklinks(
  domain: string,
  opts: BacklinkFetchOptions & { provider?: string } = {},
): Promise<BacklinkFetchOutcome> {
  const provider = getBacklinkProvider(opts.provider);
  if (!provider) return unavailable(NO_PROVIDER_REASON);
  const rows = await provider.fetchBacklinks(domain, opts);
  return { available: true, provider: provider.name, rows };
}

export async function fetchReferringDomains(
  domain: string,
  opts: BacklinkFetchOptions & { provider?: string } = {},
): Promise<ReferringDomainOutcome> {
  const provider = getBacklinkProvider(opts.provider);
  if (!provider) return unavailable(NO_PROVIDER_REASON);
  if (!provider.fetchReferringDomains) {
    return unavailable(`${provider.label} does not expose a referring-domain report.`);
  }
  const domains = await provider.fetchReferringDomains(domain, opts);
  return { available: true, provider: provider.name, domains };
}

/**
 * Fetch and persist a website's links in one step — the API-backed twin of
 * `importBacklinksCsv`, sharing its exact write path so both sources produce identical rows.
 */
export async function importProviderBacklinks(
  websiteId: string,
  domain: string,
  opts: BacklinkFetchOptions & { provider?: string } = {},
): Promise<BacklinkImportOutcome> {
  const outcome = await fetchBacklinks(domain, opts);
  if (!outcome.available) return outcome;

  const persisted = await upsertBacklinks(websiteId, outcome.rows);
  log.info('backlinks imported from provider', {
    websiteId,
    provider: outcome.provider,
    fetched: outcome.rows.length,
    inserted: persisted.inserted,
    updated: persisted.updated,
  });
  return {
    available: true,
    provider: outcome.provider,
    fetched: outcome.rows.length,
    inserted: persisted.inserted,
    updated: persisted.updated,
  };
}

/**
 * Links pointing at competitor domains, for gap analysis. Rows keep the competitor URL in
 * `targetUrl` and are never persisted to our own `Backlink` table.
 */
export async function fetchCompetitorBacklinks(
  domains: readonly string[],
  opts: BacklinkFetchOptions & { provider?: string } = {},
): Promise<BacklinkFetchOutcome> {
  const provider = getBacklinkProvider(opts.provider);
  if (!provider) return unavailable(NO_PROVIDER_REASON);
  if (!provider.fetchCompetitorBacklinks) {
    return unavailable(`${provider.label} does not expose a competitor backlink report.`);
  }
  const rows = await provider.fetchCompetitorBacklinks(domains, opts);
  return { available: true, provider: provider.name, rows };
}

/** Integration health rows for the settings screen. Never throws. */
export function backlinkIntegrationHealth(): IntegrationHealth[] {
  return PROVIDERS.map((provider) => {
    const configured = safeIsConfigured(provider);
    return {
      provider: provider.name,
      label: provider.label,
      status: configured ? 'CONNECTED' : 'NOT_CONFIGURED',
      detail: configured
        ? undefined
        : `Set ${provider.requiredEnv.join(' and ')} to fetch backlinks automatically via ${provider.label}. CSV import works without it.`,
      requiredEnv: [...provider.requiredEnv],
    };
  });
}
