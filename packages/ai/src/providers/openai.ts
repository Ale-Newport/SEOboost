import OpenAI, { APIError } from 'openai';
import { IntegrationNotConfiguredError, createLogger, env, isConfigured } from '@seo/shared';
import type { z } from 'zod';
import { toSchemaName, zodToJsonSchema } from '../json-schema';
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
  isObjectRoot,
  jsonFallbackInstruction,
  providerError,
  splitSystem,
} from './shared';

const log = createLogger('ai:openai');

const PROVIDER = 'openai' as const;
const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

const MODELS: ModelDescriptor[] = [
  { id: 'gpt-5', label: 'GPT-5', roles: ['reasoning', 'writing'], contextWindow: 400_000 },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', roles: ['fast', 'writing'], contextWindow: 400_000 },
  { id: 'gpt-4.1', label: 'GPT-4.1', roles: ['reasoning', 'writing'], contextWindow: 1_047_576 },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', roles: ['fast'], contextWindow: 1_047_576 },
  {
    id: 'text-embedding-3-small',
    label: 'Embedding 3 small',
    roles: ['embedding'],
    dimensions: 1536,
  },
  {
    id: 'text-embedding-3-large',
    label: 'Embedding 3 large',
    roles: ['embedding'],
    dimensions: 3072,
  },
];

/**
 * GPT-5 and the o-series only accept the default temperature; sending any other value is a
 * hard 400. Model ids stay free-form, so this is a prefix check rather than a whitelist.
 */
function supportsTemperature(model: string): boolean {
  return !/^(gpt-5|o1|o3|o4)/i.test(model);
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return 'unknown';
  }
}

function toError(err: unknown): Error {
  if (err instanceof APIError) {
    return providerError(PROVIDER, err.message, err.status);
  }
  if (err instanceof Error) return providerError(PROVIDER, err.message, undefined);
  return providerError(PROVIDER, String(err), undefined);
}

export class OpenAIProvider implements AIProvider {
  readonly name = PROVIDER;

  /** Constructed on first use so an unconfigured install never touches the SDK at import time. */
  private client: OpenAI | null = null;

  isConfigured(): boolean {
    return isConfigured.openai();
  }

  listModels(): ModelDescriptor[] {
    return MODELS;
  }

  private getClient(): OpenAI {
    const apiKey = env.openaiApiKey;
    if (!apiKey) {
      throw new IntegrationNotConfiguredError(
        'OpenAI',
        'Set OPENAI_API_KEY to enable the OpenAI provider.',
      );
    }
    // maxRetries: 0 — retry/backoff is owned by client.ts so every provider behaves the same
    // and a retried call is counted once in AiUsage.
    if (!this.client) this.client = new OpenAI({ apiKey, maxRetries: 0 });
    return this.client;
  }

  private buildMessages(
    messages: ChatMessage[],
    options: GenerateOptions | undefined,
    extraUserTurn?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const { system, turns } = splitSystem(messages, options);
    const out: OpenAI.ChatCompletionMessageParam[] = [];
    if (system) out.push({ role: 'system', content: system });
    for (const turn of turns) out.push({ role: turn.role, content: turn.content });
    if (extraUserTurn) out.push({ role: 'user', content: extraUserTurn });
    return out;
  }

  private baseParams(
    model: string,
    options: GenerateOptions | undefined,
  ): Pick<
    OpenAI.ChatCompletionCreateParamsNonStreaming,
    'model' | 'temperature' | 'max_completion_tokens' | 'stop'
  > {
    const temperature = clampTemperature(options?.temperature);
    return {
      model,
      ...(temperature !== undefined && supportsTemperature(model) ? { temperature } : {}),
      ...(options?.maxTokens ? { max_completion_tokens: options.maxTokens } : {}),
      ...(options?.stopSequences?.length ? { stop: options.stopSequences.slice(0, 4) } : {}),
    };
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const model = options?.model ?? DEFAULT_MODEL;
    const started = Date.now();
    try {
      const response = await this.getClient().chat.completions.create(
        { ...this.baseParams(model, options), messages: this.buildMessages(messages, options) },
        { signal: options?.signal },
      );
      const choice = response.choices[0];
      return {
        text: choice?.message.content ?? '',
        model: response.model || model,
        provider: PROVIDER,
        finishReason: mapFinishReason(choice?.finish_reason),
        ...usageOf(response.usage, response.model || model),
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

    // Strict structured outputs only accept an object root; anything else (a bare array or
    // union) falls back to prompt-instructed JSON, which the repair loop still guards.
    const strictSchema = zodToJsonSchema(schema, { strict: true });
    const native = isObjectRoot(strictSchema);
    const name = toSchemaName(options?.schemaName ?? 'response');

    try {
      const response = await this.getClient().chat.completions.create(
        {
          ...this.baseParams(model, options),
          messages: this.buildMessages(
            messages,
            options,
            native ? undefined : jsonFallbackInstruction(zodToJsonSchema(schema)),
          ),
          response_format: native
            ? {
                type: 'json_schema',
                json_schema: {
                  name,
                  strict: true,
                  schema: strictSchema,
                  ...(options?.schemaDescription
                    ? { description: options.schemaDescription }
                    : {}),
                },
              }
            : { type: 'json_object' },
        },
        { signal: options?.signal },
      );

      const choice = response.choices[0];
      const raw = choice?.message.content ?? '';
      const resolvedModel = response.model || model;
      const usage = {
        ...usageOf(response.usage, resolvedModel),
        latencyMs: Date.now() - started,
      };
      const context = {
        raw,
        usage,
        provider: PROVIDER,
        model: resolvedModel,
        finishReason: mapFinishReason(choice?.finish_reason),
      };
      const data = validateOrThrow(schema, parseJsonLoose(raw), context);
      return {
        data,
        raw,
        provider: PROVIDER,
        model: resolvedModel,
        finishReason: context.finishReason,
        ...usage,
        repairAttempts: 0,
      };
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
      const response = await this.getClient().embeddings.create(
        {
          model,
          input: texts,
          ...(options?.dimensions ? { dimensions: options.dimensions } : {}),
        },
        { signal: options?.signal },
      );
      // The API may return rows out of order; `index` is authoritative.
      const vectors: number[][] = new Array<number[]>(texts.length).fill([]);
      for (const row of response.data) vectors[row.index] = row.embedding;
      const tokensIn = response.usage?.prompt_tokens ?? 0;
      return {
        vectors,
        model: response.model || model,
        provider: PROVIDER,
        tokensIn,
        costUsd: estimateCost(PROVIDER, response.model || model, tokensIn, 0),
        dimensions: vectors[0]?.length ?? 0,
      };
    } catch (err) {
      throw toError(err);
    }
  }

  async *stream(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<string> {
    const model = options?.model ?? DEFAULT_MODEL;
    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>;
    try {
      stream = await this.getClient().chat.completions.create(
        {
          ...this.baseParams(model, options),
          messages: this.buildMessages(messages, options),
          stream: true,
        },
        { signal: options?.signal },
      );
    } catch (err) {
      throw toError(err);
    }

    try {
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta.content;
        if (delta) yield delta;
      }
    } catch (err) {
      throw toError(err);
    }
  }
}

function usageOf(
  usage: OpenAI.CompletionUsage | undefined,
  model: string,
): { tokensIn: number; tokensOut: number; costUsd: number } {
  const tokensIn = usage?.prompt_tokens ?? 0;
  const tokensOut = usage?.completion_tokens ?? 0;
  if (!usage) log.debug('response carried no usage block; cost recorded as 0', { model });
  return { tokensIn, tokensOut, costUsd: estimateCost(PROVIDER, model, tokensIn, tokensOut) };
}
