import { createLogger, errorMessage } from '@seo/shared';
import { tryDecryptJson } from '@seo/shared/crypto';
import { prisma, readJson, CmsType, IntegrationProvider, IntegrationStatus } from '@seo/db';
import type { Prisma } from '@seo/db';
import {
  GIT_CAPABILITIES,
  GIT_CONFIG_FIELDS,
  GIT_CREDENTIAL_FIELDS,
  createGitAdapter,
  parseGitConfig,
  parseGitCredentials,
} from './git';
import {
  SHOPIFY_CAPABILITIES,
  SHOPIFY_CONFIG_FIELDS,
  SHOPIFY_CREDENTIAL_FIELDS,
  createShopifyAdapter,
  parseShopifyConfig,
  parseShopifyCredentials,
} from './shopify';
import {
  WEBFLOW_CAPABILITIES,
  WEBFLOW_CONFIG_FIELDS,
  WEBFLOW_CREDENTIAL_FIELDS,
  createWebflowAdapter,
  parseWebflowConfig,
  parseWebflowCredentials,
} from './webflow';
import {
  WEBHOOK_CAPABILITIES,
  WEBHOOK_CONFIG_FIELDS,
  WEBHOOK_CREDENTIAL_FIELDS,
  createWebhookAdapter,
  parseWebhookConfig,
  parseWebhookCredentials,
} from './webhook';
import {
  WORDPRESS_CAPABILITIES,
  WORDPRESS_CONFIG_FIELDS,
  WORDPRESS_CREDENTIAL_FIELDS,
  createWordPressAdapter,
  parseWordPressConfig,
  parseWordPressCredentials,
} from './wordpress';
import { siteUrlFor, type AdapterCapabilities, type AdapterFieldSpec, type AdapterSiteContext, type WebsiteAdapter } from './types';

/**
 * Turns a Website row plus its stored Integration into a live adapter.
 *
 * Every failure path is a *value*, never an exception: a site with no CMS connected is the
 * normal state for a fresh account, and the executor, the settings screen and the agents
 * all need to render "not connected" rather than crash. The only thing that throws here is
 * a genuine database error.
 *
 * Credentials are decrypted in memory and handed straight to the adapter. Nothing in this
 * module returns them, and `describeIntegration` deliberately exposes only non-secret config.
 */

const log = createLogger('adapters:registry');

export type AdapterId = 'wordpress' | 'git' | 'webhook' | 'shopify' | 'webflow';

/** Providers backed by a website adapter, in fallback preference order. */
export const ADAPTER_PROVIDERS = [
  IntegrationProvider.WORDPRESS,
  IntegrationProvider.SHOPIFY,
  IntegrationProvider.WEBFLOW,
  IntegrationProvider.GIT,
  // Last: a webhook can carry any change but can never read the site back.
  IntegrationProvider.WEBHOOK,
] as const;

export type AdapterProvider = (typeof ADAPTER_PROVIDERS)[number];

export function isAdapterProvider(provider: IntegrationProvider): provider is AdapterProvider {
  return (ADAPTER_PROVIDERS as readonly IntegrationProvider[]).includes(provider);
}

/** Everything the settings UI needs to render a connect form for one adapter. */
export interface AdapterTypeInfo {
  id: AdapterId;
  provider: AdapterProvider;
  label: string;
  description: string;
  capabilities: AdapterCapabilities;
  /** Secret fields — encrypted into Integration.credentials, never read back to a client. */
  credentialFields: AdapterFieldSpec[];
  /** Non-secret fields — stored as-is on Integration.config. */
  configFields: AdapterFieldSpec[];
}

const ADAPTER_TYPES: readonly AdapterTypeInfo[] = [
  {
    id: 'wordpress',
    provider: IntegrationProvider.WORDPRESS,
    label: 'WordPress',
    description:
      'Edits posts and pages over the WordPress REST API using an application password. SEO metadata is written through Yoast or Rank Math when installed.',
    capabilities: WORDPRESS_CAPABILITIES,
    credentialFields: WORDPRESS_CREDENTIAL_FIELDS,
    configFields: WORDPRESS_CONFIG_FIELDS,
  },
  {
    id: 'shopify',
    provider: IntegrationProvider.SHOPIFY,
    label: 'Shopify',
    description:
      'Edits blog articles and pages through the Shopify Admin API. SEO title and description are stored in the global.title_tag / global.description_tag metafields.',
    capabilities: SHOPIFY_CAPABILITIES,
    credentialFields: SHOPIFY_CREDENTIAL_FIELDS,
    configFields: SHOPIFY_CONFIG_FIELDS,
  },
  {
    id: 'webflow',
    provider: IntegrationProvider.WEBFLOW,
    label: 'Webflow',
    description:
      'Edits CMS collection items through the Webflow Data API v2. Metadata is written to the collection fields bound to page SEO in the Designer.',
    capabilities: WEBFLOW_CAPABILITIES,
    credentialFields: WEBFLOW_CREDENTIAL_FIELDS,
    configFields: WEBFLOW_CONFIG_FIELDS,
  },
  {
    id: 'git',
    provider: IntegrationProvider.GIT,
    label: 'Git repository (GitHub)',
    description:
      'Edits Markdown/MDX content in a GitHub repository. Changes are delivered as pull requests by default so a human still merges them.',
    capabilities: GIT_CAPABILITIES,
    credentialFields: GIT_CREDENTIAL_FIELDS,
    configFields: GIT_CONFIG_FIELDS,
  },
  {
    id: 'webhook',
    provider: IntegrationProvider.WEBHOOK,
    label: 'Custom webhook',
    description:
      'Sends every approved change as a signed JSON POST to your own endpoint. Write-only: SEO OS cannot read the site back, so changes are recorded without a before-snapshot.',
    capabilities: WEBHOOK_CAPABILITIES,
    credentialFields: WEBHOOK_CREDENTIAL_FIELDS,
    configFields: WEBHOOK_CONFIG_FIELDS,
  },
];

/** Static catalogue for the settings screen. Env-free and database-free by design. */
export function listAdapterTypes(): AdapterTypeInfo[] {
  return ADAPTER_TYPES.map((type) => ({
    ...type,
    capabilities: { ...type.capabilities },
    credentialFields: type.credentialFields.map((f) => ({ ...f })),
    configFields: type.configFields.map((f) => ({ ...f })),
  }));
}

export function getAdapterTypeInfo(provider: IntegrationProvider): AdapterTypeInfo | null {
  return ADAPTER_TYPES.find((t) => t.provider === provider) ?? null;
}

// ── resolution ────────────────────────────────────────────────────────────────

export type AdapterResolutionCode =
  | 'WEBSITE_NOT_FOUND'
  | 'NO_INTEGRATION'
  | 'DISABLED'
  | 'MISSING_CREDENTIALS'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_CONFIG';

export interface ResolvedAdapter {
  adapter: WebsiteAdapter;
  integrationId: string;
  provider: AdapterProvider;
  site: AdapterSiteContext;
}

export interface UnresolvedAdapter {
  adapter: null;
  code: AdapterResolutionCode;
  /** Operator-facing sentence explaining what to connect or fix. */
  reason: string;
  /** The provider we tried, when the failure was specific to one. */
  provider?: AdapterProvider;
  integrationId?: string;
}

export type AdapterResolution = ResolvedAdapter | UnresolvedAdapter;

export interface GetAdapterOptions {
  /** Force one provider instead of picking the site's best connected one. */
  provider?: IntegrationProvider;
}

interface IntegrationRow {
  id: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  credentials: string | null;
  config: Prisma.JsonValue | null;
}

/**
 * The adapter for a website, or a typed reason there is none.
 *
 * When several CMSes are connected the one matching `Website.cmsType` wins, then
 * `ADAPTER_PROVIDERS` order — so a site that has both a real CMS and a fallback webhook
 * uses the CMS, which is the only one that can read state back for rollback.
 */
export async function getAdapterForWebsite(
  websiteId: string,
  opts: GetAdapterOptions = {},
): Promise<AdapterResolution> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: {
      id: true,
      domain: true,
      protocol: true,
      cmsType: true,
      integrations: {
        where: { provider: { in: [...ADAPTER_PROVIDERS] } },
        select: { id: true, provider: true, status: true, credentials: true, config: true },
      },
    },
  });

  if (!website) {
    return { adapter: null, code: 'WEBSITE_NOT_FOUND', reason: `No website exists with id ${websiteId}.` };
  }

  const site: AdapterSiteContext = {
    websiteId: website.id,
    domain: website.domain,
    protocol: website.protocol,
    siteUrl: siteUrlFor(website.domain, website.protocol),
  };

  const rows: IntegrationRow[] = website.integrations;
  const candidates = opts.provider ? rows.filter((r) => r.provider === opts.provider) : rows;

  if (!candidates.length) {
    return {
      adapter: null,
      code: 'NO_INTEGRATION',
      reason: opts.provider
        ? `This website has no ${labelFor(opts.provider)} integration. Connect it in Settings → Integrations.`
        : 'No publishing integration is connected for this website. Connect WordPress, Shopify, Webflow, a git repository or a webhook in Settings → Integrations to let SEO OS apply changes.',
      ...(opts.provider && isAdapterProvider(opts.provider) ? { provider: opts.provider } : {}),
    };
  }

  const usable = candidates.filter((r) => r.status !== IntegrationStatus.DISABLED);
  if (!usable.length) {
    const first = candidates[0] as IntegrationRow;
    return {
      adapter: null,
      code: 'DISABLED',
      reason: `The ${labelFor(first.provider)} integration for this website is disabled. Re-enable it in Settings → Integrations.`,
      provider: isAdapterProvider(first.provider) ? first.provider : undefined,
      integrationId: first.id,
    };
  }

  const chosen = pickIntegration(usable, website.cmsType);
  if (!chosen || !isAdapterProvider(chosen.provider)) {
    return {
      adapter: null,
      code: 'NO_INTEGRATION',
      reason: 'No connected integration on this website is backed by a website adapter.',
    };
  }

  return buildAdapter(chosen, chosen.provider, site);
}

/** Instantiate one integration row. Split out so `testAdapter` and the executor share the parsing. */
function buildAdapter(row: IntegrationRow, provider: AdapterProvider, site: AdapterSiteContext): AdapterResolution {
  if (!row.credentials) {
    return {
      adapter: null,
      code: 'MISSING_CREDENTIALS',
      reason: `The ${labelFor(provider)} integration has no stored credentials. Reconnect it in Settings → Integrations.`,
      provider,
      integrationId: row.id,
    };
  }

  const secrets = tryDecryptJson<unknown>(row.credentials);
  if (secrets === null) {
    return {
      adapter: null,
      code: 'INVALID_CREDENTIALS',
      reason: `The stored ${labelFor(provider)} credentials could not be decrypted — usually a changed ENCRYPTION_KEY. Reconnect the integration to store them again.`,
      provider,
      integrationId: row.id,
    };
  }

  const config = readJson<Record<string, unknown>>(row.config, {});
  const invalid = (what: string): UnresolvedAdapter => ({
    adapter: null,
    code: 'INVALID_CONFIG',
    reason: `The ${labelFor(provider)} integration is missing required settings (${what}). Reconnect it in Settings → Integrations.`,
    provider,
    integrationId: row.id,
  });
  const badCredentials = (what: string): UnresolvedAdapter => ({
    adapter: null,
    code: 'INVALID_CREDENTIALS',
    reason: `The stored ${labelFor(provider)} credentials are incomplete (${what}). Reconnect the integration.`,
    provider,
    integrationId: row.id,
  });

  try {
    switch (provider) {
      case IntegrationProvider.WORDPRESS: {
        const credentials = parseWordPressCredentials(secrets);
        if (!credentials) return badCredentials('username and application password');
        return {
          adapter: createWordPressAdapter({ credentials, config: parseWordPressConfig(config), site }),
          integrationId: row.id,
          provider,
          site,
        };
      }
      case IntegrationProvider.SHOPIFY: {
        const credentials = parseShopifyCredentials(secrets);
        if (!credentials) return badCredentials('Admin API access token');
        const parsed = parseShopifyConfig(config);
        if (!parsed) return invalid('shop domain');
        return { adapter: createShopifyAdapter({ credentials, config: parsed, site }), integrationId: row.id, provider, site };
      }
      case IntegrationProvider.WEBFLOW: {
        const credentials = parseWebflowCredentials(secrets);
        if (!credentials) return badCredentials('API token');
        const parsed = parseWebflowConfig(config);
        if (!parsed) return invalid('site id');
        return { adapter: createWebflowAdapter({ credentials, config: parsed, site }), integrationId: row.id, provider, site };
      }
      case IntegrationProvider.GIT: {
        const credentials = parseGitCredentials(secrets);
        if (!credentials) return badCredentials('GitHub token');
        const parsed = parseGitConfig(config);
        if (!parsed) return invalid('owner, repo and content directory');
        return { adapter: createGitAdapter({ credentials, config: parsed }), integrationId: row.id, provider, site };
      }
      case IntegrationProvider.WEBHOOK: {
        const credentials = parseWebhookCredentials(secrets);
        if (!credentials) return badCredentials('signing secret');
        const parsed = parseWebhookConfig(config);
        if (!parsed) return invalid('endpoint URL');
        return { adapter: createWebhookAdapter({ credentials, config: parsed, site }), integrationId: row.id, provider, site };
      }
      default:
        return {
          adapter: null,
          code: 'NO_INTEGRATION',
          reason: `${provider} has no website adapter.`,
        };
    }
  } catch (err) {
    // Constructors only do string work, but a malformed stored value must not take the
    // caller down — it becomes a "reconnect this integration" message instead.
    log.warn('adapter construction failed', { provider, integrationId: row.id, error: errorMessage(err) });
    return {
      adapter: null,
      code: 'INVALID_CONFIG',
      reason: `The ${labelFor(provider)} integration could not be initialised: ${errorMessage(err)}. Reconnect it in Settings → Integrations.`,
      provider,
      integrationId: row.id,
    };
  }
}

/** cmsType first (the site told us what it runs), then the static preference order. */
function pickIntegration(rows: IntegrationRow[], cmsType: CmsType): IntegrationRow | null {
  const preferred = PROVIDER_FOR_CMS[cmsType];
  if (preferred) {
    const match = rows.find((r) => r.provider === preferred);
    if (match) return match;
  }
  for (const provider of ADAPTER_PROVIDERS) {
    const match = rows.find((r) => r.provider === provider);
    if (match) return match;
  }
  return rows[0] ?? null;
}

const PROVIDER_FOR_CMS: Partial<Record<CmsType, AdapterProvider>> = {
  [CmsType.WORDPRESS]: IntegrationProvider.WORDPRESS,
  [CmsType.SHOPIFY]: IntegrationProvider.SHOPIFY,
  [CmsType.WEBFLOW]: IntegrationProvider.WEBFLOW,
  // Static-site frameworks are all edited the same way: Markdown in a repository.
  [CmsType.NEXTJS]: IntegrationProvider.GIT,
  [CmsType.ASTRO]: IntegrationProvider.GIT,
  [CmsType.HUGO]: IntegrationProvider.GIT,
  [CmsType.GIT]: IntegrationProvider.GIT,
};

function labelFor(provider: IntegrationProvider): string {
  return ADAPTER_TYPES.find((t) => t.provider === provider)?.label ?? provider;
}

// ── connection test ───────────────────────────────────────────────────────────

export interface AdapterTestResult {
  ok: boolean;
  provider?: AdapterProvider;
  adapter?: AdapterId;
  /** Human-readable success detail, from the adapter's own testConnection. */
  detail?: string;
  error?: string;
  warnings: string[];
  capabilities?: AdapterCapabilities;
}

/**
 * Run the adapter's authenticated round-trip and record the outcome on the Integration row,
 * so the settings screen shows the same status the executor would hit. Never throws for a
 * failed connection — only a database error propagates.
 */
export async function testAdapter(websiteId: string, opts: GetAdapterOptions = {}): Promise<AdapterTestResult> {
  const resolution = await getAdapterForWebsite(websiteId, opts);
  if (!resolution.adapter) {
    const status = statusForResolution(resolution.code);
    if (resolution.integrationId && status) {
      await markIntegration(resolution.integrationId, status, resolution.reason);
    }
    return { ok: false, error: resolution.reason, provider: resolution.provider, warnings: [] };
  }

  const result = await resolution.adapter.testConnection();
  const warnings = result.warnings ?? [];

  if (!result.ok) {
    await markIntegration(resolution.integrationId, statusForFailure(result.errorCode), result.error);
    return {
      ok: false,
      provider: resolution.provider,
      adapter: getAdapterTypeInfo(resolution.provider)?.id,
      error: result.error,
      warnings,
      capabilities: resolution.adapter.capabilities,
    };
  }

  await markIntegration(resolution.integrationId, IntegrationStatus.CONNECTED, null);
  return {
    ok: true,
    provider: resolution.provider,
    adapter: getAdapterTypeInfo(resolution.provider)?.id,
    detail: result.data.detail,
    warnings,
    capabilities: resolution.adapter.capabilities,
  };
}

/** An expired/revoked credential is a distinct state from a broken endpoint in the UI. */
function statusForFailure(code: string): IntegrationStatus {
  return code === 'UNAUTHORIZED' ? IntegrationStatus.EXPIRED : IntegrationStatus.ERROR;
}

/**
 * Status to store when the adapter could not even be built, or `null` to leave the row alone.
 *
 * `DISABLED` returns null on purpose: overwriting it with ERROR would erase the operator's
 * own decision, and since `getAdapterForWebsite` only skips rows whose status is DISABLED,
 * a connection test would silently re-enable an integration somebody deliberately turned off.
 */
function statusForResolution(code: AdapterResolutionCode): IntegrationStatus | null {
  switch (code) {
    case 'MISSING_CREDENTIALS':
      return IntegrationStatus.NOT_CONFIGURED;
    case 'INVALID_CREDENTIALS':
      // Undecryptable or incomplete secrets need the same "reconnect it" affordance as a
      // revoked token, which is what EXPIRED renders as.
      return IntegrationStatus.EXPIRED;
    case 'INVALID_CONFIG':
      return IntegrationStatus.ERROR;
    case 'DISABLED':
    case 'NO_INTEGRATION':
    case 'WEBSITE_NOT_FOUND':
      return null;
  }
}

async function markIntegration(
  integrationId: string,
  status: IntegrationStatus,
  error: string | null,
): Promise<void> {
  try {
    await prisma.integration.update({
      where: { id: integrationId },
      data: {
        status,
        lastError: error,
        lastSyncAt: new Date(),
        lastSyncStatus: error ? 'ERROR' : 'OK',
      },
    });
  } catch (err) {
    // A status write must never mask the real test result the caller is waiting for.
    log.warn('could not record integration status', { integrationId, error: errorMessage(err) });
  }
}

// ── description ───────────────────────────────────────────────────────────────

export interface ConnectedAdapterSummary {
  provider: AdapterProvider;
  adapter: AdapterId;
  label: string;
  integrationId: string;
  status: IntegrationStatus;
  capabilities: AdapterCapabilities;
}

/**
 * Non-secret summary of every adapter-backed integration on a website, for the settings
 * screen. Credentials are never touched here, only their presence.
 */
export async function listConnectedAdapters(websiteId: string): Promise<ConnectedAdapterSummary[]> {
  const rows = await prisma.integration.findMany({
    where: { websiteId, provider: { in: [...ADAPTER_PROVIDERS] } },
    select: { id: true, provider: true, status: true, credentials: true },
  });

  const out: ConnectedAdapterSummary[] = [];
  for (const row of rows) {
    if (!isAdapterProvider(row.provider)) continue;
    const info = getAdapterTypeInfo(row.provider);
    if (!info) continue;
    out.push({
      provider: row.provider,
      adapter: info.id,
      label: info.label,
      integrationId: row.id,
      // A row with no credentials is "not configured" whatever the stored status says.
      status: row.credentials ? row.status : IntegrationStatus.NOT_CONFIGURED,
      capabilities: info.capabilities,
    });
  }
  return out;
}
