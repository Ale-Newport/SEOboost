import { getAppSetting } from '@seo/db';
import {
  IntegrationNotConfiguredError,
  ValidationError,
  createLogger,
  env,
} from '@seo/shared';
import { PRICING } from './pricing';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { OpenAIProvider } from './providers/openai';
import { PROVIDER_ORDER, isProviderName } from './types';
import type { AIProvider, ModelRole, ProviderAvailability, ProviderName } from './types';

const log = createLogger('ai:registry');

/**
 * Provider registry + model routing.
 *
 * Everything that needs a model asks here rather than naming a vendor or a model id inline,
 * so an operator can re-route the whole platform from Settings (or a single site) without a
 * code change, and so an install with only one key still works.
 */

/**
 * Adapters are cheap to construct (each builds its SDK client lazily on first call), so the
 * three singletons exist even on an install with no keys at all.
 */
const PROVIDERS: Record<ProviderName, AIProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
  gemini: new GeminiProvider(),
};

/** Env var an operator must set to light up each provider — surfaced in the settings UI. */
export const PROVIDER_ENV_VAR: Record<ProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_AI_API_KEY',
};

/**
 * Built-in routing table, used when neither the site nor the operator has picked a model.
 * `null` means the provider has no model for that role at all (Anthropic ships no embeddings
 * endpoint), which triggers the cross-provider embedding fallback below.
 */
export const DEFAULT_MODELS: Record<ProviderName, Record<ModelRole, string | null>> = {
  anthropic: {
    reasoning: 'claude-opus-5',
    fast: 'claude-haiku-4-5-20251001',
    writing: 'claude-sonnet-5',
    embedding: null,
  },
  openai: {
    reasoning: 'gpt-5',
    fast: 'gpt-5-mini',
    writing: 'gpt-5',
    embedding: 'text-embedding-3-small',
  },
  gemini: {
    reasoning: 'gemini-2.5-pro',
    fast: 'gemini-2.5-flash',
    writing: 'gemini-2.5-pro',
    embedding: 'gemini-embedding-001',
  },
};

/** `AppSetting` keys holding the operator-wide defaults. Written by the settings UI. */
export const APP_SETTING_KEYS: Record<ModelRole, string> = {
  reasoning: 'ai.reasoningModel',
  fast: 'ai.fastModel',
  writing: 'ai.writingModel',
  embedding: 'ai.embeddingModel',
};

export const APP_SETTING_PROVIDER_KEY = 'ai.provider';

/** The routing columns of `WebsiteSettings`, structurally typed so prompts/agents can pass the row. */
export interface WebsiteModelSettings {
  reasoningModel?: string | null;
  fastModel?: string | null;
  writingModel?: string | null;
  embeddingModel?: string | null;
  aiProvider?: string | null;
}

const SETTINGS_FIELD: Record<ModelRole, keyof WebsiteModelSettings> = {
  reasoning: 'reasoningModel',
  fast: 'fastModel',
  writing: 'writingModel',
  embedding: 'embeddingModel',
};

export interface ModelRouteOverrides {
  /** The site's `WebsiteSettings` row. Only the routing columns are read. */
  settings?: WebsiteModelSettings | null;
  /** Hard provider pin from the call site. Beats every stored preference. */
  provider?: string | null;
  /** Hard model pin from the call site. Beats every stored preference. */
  model?: string | null;
}

/** Where a resolved value came from — logged so a surprising route can be traced. */
export type RouteSource = 'override' | 'website' | 'app-setting' | 'env' | 'default';

export interface ResolvedModel {
  role: ModelRole;
  provider: AIProvider;
  providerName: ProviderName;
  model: string;
  providerSource: RouteSource;
  modelSource: RouteSource;
}

export interface ProviderAvailabilityDetail extends ProviderAvailability {
  /** False for Anthropic — a capability gap, not a missing key. */
  supportsEmbeddings: boolean;
  /** Env var that enables this provider, so the UI can tell the operator what to set. */
  envVar: string;
}

/** True when at least one provider key is present. Never throws; safe at module scope. */
export function isAiAvailable(): boolean {
  return PROVIDER_ORDER.some((name) => PROVIDERS[name].isConfigured());
}

/** Guard for entry points that cannot do anything useful without a model. */
export function assertAiConfigured(): void {
  if (isAiAvailable()) return;
  throw new IntegrationNotConfiguredError(
    'AI provider',
    'No AI provider is configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_AI_API_KEY.',
  );
}

/** Misconfigured `DEFAULT_AI_PROVIDER` is reported once, not on every call. */
let warnedBadDefaultProvider = false;

/**
 * Preference order for "any configured provider": the operator's `DEFAULT_AI_PROVIDER` first,
 * then the static order in types.ts. Deduplicated so an env pin does not appear twice.
 */
function preferenceOrder(): ProviderName[] {
  const preferred = env.defaultAiProvider;
  const head: ProviderName[] = isProviderName(preferred) ? [preferred] : [];
  if (preferred && !isProviderName(preferred) && !warnedBadDefaultProvider) {
    // This runs on the hot path of every generation; warning each time would bury the log.
    warnedBadDefaultProvider = true;
    log.warn('DEFAULT_AI_PROVIDER is not a known provider — ignoring', {
      value: preferred,
      allowed: [...PROVIDER_ORDER],
    });
  }
  return [...head, ...PROVIDER_ORDER.filter((name) => !head.includes(name))];
}

function firstConfigured(candidates: readonly ProviderName[] = preferenceOrder()): ProviderName | null {
  return candidates.find((name) => PROVIDERS[name].isConfigured()) ?? null;
}

/**
 * Return a provider adapter. With a name, that exact provider (throwing if its key is absent);
 * without one, the first configured provider in preference order.
 */
export function getProvider(name?: string | null): AIProvider {
  if (name) {
    if (!isProviderName(name)) {
      throw new ValidationError(`Unknown AI provider "${name}"`, {
        allowed: [...PROVIDER_ORDER],
      });
    }
    const provider = PROVIDERS[name];
    if (!provider.isConfigured()) {
      throw new IntegrationNotConfiguredError(
        name,
        `Set ${PROVIDER_ENV_VAR[name]} to enable the ${name} provider.`,
      );
    }
    return provider;
  }

  const resolved = firstConfigured();
  // Throws IntegrationNotConfiguredError when the install has no AI keys at all.
  if (!resolved) assertAiConfigured();
  return PROVIDERS[resolved ?? 'anthropic'];
}

/** Adapter lookup that ignores configuration — for the settings UI and tests. */
export function getProviderUnchecked(name: ProviderName): AIProvider {
  return PROVIDERS[name];
}

/** Providers that expose an embeddings endpoint, in preference order. */
function embeddingCandidates(): ProviderName[] {
  return preferenceOrder().filter((name) => DEFAULT_MODELS[name].embedding !== null);
}

/** True when a configured provider can actually produce vectors. Never throws. */
export function hasEmbeddingProvider(): boolean {
  return embeddingCandidates().some((name) => PROVIDERS[name].isConfigured());
}

/**
 * The provider used for embeddings. Anthropic has no embeddings API, so a site (or install)
 * routed to Anthropic still needs OpenAI or Gemini for vectors; this is the single place that
 * knows about that gap.
 */
export function getEmbeddingProvider(preferred?: string | null): AIProvider {
  if (preferred && isProviderName(preferred) && DEFAULT_MODELS[preferred].embedding !== null) {
    const provider = PROVIDERS[preferred];
    if (provider.isConfigured()) return provider;
  }
  const name = firstConfigured(embeddingCandidates());
  if (!name) {
    throw new IntegrationNotConfiguredError(
      'AI embeddings',
      'Embeddings need OpenAI or Gemini — Anthropic has no embeddings API. Set OPENAI_API_KEY or GOOGLE_AI_API_KEY.',
    );
  }
  return PROVIDERS[name];
}

/** Everything the settings UI needs to render the provider matrix, with no network calls. */
export function getAvailableProviders(): ProviderAvailabilityDetail[] {
  return PROVIDER_ORDER.map((name) => {
    const provider = PROVIDERS[name];
    return {
      name,
      configured: provider.isConfigured(),
      models: provider.listModels(),
      supportsEmbeddings: DEFAULT_MODELS[name].embedding !== null,
      envVar: PROVIDER_ENV_VAR[name],
    };
  });
}

/**
 * Which provider owns a model id, judged by the adapter's model list and the pricing table.
 * Used to stop a stored model id being sent to the wrong vendor (a guaranteed 404).
 */
export function providerOfModel(model: string): ProviderName | null {
  const id = model.trim().replace(/^models\//, '');
  if (!id) return null;
  for (const name of PROVIDER_ORDER) {
    if (PROVIDERS[name].listModels().some((descriptor) => descriptor.id === id)) return name;
  }
  for (const name of PROVIDER_ORDER) {
    const table = PRICING[name];
    if (Object.keys(table).some((key) => id === key || id.startsWith(key))) return name;
  }
  return null;
}

interface Pick<T extends string = string> {
  value: T;
  source: RouteSource;
}

/**
 * `AppSetting.value` is a JSON column, so a legacy or hand-edited row can hold a number, an
 * object or `[]` where the settings UI writes a string. Coerce defensively — calling `.trim()`
 * on a JSON object would throw a TypeError on the hot path of every generation.
 */
function asSettingString(value: unknown, key: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  log.warn('ignoring non-string AppSetting value', { key, type: typeof value });
  return null;
}

function pickProvider(
  overrides: ModelRouteOverrides,
  appSetting: string | null,
): Pick<ProviderName> | null {
  const candidates: Array<[string | null | undefined, RouteSource]> = [
    [overrides.provider, 'override'],
    [overrides.settings?.aiProvider, 'website'],
    [appSetting, 'app-setting'],
    [env.defaultAiProvider, 'env'],
  ];
  for (const [value, source] of candidates) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    if (!isProviderName(trimmed)) {
      log.warn('ignoring unknown provider id in routing chain', { value: trimmed, source });
      continue;
    }
    return { value: trimmed, source };
  }
  return null;
}

function pickModel(
  role: ModelRole,
  overrides: ModelRouteOverrides,
  appSetting: string | null,
): Pick | null {
  const candidates: Array<[string | null | undefined, RouteSource]> = [
    [overrides.model, 'override'],
    [overrides.settings?.[SETTINGS_FIELD[role]], 'website'],
    [appSetting, 'app-setting'],
  ];
  for (const [value, source] of candidates) {
    const trimmed = value?.trim();
    if (trimmed) return { value: trimmed, source };
  }
  return null;
}

/**
 * Resolve `role` to a concrete provider + model.
 *
 * Precedence, highest first: call-site override → `WebsiteSettings` → global `AppSetting` →
 * `DEFAULT_AI_PROVIDER` (provider only) → built-in defaults.
 *
 * Two safety valves matter more than the precedence itself:
 *  - a *stored* provider preference that is no longer configured degrades to the first
 *    configured provider with a warning, so revoking one key does not take the platform down.
 *    A call-site `provider` override is treated as a hard requirement and throws instead.
 *  - a model id that clearly belongs to another configured vendor re-routes the provider to
 *    match, because sending `gpt-5` to Anthropic is a guaranteed hard failure. Skipped when
 *    the caller pinned the provider explicitly (they may be pointing at a gateway).
 */
export async function resolveModel(
  role: ModelRole,
  overrides: ModelRouteOverrides = {},
): Promise<ResolvedModel> {
  const modelKey = APP_SETTING_KEYS[role];
  const [providerSetting, modelSetting] = await Promise.all([
    getAppSetting<unknown>(APP_SETTING_PROVIDER_KEY, null),
    getAppSetting<unknown>(modelKey, null),
  ]);

  const providerPick = pickProvider(
    overrides,
    asSettingString(providerSetting, APP_SETTING_PROVIDER_KEY),
  );
  const modelPick = pickModel(role, overrides, asSettingString(modelSetting, modelKey));

  let providerName: ProviderName;
  let providerSource: RouteSource;

  if (providerPick && PROVIDERS[providerPick.value].isConfigured()) {
    providerName = providerPick.value;
    providerSource = providerPick.source;
  } else if (providerPick && providerPick.source === 'override') {
    // The caller asked for this vendor by name; silently using another one would produce
    // output attributed to a model that never ran.
    throw new IntegrationNotConfiguredError(
      providerPick.value,
      `Set ${PROVIDER_ENV_VAR[providerPick.value]} to enable the ${providerPick.value} provider.`,
    );
  } else {
    const fallback = firstConfigured();
    // Throws IntegrationNotConfiguredError when the install has no AI keys at all.
    if (!fallback) assertAiConfigured();
    providerName = fallback ?? 'anthropic';
    providerSource = 'default';
    if (providerPick) {
      log.warn('preferred AI provider is unavailable, falling back', {
        preferred: providerPick.value,
        source: providerPick.source,
        using: providerName,
      });
    }
  }

  // Re-route to the vendor that actually owns the model id, unless the caller pinned one.
  // `pinnedProvider` mirrors what `pickProvider` accepted, so `provider: ''` (or whitespace)
  // means "no pin" consistently in both places.
  const pinnedProvider = Boolean(overrides.provider?.trim());
  if (modelPick && !pinnedProvider) {
    const owner = providerOfModel(modelPick.value);
    if (owner && owner !== providerName && PROVIDERS[owner].isConfigured()) {
      log.debug('re-routing provider to match the selected model', {
        model: modelPick.value,
        from: providerName,
        to: owner,
      });
      providerName = owner;
      providerSource = modelPick.source;
    }
  }

  // Embeddings: Anthropic cannot serve this role at all, so hop to a vendor that can.
  if (role === 'embedding' && DEFAULT_MODELS[providerName].embedding === null) {
    const provider = getEmbeddingProvider();
    if (provider.name !== providerName) {
      log.debug('routing embeddings away from a provider without an embeddings API', {
        from: providerName,
        to: provider.name,
      });
      providerName = provider.name;
      providerSource = 'default';
    }
  }

  const builtIn = DEFAULT_MODELS[providerName][role];
  // A model pinned for another vendor must not leak through after a re-route was declined.
  const pinnedFitsProvider =
    modelPick && (providerOfModel(modelPick.value) ?? providerName) === providerName;

  let model: string;
  let modelSource: RouteSource;
  if (modelPick && pinnedFitsProvider) {
    model = modelPick.value;
    modelSource = modelPick.source;
  } else {
    if (modelPick) {
      log.warn('ignoring model preference that belongs to another provider', {
        model: modelPick.value,
        provider: providerName,
      });
    }
    if (!builtIn) {
      throw new IntegrationNotConfiguredError(
        'AI embeddings',
        `The ${providerName} provider has no ${role} model. Set OPENAI_API_KEY or GOOGLE_AI_API_KEY for embeddings.`,
      );
    }
    model = builtIn;
    modelSource = 'default';
  }

  return {
    role,
    provider: PROVIDERS[providerName],
    providerName,
    model,
    providerSource,
    modelSource,
  };
}
