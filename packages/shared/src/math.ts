/** Numeric helpers shared by every scoring surface. */

export function clamp(value: number, min = 0, max = 1): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function safeDivide(numerator: number, denominator: number, fallback = 0): number {
  if (!denominator || !Number.isFinite(denominator)) return fallback;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : fallback;
}

/** Map a value from [min,max] onto [0,1], clamped. */
export function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp((value - min) / (max - min));
}

/** Diminishing-returns normaliser: fast growth then a long tail. `k` is the half-way point. */
export function saturate(value: number, k: number): number {
  if (value <= 0 || k <= 0) return 0;
  return value / (value + k);
}

/** Log-scale normaliser for heavy-tailed metrics like impressions. */
export function logNormalize(value: number, max: number): number {
  if (value <= 0) return 0;
  if (max <= 1) return clamp(value / Math.max(max, 1));
  return clamp(Math.log10(1 + value) / Math.log10(1 + max));
}

export function percentChange(before: number, after: number): number | null {
  if (before === 0) return after === 0 ? 0 : null;
  return round(((after - before) / Math.abs(before)) * 100, 2);
}

export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

export function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

/**
 * Welch's t-test approximation returning a two-sided p-value.
 * Used by the experiment engine to label results "likely positive / inconclusive /
 * likely negative" — never to claim causation.
 */
export function welchTTest(a: number[], b: number[]): { t: number; df: number; p: number } | null {
  if (a.length < 3 || b.length < 3) return null;
  const ma = mean(a);
  const mb = mean(b);
  const va = stdDev(a) ** 2;
  const vb = stdDev(b) ** 2;
  const na = a.length;
  const nb = b.length;
  const se = Math.sqrt(va / na + vb / nb);
  if (se === 0) return null;
  const t = (mb - ma) / se;
  const df =
    (va / na + vb / nb) ** 2 /
    ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
  return { t: round(t, 4), df: round(df, 2), p: round(twoSidedPFromT(Math.abs(t), df), 4) };
}

/** Student-t two-sided p-value via the incomplete beta function. */
function twoSidedPFromT(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return 1;
  const x = df / (df + t * t);
  return clamp(incompleteBeta(x, df / 2, 0.5), 0, 1);
}

function logGamma(x: number): number {
  const cof = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j]! / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(lbeta) * betaContinuedFraction(x, a, b)) / a;
  return 1 - (Math.exp(lbeta) * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const MAX_ITER = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Cosine similarity between two equal-length embedding vectors. */
export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Expected organic CTR for a SERP position. Derived from published aggregate
 * click-curve studies; used only to flag *relative* CTR underperformance,
 * never presented as a guaranteed value.
 */
const CTR_CURVE: Record<number, number> = {
  1: 0.283, 2: 0.152, 3: 0.101, 4: 0.071, 5: 0.052, 6: 0.04, 7: 0.032, 8: 0.026,
  9: 0.022, 10: 0.019, 11: 0.016, 12: 0.014, 13: 0.013, 14: 0.012, 15: 0.011,
  16: 0.01, 17: 0.009, 18: 0.008, 19: 0.008, 20: 0.007,
};

export function expectedCtr(position: number): number {
  if (!Number.isFinite(position) || position < 1) return CTR_CURVE[1]!;
  const p = Math.round(position);
  if (p <= 20) return CTR_CURVE[p] ?? 0.007;
  if (p <= 30) return 0.005;
  if (p <= 50) return 0.003;
  if (p <= 100) return 0.001;
  return 0.0005;
}

/** How far below (negative) or above (positive) the curve an actual CTR sits, as a ratio. */
export function ctrDelta(position: number, actualCtr: number): number {
  const expected = expectedCtr(position);
  if (expected === 0) return 0;
  return round((actualCtr - expected) / expected, 3);
}
