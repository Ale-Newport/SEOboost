import { describe, expect, it } from 'vitest';
import { estimateCost, getModelPrice, hasPrice } from '../pricing';

describe('estimateCost', () => {
  it('prices a known model from the per-1M-token table', () => {
    // gpt-5: $1.25 / 1M in, $10 / 1M out.
    expect(estimateCost('openai', 'gpt-5', 1_000_000, 100_000)).toBeCloseTo(2.25, 6);
  });

  it('prices a dated model snapshot via its longest known prefix', () => {
    expect(estimateCost('anthropic', 'claude-haiku-4-5-20251001', 1_000_000, 1_000_000)).toBeCloseTo(
      6,
      6,
    );
  });

  it('prefers the longest matching prefix over a shorter one', () => {
    // `gpt-5-mini` must not be priced as `gpt-5`.
    expect(estimateCost('openai', 'gpt-5-mini-2025-08-07', 1_000_000, 0)).toBeCloseTo(0.25, 6);
  });

  it('normalises the Gemini `models/` prefix', () => {
    expect(estimateCost('gemini', 'models/gemini-2.5-flash', 1_000_000, 0)).toBeCloseTo(0.3, 6);
  });

  it('charges nothing for output on an embedding model', () => {
    expect(estimateCost('openai', 'text-embedding-3-small', 1_000_000, 0)).toBeCloseTo(0.02, 6);
  });

  it('returns 0 for an unpriced model rather than guessing', () => {
    expect(estimateCost('openai', 'some-unreleased-model', 1_000_000, 1_000_000)).toBe(0);
    expect(hasPrice('openai', 'some-unreleased-model')).toBe(false);
    expect(getModelPrice('openai', 'some-unreleased-model')).toBeNull();
  });

  it('treats missing or negative token counts as zero', () => {
    expect(estimateCost('openai', 'gpt-5', Number.NaN, -5)).toBe(0);
  });

  it('rounds to micro-dollars so cheap calls are not rounded away', () => {
    expect(estimateCost('openai', 'gpt-5-nano', 1000, 1000)).toBeCloseTo(0.00045, 6);
  });
});
