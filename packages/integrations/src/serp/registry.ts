/**
 * SERP provider registry.
 *
 * ## Degradation contract
 * A SERP provider is **optional**. With none configured the platform stays fully usable:
 * keyword discovery, rankings and CTR analysis all run from Search Console (and Bing, if
 * connected), which report our own positions without any third-party SERP call. What is
 * skipped is only what genuinely needs a live SERP: SERP snapshots and SERP features,
 * competitor discovery from result pages, and unlinked-brand-mention checks. Every entry
 * point here therefore returns a typed `{ available: false }` result instead of throwing,
 * so callers render an empty state with a "connect a SERP provider" hint.
 */

import { createLogger, errorMessage } from '@seo/shared';
import type { IntegrationHealth } from '@seo/shared';
import { dataForSeoProvider } from './providers/dataforseo';
import { serpApiProvider } from './providers/serpapi';
import { serperProvider } from './providers/serper';
import type {
  SerpKeywordMetric,
  SerpKeywordMetricsOptions,
  SerpProvider,
  SerpResponse,
  SerpSearchOptions,
} from './types';

const log = createLogger('serp:registry');

/**
 * Preference order. DataForSEO first because it is the only one that also returns search
 * volume/CPC (one subscription covers both jobs), then Serper (cheapest per SERP call),
 * then SerpApi.
 */
const PROVIDERS: readonly SerpProvider[] = [dataForSeoProvider, serperProvider, serpApiProvider];

export interface SerpProviderInfo {
  name: string;
  label: string;
  configured: boolean;
  requiredEnv: string[];
  /** True when the provider can also return search volume / CPC / competition. */
  supportsKeywordMetrics: boolean;
}

export type SerpUnavailable = {
  available: false;
  reason: string;
  /** Any one of these providers' env sets enables SERP features. */
  requiredEnv: string[];
};

export type SerpSearchOutcome = { available: true; response: SerpResponse } | SerpUnavailable;

export type SerpKeywordMetricsOutcome =
  | { available: true; provider: string; metrics: SerpKeywordMetric[] }
  | SerpUnavailable;

function unavailable(reason: string): SerpUnavailable {
  return {
    available: false,
    reason,
    requiredEnv: PROVIDERS.flatMap((p) => [...p.requiredEnv]),
  };
}

/** Every known provider and whether its keys are present — drives the settings UI. */
export function listSerpProviders(): SerpProviderInfo[] {
  return PROVIDERS.map((provider) => ({
    name: provider.name,
    label: provider.label,
    configured: provider.isConfigured(),
    requiredEnv: [...provider.requiredEnv],
    supportsKeywordMetrics: typeof provider.keywordMetrics === 'function',
  }));
}

/**
 * The provider to use, or null when none is configured.
 * `preferred` (a provider name) wins when that provider is configured; otherwise the first
 * configured provider in preference order is returned.
 */
export function getSerpProvider(preferred?: string): SerpProvider | null {
  if (preferred) {
    const match = PROVIDERS.find((p) => p.name === preferred && p.isConfigured());
    if (match) return match;
  }
  return PROVIDERS.find((p) => p.isConfigured()) ?? null;
}

export function isSerpAvailable(): boolean {
  return PROVIDERS.some((p) => p.isConfigured());
}

/** The first configured provider that can also return keyword volume metrics. */
export function getKeywordMetricsProvider(): SerpProvider | null {
  return PROVIDERS.find((p) => p.isConfigured() && typeof p.keywordMetrics === 'function') ?? null;
}

/**
 * Run a SERP query, degrading to `{ available: false }` when no provider is configured.
 * Provider *failures* (network, quota, bad key) still throw so the queue can retry them —
 * a configured-but-broken provider is an operational problem, not an empty state.
 */
export async function searchSerp(
  query: string,
  opts: SerpSearchOptions & { provider?: string } = {},
): Promise<SerpSearchOutcome> {
  const provider = getSerpProvider(opts.provider);
  if (!provider) {
    return unavailable(
      'No SERP provider is configured. Search Console data still powers keywords and rankings.',
    );
  }
  const response = await provider.search(query, opts);
  return { available: true, response };
}

/**
 * Same contract as `searchSerp`, but for search-volume style metrics. Providers without a
 * keyword product are skipped rather than treated as an error.
 */
export async function serpKeywordMetrics(
  keywords: string[],
  opts: SerpKeywordMetricsOptions = {},
): Promise<SerpKeywordMetricsOutcome> {
  const provider = getKeywordMetricsProvider();
  if (!provider?.keywordMetrics) {
    return unavailable(
      'No keyword-metrics provider is configured. Volume and CPC stay empty; Search Console still supplies clicks, impressions and position.',
    );
  }
  const metrics = await provider.keywordMetrics(keywords, opts);
  return { available: true, provider: provider.name, metrics };
}

/** Integration health rows for the settings screen. Never throws. */
export function serpIntegrationHealth(): IntegrationHealth[] {
  return PROVIDERS.map((provider) => {
    let configured = false;
    let detail: string | undefined;
    try {
      configured = provider.isConfigured();
    } catch (err) {
      // isConfigured only reads env, but never let a settings page fail because of it.
      detail = errorMessage(err);
      log.warn('provider isConfigured threw', { provider: provider.name, detail });
    }
    return {
      provider: provider.name,
      label: provider.label,
      status: configured ? 'CONNECTED' : 'NOT_CONFIGURED',
      detail:
        detail ??
        (configured
          ? undefined
          : `Set ${provider.requiredEnv.join(' and ')} to enable SERP features via ${provider.label}.`),
      requiredEnv: [...provider.requiredEnv],
    };
  });
}
