import 'server-only';
import { IntegrationProvider, getAppSetting, prisma, readJson } from '@seo/db';
import { ForbiddenError, NotFoundError } from '@seo/shared';
import {
  APP_SETTING_KEYS,
  APP_SETTING_PROVIDER_KEY,
  DEFAULT_MODELS,
  getAvailableProviders,
  isAiAvailable,
} from '@seo/ai';
import { adapterInfoFor, getSiteIntegrations } from '@/server/queries/integrations';
import {
  MODEL_ROLE_ORDER,
  PROVIDER_LABELS,
  type AdapterInfo,
  type AiDefaults,
  type BrandFactRow,
  type IntegrationRow,
  type KnowledgeAuthor,
  type KnowledgeBaseData,
  type KnowledgeProduct,
  type KnowledgeTerm,
  type ModelOption,
  type ModelRole,
  type ProviderOption,
  type SiteSettingsData,
} from '@/components/site-settings/types';

/**
 * Read model for the per-site Settings screen.
 *
 * It reads six unrelated things in one round of queries because the screen is one page of tabs
 * and a tab that fetched on open would make switching tabs feel like navigation. Credentials are
 * never selected: integration state comes from `getSiteIntegrations`, which reduces the encrypted
 * envelope to a boolean before it leaves the server.
 */

const GOOGLE_PROVIDERS: string[] = [
  IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  IntegrationProvider.GOOGLE_ANALYTICS_4,
];

/** Only string-ish config values reach the client; anything else is provider internals. */
function readableConfig(config: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === 'string' && value.length > 0) out[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value);
  }
  return out;
}

function toAdapterInfo(provider: IntegrationProvider): AdapterInfo | null {
  const info = adapterInfoFor(provider);
  if (!info) return null;
  return {
    provider,
    label: info.label,
    description: info.description,
    credentialFields: info.credentialFields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      secret: field.secret,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.help ? { help: field.help } : {}),
    })),
    configFields: info.configFields.map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required,
      secret: field.secret,
      ...(field.placeholder ? { placeholder: field.placeholder } : {}),
      ...(field.help ? { help: field.help } : {}),
    })),
  };
}

/** Counted, not weighted: how many of the eleven knowledge sections hold anything. */
function knowledgeCompleteness(sections: readonly boolean[]): number {
  return Math.round((sections.filter(Boolean).length / sections.length) * 100);
}

export async function getSiteSettings(userId: string, websiteId: string): Promise<SiteSettingsData> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: {
      id: true,
      userId: true,
      name: true,
      domain: true,
      protocol: true,
      status: true,
      description: true,
      businessCategory: true,
      targetAudience: true,
      conversionGoal: true,
      brandName: true,
      cmsType: true,
      primaryLanguage: true,
      targetLocales: true,
      targetCountry: true,
    },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const [settings, knowledge, brandFacts, brandFactCounts, integrations, defaultProvider, defaultModels] =
    await Promise.all([
      // A site restored from an older export may have no settings row; the defaults in the schema
      // are the shipped behaviour, so creating it is safe rather than inventing values.
      prisma.websiteSettings.upsert({
        where: { websiteId: website.id },
        create: { websiteId: website.id },
        update: {},
      }),
      prisma.knowledgeBase.findUnique({ where: { websiteId: website.id } }),
      prisma.brandFact.findMany({
        where: { websiteId: website.id },
        orderBy: [{ verified: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      }),
      prisma.brandFact.groupBy({
        by: ['verified'],
        where: { websiteId: website.id },
        _count: { _all: true },
      }),
      getSiteIntegrations(website.id),
      getAppSetting<string | null>(APP_SETTING_PROVIDER_KEY, null),
      Promise.all(
        MODEL_ROLE_ORDER.map((role) => getAppSetting<string | null>(APP_SETTING_KEYS[role], null)),
      ),
    ]);

  const expired = await prisma.brandFact.count({
    where: { websiteId: website.id, expiresAt: { lte: new Date() } },
  });

  const products = readJson<KnowledgeProduct[]>(knowledge?.products, []);
  const terminology = readJson<KnowledgeTerm[]>(knowledge?.terminology, []);
  const authorBios = readJson<KnowledgeAuthor[]>(knowledge?.authorBios, []);

  const knowledgeSections = [
    Boolean(knowledge?.businessDescription),
    Boolean(knowledge?.audience),
    Boolean(knowledge?.toneOfVoice),
    Boolean(knowledge?.brandStyle),
    Boolean(knowledge?.preferredCta),
    Boolean(knowledge?.writingGuidelines),
    (knowledge?.uniqueValueProps.length ?? 0) > 0,
    (knowledge?.prohibitedClaims.length ?? 0) > 0,
    products.length > 0,
    terminology.length > 0,
    authorBios.length > 0,
  ];

  const knowledgeData: KnowledgeBaseData = {
    businessDescription: knowledge?.businessDescription ?? null,
    audience: knowledge?.audience ?? null,
    toneOfVoice: knowledge?.toneOfVoice ?? null,
    brandStyle: knowledge?.brandStyle ?? null,
    preferredCta: knowledge?.preferredCta ?? null,
    writingGuidelines: knowledge?.writingGuidelines ?? null,
    prohibitedClaims: knowledge?.prohibitedClaims ?? [],
    uniqueValueProps: knowledge?.uniqueValueProps ?? [],
    products,
    terminology,
    authorBios,
    isEmpty: knowledgeSections.every((filled) => !filled),
    completeness: knowledgeCompleteness(knowledgeSections),
  };

  const verifiedCount = brandFactCounts.find((row) => row.verified)?._count._all ?? 0;
  const unverifiedCount = brandFactCounts.find((row) => !row.verified)?._count._all ?? 0;

  const facts: BrandFactRow[] = brandFacts.map((fact) => ({
    id: fact.id,
    fact: fact.fact,
    category: fact.category,
    source: fact.source,
    sourceUrl: fact.sourceUrl,
    verified: fact.verified,
    verifiedAt: fact.verifiedAt?.toISOString() ?? null,
    expiresAt: fact.expiresAt?.toISOString() ?? null,
    createdAt: fact.createdAt.toISOString(),
  }));

  const integrationRows: IntegrationRow[] = integrations.map((row) => ({
    provider: row.provider,
    label: row.label,
    status: row.status,
    hasCredentials: row.hasCredentials,
    accountEmail: row.accountEmail,
    config: readableConfig(row.config),
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus: row.lastSyncStatus,
    lastError: row.lastError,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    envReady: row.envReady,
    requiredEnv: row.requiredEnv,
    canSync: row.canSync,
    isOAuth: GOOGLE_PROVIDERS.includes(row.provider),
    adapter: toAdapterInfo(row.provider),
  }));

  const providers: ProviderOption[] = getAvailableProviders().map((provider) => {
    const models: ModelOption[] = provider.models.map((model) => ({
      id: model.id,
      label: model.label,
      roles: model.roles as ModelRole[],
    }));
    return {
      name: provider.name,
      label: PROVIDER_LABELS[provider.name] ?? provider.name,
      configured: provider.configured,
      envVar: provider.envVar,
      supportsEmbeddings: provider.supportsEmbeddings,
      models,
      builtIn: DEFAULT_MODELS[provider.name],
    };
  });

  const models: Record<ModelRole, string | null> = {
    reasoning: defaultModels[0] ?? null,
    fast: defaultModels[1] ?? null,
    writing: defaultModels[2] ?? null,
    embedding: defaultModels[3] ?? null,
  };

  // The provider that would actually serve a call: the site's choice if its key is present,
  // otherwise the operator's default, otherwise the first configured one. Resolved here rather
  // than by calling `getProvider`, which throws when nothing is configured.
  const preferred = settings.aiProvider ?? defaultProvider ?? null;
  const effectiveProvider =
    providers.find((provider) => provider.name === preferred && provider.configured)?.name ??
    providers.find((provider) => provider.configured)?.name ??
    null;

  const aiDefaults: AiDefaults = {
    provider: defaultProvider,
    models,
    effectiveProvider,
    anyConfigured: isAiAvailable(),
  };

  return {
    site: {
      id: website.id,
      name: website.name,
      domain: website.domain,
      protocol: website.protocol,
      status: website.status,
      description: website.description,
      businessCategory: website.businessCategory,
      targetAudience: website.targetAudience,
      conversionGoal: website.conversionGoal,
      brandName: website.brandName,
      cmsType: website.cmsType,
      primaryLanguage: website.primaryLanguage,
      targetLocales: website.targetLocales,
      targetCountry: website.targetCountry,
    },
    crawler: {
      crawlMaxPages: settings.crawlMaxPages,
      crawlMaxDepth: settings.crawlMaxDepth,
      crawlConcurrency: settings.crawlConcurrency,
      crawlDelayMs: settings.crawlDelayMs,
      crawlUserAgent: settings.crawlUserAgent,
      crawlRespectRobots: settings.crawlRespectRobots,
      crawlRenderJs: settings.crawlRenderJs,
      crawlIncludePatterns: settings.crawlIncludePatterns,
      crawlExcludePatterns: settings.crawlExcludePatterns,
      crawlTimeoutMs: settings.crawlTimeoutMs,
    },
    ai: {
      aiProvider: settings.aiProvider,
      reasoningModel: settings.reasoningModel,
      fastModel: settings.fastModel,
      writingModel: settings.writingModel,
      embeddingModel: settings.embeddingModel,
      monthlyAiBudgetUsd: settings.monthlyAiBudgetUsd,
    },
    thresholds: {
      thinContentWords: settings.thinContentWords,
      ctrOpportunityMinImpressions: settings.ctrOpportunityMinImpressions,
      strikingDistanceMin: settings.strikingDistanceMin,
      strikingDistanceMax: settings.strikingDistanceMax,
    },
    knowledge: knowledgeData,
    brandFacts: facts,
    brandFactCounts: {
      total: verifiedCount + unverifiedCount,
      verified: verifiedCount,
      unverified: unverifiedCount,
      expired,
    },
    integrations: integrationRows,
    providers,
    aiDefaults,
    autonomyLevel: settings.autonomyLevel,
  };
}
