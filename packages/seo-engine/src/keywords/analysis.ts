import {
  SEO_THRESHOLDS,
  clamp,
  ctrDelta,
  expectedCtr,
  normalizeKeyword,
  percentChange,
  round,
} from '@seo/shared';

/** A query × page × period aggregate, the unit every analysis below works on. */
export interface QueryPageAggregate {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface PeriodComparison<T> {
  current: T[];
  previous: T[];
}

export interface StrikingDistanceKeyword {
  query: string;
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  /** Clicks we would expect if the query moved into the top 3. */
  potentialClicks: number;
  reason: string;
}

/**
 * Queries ranking just off page one (default 8-20) with real impression volume.
 * These are the cheapest wins in SEO: the page already has relevance, it needs a push.
 */
export function findStrikingDistance(
  rows: QueryPageAggregate[],
  opts: { min?: number; max?: number; minImpressions?: number } = {},
): StrikingDistanceKeyword[] {
  const min = opts.min ?? SEO_THRESHOLDS.strikingDistance.min;
  const max = opts.max ?? SEO_THRESHOLDS.strikingDistance.max;
  const minImpressions = opts.minImpressions ?? 20;

  return rows
    .filter((r) => r.position >= min && r.position <= max && r.impressions >= minImpressions)
    .map((r) => {
      // Model the win as reaching position 3, a realistic target from striking distance.
      const target = expectedCtr(3);
      const potentialClicks = Math.max(0, Math.round(r.impressions * target - r.clicks));
      return {
        query: r.query,
        page: r.page,
        position: round(r.position, 1),
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: round(r.ctr, 4),
        potentialClicks,
        reason:
          `Ranking ${r.position.toFixed(1)} for "${r.query}" with ${r.impressions.toLocaleString()} impressions. ` +
          `Reaching the top 3 would be worth roughly ${potentialClicks.toLocaleString()} additional clicks per period.`,
      };
    })
    .sort((a, b) => b.potentialClicks - a.potentialClicks);
}

export interface CtrOpportunity {
  query: string;
  page: string;
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  expectedCtr: number;
  deltaRatio: number;
  potentialClicks: number;
  reason: string;
}

/** Pages/queries ranking well but under-clicked versus the position/CTR curve. */
export function findCtrOpportunities(
  rows: QueryPageAggregate[],
  opts: { minImpressions?: number; maxPosition?: number; minDeltaRatio?: number } = {},
): CtrOpportunity[] {
  const minImpressions = opts.minImpressions ?? SEO_THRESHOLDS.ctrOpportunity.minImpressions;
  const maxPosition = opts.maxPosition ?? SEO_THRESHOLDS.ctrOpportunity.maxPosition;
  const minDeltaRatio = opts.minDeltaRatio ?? SEO_THRESHOLDS.ctrOpportunity.minDeltaRatio;

  const out: CtrOpportunity[] = [];
  for (const r of rows) {
    if (r.impressions < minImpressions || r.position > maxPosition) continue;
    const delta = ctrDelta(r.position, r.ctr);
    if (delta > minDeltaRatio) continue;
    const expected = expectedCtr(r.position);
    const potentialClicks = Math.max(0, Math.round(r.impressions * expected - r.clicks));
    if (potentialClicks < 1) continue;
    out.push({
      query: r.query,
      page: r.page,
      position: round(r.position, 1),
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: round(r.ctr, 4),
      expectedCtr: round(expected, 4),
      deltaRatio: round(delta, 3),
      potentialClicks,
      reason:
        `"${r.query}" averages position ${r.position.toFixed(1)} with ${r.impressions.toLocaleString()} impressions but ` +
        `only ${(r.ctr * 100).toFixed(2)}% CTR versus ~${(expected * 100).toFixed(1)}% typical. ` +
        `A stronger title and meta description is worth about ${potentialClicks.toLocaleString()} clicks.`,
    });
  }
  return out.sort((a, b) => b.potentialClicks - a.potentialClicks);
}

export interface DecayingPage {
  page: string;
  clicksBefore: number;
  clicksAfter: number;
  clicksChangePct: number;
  impressionsBefore: number;
  impressionsAfter: number;
  impressionsChangePct: number | null;
  positionBefore: number;
  positionAfter: number;
  positionChange: number;
  lostQueries: string[];
  severity: 'high' | 'medium' | 'low';
  reason: string;
}

/**
 * Pages losing organic traffic between two equal-length periods.
 *
 * Distinguishes *ranking* decay (position worsened) from *demand* decay (impressions fell while
 * position held) — they need completely different responses, so the reason text says which.
 */
export function findDecayingPages(
  comparison: PeriodComparison<QueryPageAggregate>,
  opts: { minClicksBefore?: number; dropPct?: number } = {},
): DecayingPage[] {
  const minClicksBefore = opts.minClicksBefore ?? SEO_THRESHOLDS.decay.minClicksBefore;
  const dropPct = opts.dropPct ?? SEO_THRESHOLDS.decay.dropPct;

  const before = aggregateByPage(comparison.previous);
  const after = aggregateByPage(comparison.current);

  const out: DecayingPage[] = [];
  for (const [page, prev] of before) {
    if (prev.clicks < minClicksBefore) continue;
    const curr = after.get(page) ?? { clicks: 0, impressions: 0, position: prev.position, queries: new Map<string, number>() };
    const clicksChange = percentChange(prev.clicks, curr.clicks);
    if (clicksChange === null || clicksChange > dropPct) continue;

    const lostQueries = [...prev.queries.keys()]
      .filter((q) => !curr.queries.has(q))
      .sort((a, b) => (prev.queries.get(b) ?? 0) - (prev.queries.get(a) ?? 0))
      .slice(0, 10);

    const positionChange = round(curr.position - prev.position, 1);
    const impressionsChange = percentChange(prev.impressions, curr.impressions);
    const severity = clicksChange <= -60 ? 'high' : clicksChange <= -40 ? 'medium' : 'low';

    const rankingDriven = positionChange > 1.5;
    const demandDriven = !rankingDriven && impressionsChange !== null && impressionsChange < -20;

    out.push({
      page,
      clicksBefore: prev.clicks,
      clicksAfter: curr.clicks,
      clicksChangePct: clicksChange,
      impressionsBefore: prev.impressions,
      impressionsAfter: curr.impressions,
      impressionsChangePct: impressionsChange,
      positionBefore: round(prev.position, 1),
      positionAfter: round(curr.position, 1),
      positionChange,
      lostQueries,
      severity,
      reason: rankingDriven
        ? `Clicks fell ${Math.abs(Math.round(clicksChange))}% and average position slipped ${positionChange.toFixed(1)} places — ` +
          `this is ranking loss, most likely to competitors publishing fresher or more complete content` +
          (lostQueries.length ? `. Queries no longer ranking: ${lostQueries.slice(0, 3).join(', ')}` : '') + '.'
        : demandDriven
          ? `Clicks fell ${Math.abs(Math.round(clicksChange))}% while position held at ${curr.position.toFixed(1)} and impressions ` +
            `dropped ${Math.abs(Math.round(impressionsChange ?? 0))}% — this looks like falling search demand or seasonality, not a ranking problem.`
          : `Clicks fell ${Math.abs(Math.round(clicksChange))}% with position roughly stable — check for SERP layout changes ` +
            `(AI overviews, more ads, new rich results) compressing click-through.`,
    });
  }
  return out.sort((a, b) => a.clicksChangePct - b.clicksChangePct);
}

function aggregateByPage(rows: QueryPageAggregate[]) {
  const map = new Map<
    string,
    { clicks: number; impressions: number; position: number; queries: Map<string, number> }
  >();
  const weightedPosition = new Map<string, number>();
  for (const r of rows) {
    let entry = map.get(r.page);
    if (!entry) {
      entry = { clicks: 0, impressions: 0, position: 0, queries: new Map() };
      map.set(r.page, entry);
      weightedPosition.set(r.page, 0);
    }
    entry.clicks += r.clicks;
    entry.impressions += r.impressions;
    entry.queries.set(r.query, (entry.queries.get(r.query) ?? 0) + r.clicks);
    weightedPosition.set(r.page, (weightedPosition.get(r.page) ?? 0) + r.position * r.impressions);
  }
  for (const [page, entry] of map) {
    entry.position = entry.impressions > 0 ? (weightedPosition.get(page) ?? 0) / entry.impressions : 0;
  }
  return map;
}

export interface CannibalizationGroup {
  query: string;
  totalImpressions: number;
  totalClicks: number;
  pages: Array<{ page: string; clicks: number; impressions: number; position: number; share: number }>;
  bestPage: string;
  severity: 'high' | 'medium' | 'low';
  recommendation: string;
  reason: string;
}

/**
 * Keyword cannibalisation: one query pulling impressions across several URLs.
 *
 * Not every multi-URL query is a problem — a brand query legitimately matches many pages. We
 * flag it only when a genuine competitor exists: a second URL with a meaningful impression share
 * AND a position close enough that the engine is plausibly alternating between them.
 */
export function findCannibalization(
  rows: QueryPageAggregate[],
  opts: { minImpressions?: number; minSecondaryShare?: number; maxPositionSpread?: number } = {},
): CannibalizationGroup[] {
  const minImpressions = opts.minImpressions ?? SEO_THRESHOLDS.cannibalization.minImpressions;
  const minSecondaryShare = opts.minSecondaryShare ?? 0.15;
  const maxPositionSpread = opts.maxPositionSpread ?? SEO_THRESHOLDS.cannibalization.maxPositionSpread;

  const byQuery = new Map<string, QueryPageAggregate[]>();
  for (const r of rows) {
    const key = normalizeKeyword(r.query);
    const list = byQuery.get(key);
    if (list) list.push(r);
    else byQuery.set(key, [r]);
  }

  const out: CannibalizationGroup[] = [];
  for (const [, group] of byQuery) {
    if (group.length < 2) continue;
    const totalImpressions = group.reduce((s, r) => s + r.impressions, 0);
    if (totalImpressions < minImpressions) continue;

    const sorted = [...group].sort((a, b) => b.impressions - a.impressions);
    const primary = sorted[0]!;
    const secondary = sorted[1]!;
    const secondaryShare = secondary.impressions / totalImpressions;
    if (secondaryShare < minSecondaryShare) continue;
    if (Math.abs(primary.position - secondary.position) > maxPositionSpread) continue;

    const totalClicks = group.reduce((s, r) => s + r.clicks, 0);
    const best = [...group].sort((a, b) => a.position - b.position)[0]!;
    const competing = sorted.filter((r) => r.impressions / totalImpressions >= minSecondaryShare);
    const severity = competing.length >= 3 ? 'high' : secondaryShare >= 0.35 ? 'medium' : 'low';

    out.push({
      query: primary.query,
      totalImpressions,
      totalClicks,
      pages: sorted.map((r) => ({
        page: r.page,
        clicks: r.clicks,
        impressions: r.impressions,
        position: round(r.position, 1),
        share: round(r.impressions / totalImpressions, 3),
      })),
      bestPage: best.page,
      severity,
      recommendation:
        `Choose ${best.page} as the canonical answer for "${primary.query}". Fold the unique value from the other ` +
        `page(s) into it, then either 301-redirect them or re-target them at a distinct query, and point their ` +
        `internal links at the winner.`,
      reason:
        `${competing.length} URLs compete for "${primary.query}" (${totalImpressions.toLocaleString()} impressions). ` +
        `The engine is splitting relevance signals instead of consolidating them onto one page.`,
    });
  }
  return out.sort((a, b) => b.totalImpressions - a.totalImpressions);
}

export interface QueryGrowth {
  query: string;
  clicksBefore: number;
  clicksAfter: number;
  clicksChange: number;
  positionBefore: number;
  positionAfter: number;
  positionChange: number;
  status: 'new' | 'improved' | 'declined' | 'lost' | 'stable';
}

/** Query-level movement between two periods, used for the weekly report and the site timeline. */
export function compareQueries(comparison: PeriodComparison<QueryPageAggregate>): QueryGrowth[] {
  const agg = (rows: QueryPageAggregate[]) => {
    const map = new Map<string, { clicks: number; impressions: number; weightedPos: number }>();
    for (const r of rows) {
      const key = normalizeKeyword(r.query);
      const e = map.get(key) ?? { clicks: 0, impressions: 0, weightedPos: 0 };
      e.clicks += r.clicks;
      e.impressions += r.impressions;
      e.weightedPos += r.position * r.impressions;
      map.set(key, e);
    }
    return map;
  };
  const before = agg(comparison.previous);
  const after = agg(comparison.current);
  const queries = new Set([...before.keys(), ...after.keys()]);

  const out: QueryGrowth[] = [];
  for (const query of queries) {
    const b = before.get(query);
    const a = after.get(query);
    const positionBefore = b && b.impressions > 0 ? b.weightedPos / b.impressions : 0;
    const positionAfter = a && a.impressions > 0 ? a.weightedPos / a.impressions : 0;
    const clicksBefore = b?.clicks ?? 0;
    const clicksAfter = a?.clicks ?? 0;
    const positionChange = b && a ? round(positionBefore - positionAfter, 1) : 0;

    let status: QueryGrowth['status'];
    if (!b) status = 'new';
    else if (!a) status = 'lost';
    else if (positionChange >= 1 || clicksAfter > clicksBefore * 1.2) status = 'improved';
    else if (positionChange <= -1 || clicksAfter < clicksBefore * 0.8) status = 'declined';
    else status = 'stable';

    out.push({
      query,
      clicksBefore,
      clicksAfter,
      clicksChange: clicksAfter - clicksBefore,
      positionBefore: round(positionBefore, 1),
      positionAfter: round(positionAfter, 1),
      positionChange,
      status,
    });
  }
  return out;
}

/** Rough commercial value of a query from its wording. Deterministic, locale-aware-ish. */
export function inferBusinessValue(query: string, intent?: string | null): number {
  const q = query.toLowerCase();
  let value = 0.35;
  if (intent === 'TRANSACTIONAL') value = 0.9;
  else if (intent === 'COMMERCIAL') value = 0.75;
  else if (intent === 'LOCAL') value = 0.7;
  else if (intent === 'NAVIGATIONAL') value = 0.5;
  else if (intent === 'INFORMATIONAL') value = 0.35;

  const commercialMarkers = ['buy', 'price', 'pricing', 'cost', 'cheap', 'discount', 'deal', 'coupon',
    'best', 'top', 'review', 'vs', 'versus', 'alternative', 'comparison', 'software', 'tool', 'app',
    'service', 'agency', 'near me', 'hire', 'plan', 'subscription', 'free trial', 'demo',
    'comprar', 'precio', 'mejor', 'opiniones'];
  const informationalMarkers = ['what is', 'how to', 'why', 'guide', 'tutorial', 'meaning', 'definition',
    'examples', 'ideas', 'que es', 'como', 'por que'];

  if (commercialMarkers.some((m) => q.includes(m))) value = Math.max(value, 0.7);
  if (informationalMarkers.some((m) => q.startsWith(m) || q.includes(` ${m} `))) value = Math.min(value, 0.45);
  return clamp(value);
}

/** Deterministic intent classification. The LLM refines this; it never starts from nothing. */
export function inferIntent(query: string): 'INFORMATIONAL' | 'NAVIGATIONAL' | 'COMMERCIAL' | 'TRANSACTIONAL' | 'LOCAL' | 'UNKNOWN' {
  const q = query.toLowerCase().trim();
  if (!q) return 'UNKNOWN';

  const local = ['near me', 'nearby', 'in my area', 'open now', 'cerca de mi', 'directions to'];
  if (local.some((m) => q.includes(m))) return 'LOCAL';

  const transactional = ['buy', 'purchase', 'order', 'checkout', 'coupon', 'discount code', 'for sale',
    'sign up', 'subscribe', 'download', 'free trial', 'get started', 'comprar', 'descargar'];
  if (transactional.some((m) => q.includes(m))) return 'TRANSACTIONAL';

  const commercial = ['best', 'top ', 'review', 'reviews', 'vs', 'versus', 'compare', 'comparison',
    'alternative', 'alternatives', 'pricing', 'price', 'cost', 'cheapest', 'mejor', 'opiniones'];
  if (commercial.some((m) => q.includes(m))) return 'COMMERCIAL';

  const informational = ['what', 'how', 'why', 'when', 'where', 'who', 'guide', 'tutorial', 'examples',
    'ideas', 'tips', 'meaning', 'definition', 'que', 'como', 'por que'];
  if (informational.some((m) => q.startsWith(`${m} `) || q === m)) return 'INFORMATIONAL';

  // Single- or two-word queries that look like a brand or product name.
  if (q.split(/\s+/).length <= 2 && !/\d/.test(q)) return 'NAVIGATIONAL';
  return 'INFORMATIONAL';
}

export function inferFunnelStage(intent: string): 'AWARENESS' | 'CONSIDERATION' | 'DECISION' | 'UNKNOWN' {
  switch (intent) {
    case 'INFORMATIONAL':
      return 'AWARENESS';
    case 'COMMERCIAL':
      return 'CONSIDERATION';
    case 'TRANSACTIONAL':
    case 'LOCAL':
      return 'DECISION';
    case 'NAVIGATIONAL':
      return 'DECISION';
    default:
      return 'UNKNOWN';
  }
}

/** Is this query likely to be answered by an AI assistant rather than a blue link? */
export function estimateGeoPotential(query: string, intent: string): number {
  const q = query.toLowerCase();
  let score = 0.35;
  if (intent === 'INFORMATIONAL') score = 0.6;
  if (intent === 'COMMERCIAL') score = 0.75; // "best X" / "X vs Y" are heavily synthesised
  if (intent === 'TRANSACTIONAL') score = 0.4;
  if (intent === 'NAVIGATIONAL') score = 0.25;

  const synthesisMarkers = ['best', 'top', 'vs', 'versus', 'alternative', 'compare', 'how to', 'what is',
    'which', 'should i', 'is it worth', 'pros and cons', 'difference between'];
  if (synthesisMarkers.some((m) => q.includes(m))) score += 0.2;
  // Long, conversational queries are exactly what people type into assistants.
  const words = q.split(/\s+/).length;
  if (words >= 6) score += 0.15;
  else if (words <= 2) score -= 0.1;
  return clamp(score);
}
