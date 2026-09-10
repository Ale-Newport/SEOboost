import { ProviderError, ValidationError, createLogger, errorMessage, retry } from '@seo/shared';
import type { z } from 'zod';
import { resolveModel } from './registry';
import type { ResolvedModel, WebsiteModelSettings } from './registry';
import { generateStructured as runStructured } from './structured';
import { assertWithinBudget, recordUsage } from './usage';
import type {
  ChatMessage,
  GenerateOptions,
  GenerateResult,
  ModelRole,
  StructuredResult,
} from './types';

const log = createLogger('ai:client');

/**
 * The façade every other package calls.
 *
 * A single entry point is what makes the platform's AI spend governable: routing, the budget
 * guard, retry policy and `AiUsage` accounting all live here, so no caller can accidentally
 * bypass them by reaching for a provider adapter directly.
 */

export interface AiCallOptions {
  /** Coarse label recorded in `AiUsage` — use the prompt id where there is one. */
  task: string;
  websiteId?: string | null;
  agent?: string | null;
  /** Which model class to route to. Defaults to `reasoning`. */
  role?: ModelRole;
  system?: string;
  /** Convenience for a single user turn. Ignored when `messages` is provided. */
  prompt?: string;
  messages?: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  /** Hard provider pin. Throws if that provider has no key. */
  providerOverride?: string | null;
  /** Hard model pin. */
  modelOverride?: string | null;
  /** The site's `WebsiteSettings` row, so per-site model routing is honoured. */
  settings?: WebsiteModelSettings | null;
  signal?: AbortSignal;
  /** Total provider attempts, including the first. Default 3. */
  attempts?: number;
}

export interface AiStructuredOptions<T> extends AiCallOptions {
  schema: z.ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
  /** Extra round-trips allowed when the answer fails schema validation. Default 2. */
  maxRepairAttempts?: number;
}

/** Retry only what the provider adapters flagged as transient — never a 4xx or a bad schema. */
function isRetryable(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

function buildMessages(options: AiCallOptions): ChatMessage[] {
  const messages: ChatMessage[] = options.messages ? [...options.messages] : [];
  if (!options.messages && options.prompt !== undefined) {
    messages.push({ role: 'user', content: options.prompt });
  }
  const hasUserTurn = messages.some((message) => message.role !== 'system');
  if (!hasUserTurn) {
    throw new ValidationError('An AI call needs either `prompt` or at least one non-system message', {
      task: options.task,
    });
  }
  return messages;
}

function providerOptions(options: AiCallOptions, route: ResolvedModel): GenerateOptions {
  return {
    model: route.model,
    ...(options.system ? { system: options.system } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.stopSequences?.length ? { stopSequences: options.stopSequences } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/** Everything a call does before touching a provider: budget guard, then routing. */
async function prepare(options: AiCallOptions, defaultRole: ModelRole): Promise<ResolvedModel> {
  // Budget first: an exhausted budget must not cost a settings round-trip either, and this is
  // the guard that stops an agent loop from spending without bound.
  await assertWithinBudget(options.websiteId ?? null);
  return resolveModel(options.role ?? defaultRole, {
    settings: options.settings,
    provider: options.providerOverride,
    model: options.modelOverride,
  });
}

async function recordFailure(
  options: AiCallOptions,
  route: ResolvedModel,
  startedAt: number,
  err: unknown,
): Promise<void> {
  log.warn('AI call failed', {
    task: options.task,
    provider: route.providerName,
    model: route.model,
    websiteId: options.websiteId ?? null,
    error: errorMessage(err),
  });
  // Tokens are unknown on a failure, so they stay 0 rather than being guessed; the row exists
  // so the failure rate and latency are still visible in the cost dashboard.
  await recordUsage({
    websiteId: options.websiteId ?? null,
    provider: route.providerName,
    model: route.model,
    task: options.task,
    agent: options.agent ?? null,
    latencyMs: Date.now() - startedAt,
    success: false,
  });
}

/** Free-text generation. Routes, guards the budget, retries transient provider errors, bills. */
export async function aiGenerate(options: AiCallOptions): Promise<GenerateResult> {
  const messages = buildMessages(options);
  const route = await prepare(options, 'reasoning');
  const startedAt = Date.now();

  try {
    const result = await retry(
      () => route.provider.generate(messages, providerOptions(options, route)),
      {
        attempts: options.attempts ?? 3,
        shouldRetry: isRetryable,
        ...(options.signal ? { signal: options.signal } : {}),
        onRetry: (err, attempt, delayMs) =>
          log.warn('retrying AI call', {
            task: options.task,
            provider: route.providerName,
            model: route.model,
            attempt,
            delayMs: Math.round(delayMs),
            error: errorMessage(err),
          }),
      },
    );

    await recordUsage({
      websiteId: options.websiteId ?? null,
      provider: result.provider,
      model: result.model,
      task: options.task,
      agent: options.agent ?? null,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      latencyMs: Date.now() - startedAt,
      success: true,
    });

    log.debug('AI call complete', {
      task: options.task,
      provider: result.provider,
      model: result.model,
      finishReason: result.finishReason,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      latencyMs: Date.now() - startedAt,
    });

    return result;
  } catch (err) {
    await recordFailure(options, route, startedAt, err);
    throw err;
  }
}

/**
 * Schema-guaranteed generation. The self-repair loop in structured.ts handles a malformed
 * answer; this layer only retries genuine transport failures, so a stubborn schema failure
 * surfaces as a `SchemaValidationError` instead of being retried three times at full price.
 */
export async function aiGenerateStructured<T>(
  options: AiStructuredOptions<T>,
): Promise<StructuredResult<T>> {
  const messages = buildMessages(options);
  const route = await prepare(options, 'reasoning');
  const startedAt = Date.now();

  try {
    const result = await retry(
      () =>
        runStructured(options.schema, {
          provider: route.provider,
          messages,
          options: {
            ...providerOptions(options, route),
            ...(options.schemaName ? { schemaName: options.schemaName } : { schemaName: options.task }),
            ...(options.schemaDescription ? { schemaDescription: options.schemaDescription } : {}),
          },
          ...(options.maxRepairAttempts === undefined
            ? {}
            : { maxRepairAttempts: options.maxRepairAttempts }),
        }),
      {
        attempts: options.attempts ?? 3,
        shouldRetry: isRetryable,
        ...(options.signal ? { signal: options.signal } : {}),
        onRetry: (err, attempt, delayMs) =>
          log.warn('retrying structured AI call', {
            task: options.task,
            provider: route.providerName,
            model: route.model,
            attempt,
            delayMs: Math.round(delayMs),
            error: errorMessage(err),
          }),
      },
    );

    await recordUsage({
      websiteId: options.websiteId ?? null,
      provider: result.provider,
      model: result.model,
      task: options.task,
      agent: options.agent ?? null,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      latencyMs: Date.now() - startedAt,
      success: true,
    });

    log.debug('structured AI call complete', {
      task: options.task,
      provider: result.provider,
      model: result.model,
      repairAttempts: result.repairAttempts,
      costUsd: result.costUsd,
      latencyMs: Date.now() - startedAt,
    });

    return result;
  } catch (err) {
    await recordFailure(options, route, startedAt, err);
    throw err;
  }
}

/**
 * Token stream for the UI. Not retried — a stream that fails mid-flight has already emitted
 * text to the client, so restarting it would duplicate output.
 *
 * The provider stream interface yields text only, so no token counts are available: the usage
 * row records the call and its latency with zero tokens rather than an invented estimate.
 */
export async function* aiStream(options: AiCallOptions): AsyncIterable<string> {
  const messages = buildMessages(options);
  const route = await prepare(options, 'writing');
  const startedAt = Date.now();
  let failed = false;

  try {
    for await (const delta of route.provider.stream(messages, providerOptions(options, route))) {
      yield delta;
    }
  } catch (err) {
    failed = true;
    await recordFailure(options, route, startedAt, err);
    throw err;
  } finally {
    // `finally` rather than a tail statement: a consumer that stops reading (client
    // disconnect, `break`, an error downstream) disposes the generator without running any
    // code after the loop, and the call still happened and still cost money.
    if (!failed) {
      await recordUsage({
        websiteId: options.websiteId ?? null,
        provider: route.providerName,
        model: route.model,
        task: options.task,
        agent: options.agent ?? null,
        latencyMs: Date.now() - startedAt,
        success: true,
      });
    }
  }
}

/**
 * Namespace form, so call sites read as `ai.generate(...)`. Identical to the named exports.
 */
export const ai = {
  generate: aiGenerate,
  generateStructured: aiGenerateStructured,
  stream: aiStream,
} as const;
