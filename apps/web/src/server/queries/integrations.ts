import 'server-only';
import {
  IntegrationProvider,
  IntegrationStatus,
  type Prisma,
  prisma,
  readJson,
} from '@seo/db';
import { type IntegrationHealth, isConfigured } from '@seo/shared';
import {
  GOOGLE_REQUIRED_ENV,
  isGoogleOAuthConfigured,
  readGoogleConfig,
} from '@seo/integrations/google/oauth';
import { getGa4Status } from '@seo/integrations/google/analytics';
import { BING_REQUIRED_ENV, isBingConfigured } from '@seo/integrations/bing/webmaster';
import { serpIntegrationHealth } from '@seo/integrations/serp/registry';
import { backlinkIntegrationHealth } from '@seo/integrations/backlinks/registry';
import {
  type AdapterTypeInfo,
  type ConnectedAdapterSummary,
  getAdapterTypeInfo,
  listAdapterTypes,
  listConnectedAdapters,
} from '@seo/integrations/adapters/registry';

/**
 * Read model for the integrations screen.
 *
 * Two hard rules shape this file:
 *  1. **Credentials never leave the server.** Every query selects columns explicitly and the
 *     `credentials` column is never among them — only `hasCredentials`, derived from a
 *     `select` that reads it and immediately discards it.
 *  2. **Environment availability is separate from per-site connection state.** "Google is not
 *     configured on this installation" and "this site has not connected Google" are different
 *     problems with different fixes, and the UI has to be able to tell them apart.
 */

export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  GOOGLE_SEARCH_CONSOLE: 'Google Search Console',
  GOOGLE_ANALYTICS_4: 'Google Analytics 4',
  BING_WEBMASTER: 'Bing Webmaster Tools',
  WORDPRESS: 'WordPress',
  GIT: 'Git repository',
  WEBHOOK: 'Custom webhook',
  SHOPIFY: 'Shopify',
  WEBFLOW: 'Webflow',
};

/** Providers whose data sync is driven by a queue job. */
export const SYNCABLE_PROVIDERS: IntegrationProvider[] = [
  IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  IntegrationProvider.GOOGLE_ANALYTICS_4,
  IntegrationProvider.BING_WEBMASTER,
];

export interface SiteIntegrationStatus {
  provider: IntegrationProvider;
  label: string;
  /** Row exists and holds an encrypted credential envelope. Never the credential itself. */
  hasCredentials: boolean;
  integrationId: string | null;
  status: IntegrationStatus;
  accountEmail: string | null;
  externalId: string | null;
  /** Non-secret configuration only (property url, repo, base path…). */
  config: Record<string, unknown>;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  expiresAt: Date | null;
  /** True when the installation itself can support this provider at all. */
  envReady: boolean;
  /** Env vars an operator must set before this provider can be connected. */
  requiredEnv: string[];
  canSync: boolean;
}

const INTEGRATION_SELECT = {
  id: true,
  provider: true,
  status: true,
  credentials: true,
  config: true,
  accountEmail: true,
  externalId: true,
  lastSyncAt: true,
  lastSyncStatus: true,
  lastError: true,
  expiresAt: true,
} satisfies Prisma.IntegrationSelect;

/** Which env vars (if any) gate a provider, and whether they are present. */
function envGate(provider: IntegrationProvider): { ready: boolean; requiredEnv: string[] } {
  switch (provider) {
    case IntegrationProvider.GOOGLE_SEARCH_CONSOLE:
    case IntegrationProvider.GOOGLE_ANALYTICS_4:
      return { ready: isGoogleOAuthConfigured(), requiredEnv: [...GOOGLE_REQUIRED_ENV] };
    case IntegrationProvider.BING_WEBMASTER:
      return { ready: isBingConfigured(), requiredEnv: [...BING_REQUIRED_ENV] };
    default:
      // CMS adapters carry their own per-site credentials; nothing is needed in the environment.
      return { ready: true, requiredEnv: [] };
  }
}

/**
 * Per-provider connection state for one website.
 * Every provider in the enum appears, connected or not, so the UI renders a stable list.
 */
export async function getSiteIntegrations(websiteId: string): Promise<SiteIntegrationStatus[]> {
  const rows = await prisma.integration.findMany({
    where: { websiteId },
    select: INTEGRATION_SELECT,
  });
  const byProvider = new Map(rows.map((row) => [row.provider, row]));

  return Object.values(IntegrationProvider).map((provider) => {
    const row = byProvider.get(provider);
    const gate = envGate(provider);
    const hasCredentials = Boolean(row?.credentials);
    const isGoogle =
      provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE ||
      provider === IntegrationProvider.GOOGLE_ANALYTICS_4;

    return {
      provider,
      label: PROVIDER_LABELS[provider],
      hasCredentials,
      integrationId: row?.id ?? null,
      status: row?.status ?? IntegrationStatus.NOT_CONFIGURED,
      accountEmail: row?.accountEmail ?? null,
      externalId: row?.externalId ?? null,
      // Google config is normalised through the package so we cannot accidentally pass a
      // secret that ended up on the config column of an older row.
      config: isGoogle
        ? { ...readGoogleConfig(row?.config) }
        : readJson<Record<string, unknown>>(row?.config, {}),
      lastSyncAt: row?.lastSyncAt ?? null,
      lastSyncStatus: row?.lastSyncStatus ?? null,
      lastError: row?.lastError ?? null,
      expiresAt: row?.expiresAt ?? null,
      envReady: gate.ready,
      requiredEnv: gate.requiredEnv,
      canSync: SYNCABLE_PROVIDERS.includes(provider) && hasCredentials,
    };
  });
}

/**
 * Installation-wide availability, from the environment only.
 * Synchronous checks — no database, no network — so this is safe on every settings render.
 */
export function describeEnvironmentIntegrations(): IntegrationHealth[] {
  const google: IntegrationHealth = {
    provider: 'google',
    label: 'Google OAuth (Search Console + GA4)',
    status: isGoogleOAuthConfigured() ? 'CONNECTED' : 'NOT_CONFIGURED',
    requiredEnv: [...GOOGLE_REQUIRED_ENV],
    ...(isGoogleOAuthConfigured()
      ? {}
      : {
          detail:
            `Set ${GOOGLE_REQUIRED_ENV.join(' and ')} to let sites connect Search Console and GA4.`,
        }),
  };

  const bing: IntegrationHealth = {
    provider: 'bing',
    label: 'Bing Webmaster Tools',
    status: isBingConfigured() ? 'CONNECTED' : 'NOT_CONFIGURED',
    requiredEnv: [...BING_REQUIRED_ENV],
    ...(isBingConfigured() ? {} : { detail: `Set ${BING_REQUIRED_ENV.join(' and ')} to enable Bing data.` }),
  };

  const redis: IntegrationHealth = {
    provider: 'redis',
    label: 'Queue broker (Redis)',
    status: isConfigured.redis() ? 'CONNECTED' : 'NOT_CONFIGURED',
    requiredEnv: ['REDIS_URL'],
    ...(isConfigured.redis()
      ? {}
      : { detail: 'Set REDIS_URL and run the worker; without it, queued jobs are recorded but never run.' }),
  };

  return [google, bing, redis, ...serpIntegrationHealth(), ...backlinkIntegrationHealth()];
}

export interface IntegrationOverview {
  websiteId: string;
  site: SiteIntegrationStatus[];
  environment: IntegrationHealth[];
  /** Static catalogue of CMS adapters plus which ones this site has connected. */
  adapters: { types: AdapterTypeInfo[]; connected: ConnectedAdapterSummary[] };
  /** GA4 needs a selected property on top of the OAuth grant, so it gets its own state. */
  ga4: { connected: boolean; propertyId: string | null; propertyDisplayName: string | null; reason: string | null };
}

/** Everything the integrations screen needs for one website, in one round of queries. */
export async function getIntegrationOverview(websiteId: string): Promise<IntegrationOverview> {
  const [site, connected, ga4Status] = await Promise.all([
    getSiteIntegrations(websiteId),
    listConnectedAdapters(websiteId),
    getGa4Status(websiteId),
  ]);

  return {
    websiteId,
    site,
    environment: describeEnvironmentIntegrations(),
    adapters: { types: listAdapterTypes(), connected },
    ga4: ga4Status.connected
      ? {
          connected: true,
          propertyId: ga4Status.propertyId,
          propertyDisplayName: ga4Status.propertyDisplayName,
          reason: null,
        }
      : { connected: false, propertyId: null, propertyDisplayName: null, reason: ga4Status.reason },
  };
}

/** The adapter catalogue entry for a provider, or null when the provider is not adapter-backed. */
export function adapterInfoFor(provider: IntegrationProvider): AdapterTypeInfo | null {
  return getAdapterTypeInfo(provider);
}
