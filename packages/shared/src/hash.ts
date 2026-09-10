import { createHash } from 'node:crypto';
import { tokenize } from './text';

/**
 * Content hashing, kept in its own module because it needs `node:crypto`.
 *
 * `text.ts` deliberately does NOT import this: client components pull formatting and tokenising
 * helpers out of `@seo/shared`, and a top-level `node:crypto` import anywhere in that graph breaks
 * the browser bundle. Keeping the Node-only surface isolated lets the bundler drop it.
 */

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Content hash used for exact-duplicate detection — whitespace and case insensitive. */
export function contentHash(text: string): string {
  return sha256(text.toLowerCase().replace(/\s+/g, ' ').trim());
}

/**
 * 64-bit SimHash over token shingles, returned as a hex string.
 * Used for near-duplicate detection where exact hashes miss reworded pages.
 */
export function simhash(text: string): string {
  const tokens = tokenize(text, { stopWords: false, minLength: 1 });
  if (tokens.length === 0) return '0'.repeat(16);
  const shingles: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    shingles.push(tokens[i]!);
    if (i + 1 < tokens.length) shingles.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  const bits = new Array<number>(64).fill(0);
  for (const shingle of shingles) {
    const digest = createHash('md5').update(shingle).digest();
    for (let bit = 0; bit < 64; bit++) {
      const byte = digest[bit >> 3]!;
      const isSet = (byte >> (7 - (bit & 7))) & 1;
      bits[bit] += isSet ? 1 : -1;
    }
  }
  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let value = 0;
    for (let b = 0; b < 4; b++) value = (value << 1) | (bits[nibble * 4 + b]! > 0 ? 1 : 0);
    hex += value.toString(16);
  }
  return hex;
}

/** Hamming distance between two simhashes (0 = identical, 64 = opposite). */
export function simhashDistance(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16);
    distance += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return distance;
}
