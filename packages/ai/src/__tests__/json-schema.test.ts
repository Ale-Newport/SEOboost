import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toSchemaName, zodToJsonSchema } from '../json-schema';

/**
 * Representative of the shape the prompt schemas actually use: nested objects, arrays of
 * objects, enums, optionals, nullables, bounded numbers and a union.
 */
const briefSchema = z.object({
  angle: z.string().min(10).max(300).describe('One-sentence thesis'),
  intent: z.enum(['INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL']),
  targetWordCount: z.number().int().min(300).max(5000),
  confidence: z.number().min(0).max(1),
  sections: z.array(
    z.object({
      heading: z.string(),
      wordBudget: z.number().int(),
      requiresHumanInput: z.boolean().default(false),
    }),
  ),
  canonicalUrl: z.string().url().nullable(),
  notes: z.string().optional(),
  verdict: z.union([z.literal('PASS'), z.literal('BLOCK')]),
});

describe('zodToJsonSchema', () => {
  const schema = zodToJsonSchema(briefSchema);

  it('emits an object root with only the required keys listed', () => {
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual([
      'angle',
      'intent',
      'targetWordCount',
      'confidence',
      'sections',
      'canonicalUrl',
      'verdict',
    ]);
    expect(schema.required).not.toContain('notes');
  });

  it('carries string constraints, descriptions and enums', () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.angle).toMatchObject({
      type: 'string',
      minLength: 10,
      maxLength: 300,
      description: 'One-sentence thesis',
    });
    expect(properties.intent).toMatchObject({
      type: 'string',
      enum: ['INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL'],
    });
  });

  it('distinguishes integers from floats and keeps bounds', () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.targetWordCount).toMatchObject({
      type: 'integer',
      minimum: 300,
      maximum: 5000,
    });
    expect(properties.confidence).toMatchObject({ type: 'number', minimum: 0, maximum: 1 });
  });

  it('converts arrays of objects recursively and unwraps defaults', () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    const sections = properties.sections as { type: string; items: Record<string, unknown> };
    expect(sections.type).toBe('array');
    const items = sections.items as {
      type: string;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(items.type).toBe('object');
    // `requiresHumanInput` has a default, so it is optional and stays out of `required`.
    expect(items.required).toEqual(['heading', 'wordBudget']);
    expect(items.properties.requiresHumanInput).toEqual({ type: 'boolean' });
  });

  it('widens nullables and flattens unions to anyOf', () => {
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.canonicalUrl).toMatchObject({ type: ['string', 'null'], format: 'uri' });
    expect(properties.verdict).toEqual({
      anyOf: [
        { type: 'string', enum: ['PASS'] },
        { type: 'string', enum: ['BLOCK'] },
      ],
    });
  });

  it('makes every property required and nullable in strict mode', () => {
    const strict = zodToJsonSchema(briefSchema, { strict: true });
    expect(strict.required).toContain('notes');
    const properties = strict.properties as Record<string, Record<string, unknown>>;
    expect(properties.notes).toEqual({ type: ['string', 'null'] });
    // Validation keywords are dropped: OpenAI strict mode rejects them.
    expect(properties.angle).toEqual({
      type: 'string',
      description: 'One-sentence thesis',
    });
    expect(properties.targetWordCount).toEqual({ type: 'integer' });
  });

  it('detects non-object roots so callers can pick the prompt fallback', () => {
    expect(zodToJsonSchema(z.array(z.string())).type).toBe('array');
  });
});

describe('toSchemaName', () => {
  it('strips characters the provider APIs reject', () => {
    expect(toSchemaName('content brief/v2')).toBe('content_brief_v2');
  });

  it('falls back when nothing usable survives', () => {
    expect(toSchemaName('///')).toBe('response');
  });
});
