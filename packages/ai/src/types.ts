import type { z } from 'zod';

/**
 * Provider-agnostic contract.
 *
 * Everything above `providers/` speaks only this vocabulary, so swapping or adding a
 * vendor never leaks into agents, the SEO engine or the UI.
 */

export type ProviderName = 'openai' | 'anthropic' | 'gemini';

/**
 * Fallback order used when the operator has not pinned a provider. Anthropic first
 * because the writing/reasoning prompts in this app are tuned against it.
 */
export const PROVIDER_ORDER: readonly ProviderName[] = ['anthropic', 'openai', 'gemini'];

export function isProviderName(value: unknown): value is ProviderName {
  return value === 'openai' || value === 'anthropic' || value === 'gemini';
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Preferred way to pass a system prompt; a leading `system` message works too. */
  system?: string;
  stopSequences?: string[];
  signal?: AbortSignal;
}

export interface StructuredOptions extends GenerateOptions {
  /** Name given to the schema in provider structured-output modes (a-z, 0-9, _ and -). */
  schemaName?: string;
  /** Human description of the schema, passed to the provider where supported. */
  schemaDescription?: string;
}

export interface EmbedOptions {
  model?: string;
  /** Reduce the output vector size where the model supports it (OpenAI v3, Gemini). */
  dimensions?: number;
  signal?: AbortSignal;
}

/**
 * Normalised stop reason. Vendors use different vocabularies; callers only ever need to
 * know "did this get truncated" and "was it filtered".
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'content_filter'
  | 'tool_use'
  | 'refusal'
  | 'unknown';

/** Usage fields every priced call reports back, so cost tracking is uniform. */
export interface UsageFields {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
}

export interface GenerateResult extends UsageFields {
  text: string;
  model: string;
  provider: ProviderName;
  finishReason: FinishReason;
}

export interface StructuredResult<T> extends UsageFields {
  data: T;
  /** Exact text the model returned, kept for debugging and prompt regression tests. */
  raw: string;
  model: string;
  provider: ProviderName;
  finishReason: FinishReason;
  /** How many extra round-trips were needed to satisfy the schema. 0 = first try. */
  repairAttempts: number;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  provider: ProviderName;
  tokensIn: number;
  costUsd: number;
  dimensions: number;
}

/** Which job a model is routed to. Per-site overrides live on `WebsiteSettings`. */
export type ModelRole = 'reasoning' | 'fast' | 'writing' | 'embedding';

export const MODEL_ROLES: readonly ModelRole[] = ['reasoning', 'fast', 'writing', 'embedding'];

export function isModelRole(value: unknown): value is ModelRole {
  return (
    value === 'reasoning' || value === 'fast' || value === 'writing' || value === 'embedding'
  );
}

/**
 * Static description of a model the settings UI can render without hitting the network.
 * Model ids stay free-form strings everywhere else — this list is a convenience, not a whitelist.
 */
export interface ModelDescriptor {
  id: string;
  label: string;
  roles: ModelRole[];
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Output dimensions for embedding models. */
  dimensions?: number;
}

export interface AIProvider {
  readonly name: ProviderName;
  /** True when this provider's API key is present. Never throws. */
  isConfigured(): boolean;
  /** Known models for the settings UI. Synchronous and offline by design. */
  listModels(): ModelDescriptor[];
  generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult>;
  generateStructured<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    options?: StructuredOptions,
  ): Promise<StructuredResult<T>>;
  embed(texts: string[], options?: EmbedOptions): Promise<EmbedResult>;
  stream(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<string>;
}

export interface ProviderAvailability {
  name: ProviderName;
  configured: boolean;
  models: ModelDescriptor[];
}
