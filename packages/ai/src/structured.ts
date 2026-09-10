import { AppError, ValidationError, createLogger, truncate } from '@seo/shared';
import { z } from 'zod';
import type {
  AIProvider,
  ChatMessage,
  FinishReason,
  ProviderName,
  StructuredOptions,
  StructuredResult,
  UsageFields,
} from './types';

const log = createLogger('ai:structured');

/**
 * Raised by a provider when the model answered but the answer does not match the schema.
 * Carries the raw text and the usage already paid for, so the repair loop can feed the
 * failure back to the model and still bill the attempt.
 */
export class SchemaValidationError extends ValidationError {
  readonly raw: string;
  readonly issues: string;
  readonly usage: UsageFields;
  readonly provider: ProviderName;
  readonly model: string;
  readonly finishReason: FinishReason;

  constructor(params: {
    issues: string;
    raw: string;
    usage: UsageFields;
    provider: ProviderName;
    model: string;
    finishReason: FinishReason;
  }) {
    super(`Model output failed schema validation: ${params.issues}`, {
      provider: params.provider,
      model: params.model,
      preview: truncate(params.raw, 500),
    });
    this.raw = params.raw;
    this.issues = params.issues;
    this.usage = params.usage;
    this.provider = params.provider;
    this.model = params.model;
    this.finishReason = params.finishReason;
  }
}

/** Flatten a ZodError into a compact, model-readable list of problems. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 20)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Validate `value` against `schema`, converting a failure into a SchemaValidationError that
 * the repair loop understands. Providers call this after their native structured request.
 */
export function validateOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: {
    raw: string;
    usage: UsageFields;
    provider: ProviderName;
    model: string;
    finishReason: FinishReason;
  },
): T {
  const first = schema.safeParse(value);
  if (first.success) return first.data;

  // Second chance before we spend a repair round-trip: OpenAI strict mode cannot omit a key,
  // so optional fields come back as explicit `null`. Rewrite those to `undefined` where the
  // schema wants absence rather than null, then validate again.
  const retry = schema.safeParse(normalizeNullables(schema, value));
  if (retry.success) return retry.data;

  throw new SchemaValidationError({ ...context, issues: formatZodIssues(first.error) });
}

/**
 * Walk a value alongside its schema, turning `null` into `undefined` wherever the schema
 * accepts absence but not null. Leaves genuinely nullable fields alone.
 */
export function normalizeNullables(schema: z.ZodTypeAny, value: unknown): unknown {
  if (value === null) {
    if (schema.safeParse(null).success) return null;
    if (schema.safeParse(undefined).success) return undefined;
    return null;
  }

  const core = unwrapSchema(schema);

  if (core instanceof z.ZodObject && isPlainObject(value)) {
    const shape: z.ZodRawShape = core.shape;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childSchema = shape[key];
      const next = childSchema ? normalizeNullables(childSchema, child) : child;
      if (next !== undefined) out[key] = next;
    }
    return out;
  }

  if (core instanceof z.ZodArray && Array.isArray(value)) {
    const element: z.ZodTypeAny = core.element;
    return value.map((item) => normalizeNullables(element, item));
  }

  return value;
}

function unwrapSchema(node: z.ZodTypeAny): z.ZodTypeAny {
  if (node instanceof z.ZodOptional || node instanceof z.ZodNullable) {
    return unwrapSchema(node.unwrap());
  }
  if (node instanceof z.ZodReadonly || node instanceof z.ZodBranded) {
    return unwrapSchema(node.unwrap());
  }
  if (node instanceof z.ZodDefault) return unwrapSchema(node.removeDefault());
  if (node instanceof z.ZodEffects) return unwrapSchema(node.innerType());
  return node;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface GenerateStructuredArgs {
  provider: AIProvider;
  messages: ChatMessage[];
  options?: StructuredOptions;
  /**
   * Extra round-trips allowed when the first answer fails validation. Each repair costs a
   * full call, so the default is deliberately small.
   */
  maxRepairAttempts?: number;
}

/**
 * Schema-guaranteed generation with a self-repair loop.
 *
 * The provider's native structured mode gets the first shot; when the result still fails Zod
 * validation the exact validation errors are appended to the conversation and the model is
 * asked again. This recovers the common failure modes (a missing optional, a stringified
 * number, an invented enum member) without a human in the loop, and gives up loudly rather
 * than returning half-valid data.
 */
export async function generateStructured<T>(
  schema: z.ZodType<T>,
  args: GenerateStructuredArgs,
): Promise<StructuredResult<T>> {
  const maxRepairAttempts = Math.max(0, args.maxRepairAttempts ?? 2);
  const messages: ChatMessage[] = [...args.messages];
  const totals: UsageFields = { tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0 };
  let repairAttempts = 0;
  let lastError: SchemaValidationError | undefined;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    try {
      const result = await args.provider.generateStructured(messages, schema, args.options);
      addUsage(totals, result);
      return { ...result, ...totals, repairAttempts };
    } catch (err) {
      if (!(err instanceof SchemaValidationError)) throw err;
      addUsage(totals, err.usage);
      lastError = err;
      if (attempt === maxRepairAttempts) break;

      repairAttempts += 1;
      log.warn('structured output failed validation, repairing', {
        provider: err.provider,
        model: err.model,
        attempt: attempt + 1,
        issues: err.issues,
      });
      messages.push({ role: 'assistant', content: err.raw });
      messages.push({ role: 'user', content: repairInstruction(err) });
    }
  }

  throw (
    lastError ??
    new AppError('Structured generation failed without a result', { code: 'AI_STRUCTURED_FAILED' })
  );
}

function repairInstruction(error: SchemaValidationError): string {
  return [
    `Your previous output failed validation: ${error.issues}`,
    '',
    'Fix exactly those problems and reply again.',
    'Reply with the corrected JSON object only — no prose, no apology, no markdown fences.',
    'Do not invent values to satisfy the schema: if a field is genuinely unknown, use the',
    'schema-permitted empty value (null, empty string or empty array) rather than a guess.',
  ].join('\n');
}

function addUsage(totals: UsageFields, part: UsageFields): void {
  totals.tokensIn += part.tokensIn;
  totals.tokensOut += part.tokensOut;
  totals.costUsd += part.costUsd;
  totals.latencyMs += part.latencyMs;
}

/**
 * Parse JSON out of a model response that may be wrapped in markdown fences or preceded by
 * chatter ("Sure! Here is the JSON:"). Tries, in order: the whole string, every fenced block,
 * then the first balanced `{…}` / `[…]` span. Throws ValidationError when nothing parses.
 */
export function parseJsonLoose(text: string): unknown {
  for (const candidate of jsonCandidates(text)) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next candidate
    }
  }
  throw new ValidationError('Model did not return parseable JSON', {
    preview: truncate(text, 500),
  });
}

function* jsonCandidates(text: string): Generator<string> {
  const trimmed = text.trim();
  if (!trimmed) return;
  yield trimmed;

  const fence = /```(?:json|json5|javascript)?\s*\n?([\s\S]*?)```/gi;
  for (const match of trimmed.matchAll(fence)) {
    const inner = match[1]?.trim();
    if (inner) yield inner;
  }

  // Unterminated fence: the model started ```json and ran out of tokens.
  const openFence = trimmed.match(/```(?:json|json5|javascript)?\s*\n?([\s\S]*)$/i);
  const openInner = openFence?.[1]?.trim();
  if (openInner) yield openInner;

  for (const source of [trimmed, openInner ?? '']) {
    if (!source) continue;
    // Whichever span *starts* first is the actual payload. Yielding `{…}` unconditionally
    // first turns a prose-prefixed top-level array ("Here you go:\n[{…},{…}]") into just its
    // first element, which parses cleanly and is silently wrong.
    const spans = [
      extractBalanced(source, '{', '}'),
      extractBalanced(source, '[', ']'),
    ].filter((span): span is { text: string; start: number } => span !== null);
    spans.sort((a, b) => a.start - b.start);
    for (const span of spans) yield span.text;
  }
}

/**
 * Return the first balanced `open…close` span with the offset it starts at, ignoring braces
 * inside string literals. A plain `indexOf`/`lastIndexOf` slice breaks as soon as the prose
 * after the JSON contains a brace, which model output frequently does. The offset lets the
 * caller decide which of two candidate spans is the real payload.
 */
function extractBalanced(
  text: string,
  open: string,
  close: string,
): { text: string; start: number } | null {
  const start = text.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return { text: text.slice(start, i + 1), start };
    }
  }
  return null;
}
