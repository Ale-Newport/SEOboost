import { describe, expect, it } from 'vitest';
import { extractVerifyMarkers } from '../content-writer-agent';

describe('extractVerifyMarkers', () => {
  it('collects trimmed, unique claims', () => {
    const markdown = 'A [VERIFY: 40% of users] claim. [verify:Founded in 1999] and [VERIFY:  40% of users ].';
    expect(extractVerifyMarkers(markdown)).toEqual(['40% of users', 'Founded in 1999']);
  });

  it('matches what /\\[VERIFY:\\s*([^\\]]+)\\]/gi captured', () => {
    const old = /\[VERIFY:\s*([^\]]+)\]/gi;
    const markdown = '[VERIFY:] [VERIFY:   ] [VERIFY: a [VERIFY: b] c] [VERIFY:\nmulti\nline] [VERIFY: open';
    const expected = [...new Set([...markdown.matchAll(old)].map((m) => (m[1] ?? '').trim()).filter(Boolean))];
    expect(extractVerifyMarkers(markdown)).toEqual(expected);
    expect(expected).toEqual(['a [VERIFY: b', 'multi\nline']);
  });

  it('runs in linear time on an unclosed marker', () => {
    const started = performance.now();
    expect(extractVerifyMarkers(`[VERIFY:${' '.repeat(50_000)}`)).toEqual([]);
    expect(extractVerifyMarkers('[VERIFY:a'.repeat(5_000))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
