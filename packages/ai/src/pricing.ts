import { createLogger, round } from '@seo/shared';
import type { ProviderName } from './types';

const log = createLogger('ai:pricing');

/**
 * Per-1M-token list prices in USD.
 *
 * OPERATOR-EDITABLE: vendor prices change often and this table WILL drift. It exists so the
 * cost dashboard and the monthly budget guard have a number to work with — it is an estimate,
 * never an invoice. Update it when a vendor changes pricing, or override a model by adding a
 * row here. Unknown models deliberately cost 0 (with a warning) rather than a guessed price:
 * a silently wrong price is worse than a visible zero.
 *
 * Prices below reflect published standard-tier text pricing (no batch/cache discounts).
 * Cached-input and batch discounts are not modelled, so real spend is usually a little lower.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. Embedding models have no output charge. */
  output: number;
}

export const PRICING: Record<ProviderName, Record<string, ModelPrice>> = {
  anthropic: {
    'claude-opus-5': { input: 5, output: 25 },
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-opus-4-1': { input: 15, output: 75 },
    'claude-sonnet-4-5': { input: 3, output: 15 },
  },
  openai: {
    'gpt-5': { input: 1.25, output: 10 },
    'gpt-5-mini': { input: 0.25, output: 2 },
    'gpt-5-nano': { input: 0.05, output: 0.4 },
    'gpt-4.1': { input: 2, output: 8 },
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
    'gpt-4o': { input: 2.5, output: 10 },
    'gpt-4o-mini': { input: 0.15, output: 0.6 },
    'text-embedding-3-small': { input: 0.02, output: 0 },
    'text-embedding-3-large': { input: 0.13, output: 0 },
  },
  gemini: {
    'gemini-2.5-pro': { input: 1.25, output: 10 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
    'gemini-embedding-001': { input: 0.15, output: 0 },
  },
};

/** Warn once per unknown id — a hot loop must not spam the log with the same miss. */
const warnedUnknown = new Set<string>();
/** Cap on the memo above: model ids come from operator settings, so the set is small, but an
 * unbounded process-lifetime set is a leak waiting for the one install that rotates ids. */
const WARNED_UNKNOWN_LIMIT = 200;

/**
 * Vendors append dated suffixes to ids (`claude-haiku-4-5-20251001`, `gpt-5-2025-08-07`,
 * `models/gemini-2.5-pro`). Normalise the shape, then fall back to the longest known prefix
 * so a dated snapshot of a priced model is still costed correctly.
 */
function lookup(provider: ProviderName, model: string): ModelPrice | undefined {
  const table = PRICING[provider];
  const id = model.trim().replace(/^models\//, '');
  const exact = table[id];
  if (exact) return exact;

  let best: { key: string; price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table)) {
    if (!id.startsWith(key)) continue;
    if (!best || key.length > best.key.length) best = { key, price };
  }
  return best?.price;
}

/**
 * Estimated USD cost of one call. Returns 0 for a model we have no price for, so an unknown
 * model degrades to "free" in the dashboard instead of inventing a plausible-looking number.
 */
export function estimateCost(
  provider: ProviderName,
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const price = lookup(provider, model);
  if (!price) {
    const key = `${provider}:${model}`;
    if (!warnedUnknown.has(key)) {
      if (warnedUnknown.size >= WARNED_UNKNOWN_LIMIT) warnedUnknown.clear();
      warnedUnknown.add(key);
      log.warn('no price entry for model — cost recorded as 0', { provider, model });
    }
    return 0;
  }
  const inTokens = Number.isFinite(tokensIn) && tokensIn > 0 ? tokensIn : 0;
  const outTokens = Number.isFinite(tokensOut) && tokensOut > 0 ? tokensOut : 0;
  const cost = (inTokens / 1_000_000) * price.input + (outTokens / 1_000_000) * price.output;
  // 6 decimals: a single cheap call can legitimately cost a few micro-dollars.
  return round(cost, 6);
}

/** True when the table has a price for this model — used to flag "unpriced" rows in the UI. */
export function hasPrice(provider: ProviderName, model: string): boolean {
  return lookup(provider, model) !== undefined;
}

/** The price row a model resolves to (after suffix normalisation), for the pricing settings UI. */
export function getModelPrice(provider: ProviderName, model: string): ModelPrice | null {
  return lookup(provider, model) ?? null;
}
