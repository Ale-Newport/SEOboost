import { z } from 'zod';

/**
 * Minimal Zod → JSON Schema converter.
 *
 * Deliberately hand-rolled rather than pulled from npm: the provider structured-output modes
 * each accept a different *subset* of JSON Schema, and we only need the node kinds this app's
 * prompt schemas actually use. A general converter emits `$ref`/`$defs`/`allOf` shapes that
 * OpenAI strict mode and Gemini's `responseJsonSchema` both reject.
 */

export type JsonSchema = Record<string, unknown>;

export interface ZodToJsonSchemaOptions {
  /**
   * OpenAI strict structured outputs: every property must appear in `required` and
   * `additionalProperties` must be false. Optional fields are therefore emitted as nullable
   * instead of omitted, and validation constraints (min/max/format) are dropped because the
   * strict subset rejects them.
   */
  strict?: boolean;
}

/**
 * Depth at which conversion stops descending and emits an unconstrained schema.
 *
 * `z.lazy()` makes a recursive schema possible, and a naive walk of one never terminates —
 * a stack overflow inside a request handler, not a caught error. Provider structured-output
 * modes reject deep nesting anyway (OpenAI strict mode caps at 5 levels), so the cut-off is
 * well past anything a prompt schema legitimately uses.
 */
const MAX_DEPTH = 24;

/** Convert a Zod schema into a JSON Schema object suitable for provider structured output. */
export function zodToJsonSchema(
  schema: z.ZodTypeAny,
  options: ZodToJsonSchemaOptions = {},
): JsonSchema {
  return convert(schema, options.strict === true, 0);
}

function convert(node: z.ZodTypeAny, strict: boolean, depth: number): JsonSchema {
  // An empty schema accepts anything; the Zod validation pass downstream is the real gate.
  if (depth > MAX_DEPTH) return {};
  const body = convertNode(node, strict, depth);
  const description = node.description;
  return description ? { ...body, description } : body;
}

function convertNode(node: z.ZodTypeAny, strict: boolean, depth: number): JsonSchema {
  // Wrappers first — they delegate to the inner type. They do not add a level of nesting, but
  // they do count towards the depth budget so a pathological wrapper chain still terminates.
  const next = depth + 1;
  if (node instanceof z.ZodOptional) return convert(node.unwrap(), strict, next);
  if (node instanceof z.ZodNullable) return makeNullable(convert(node.unwrap(), strict, next));
  if (node instanceof z.ZodDefault) return convert(node.removeDefault(), strict, next);
  if (node instanceof z.ZodCatch) return convert(node.removeCatch(), strict, next);
  if (node instanceof z.ZodEffects) return convert(node.innerType(), strict, next);
  if (node instanceof z.ZodBranded) return convert(node.unwrap(), strict, next);
  if (node instanceof z.ZodReadonly) return convert(node.unwrap(), strict, next);
  if (node instanceof z.ZodLazy) return convert(node.schema, strict, next);
  if (node instanceof z.ZodPipeline) return convert(node._def.out, strict, next);

  if (node instanceof z.ZodObject) return convertObject(node, strict, next);
  if (node instanceof z.ZodArray) return convertArray(node, strict, next);
  if (node instanceof z.ZodTuple) return convertTuple(node, strict, next);
  if (node instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: convert(node.valueSchema, strict, next) };
  }

  if (node instanceof z.ZodString) return convertString(node, strict);
  if (node instanceof z.ZodNumber) return convertNumber(node, strict);
  if (node instanceof z.ZodBoolean) return { type: 'boolean' };
  if (node instanceof z.ZodBigInt) return { type: 'integer' };
  if (node instanceof z.ZodDate) return { type: 'string', format: 'date-time' };
  if (node instanceof z.ZodNull) return { type: 'null' };

  if (node instanceof z.ZodLiteral) return convertLiteral(node.value);
  if (node instanceof z.ZodEnum) return { type: 'string', enum: [...node.options] };
  if (node instanceof z.ZodNativeEnum) return convertNativeEnum(node);

  if (node instanceof z.ZodDiscriminatedUnion) {
    return { anyOf: node.options.map((option: z.ZodTypeAny) => convert(option, strict, next)) };
  }
  if (node instanceof z.ZodUnion) {
    return { anyOf: node.options.map((option: z.ZodTypeAny) => convert(option, strict, next)) };
  }

  // ZodAny / ZodUnknown / anything exotic: an empty schema accepts everything, which is the
  // safest fallback — the Zod validation pass downstream is the real gate.
  return {};
}

function convertObject(node: z.ZodObject<z.ZodRawShape>, strict: boolean, depth: number): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(node.shape)) {
    const optional = isOptional(value);
    const child = convert(value, strict, depth);
    // Strict mode has no notion of an absent key, so an optional field becomes nullable and
    // is still listed as required. The Zod pass then turns `null` back into `undefined`.
    properties[key] = strict && optional ? makeNullable(child) : child;
    if (!optional || strict) required.push(key);
  }

  const schema: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function convertArray(node: z.ZodArray<z.ZodTypeAny>, strict: boolean, depth: number): JsonSchema {
  const schema: JsonSchema = { type: 'array', items: convert(node.element, strict, depth) };
  if (!strict) {
    const min = node._def.minLength?.value;
    const max = node._def.maxLength?.value;
    const exact = node._def.exactLength?.value;
    if (typeof exact === 'number') {
      schema.minItems = exact;
      schema.maxItems = exact;
    } else {
      if (typeof min === 'number') schema.minItems = min;
      if (typeof max === 'number') schema.maxItems = max;
    }
  }
  return schema;
}

function convertTuple(node: z.ZodTuple, strict: boolean, depth: number): JsonSchema {
  const items = node.items.map((item: z.ZodTypeAny) => convert(item, strict, depth));
  return { type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length };
}

function convertString(node: z.ZodString, strict: boolean): JsonSchema {
  const schema: JsonSchema = { type: 'string' };
  if (strict) return schema;
  for (const check of node._def.checks) {
    switch (check.kind) {
      case 'min':
        schema.minLength = check.value;
        break;
      case 'max':
        schema.maxLength = check.value;
        break;
      case 'email':
        schema.format = 'email';
        break;
      case 'url':
        schema.format = 'uri';
        break;
      case 'uuid':
        schema.format = 'uuid';
        break;
      case 'datetime':
        schema.format = 'date-time';
        break;
      case 'regex':
        schema.pattern = check.regex.source;
        break;
      default:
        break;
    }
  }
  return schema;
}

function convertNumber(node: z.ZodNumber, strict: boolean): JsonSchema {
  const isInt = node._def.checks.some((check) => check.kind === 'int');
  const schema: JsonSchema = { type: isInt ? 'integer' : 'number' };
  if (strict) return schema;
  for (const check of node._def.checks) {
    if (check.kind === 'min') {
      if (check.inclusive) schema.minimum = check.value;
      else schema.exclusiveMinimum = check.value;
    } else if (check.kind === 'max') {
      if (check.inclusive) schema.maximum = check.value;
      else schema.exclusiveMaximum = check.value;
    }
  }
  return schema;
}

function convertLiteral(value: unknown): JsonSchema {
  // `const` is not accepted by every provider; a single-member `enum` is understood everywhere.
  if (typeof value === 'string') return { type: 'string', enum: [value] };
  if (typeof value === 'number') return { type: 'number', enum: [value] };
  if (typeof value === 'boolean') return { type: 'boolean', enum: [value] };
  if (value === null) return { type: 'null' };
  return {};
}

function convertNativeEnum(node: z.ZodNativeEnum<z.EnumLike>): JsonSchema {
  const values = Object.values(node._def.values).filter(
    (value): value is string | number => typeof value === 'string' || typeof value === 'number',
  );
  const allStrings = values.every((value) => typeof value === 'string');
  return { type: allStrings ? 'string' : 'number', enum: values };
}

/** Widen a schema so `null` is also accepted, keeping the `type` compact where possible. */
function makeNullable(schema: JsonSchema): JsonSchema {
  const type = schema.type;
  if (typeof type === 'string') return { ...schema, type: [type, 'null'] };
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] };
  }
  if (Array.isArray(schema.anyOf)) {
    return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

function isOptional(node: z.ZodTypeAny): boolean {
  if (node instanceof z.ZodOptional) return true;
  if (node instanceof z.ZodDefault) return true;
  if (node instanceof z.ZodEffects) return isOptional(node.innerType());
  return false;
}

/**
 * Sanitise a schema name for provider APIs, which restrict it to `[a-zA-Z0-9_-]`.
 * Used for OpenAI `response_format.json_schema.name` and the Anthropic forced-tool name.
 */
export function toSchemaName(name: string, fallback = 'response'): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  return (cleaned || fallback).slice(0, 64);
}
