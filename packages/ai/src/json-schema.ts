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

/** Any Zod 4 schema node; object shapes are typed with the core interface, not the classic one. */
type ZodNode = z.core.$ZodType;

/** Convert a Zod schema into a JSON Schema object suitable for provider structured output. */
export function zodToJsonSchema(
  schema: ZodNode,
  options: ZodToJsonSchemaOptions = {},
): JsonSchema {
  return convert(schema, options.strict === true, 0);
}

/**
 * The fields this converter reads from a Zod 4 check definition (`schema._zod.def.checks[i]._zod.def`).
 * A string-format schema such as `z.email()` carries the same fields on its own definition.
 */
interface CheckDef {
  check?: string;
  format?: string;
  value?: unknown;
  inclusive?: boolean;
  minimum?: number;
  maximum?: number;
  length?: number;
  pattern?: RegExp;
}

function convert(node: ZodNode, strict: boolean, depth: number): JsonSchema {
  // An empty schema accepts anything; the Zod validation pass downstream is the real gate.
  if (depth > MAX_DEPTH) return {};
  const body = convertNode(node, strict, depth);
  const description = node instanceof z.ZodType ? node.description : undefined;
  return description ? { ...body, description } : body;
}

function convertNode(node: ZodNode, strict: boolean, depth: number): JsonSchema {
  // Wrappers first — they delegate to the inner type. They do not add a level of nesting, but
  // they do count towards the depth budget so a pathological wrapper chain still terminates.
  // (Zod 4 has no wrapper for `.refine()` or `.brand()`: both return the same kind of schema.)
  const next = depth + 1;
  if (node instanceof z.ZodOptional) return convert(node.unwrap(), strict, next);
  if (node instanceof z.ZodNullable) return makeNullable(convert(node.unwrap(), strict, next));
  if (node instanceof z.ZodDefault) return convert(node.unwrap(), strict, next);
  if (node instanceof z.ZodCatch) return convert(node.unwrap(), strict, next);
  if (node instanceof z.ZodReadonly) return convert(node.unwrap(), strict, next);
  if (node instanceof z.ZodLazy) return convert(node.unwrap(), strict, next);
  // `.transform()` is `pipe(schema, transform)` and `z.preprocess()` is `pipe(transform, schema)`:
  // describe the side that is a real schema. A plain `.pipe(target)` describes the target.
  if (node instanceof z.ZodPipe) {
    const { in: input, out } = node._zod.def;
    return convert(out instanceof z.ZodTransform ? input : out, strict, next);
  }

  if (node instanceof z.ZodObject) return convertObject(node, strict, next);
  if (node instanceof z.ZodArray) return convertArray(node, strict, next);
  if (node instanceof z.ZodTuple) return convertTuple(node, strict, next);
  if (node instanceof z.ZodRecord) {
    return { type: 'object', additionalProperties: convert(node.valueType, strict, next) };
  }

  if (node instanceof z.ZodString || node instanceof z.ZodStringFormat) {
    return convertString(node, strict);
  }
  if (node instanceof z.ZodNumber) return convertNumber(node, strict);
  if (node instanceof z.ZodBoolean) return { type: 'boolean' };
  if (node instanceof z.ZodBigInt) return { type: 'integer' };
  if (node instanceof z.ZodDate) return { type: 'string', format: 'date-time' };
  if (node instanceof z.ZodNull) return { type: 'null' };

  if (node instanceof z.ZodLiteral) {
    const values = node._zod.def.values;
    if (values.length === 1) return convertLiteral(values[0]);
    return { anyOf: values.map((value) => convertLiteral(value)) };
  }
  // `z.enum([...])` and `z.nativeEnum(...)` are the same class in Zod 4.
  if (node instanceof z.ZodEnum) return convertEnum(node);

  // Covers `z.discriminatedUnion()` too: it is a `ZodUnion` subclass in Zod 4.
  if (node instanceof z.ZodUnion) {
    return { anyOf: node.options.map((option: ZodNode) => convert(option, strict, next)) };
  }

  // ZodAny / ZodUnknown / anything exotic: an empty schema accepts everything, which is the
  // safest fallback — the Zod validation pass downstream is the real gate.
  return {};
}

function convertObject(node: z.ZodObject, strict: boolean, depth: number): JsonSchema {
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

function convertArray(node: z.ZodArray, strict: boolean, depth: number): JsonSchema {
  const schema: JsonSchema = { type: 'array', items: convert(node.element, strict, depth) };
  if (!strict) {
    // The last check of each kind wins, and an exact length beats min/max.
    let min: number | undefined;
    let max: number | undefined;
    let exact: number | undefined;
    for (const check of checkDefs(node)) {
      if (check.check === 'min_length') min = check.minimum;
      else if (check.check === 'max_length') max = check.maximum;
      else if (check.check === 'length_equals') exact = check.length;
    }
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
  const items = node._zod.def.items.map((item: ZodNode) => convert(item, strict, depth));
  return { type: 'array', prefixItems: items, minItems: items.length, maxItems: items.length };
}

function convertString(node: z.ZodString | z.ZodStringFormat, strict: boolean): JsonSchema {
  const schema: JsonSchema = { type: 'string' };
  if (strict) return schema;
  for (const check of checkDefs(node)) {
    if (check.check === 'min_length') {
      schema.minLength = check.minimum;
    } else if (check.check === 'max_length') {
      schema.maxLength = check.maximum;
    } else if (check.check === 'string_format') {
      // Only the formats the providers understand. Others (`startsWith`, `cuid`, `ipv4`, …)
      // also carry a `pattern` internally, but are deliberately not exposed as one.
      switch (check.format) {
        case 'email':
          schema.format = 'email';
          break;
        case 'url':
          schema.format = 'uri';
          break;
        case 'uuid':
        case 'guid':
          schema.format = 'uuid';
          break;
        case 'datetime':
          schema.format = 'date-time';
          break;
        case 'regex':
          if (check.pattern) schema.pattern = check.pattern.source;
          break;
        default:
          break;
      }
    }
  }
  return schema;
}

const INTEGER_FORMATS = new Set(['safeint', 'int32', 'uint32']);

function convertNumber(node: z.ZodNumber, strict: boolean): JsonSchema {
  const checks = checkDefs(node);
  const isInt = checks.some(
    (check) => check.check === 'number_format' && INTEGER_FORMATS.has(check.format ?? ''),
  );
  const schema: JsonSchema = { type: isInt ? 'integer' : 'number' };
  if (strict) return schema;
  for (const check of checks) {
    if (check.check === 'greater_than') {
      if (check.inclusive) schema.minimum = check.value;
      else schema.exclusiveMinimum = check.value;
    } else if (check.check === 'less_than') {
      if (check.inclusive) schema.maximum = check.value;
      else schema.exclusiveMaximum = check.value;
    }
  }
  return schema;
}

/**
 * The check definitions attached to a schema, in the order they were added. A format schema
 * (`z.email()`, `z.int()`) is itself a check, so its own definition is included first.
 */
function checkDefs(node: ZodNode): CheckDef[] {
  const def = node._zod.def;
  const own = 'check' in def ? [def as CheckDef] : [];
  return [...own, ...(def.checks ?? []).map((check) => check._zod.def as CheckDef)];
}

function convertLiteral(value: unknown): JsonSchema {
  // `const` is not accepted by every provider; a single-member `enum` is understood everywhere.
  if (typeof value === 'string') return { type: 'string', enum: [value] };
  if (typeof value === 'number') return { type: 'number', enum: [value] };
  if (typeof value === 'boolean') return { type: 'boolean', enum: [value] };
  if (value === null) return { type: 'null' };
  return {};
}

function convertEnum(node: z.ZodEnum): JsonSchema {
  // Read the raw entries rather than `options`: for a numeric TypeScript enum this keeps the
  // reverse-mapped member names, exactly as the Zod 3 `nativeEnum` conversion emitted them.
  const values = Object.values(node._zod.def.entries).filter(
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

function isOptional(node: ZodNode): boolean {
  if (node instanceof z.ZodOptional) return true;
  if (node instanceof z.ZodDefault) return true;
  // A transform or preprocess is optional when the schema it wraps is; a plain `.pipe()` is not.
  if (node instanceof z.ZodPipe) {
    const { in: input, out } = node._zod.def;
    if (out instanceof z.ZodTransform) return isOptional(input);
    if (input instanceof z.ZodTransform) return isOptional(out);
  }
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
