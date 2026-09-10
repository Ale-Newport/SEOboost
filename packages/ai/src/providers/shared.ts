import { ProviderError } from '@seo/shared';
import type { ChatMessage, GenerateOptions, ProviderName } from '../types';
import type { JsonSchema } from '../json-schema';

/** Helpers shared by the three provider adapters. Not exported from the package barrel. */

export interface SplitMessages {
  /** Merged system prompt: `options.system` first, then any leading system messages. */
  system?: string;
  /** Conversation without system turns, ready for providers that model them separately. */
  turns: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/**
 * Anthropic and Gemini carry the system prompt outside the message list, and OpenAI is happy
 * either way — so every adapter normalises through here. System turns that appear mid-thread
 * are folded into the single system block rather than dropped.
 */
export function splitSystem(messages: ChatMessage[], options?: GenerateOptions): SplitMessages {
  const systemParts: string[] = [];
  if (options?.system?.trim()) systemParts.push(options.system.trim());

  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content.trim()) systemParts.push(message.content.trim());
      continue;
    }
    turns.push({ role: message.role, content: message.content });
  }

  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    turns,
  };
}

/**
 * HTTP statuses worth retrying. 408/409/429 and 5xx are transient; a missing status means the
 * request never reached the API (DNS, socket, timeout) which is also worth another go.
 * Everything else (400/401/403/404/422) is a permanent, caller-side problem.
 */
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 409 || status === 429) return true;
  return status >= 500;
}

export function providerError(
  provider: ProviderName,
  message: string,
  status: number | undefined,
): ProviderError {
  return new ProviderError(provider, message, isRetryableStatus(status));
}

/**
 * Prompt-instructed JSON, used only when a provider cannot express the schema natively
 * (non-object roots, or a model that rejects the structured-output parameter). Weaker than
 * native mode, which is why the repair loop in structured.ts still guards the result.
 */
export function jsonFallbackInstruction(schema: JsonSchema): string {
  return [
    'Respond with a single JSON value that validates against this JSON Schema:',
    '',
    JSON.stringify(schema, null, 2),
    '',
    'Rules:',
    '- Output raw JSON only. No markdown fences, no commentary before or after.',
    '- Use exactly the property names in the schema; do not add properties.',
    '- If a value is genuinely unknown, use null or an empty array rather than inventing one.',
  ].join('\n');
}

/** True when the converted schema has an object at its root, which native modes require. */
export function isObjectRoot(schema: JsonSchema): boolean {
  return schema.type === 'object';
}

export function clampTemperature(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(2, Math.max(0, value));
}
