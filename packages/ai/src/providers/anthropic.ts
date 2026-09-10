import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { AppError, IntegrationNotConfiguredError, createLogger, env, isConfigured } from '@seo/shared';
import type { z } from 'zod';
import { toSchemaName, zodToJsonSchema } from '../json-schema';
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
  isObjectRoot,
  jsonFallbackInstruction,
  providerError,
  splitSystem,
} from './shared';

const log = createLogger('ai:anthropic');

const PROVIDER = 'anthropic' as const;
const DEFAULT_MODEL = 'claude-sonnet-5';
/** `max_tokens` is mandatory on the Messages API; this is a safe cap every listed model allows. */
const DEFAULT_MAX_TOKENS = 8192;

const MODELS: ModelDescriptor[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    roles: ['reasoning', 'writing'],
    contextWindow: 200_000,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    roles: ['reasoning', 'writing'],
    contextWindow: 200_000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    roles: ['fast'],
    contextWindow: 200_000,
  },
];

/**
 * Models released after Claude Opus 4.6 reject an explicit `temperature`. Rather than
 * hard-failing on an unknown id, we drop the parameter for the known-affected families and
 * send it for everything else.
 */
function supportsTemperature(model: string): boolean {
  return !/^claude-(opus-5|sonnet-5|opus-4-6)/i.test(model);
}

function mapStopReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'refusal';
    default:
      return 'unknown';
  }
}

function toError(err: unknown): Error {
  if (err instanceof APIError) return providerError(PROVIDER, err.message, err.status);
  if (err instanceof Error) return providerError(PROVIDER, err.message, undefined);
  return providerError(PROVIDER, String(err), undefined);
}

/**
 * The Tool input schema type is narrower than a generic JSON Schema record, so the object is
 * rebuilt field by field instead of being cast.
 */
function toInputSchema(schema: JsonSchema): Anthropic.Tool.InputSchema {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : undefined;
  return {
    type: 'object',
    properties: schema.properties ?? {},
    ...(required?.length ? { required } : {}),
  };
}

export class AnthropicProvider implements AIProvider {
  readonly name = PROVIDER;

  private client: Anthropic | null = null;

  isConfigured(): boolean {
    return isConfigured.anthropic();
  }

  listModels(): ModelDescriptor[] {
    return MODELS;
  }

  private getClient(): Anthropic {
    const apiKey = env.anthropicApiKey;
    if (!apiKey) {
      throw new IntegrationNotConfiguredError(
        'Anthropic',
        'Set ANTHROPIC_API_KEY to enable the Anthropic provider.',
      );
    }
    // Retry policy lives in client.ts, so the SDK's own retries are disabled.
    if (!this.client) this.client = new Anthropic({ apiKey, maxRetries: 0 });
    return this.client;
  }

  private buildRequest(
    messages: ChatMessage[],
    options: GenerateOptions | undefined,
    extraUserTurn?: string,
  ): {
    model: string;
    max_tokens: number;
    system?: string;
    messages: Anthropic.MessageParam[];
    temperature?: number;
    stop_sequences?: string[];
  } {
    const model = options?.model ?? DEFAULT_MODEL;
    const { system, turns } = splitSystem(messages, options);
    const params: Anthropic.MessageParam[] = turns.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));
    if (extraUserTurn) params.push({ role: 'user', content: extraUserTurn });
    // The Messages API rejects an empty conversation; a single empty user turn is never useful
    // either, so surface that as a caller error rather than a 400 from the wire.
    if (!params.length) {
      throw new AppError('Anthropic requires at least one user message', {
        code: 'VALIDATION_ERROR',
        status: 400,
      });
    }

    const temperature = clampTemperature(options?.temperature);
    return {
      model,
      max_tokens: options?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: params,
      ...(temperature !== undefined && supportsTemperature(model) ? { temperature } : {}),
      ...(options?.stopSequences?.length ? { stop_sequences: options.stopSequences } : {}),
    };
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const started = Date.now();
    try {
      const request = this.buildRequest(messages, options);
      const response = await this.getClient().messages.create(request, {
        signal: options?.signal,
      });
      return {
        text: textOf(response.content),
        model: response.model,
        provider: PROVIDER,
        finishReason: mapStopReason(response.stop_reason),
        ...usageOf(response.usage, response.model),
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
    const started = Date.now();
    const jsonSchema = zodToJsonSchema(schema);
    // Anthropic's structured mode is a forced tool call, and a tool's input must be an object.
    // Non-object roots fall back to prompt-instructed JSON.
    const native = isObjectRoot(jsonSchema);
    const toolName = toSchemaName(options?.schemaName ?? 'record_response');

    try {
      const request = this.buildRequest(
        messages,
        options,
        native ? undefined : jsonFallbackInstruction(jsonSchema),
      );
      const response = await this.getClient().messages.create(
        {
          ...request,
          ...(native
            ? {
                tools: [
                  {
                    name: toolName,
                    description:
                      options?.schemaDescription ??
                      'Record the response using this exact structure.',
                    input_schema: toInputSchema(jsonSchema),
                  },
                ],
                tool_choice: { type: 'tool', name: toolName },
              }
            : {}),
        },
        { signal: options?.signal },
      );

      const toolBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      // A forced tool call normally returns tool_use; if the model answered in prose instead
      // (refusal, or the fallback path) parse whatever text came back.
      const raw = toolBlock ? JSON.stringify(toolBlock.input) : textOf(response.content);
      const parsed = toolBlock ? toolBlock.input : parseJsonLoose(raw);

      const usage = {
        ...usageOf(response.usage, response.model),
        latencyMs: Date.now() - started,
      };
      const finishReason = mapStopReason(response.stop_reason);
      const data = validateOrThrow(schema, parsed, {
        raw,
        usage,
        provider: PROVIDER,
        model: response.model,
        finishReason,
      });

      return {
        data,
        raw,
        provider: PROVIDER,
        model: response.model,
        finishReason,
        ...usage,
        repairAttempts: 0,
      };
    } catch (err) {
      if (err instanceof SchemaValidationError) throw err;
      throw toError(err);
    }
  }

  /**
   * Anthropic has no embeddings endpoint. This is a capability gap, not a missing key, so it
   * throws a typed error the caller can route around (see `getEmbeddingProvider`).
   */
  async embed(): Promise<EmbedResult> {
    throw new AppError('Anthropic does not provide an embeddings API', {
      code: 'EMBEDDINGS_NOT_SUPPORTED',
      status: 501,
      details: { provider: PROVIDER },
    });
  }

  async *stream(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<string> {
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.getClient().messages.create(
        { ...this.buildRequest(messages, options), stream: true },
        { signal: options?.signal },
      );
    } catch (err) {
      throw toError(err);
    }

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield event.delta.text;
        }
      }
    } catch (err) {
      throw toError(err);
    }
  }
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function usageOf(
  usage: Anthropic.Usage | undefined,
  model: string,
): { tokensIn: number; tokensOut: number; costUsd: number } {
  if (!usage) {
    log.debug('response carried no usage block; cost recorded as 0', { model });
    return { tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }
  // Cache reads/writes are billed at different rates we do not model; counting them as plain
  // input keeps the token totals honest and the cost estimate conservative.
  const tokensIn =
    usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return {
    tokensIn,
    tokensOut: usage.output_tokens,
    costUsd: estimateCost(PROVIDER, model, tokensIn, usage.output_tokens),
  };
}
