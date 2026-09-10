import {
  KEYWORD_OPPORTUNITY_WEIGHTS,
  clamp,
  ctrDelta,
  expectedCtr,
  logNormalize,
  round,
  saturate,
  type ExplainableScore,
  type ScoreFactor,
} from '@seo/shared';

export interface KeywordOpportunityInput {
  keyword: string;
  /** Current average position from Search Console or a SERP provider. Null = not ranking. */
  currentPosition: number | null;
  impressions28d: number;
  clicks28d: number;
  ctr28d: number | null;
  searchVolume: number | null;
  difficulty: number | null;
  /** 0-1 semantic relevance of the keyword to the site's topical footprint. */
  relevance: number;
  /** 0-1 commercial value inferred from intent + the site's conversion goal. */
  businessValue: number;
  /** True when no existing page targets this keyword well. */
  isContentGap: boolean;
  /** Number of tracked competitors ranking in the top 10 for this keyword (if SERP data exists). */
  competitorsRanking: number | null;
  /** 0-1: how well this keyword's topic is already covered by the site. */
  topicalAuthority: number;
  /** 0-1 likelihood the query is the kind answer engines synthesise. */
  geoPotential: number;
  /** Site-wide max impressions, used to normalise this keyword against the portfolio. */
  maxImpressionsOnSite?: number;
}

/**
 * Keyword opportunity score, 0-100, with a plain-English explanation.
 *
 * The weights live in `KEYWORD_OPPORTUNITY_WEIGHTS` and are rendered in the UI, so the score is
 * auditable rather than a black box. Factors degrade gracefully: with no SERP provider the
 * competition factor falls back to a neutral 0.5 and says so.
 */
export function calculateKeywordOpportunity(input: KeywordOpportunityInput): ExplainableScore {
  const factors: ScoreFactor[] = [];
  const add = (key: keyof typeof KEYWORD_OPPORTUNITY_WEIGHTS, label: string, value: number, explanation: string) => {
    const weight = KEYWORD_OPPORTUNITY_WEIGHTS[key];
    factors.push({
      key,
      label,
      value: clamp(value),
      weight,
      contribution: round(clamp(value) * weight * 100, 2),
      explanation,
    });
  };

  // 1. Ranking potential — the single strongest signal.
  // Striking distance (8-20) scores highest: real movement is achievable with on-page work.
  const position = input.currentPosition;
  let rankingPotential: number;
  let rankingExplanation: string;
  if (position === null) {
    rankingPotential = input.isContentGap ? 0.45 : 0.2;
    rankingExplanation = 'Not currently ranking — requires new or substantially expanded content.';
  } else if (position <= 3) {
    rankingPotential = 0.12;
    rankingExplanation = `Already at position ${position.toFixed(1)} — limited headroom.`;
  } else if (position <= 7) {
    rankingPotential = 0.65;
    rankingExplanation = `Position ${position.toFixed(1)} — moving into the top 3 would roughly double clicks.`;
  } else if (position <= 20) {
    rankingPotential = 1;
    rankingExplanation = `Position ${position.toFixed(1)} is striking distance: page-one entry is realistic with focused work.`;
  } else if (position <= 50) {
    rankingPotential = 0.5;
    rankingExplanation = `Position ${position.toFixed(1)} — needs meaningful content and link work to reach page one.`;
  } else {
    rankingPotential = 0.22;
    rankingExplanation = `Position ${position.toFixed(1)} — a long way from page one.`;
  }
  add('rankingPotential', 'Ranking potential', rankingPotential, rankingExplanation);

  // 2. Demand: prefer observed impressions (real, site-specific) over provider volume estimates.
  const maxImpressions = Math.max(1000, input.maxImpressionsOnSite ?? 10_000);
  let demand: number;
  let demandExplanation: string;
  if (input.impressions28d > 0) {
    demand = logNormalize(input.impressions28d, maxImpressions);
    demandExplanation = `${input.impressions28d.toLocaleString()} impressions in the last 28 days.`;
  } else if (input.searchVolume) {
    demand = logNormalize(input.searchVolume, 50_000) * 0.85;
    demandExplanation = `No impressions yet; provider estimates ${input.searchVolume.toLocaleString()} monthly searches.`;
  } else {
    demand = 0.25;
    demandExplanation = 'No impression or volume data available — demand is unverified.';
  }
  add('impressionVolume', 'Search demand', demand, demandExplanation);

  add(
    'relevance',
    'Topical relevance',
    input.relevance,
    input.relevance >= 0.7
      ? 'Closely matches what this site is about.'
      : input.relevance >= 0.4
        ? 'Partially related to the site\'s core topics.'
        : 'Weakly related to the site — content would sit outside the existing topical footprint.',
  );

  add(
    'businessValue',
    'Business value',
    input.businessValue,
    input.businessValue >= 0.7
      ? 'Commercial or high-intent query aligned with the conversion goal.'
      : input.businessValue >= 0.4
        ? 'Mid-funnel query that supports conversion indirectly.'
        : 'Top-of-funnel query — traffic value is mostly awareness.',
  );

  // 5. Competition gap
  let competition: number;
  let competitionExplanation: string;
  if (input.difficulty !== null) {
    competition = clamp(1 - input.difficulty / 100);
    competitionExplanation = `Provider difficulty ${Math.round(input.difficulty)}/100.`;
  } else if (input.competitorsRanking !== null) {
    competition = clamp(1 - input.competitorsRanking / 6);
    competitionExplanation = `${input.competitorsRanking} tracked competitor(s) rank in the top 10.`;
  } else {
    competition = 0.5;
    competitionExplanation = 'No difficulty data — configure a SERP provider for a real competition estimate.';
  }
  add('competitionGap', 'Competition', competition, competitionExplanation);

  add(
    'contentGap',
    'Content gap',
    input.isContentGap ? 1 : 0.3,
    input.isContentGap
      ? 'No existing page targets this query well — a genuine gap.'
      : 'An existing page already targets this query; improving it beats creating a new one.',
  );

  add(
    'topicalAuthority',
    'Topical authority',
    input.topicalAuthority,
    input.topicalAuthority >= 0.6
      ? 'The site already has depth in this topic, which makes ranking easier.'
      : 'Little existing coverage of this topic — expect a longer ramp.',
  );

  add(
    'geoPotential',
    'AI-search potential',
    input.geoPotential,
    input.geoPotential >= 0.6
      ? 'The kind of question answer engines synthesise — worth structuring for citation.'
      : 'Less likely to surface in AI answers.',
  );

  const score = round(factors.reduce((total, f) => total + f.value * f.weight, 0) * 100, 1);

  // Build a human summary from the top contributors, in the style the product spec asks for.
  const top = [...factors].sort((a, b) => b.contribution - a.contribution).slice(0, 3);
  const summary =
    score >= 70
      ? `High potential: ${top.map((f) => f.explanation.replace(/\.$/, '')).join('; ')}.`
      : score >= 45
        ? `Moderate potential. Strongest signals: ${top.map((f) => f.label.toLowerCase()).join(', ')}.`
        : `Low priority. ${
            [...factors].sort((a, b) => a.value - b.value)[0]?.explanation ?? ''
          }`;

  return { score, factors, summary };
}

export interface CtrOpportunityInput {
  position: number;
  impressions: number;
  clicks: number;
  ctr: number;
  minImpressions: number;
}

/**
 * Detects "high impressions, low CTR" pages: ranking well but under-clicked relative to the
 * published position/CTR curve. Returns null when the page is not a genuine opportunity.
 */
export function detectCtrOpportunity(input: CtrOpportunityInput): {
  delta: number;
  expectedCtr: number;
  potentialClicks: number;
  severity: 'high' | 'medium' | 'low';
  explanation: string;
} | null {
  if (input.impressions < input.minImpressions) return null;
  if (input.position > 20) return null;
  const expected = expectedCtr(input.position);
  const delta = ctrDelta(input.position, input.ctr);
  if (delta > -0.25) return null; // within a quarter of the curve is normal variance

  const potentialClicks = Math.max(0, Math.round(input.impressions * expected - input.clicks));
  const severity = delta <= -0.6 ? 'high' : delta <= -0.4 ? 'medium' : 'low';
  return {
    delta: round(delta, 3),
    expectedCtr: round(expected, 4),
    potentialClicks,
    severity,
    explanation:
      `Averaging position ${input.position.toFixed(1)} with ${input.impressions.toLocaleString()} impressions but only ` +
      `${(input.ctr * 100).toFixed(2)}% CTR — ${Math.abs(Math.round(delta * 100))}% below the ~${(expected * 100).toFixed(1)}% ` +
      `typical for that position. Closing the gap is worth roughly ${potentialClicks.toLocaleString()} extra clicks per month.`,
  };
}

/** Page-level opportunity score used to rank which URLs deserve work next. */
export function calculatePageOpportunity(input: {
  impressions28d: number;
  clicks28d: number;
  position28d: number | null;
  ctr28d: number | null;
  clicksTrendPct: number | null;
  seoScore: number | null;
  internalLinksIn: number;
  wordCount: number;
  openIssueCount: number;
  maxImpressionsOnSite: number;
}): ExplainableScore {
  const factors: ScoreFactor[] = [];
  const add = (key: string, label: string, value: number, weight: number, explanation: string) => {
    factors.push({
      key,
      label,
      value: clamp(value),
      weight,
      contribution: round(clamp(value) * weight * 100, 2),
      explanation,
    });
  };

  const position = input.position28d;
  const strikingDistance =
    position === null ? 0.2 : position >= 8 && position <= 20 ? 1 : position < 8 ? 0.5 : position <= 40 ? 0.55 : 0.2;
  add(
    'strikingDistance',
    'Ranking headroom',
    strikingDistance,
    0.3,
    position === null
      ? 'No ranking data for this page yet.'
      : `Average position ${position.toFixed(1)}.`,
  );

  add(
    'demand',
    'Existing demand',
    logNormalize(input.impressions28d, Math.max(1000, input.maxImpressionsOnSite)),
    0.24,
    `${input.impressions28d.toLocaleString()} impressions in 28 days.`,
  );

  const ctrGap =
    position !== null && input.ctr28d !== null && input.impressions28d > 50
      ? clamp(-ctrDelta(position, input.ctr28d))
      : 0;
  add(
    'ctrGap',
    'CTR gap',
    ctrGap,
    0.16,
    ctrGap > 0.2
      ? `CTR is ${Math.round(ctrGap * 100)}% below the curve for this position — a title/meta rewrite is the cheapest win.`
      : 'CTR is in line with the expected curve.',
  );

  const decay = input.clicksTrendPct !== null && input.clicksTrendPct < 0 ? clamp(-input.clicksTrendPct / 60) : 0;
  add(
    'decay',
    'Traffic decay',
    decay,
    0.14,
    input.clicksTrendPct === null
      ? 'No period-over-period comparison available yet.'
      : input.clicksTrendPct < -10
        ? `Clicks are down ${Math.abs(Math.round(input.clicksTrendPct))}% versus the previous period.`
        : `Clicks are ${input.clicksTrendPct >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(input.clicksTrendPct))}%.`,
  );

  const quality = input.seoScore === null ? 0.4 : clamp(1 - input.seoScore / 100);
  add(
    'onPageGap',
    'On-page quality gap',
    quality,
    0.1,
    input.seoScore === null
      ? 'Page has not been scored yet.'
      : `On-page score ${Math.round(input.seoScore)}/100 — ${
          input.seoScore < 60 ? 'meaningful on-page work available' : 'already well optimised'
        }.`,
  );

  add(
    'fixableIssues',
    'Open issues',
    saturate(input.openIssueCount, 3),
    0.06,
    input.openIssueCount === 0
      ? 'No open technical issues on this URL.'
      : `${input.openIssueCount} open technical issue${input.openIssueCount === 1 ? '' : 's'} to clear.`,
  );

  const score = round(factors.reduce((t, f) => t + f.value * f.weight, 0) * 100, 1);
  const top = [...factors].sort((a, b) => b.contribution - a.contribution)[0];
  return {
    score,
    factors,
    summary: top ? top.explanation : 'Not enough data to rank this page.',
  };
}
