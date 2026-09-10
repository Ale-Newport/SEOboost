/**
 * Server → client shapes for the per-site settings screen.
 *
 * Everything crossing this boundary is plain JSON: dates are ISO strings and no Prisma model is
 * passed through wholesale. Two rules hold everywhere in this file:
 *
 *  - **No secret ever appears.** Integrations are described by *whether* a credential is stored
 *    and by the environment variable that would enable the provider — never by a value.
 *  - **Unknown is not zero.** A field the operator has never filled in is `null`, so the form can
 *    say "not set" rather than showing a default that was never chosen.
 */

export type ModelRole = 'reasoning' | 'fast' | 'writing' | 'embedding';

export const MODEL_ROLE_ORDER: readonly ModelRole[] = ['reasoning', 'fast', 'writing', 'embedding'];

export const MODEL_ROLE_COPY: Record<ModelRole, { label: string; description: string }> = {
  reasoning: {
    label: 'Reasoning',
    description: 'Strategy, prioritisation and anything an agent has to think hard about.',
  },
  fast: {
    label: 'Fast',
    description: 'High-volume classification and extraction, where latency and cost dominate.',
  },
  writing: {
    label: 'Writing',
    description: 'Briefs, drafts, titles and meta descriptions — quality of prose matters most.',
  },
  embedding: {
    label: 'Embedding',
    description: 'Vectors for clustering, internal link suggestions and semantic search.',
  },
};

/** The `WebsiteSettings` column each role override is written to. */
export const MODEL_ROLE_COLUMN: Record<ModelRole, 'reasoningModel' | 'fastModel' | 'writingModel' | 'embeddingModel'> = {
  reasoning: 'reasoningModel',
  fast: 'fastModel',
  writing: 'writingModel',
  embedding: 'embeddingModel',
};

export interface SiteProfile {
  id: string;
  name: string;
  domain: string;
  protocol: string;
  status: string;
  description: string | null;
  businessCategory: string | null;
  targetAudience: string | null;
  conversionGoal: string | null;
  brandName: string | null;
  cmsType: string;
  primaryLanguage: string;
  targetLocales: string[];
  targetCountry: string;
}

export interface CrawlerSettings {
  crawlMaxPages: number;
  crawlMaxDepth: number;
  crawlConcurrency: number;
  crawlDelayMs: number;
  crawlUserAgent: string;
  crawlRespectRobots: boolean;
  crawlRenderJs: boolean;
  crawlIncludePatterns: string[];
  crawlExcludePatterns: string[];
  crawlTimeoutMs: number;
}

export interface AiSettings {
  aiProvider: string | null;
  reasoningModel: string | null;
  fastModel: string | null;
  writingModel: string | null;
  embeddingModel: string | null;
  monthlyAiBudgetUsd: number | null;
}

export interface ThresholdSettings {
  thinContentWords: number;
  ctrOpportunityMinImpressions: number;
  strikingDistanceMin: number;
  strikingDistanceMax: number;
}

export interface ModelOption {
  id: string;
  label: string;
  roles: ModelRole[];
}

export interface ProviderOption {
  name: string;
  label: string;
  /** The provider's key is present on this installation. */
  configured: boolean;
  /** Exactly the environment variable that enables it. */
  envVar: string;
  supportsEmbeddings: boolean;
  models: ModelOption[];
  /** Shipped model per role, used when neither this site nor the operator has chosen one. */
  builtIn: Record<ModelRole, string | null>;
}

export interface AiDefaults {
  /** Operator-chosen provider for the whole installation, or null to auto-select. */
  provider: string | null;
  /** Operator-chosen model per role; null means "use the provider's built-in". */
  models: Record<ModelRole, string | null>;
  /** The provider that would actually serve a call right now. */
  effectiveProvider: string | null;
  anyConfigured: boolean;
}

export interface KnowledgeProduct {
  name: string;
  description?: string;
  url?: string;
}

export interface KnowledgeTerm {
  term: string;
  definition: string;
}

export interface KnowledgeAuthor {
  name: string;
  title?: string;
  bio?: string;
  url?: string;
}

export interface KnowledgeBaseData {
  businessDescription: string | null;
  audience: string | null;
  toneOfVoice: string | null;
  brandStyle: string | null;
  preferredCta: string | null;
  writingGuidelines: string | null;
  prohibitedClaims: string[];
  uniqueValueProps: string[];
  products: KnowledgeProduct[];
  terminology: KnowledgeTerm[];
  authorBios: KnowledgeAuthor[];
  /** Nothing has been filled in yet — the content agents have no material to work from. */
  isEmpty: boolean;
  /** Share of the eleven sections that hold something. Counted, never weighted. */
  completeness: number;
}

export interface BrandFactRow {
  id: string;
  fact: string;
  category: string | null;
  source: string;
  sourceUrl: string | null;
  verified: boolean;
  verifiedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface AdapterFieldInfo {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface AdapterInfo {
  provider: string;
  label: string;
  description: string;
  credentialFields: AdapterFieldInfo[];
  configFields: AdapterFieldInfo[];
}

export interface IntegrationRow {
  provider: string;
  label: string;
  status: string;
  /** A credential envelope is stored. The credential itself never leaves the server. */
  hasCredentials: boolean;
  accountEmail: string | null;
  /** Non-secret settings only: property URL, repo, base path. */
  config: Record<string, string>;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastError: string | null;
  expiresAt: string | null;
  /** This installation can support the provider at all. */
  envReady: boolean;
  /** Environment variables an operator must set before it can be connected. */
  requiredEnv: string[];
  canSync: boolean;
  /** OAuth rather than a pasted secret. */
  isOAuth: boolean;
  /** Credential/config field specs, for providers connected with a form. */
  adapter: AdapterInfo | null;
}

export interface SiteSettingsData {
  site: SiteProfile;
  crawler: CrawlerSettings;
  ai: AiSettings;
  thresholds: ThresholdSettings;
  knowledge: KnowledgeBaseData;
  brandFacts: BrandFactRow[];
  brandFactCounts: { total: number; verified: number; unverified: number; expired: number };
  integrations: IntegrationRow[];
  providers: ProviderOption[];
  aiDefaults: AiDefaults;
  /** Autonomy is edited on the Automations screen; shown here read-only for context. */
  autonomyLevel: string;
}

export const WEBSITE_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const;

export const WEBSITE_STATUS_COPY: Record<string, string> = {
  ACTIVE: 'Crawls, syncs and scheduled work run normally.',
  PAUSED: 'Nothing is scheduled and no repeatable job is registered. Data is kept.',
  ARCHIVED: 'Read-only. Kept for the record; nothing runs and it drops out of the portfolio rollups.',
};

export const CMS_TYPES = [
  'UNKNOWN', 'WORDPRESS', 'SHOPIFY', 'WEBFLOW', 'NEXTJS', 'ASTRO', 'HUGO', 'GHOST',
  'SQUARESPACE', 'WIX', 'CUSTOM', 'GIT',
] as const;

export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
};
