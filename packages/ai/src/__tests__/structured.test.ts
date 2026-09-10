import { ValidationError } from '@seo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { formatZodIssues, normalizeNullables, parseJsonLoose } from '../structured';

describe('parseJsonLoose', () => {
  it('parses a bare JSON object', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a fenced block', () => {
    const text = ['```json', '{ "verdict": "PASS", "score": 82 }', '```'].join('\n');
    expect(parseJsonLoose(text)).toEqual({ verdict: 'PASS', score: 82 });
  });

  it('parses a fenced block preceded by chatter', () => {
    const text = [
      'Sure! Here is the JSON you asked for:',
      '',
      '```json',
      '{ "items": [1, 2, 3] }',
      '```',
      '',
      'Let me know if you need anything else.',
    ].join('\n');
    expect(parseJsonLoose(text)).toEqual({ items: [1, 2, 3] });
  });

  it('parses an unterminated fence left by a truncated response', () => {
    const text = ['```json', '{ "ok": true }'].join('\n');
    expect(parseJsonLoose(text)).toEqual({ ok: true });
  });

  it('ignores braces that appear in prose after the JSON', () => {
    const text = 'Result: { "n": 1 } — note that {curly braces} are common in templates.';
    expect(parseJsonLoose(text)).toEqual({ n: 1 });
  });

  it('ignores braces inside string literals', () => {
    const text = 'Here: { "pattern": "a{2,3}", "closing": "}" } done';
    expect(parseJsonLoose(text)).toEqual({ pattern: 'a{2,3}', closing: '}' });
  });

  it('parses a bare top-level array', () => {
    expect(parseJsonLoose('[{"k":"a"},{"k":"b"}]')).toEqual([{ k: 'a' }, { k: 'b' }]);
  });

  it('parses a fenced top-level array', () => {
    const text = ['Here you go:', '```json', '[{"k":"a"},{"k":"b"}]', '```'].join('\n');
    expect(parseJsonLoose(text)).toEqual([{ k: 'a' }, { k: 'b' }]);
  });

  it('parses an unfenced top-level array preceded by prose', () => {
    // Regression: preferring the balanced {…} span returned the array's first element, which
    // parses cleanly and is silently wrong.
    const text = 'Here you go:\n[{"k":"a"},{"k":"b"}]';
    expect(parseJsonLoose(text)).toEqual([{ k: 'a' }, { k: 'b' }]);
  });

  it('still prefers an object that starts before an array in the prose', () => {
    const text = 'Result: {"items":[1,2]} — see [the docs] for more.';
    expect(parseJsonLoose(text)).toEqual({ items: [1, 2] });
  });

  it('throws a ValidationError when nothing parses', () => {
    expect(() => parseJsonLoose('I am afraid I cannot help with that.')).toThrow(ValidationError);
  });
});

describe('normalizeNullables', () => {
  it('turns a null into undefined where the schema wants absence, not null', () => {
    const schema = z.object({ a: z.string().optional(), b: z.string().nullable() });
    expect(normalizeNullables(schema, { a: null, b: null })).toEqual({ b: null });
  });

  it('recurses through arrays of objects', () => {
    const schema = z.object({ rows: z.array(z.object({ note: z.string().optional() })) });
    expect(normalizeNullables(schema, { rows: [{ note: null }, { note: 'x' }] })).toEqual({
      rows: [{}, { note: 'x' }],
    });
  });
});

describe('formatZodIssues', () => {
  it('flattens issues into a compact, model-readable list', () => {
    const schema = z.object({ score: z.number(), tags: z.array(z.string()) });
    const result = schema.safeParse({ score: 'high', tags: [1] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = formatZodIssues(result.error);
    expect(issues).toContain('score:');
    expect(issues).toContain('tags.0:');
  });
});
