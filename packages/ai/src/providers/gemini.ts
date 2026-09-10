import { ApiError, GoogleGenAI } from '@google/genai';
import type { Content, GenerateContentResponse } from '@google/genai';
import { createLogger, env, IntegrationNotConfiguredError, isConfigured } from '@seo/shared';
import type { z } from 'zod';
import { zodToJsonSchema } from '../json-schema';
import type { JsonSchema } from '../json-schema';
import { estimateCost } from '../pricing';
import { SchemaValidationError, parseJsonLoose, validateOrThrow } from '../structured';
import type {
  AIProvider,
  ChatMessage,
  EmbedOptions,
  EmbedResult,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  ModelDescriptor,
  StructuredOptions,
  StructuredResult,
} from '../types';
import {
  clampTemperature,
  isRetryableStatus,
  jsonFallbackInstruction,
  providerError,
  splitSystem,
} from './shared';

const log = createLogger('ai:gemini');

const PROVIDER = 'gemini' as const;
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001';

const MODELS: ModelDescriptor[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    roles: ['reasoning', 'writing'],
    contextWindow: 1_048_576,
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    roles: ['fast', 'writing'],
    contextWindow: 1_048_576,
  },
  {
    id: 'gemini-embedding-001',
    label: 'Gemini Embedding 001',
    roles: ['embedding'],
    dimensions: 3072,
  },
];

function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function toError(err: unknown): Error {
  if (err instanceof ApiError) return providerError(PROVIDER, err.message, err.status);
  if (err instanceof Error) return providerError(PROVIDER, err.message, undefined);
  return providerError(PROVIDER, String(err), undefined);
}

/**
 * Gemini's `responseJsonSchema` accepts a subset of JSON Schema and rejects keywords it does
 * not model — `additionalProperties` in particular, which our converter always emits for
 * objects. Strip those rather than losing native structured output entirely.
 */
function sanitizeForGemini(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema') continue;
    out[key] = sanitizeValue(value);
  }
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') return sanitizeForGemini(value as JsonSchema);
  return value;
}

export class GeminiProvider implements AIProvider {
  readonly name = PROVIDER;

  private client: GoogleGenAI | null = null;

  isConfigured(): boolean {
    return isConfigured.gemini();
  }

  listModels(): ModelDescriptor[] {
    return MODELS;
  }

  private getClient(): GoogleGenAI {
    const apiKey = env.googleAiApiKey;
    if (!apiKey) {
      throw new IntegrationNotConfiguredError(
        'Google Gemini',
        'Set GOOGLE_AI_API_KEY to enable the Gemini provider.',
      );
    }
    if (!this.client) this.client = new GoogleGenAI({ apiKey });
    return this.client;
  }

  private buildContents(
    messages: ChatMessage[],
    options: GenerateOptions | undefined,
    extraUserTurn?: string,
  ): { contents: Content[]; system?: string } {
    const { system, turns } = splitSystem(messages, options);
    const contents: Content[] = turns.map((turn) => ({
      // Gemini calls the assistant side "model".
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    }));
    if (extraUserTurn) contents.push({ role: 'user', parts: [{ text: extraUserTurn }] });
    return { contents, system };
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const model = options?.model ?? DEFAULT_MODEL;
    const started = Date.now();
    const { contents, system } = this.buildContents(messages, options);
    const temperature = clampTemperature(options?.temperature);

    try {
      const response = await this.getClient().models.generateContent({
        model,
        contents,
        config: {
          ...(system ? { systemInstruction: system } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
          ...(options?.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        },
      });

      return {
        text: response.text ?? '',
        model,
        provider: PROVIDER,
        finishReason: mapFinishReason(response.candidates?.[0]?.finishReason),
        ...usageOf(response, model),
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      throw toError(err);
    }
  }

  async generateStructured<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    options?: StructuredOptions,
  ): Promise<StructuredResult<T>> {
    const model = options?.model ?? DEFAULT_MODEL;
    const started = Date.now();
    const jsonSchema = zodToJsonSchema(schema);
    const { contents, system } = this.buildContents(messages, options);
    const temperature = clampTemperature(options?.temperature);

    try {
      const response = await this.getClient().models.generateContent({
        model,
        contents,
        config: {
          ...(system ? { systemInstruction: system } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
          responseMimeType: 'application/json',
          responseJsonSchema: sanitizeForGemini(jsonSchema),
        },
      });

      const raw = response.text ?? '';
      const usage = { ...usageOf(response, model), latencyMs: Date.now() - started };
      const finishReason = mapFinishReason(response.candidates?.[0]?.finishReason);
      const data = validateOrThrow(schema, parseJsonLoose(raw), {
        raw,
        usage,
        provider: PROVIDER,
        model,
        finishReason,
      });

      return { data, raw, provider: PROVIDER, model, finishReason, ...usage, repairAttempts: 0 };
    } catch (err) {
      if (err instanceof SchemaValidationError) throw err;
      if (err instanceof ApiError && !isRetryableStatus(err.status)) {
        // A 400 here usually means the schema used a keyword this model rejects. Retry once
        // with prompt-instructed JSON so an exotic schema degrades instead of failing.
        log.warn('native structured output rejected, retrying with prompt-instructed JSON', {
          model,
          error: err.message,
        });
        return this.structuredViaPrompt(messages, schema, options, jsonSchema, model);
      }
      throw toError(err);
    }
  }

  private async structuredViaPrompt<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    options: StructuredOptions | undefined,
    jsonSchema: JsonSchema,
    model: string,
  ): Promise<StructuredResult<T>> {
    const started = Date.now();
    const { contents, system } = this.buildContents(
      messages,
      options,
      jsonFallbackInstruction(jsonSchema),
    );
    const temperature = clampTemperature(options?.temperature);

    try {
      const response = await this.getClient().models.generateContent({
        model,
        contents,
        config: {
          ...(system ? { systemInstruction: system } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
          responseMimeType: 'application/json',
        },
      });

      const raw = response.text ?? '';
      const usage = { ...usageOf(response, model), latencyMs: Date.now() - started };
      const finishReason = mapFinishReason(response.candidates?.[0]?.finishReason);
      const data = validateOrThrow(schema, parseJsonLoose(raw), {
        raw,
        usage,
        provider: PROVIDER,
        model,
        finishReason,
      });
      return { data, raw, provider: PROVIDER, model, finishReason, ...usage, repairAttempts: 0 };
    } catch (err) {
      if (err instanceof SchemaValidationError) throw err;
      throw toError(err);
    }
  }

  async embed(texts: string[], options?: EmbedOptions): Promise<EmbedResult> {
    const model = options?.model ?? DEFAULT_EMBEDDING_MODEL;
    if (!texts.length) {
      return { vectors: [], model, provider: PROVIDER, tokensIn: 0, costUsd: 0, dimensions: 0 };
    }
    try {
      const response = await this.getClient().models.embedContent({
        model,
        contents: texts,
        config: {
          ...(options?.dimensions ? { outputDimensionality: options.dimensions } : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        },
      });

      const vectors = (response.embeddings ?? []).map((embedding) => embedding.values ?? []);
      // The Gemini embeddings response reports no token usage (billableCharacterCount is
      // Vertex-only), so cost is recorded as 0 rather than derived from a character estimate.
      return {
        vectors,
        model,
        provider: PROVIDER,
        tokensIn: 0,
        costUsd: 0,
        dimensions: vectors[0]?.length ?? 0,
      };
    } catch (err) {
      throw toError(err);
    }
  }

  async *stream(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<string> {
    const model = options?.model ?? DEFAULT_MODEL;
    const { contents, system } = this.buildContents(messages, options);
    const temperature = clampTemperature(options?.temperature);

    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.getClient().models.generateContentStream({
        model,
        contents,
        config: {
          ...(system ? { systemInstruction: system } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
          ...(options?.maxTokens ? { maxOutputTokens: options.maxTokens } : {}),
          ...(options?.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
          ...(options?.signal ? { abortSignal: options.signal } : {}),
        },
      });
    } catch (err) {
      throw toError(err);
    }

    try {
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) yield text;
      }
    } catch (err) {
      throw toError(err);
    }
  }
}

function usageOf(
  response: GenerateContentResponse,
  model: string,
): { tokensIn: number; tokensOut: number; costUsd: number } {
  const usage = response.usageMetadata;
  if (!usage) {
    log.debug('response carried no usage metadata; cost recorded as 0', { model });
    return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }
  const tokensIn = usage.promptTokenCount ?? 0;
  // Thinking tokens are billed as output but reported separately.
  const tokensOut = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return { tokensIn, tokensOut, costUsd: estimateCost(PROVIDER, model, tokensIn, tokensOut) };
}
