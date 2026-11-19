import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../json-schema';

/**
 * Pins the exact JSON Schema the converter emitted on Zod 3 (captured from 3.25.76 before the
 * Zod 4 migration), so a change in Zod internals cannot silently alter what the providers see.
 * Key order is part of the contract: the non-native fallback embeds this JSON in the prompt.
 *
 * The schema covers every node kind and check the converter understands: nested objects and
 * arrays, optional / nullable / default, enums (incl. native), literals, unions, numeric bounds
 * (inclusive and exclusive), integer detection, string formats and patterns, array length,
 * tuples, records, descriptions, refinements, transforms, `.pipe()` and `z.preprocess()`.
 */

const Mode = { Auto: 'auto', Manual: 'manual' } as const;

const representativeSchema = z.object({
  title: z.string().min(5).max(120).describe('Page title'),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  contactEmail: z.string().email().optional(),
  canonicalUrl: z.string().url().nullable(),
  requestId: z.string().uuid(),
  publishedAt: z.string().datetime().nullable().optional(),
  status: z.enum(['DRAFT', 'REVIEW', 'PUBLISHED']).describe('Workflow state'),
  kind: z.literal('article'),
  priority: z.number().int().min(1).max(5),
  score: z.number().gt(0).lt(1),
  weight: z.number().nonnegative().optional(),
  tags: z.array(z.string().min(1)).min(1).max(10),
  pair: z.array(z.number()).length(2),
  sections: z
    .array(
      z.object({
        heading: z.string().describe('H2 text'),
        level: z.number().int().min(2).max(4).default(2),
        bullets: z.array(z.string()).max(8).optional(),
        sources: z
          .array(z.object({ url: z.string().url(), note: z.string().nullable() }))
          .nullable(),
      }),
    )
    .max(20),
  wordCount: z.string().transform((value) => Number(value)),
  normalisedTitle: z.string().trim().pipe(z.string().min(1)),
  confidence: z.preprocess((value) => value, z.number().min(0).max(1)),
  verdict: z.union([z.literal('PASS'), z.literal('BLOCK'), z.null()]),
  meta: z.record(z.string(), z.string()),
  checked: z.boolean().default(false),
  flagged: z.boolean().refine((value) => typeof value === 'boolean'),
  tuple: z.tuple([z.string(), z.number()]),
  mode: z.nativeEnum(Mode),
  target: z.discriminatedUnion('type', [
    z.object({ type: z.literal('page'), pageId: z.string() }),
    z.object({ type: z.literal('keyword'), keyword: z.string().max(80) }),
  ]),
});

const expectedLoose = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 5, maxLength: 120, description: 'Page title' },
    slug: { type: 'string', pattern: '^[a-z0-9-]+$' },
    contactEmail: { type: 'string', format: 'email' },
    canonicalUrl: { type: ['string', 'null'], format: 'uri' },
    requestId: { type: 'string', format: 'uuid' },
    publishedAt: { type: ['string', 'null'], format: 'date-time' },
    status: { type: 'string', enum: ['DRAFT', 'REVIEW', 'PUBLISHED'], description: 'Workflow state' },
    kind: { type: 'string', enum: ['article'] },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    score: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    weight: { type: 'number', minimum: 0 },
    tags: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 10 },
    pair: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'H2 text' },
          level: { type: 'integer', minimum: 2, maximum: 4 },
          bullets: { type: 'array', items: { type: 'string' }, maxItems: 8 },
          sources: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: { url: { type: 'string', format: 'uri' }, note: { type: ['string', 'null'] } },
              additionalProperties: false,
              required: ['url', 'note'],
            },
          },
        },
        additionalProperties: false,
        required: ['heading', 'sources'],
      },
      maxItems: 20,
    },
    wordCount: { type: 'string' },
    normalisedTitle: { type: 'string', minLength: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    verdict: {
      anyOf: [
        { type: 'string', enum: ['PASS'] },
        { type: 'string', enum: ['BLOCK'] },
        { type: 'null' },
      ],
    },
    meta: { type: 'object', additionalProperties: { type: 'string' } },
    checked: { type: 'boolean' },
    flagged: { type: 'boolean' },
    tuple: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      minItems: 2,
      maxItems: 2,
    },
    mode: { type: 'string', enum: ['auto', 'manual'] },
    target: {
      anyOf: [
        {
          type: 'object',
          properties: { type: { type: 'string', enum: ['page'] }, pageId: { type: 'string' } },
          additionalProperties: false,
          required: ['type', 'pageId'],
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['keyword'] },
            keyword: { type: 'string', maxLength: 80 },
          },
          additionalProperties: false,
          required: ['type', 'keyword'],
        },
      ],
    },
  },
  additionalProperties: false,
  required: [
    'title',
    'slug',
    'canonicalUrl',
    'requestId',
    'status',
    'kind',
    'priority',
    'score',
    'tags',
    'pair',
    'sections',
    'wordCount',
    'normalisedTitle',
    'confidence',
    'verdict',
    'meta',
    'flagged',
    'tuple',
    'mode',
    'target',
  ],
};

const expectedStrict = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Page title' },
    slug: { type: 'string' },
    contactEmail: { type: ['string', 'null'] },
    canonicalUrl: { type: ['string', 'null'] },
    requestId: { type: 'string' },
    publishedAt: { type: ['string', 'null'] },
    status: { type: 'string', enum: ['DRAFT', 'REVIEW', 'PUBLISHED'], description: 'Workflow state' },
    kind: { type: 'string', enum: ['article'] },
    priority: { type: 'integer' },
    score: { type: 'number' },
    weight: { type: ['number', 'null'] },
    tags: { type: 'array', items: { type: 'string' } },
    pair: { type: 'array', items: { type: 'number' } },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'H2 text' },
          level: { type: ['integer', 'null'] },
          bullets: { type: ['array', 'null'], items: { type: 'string' } },
          sources: {
            type: ['array', 'null'],
            items: {
              type: 'object',
              properties: { url: { type: 'string' }, note: { type: ['string', 'null'] } },
              additionalProperties: false,
              required: ['url', 'note'],
            },
          },
        },
        additionalProperties: false,
        required: ['heading', 'level', 'bullets', 'sources'],
      },
    },
    wordCount: { type: 'string' },
    normalisedTitle: { type: 'string' },
    confidence: { type: 'number' },
    verdict: {
      anyOf: [
        { type: 'string', enum: ['PASS'] },
        { type: 'string', enum: ['BLOCK'] },
        { type: 'null' },
      ],
    },
    meta: { type: 'object', additionalProperties: { type: 'string' } },
    checked: { type: ['boolean', 'null'] },
    flagged: { type: 'boolean' },
    tuple: {
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
      minItems: 2,
      maxItems: 2,
    },
    mode: { type: 'string', enum: ['auto', 'manual'] },
    target: {
      anyOf: [
        {
          type: 'object',
          properties: { type: { type: 'string', enum: ['page'] }, pageId: { type: 'string' } },
          additionalProperties: false,
          required: ['type', 'pageId'],
        },
        {
          type: 'object',
          properties: { type: { type: 'string', enum: ['keyword'] }, keyword: { type: 'string' } },
          additionalProperties: false,
          required: ['type', 'keyword'],
        },
      ],
    },
  },
  additionalProperties: false,
  required: [
    'title',
    'slug',
    'contactEmail',
    'canonicalUrl',
    'requestId',
    'publishedAt',
    'status',
    'kind',
    'priority',
    'score',
    'weight',
    'tags',
    'pair',
    'sections',
    'wordCount',
    'normalisedTitle',
    'confidence',
    'verdict',
    'meta',
    'checked',
    'flagged',
    'tuple',
    'mode',
    'target',
  ],
};

describe('zodToJsonSchema output is unchanged from the Zod 3 converter', () => {
  it('matches the captured non-strict schema exactly, key order included', () => {
    const actual = zodToJsonSchema(representativeSchema);
    expect(actual).toEqual(expectedLoose);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expectedLoose));
  });

  it('matches the captured strict-mode schema exactly, key order included', () => {
    const actual = zodToJsonSchema(representativeSchema, { strict: true });
    expect(actual).toEqual(expectedStrict);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expectedStrict));
  });
});
