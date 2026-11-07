import { IntegrationNotConfiguredError, createLogger } from '@seo/shared';
import type { z } from 'zod';
import { CHATGPT_RESPONSES_URL } from '../chatgpt/constants';
import { ChatGptError, classifyResponsesError } from '../chatgpt/errors';
import { pickDefaultModels, toModelDescriptors } from '../chatgpt/models';
import { collectResponse, readSse, type CollectedResponse } from '../chatgpt/sse';
import {
  chatGptStatusSync,
  clearChatGptError,
  getChatGptAccessToken,
  isChatGptReady,
  markChatGptNeedsReauth,
  recordChatGptError,
} from '../chatgpt/store';
import { toSchemaName, zodToJsonSchema } from '../json-schema';
import { parseJsonLoose, validateOrThrow } from '../structured';
import type {
  AIProvider,
  ChatMessage,
  EmbedResult,
  FinishReason,
  GenerateOptions,
  GenerateResult,
  ModelDescriptor,
  ModelRole,
  StructuredOptions,
  StructuredResult,
} from '../types';
import { isObjectRoot, jsonFallbackInstruction, splitSystem } from './shared';

const log = createLogger('ai:chatgpt');

const PROVIDER = 'chatgpt' as const;

/**
 * The user's ChatGPT Plus/Pro plan as a provider ("Sign in with ChatGPT").
 *
 * Calls the public Responses API with the user's OAuth access token, under the constraints the
 * plan route imposes: every request is `store: false` + `stream: true`, and sampling knobs
 * (`temperature`, `max_output_tokens`) are not accepted, so they are simply not sent. Usage is
 * billed to the user's plan cap, not to an API account, so every call is costed at $0.
 *
 * Structured output first tries the native `text.format` JSON schema; if the plan route reports
 * that as an unsupported capability, the provider remembers it for the life of the process and
 * falls back to schema-in-instructions JSON, which the shared repair loop still guards.
 */

/** Set once the plan route has rejected `text.format`, so it is not re-sent on every call. */
let nativeSchemaUnsupported = false;

/** Test seam. */
export function resetChatGptProviderState(): void {
  nativeSchemaUnsupported = false;
}

/** Whether a failed native-schema call should be retried with prompt-instructed JSON. */
export function shouldFallBackToPromptJson(error: unknown): boolean {
  if (!(error instanceof ChatGptError) || error.kind !== 'unsupported') return false;
  // Without a param the API did not say what it disliked; text.format is still the only
  // structured-output-specific thing in the body, so fall back rather than fail the call.
  return !error.param || /text|format|schema/i.test(error.param);
}

function finishReasonOf(result: CollectedResponse): FinishReason {
  if (result.outcome === 'completed') return 'stop';
  if (result.incompleteReason === 'max_output_tokens') return 'length';
  if (result.incompleteReason === 'content_filter') return 'content_filter';
  return 'unknown';
}

interface ResponsesBody {
  model: string;
  instructions?: string;
  input: Array<{ role: 'user' | 'assistant'; content: string }>;
  store: false;
  stream: true;
  text?: { format: Record<string, unknown> };
}

export function buildResponsesBody(
  messages: ChatMessage[],
  options: GenerateOptions | undefined,
  model: string,
  extra: { instructionsSuffix?: string; textFormat?: Record<string, unknown> } = {},
): ResponsesBody {
  const { system, turns } = splitSystem(messages, options);
  const instructions = [system, extra.instructionsSuffix].filter(Boolean).join('\n\n');
  return {
    model,
    ...(instructions ? { instructions } : {}),
    input: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    store: false,
    stream: true,
    ...(extra.textFormat ? { text: { format: extra.textFormat } } : {}),
  };
}

export class ChatGptProvider implements AIProvider {
  readonly name = PROVIDER;

  isConfigured(): boolean {
    return isChatGptReady();
  }

  listModels(): ModelDescriptor[] {
    return toModelDescriptors(chatGptStatusSync().models);
  }

  /** Built-in model per role from the plan's own model list (see `pickDefaultModels`). */
  defaultModel(role: ModelRole): string | null {
    return pickDefaultModels(chatGptStatusSync().models)[role];
  }

  private resolveModel(options: GenerateOptions | undefined, role: ModelRole = 'reasoning'): string {
    const model = options?.model ?? this.defaultModel(role);
    if (!model) {
      throw new IntegrationNotConfiguredError(
        'ChatGPT',
        'No ChatGPT model is available for this plan yet. Refresh the model list in Settings → AI providers.',
      );
    }
    return model;
  }

  /** One Responses call: token, request, stream; one forced refresh on a 401. */
  private async call(body: ResponsesBody, signal: AbortSignal | undefined, onDelta?: (delta: string) => void): Promise<CollectedResponse> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await getChatGptAccessToken({ force: attempt > 0 });
      let response: Response;
      try {
        response = await fetch(CHATGPT_RESPONSES_URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(body),
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw classifyResponsesError({ status: null, code: null, message: err instanceof Error ? err.message : String(err) });
      }

      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '');
        let code: string | null = null;
        let message: string | null = text.slice(0, 300) || null;
        let param: string | null = null;
        try {
          const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown; param?: unknown } };
          code = typeof parsed.error?.code === 'string' ? parsed.error.code : null;
          message = typeof parsed.error?.message === 'string' ? parsed.error.message : message;
          param = typeof parsed.error?.param === 'string' ? parsed.error.param : null;
        } catch {
          // Not JSON: the status alone decides.
        }
        const error = classifyResponsesError({ status: response.status, code, message, param });
        // A rejected token is first assumed stale (refresh once); only a terminal refresh
        // failure — handled inside getChatGptAccessToken — means the user must sign in again.
        if (error.kind === 'invalid-user' && attempt === 0) continue;
        throw await this.noted(error);
      }

      try {
        const result = await collectResponse(readSse(response.body), onDelta);
        void clearChatGptError();
        return result;
      } catch (err) {
        if (err instanceof ChatGptError) throw await this.noted(err);
        throw err;
      }
    }
    throw await this.noted(classifyResponsesError({ status: 401, code: 'subscription_sharing_invalid_user', message: 'Rejected after a token refresh' }));
  }

  /** Persist the errors the operator needs to see in Settings, then rethrow. */
  private async noted(error: ChatGptError): Promise<ChatGptError> {
    if (error.needsReauth) {
      await markChatGptNeedsReauth(error);
    } else if (['usage-limit', 'not-eligible', 'not-authorized', 'invalid-user', 'plan-not-granted'].includes(error.kind)) {
      await recordChatGptError(error);
    }
    return error;
  }

  async generate(messages: ChatMessage[], options?: GenerateOptions): Promise<GenerateResult> {
    const model = this.resolveModel(options);
    const started = Date.now();
    const result = await this.call(buildResponsesBody(messages, options, model), options?.signal);
    return {
      text: result.text,
      model: result.model ?? model,
      provider: PROVIDER,
      finishReason: finishReasonOf(result),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: 0,
      latencyMs: Date.now() - started,
    };
  }

  async generateStructured<T>(
    messages: ChatMessage[],
    schema: z.ZodType<T>,
    options?: StructuredOptions,
  ): Promise<StructuredResult<T>> {
    const model = this.resolveModel(options);
    const started = Date.now();
    const strictSchema = zodToJsonSchema(schema, { strict: true });
    const native = isObjectRoot(strictSchema) && !nativeSchemaUnsupported;
    const promptJson = jsonFallbackInstruction(zodToJsonSchema(schema));

    let result: CollectedResponse;
    if (native) {
      try {
        result = await this.call(
          buildResponsesBody(messages, options, model, {
            textFormat: {
              type: 'json_schema',
              name: toSchemaName(options?.schemaName ?? 'response'),
              schema: strictSchema,
              strict: true,
              ...(options?.schemaDescription ? { description: options.schemaDescription } : {}),
            },
          }),
          options?.signal,
        );
      } catch (err) {
        if (!shouldFallBackToPromptJson(err)) throw err;
        nativeSchemaUnsupported = true;
        log.info('ChatGPT plan route rejected text.format; using prompt-instructed JSON from now on');
        result = await this.call(buildResponsesBody(messages, options, model, { instructionsSuffix: promptJson }), options?.signal);
      }
    } else {
      result = await this.call(buildResponsesBody(messages, options, model, { instructionsSuffix: promptJson }), options?.signal);
    }

    const resolvedModel = result.model ?? model;
    const usage = { tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: 0, latencyMs: Date.now() - started };
    const context = { raw: result.text, usage, provider: PROVIDER, model: resolvedModel, finishReason: finishReasonOf(result) };
    // A SchemaValidationError from here is what the shared repair loop in structured.ts expects.
    const data = validateOrThrow(schema, parseJsonLoose(result.text), context);
    return { data, raw: result.text, provider: PROVIDER, model: resolvedModel, finishReason: context.finishReason, ...usage, repairAttempts: 0 };
  }

  async embed(): Promise<EmbedResult> {
    throw new IntegrationNotConfiguredError(
      'ChatGPT embeddings',
      'ChatGPT plan usage only serves the Responses API, so it cannot produce embeddings. Semantic features use another configured provider or fall back to lexical similarity.',
    );
  }

  async *stream(messages: ChatMessage[], options?: GenerateOptions): AsyncIterable<string> {
    const model = this.resolveModel(options, 'writing');
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failure: unknown = null;

    const done = this.call(buildResponsesBody(messages, options, model), options?.signal, (delta) => {
      queue.push(delta);
      wake?.();
    })
      .catch((err: unknown) => {
        failure = err;
      })
      .finally(() => {
        finished = true;
        wake?.();
      });

    while (!finished || queue.length) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = null;
    }
    await done;
    if (failure) throw failure;
  }
}
