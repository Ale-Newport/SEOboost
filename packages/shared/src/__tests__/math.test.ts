import { describe, expect, it } from 'vitest';
import { cosineSimilarity, ctrDelta, expectedCtr, logNormalize, normalize, percentChange, saturate, welchTTest } from '../math';
import { fleschReadingEase, jaccardSimilarity, keywordDensity, markdownToText, slugify } from '../text';
import { contentHash, simhash, simhashDistance } from '../hash';

describe('normalisers', () => {
  it('normalize maps into [0,1] and clamps', () => {
    expect(normalize(5, 0, 10)).toBe(0.5);
    expect(normalize(-5, 0, 10)).toBe(0);
    expect(normalize(50, 0, 10)).toBe(1);
    expect(normalize(5, 5, 5)).toBe(0);
  });

  it('saturate has diminishing returns and hits 0.5 at k', () => {
    expect(saturate(10, 10)).toBeCloseTo(0.5, 5);
    expect(saturate(0, 10)).toBe(0);
    expect(saturate(1000, 10)).toBeGreaterThan(0.98);
  });

  it('logNormalize compresses heavy tails', () => {
    expect(logNormalize(0, 1000)).toBe(0);
    expect(logNormalize(1000, 1000)).toBeCloseTo(1, 5);
    expect(logNormalize(100, 1000)).toBeGreaterThan(0.6);
  });

  it('percentChange handles a zero baseline', () => {
    expect(percentChange(100, 150)).toBe(50);
    expect(percentChange(100, 50)).toBe(-50);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(0, 10)).toBeNull();
  });
});

describe('CTR curve', () => {
  it('decreases monotonically across the first page', () => {
    for (let position = 1; position < 10; position++) {
      expect(expectedCtr(position)).toBeGreaterThan(expectedCtr(position + 1));
    }
  });

  it('reports the shortfall relative to the curve', () => {
    const expected = expectedCtr(3);
    expect(ctrDelta(3, expected)).toBeCloseTo(0, 3);
    expect(ctrDelta(3, expected / 2)).toBeCloseTo(-0.5, 2);
    expect(ctrDelta(3, expected * 2)).toBeCloseTo(1, 2);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe('welchTTest', () => {
  it('separates clearly different samples', () => {
    const a = [10, 11, 9, 10, 12, 11, 10, 9, 11, 10];
    const b = [20, 21, 19, 22, 20, 21, 19, 20, 22, 21];
    const result = welchTTest(a, b);
    expect(result).not.toBeNull();
    expect(result!.p).toBeLessThan(0.01);
  });

  it('does not separate identical distributions', () => {
    const a = [10, 11, 9, 10, 12, 11, 10];
    const b = [10, 11, 9, 10, 12, 11, 10];
    expect(welchTTest(a, b)!.p).toBeGreaterThan(0.5);
  });

  it('returns null for samples that are too small', () => {
    expect(welchTTest([1, 2], [3, 4])).toBeNull();
  });
});

describe('text utilities', () => {
  it('slugifies with accent folding and length limits', () => {
    expect(slugify('¿Cómo hacer una rutina de gimnasio?')).toBe('como-hacer-una-rutina-de-gimnasio');
    expect(slugify('Hello   World!!')).toBe('hello-world');
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it('content hash ignores whitespace and case', () => {
    expect(contentHash('Hello   World')).toBe(contentHash('hello world'));
    expect(contentHash('Hello World')).not.toBe(contentHash('Hello Worlds'));
  });

  it('simhash distance is small for near-duplicates and large for unrelated text', () => {
    const a = 'The quick brown fox jumps over the lazy dog in the meadow every single morning.';
    const b = 'The quick brown fox jumps over the lazy dog in the meadow every single evening.';
    const c = 'Structured data helps search engines understand entities and their relationships.';
    expect(simhashDistance(simhash(a), simhash(b))).toBeLessThan(simhashDistance(simhash(a), simhash(c)));
  });

  it('jaccard similarity is 1 for identical text', () => {
    expect(jaccardSimilarity('workout planner app', 'workout planner app')).toBe(1);
    expect(jaccardSimilarity('workout planner', 'tax software')).toBe(0);
  });

  it('keyword density counts multi-word phrases', () => {
    const text = 'workout planner is great. Every workout planner needs a plan.';
    expect(keywordDensity(text, 'workout planner')).toBeGreaterThan(0.1);
    expect(keywordDensity(text, 'tax return')).toBe(0);
  });

  it('markdown is reduced to prose', () => {
    const md = '# Title\n\nSome **bold** text with a [link](https://x.com).\n\n```js\ncode()\n```\n\n- item';
    const text = markdownToText(md);
    expect(text).toContain('Some bold text with a link.');
    expect(text).not.toContain('```');
    expect(text).not.toContain('https://x.com');
  });

  it('reading ease scores simple text higher than dense text', () => {
    const simple = 'The cat sat on the mat. It was warm. The sun was out. We were glad.';
    const dense =
      'Notwithstanding the aforementioned considerations, the implementation necessitates comprehensive ' +
      'architectural reconfiguration predicated upon multidimensional performance characteristics.';
    expect(fleschReadingEase(simple)).toBeGreaterThan(fleschReadingEase(dense));
  });
});
