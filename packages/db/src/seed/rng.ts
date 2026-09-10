/**
 * Deterministic pseudo-random numbers for the demo dataset.
 *
 * `Math.random()` is banned here: a seed that produces a different database on every run cannot
 * be reviewed in a diff, cannot be reproduced from a bug report, and makes "is this number real?"
 * unanswerable. mulberry32 is a 32-bit generator with no dependencies and no platform-specific
 * behaviour, so the same seed yields byte-identical demo data on every machine and Node version.
 */

/** mulberry32 — small, fast, adequate statistical quality for shaping demo curves. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * FNV-1a. Used to derive a per-site stream from the site's domain so each demo site has its own
 * reproducible shape without the sites accidentally sharing a sequence.
 */
export function seedFromString(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Convenience wrapper around `mulberry32` with the distributions the generators actually need. */
export class Rng {
  private readonly next01: () => number;

  constructor(seed: number | string) {
    this.next01 = mulberry32(typeof seed === 'string' ? seedFromString(seed) : seed);
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.next01();
  }

  /** Uniform in [min, max). */
  float(min: number, max: number): number {
    return min + this.next01() * (max - min);
  }

  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  bool(probability = 0.5): boolean {
    return this.next01() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next01() * items.length)];
  }

  /** `count` distinct items, in the order they appear in `items`. */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    const out: T[] = [];
    const take = Math.min(count, pool.length);
    for (let i = 0; i < take; i++) out.push(pool.splice(Math.floor(this.next01() * pool.length), 1)[0]);
    return out;
  }

  /**
   * Normal deviate (Box–Muller), clamped to ±3σ.
   *
   * Traffic series generated from a raw normal occasionally produce a spike big enough that the
   * demo looks broken rather than realistic; clamping keeps the shape without the outliers.
   */
  gauss(mean: number, stdDev: number): number {
    const u = Math.max(this.next01(), Number.EPSILON);
    const v = this.next01();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + Math.max(-3, Math.min(3, z)) * stdDev;
  }

  /** Multiplicative noise around 1 — `jitter(0.12)` returns roughly 0.88…1.12. */
  jitter(spread: number): number {
    return Math.max(0.05, this.gauss(1, spread / 2));
  }
}
