import { addDays, daysBetween, mean, percentChange, round, welchTTest, type DateRange } from '@seo/shared';

export type ExperimentOutcomeValue = 'PENDING' | 'LIKELY_POSITIVE' | 'INCONCLUSIVE' | 'LIKELY_NEGATIVE';

export interface DailyMetricPoint {
  date: Date;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface ExperimentDefinition {
  metric: 'clicks' | 'impressions' | 'ctr' | 'position';
  baseline: DateRange;
  measurement: DateRange;
  minDays: number;
  /** Days after the change during which data is ignored while the engine re-crawls and re-ranks. */
  settlingDays?: number;
}

export interface ExperimentEvaluation {
  outcome: ExperimentOutcomeValue;
  metric: string;
  baselineMean: number;
  measurementMean: number;
  deltaPct: number | null;
  /** Two-sided p-value from Welch's t-test on the daily series. Null when the sample is too small. */
  pValue: number | null;
  baselineDays: number;
  measurementDays: number;
  baselineMetrics: Record<string, number>;
  resultMetrics: Record<string, number>;
  interpretation: string;
  /** True when there is not yet enough data to say anything. */
  needsMoreData: boolean;
  daysRemaining: number;
}

/**
 * Evaluate an SEO experiment.
 *
 * SEO changes are never a clean A/B test — there is no control group, seasonality moves, and the
 * index updates on its own schedule. So this function is deliberately conservative:
 *   • it requires a minimum observation window before saying anything at all;
 *   • it ignores a settling period immediately after the change;
 *   • it runs Welch's t-test on the daily series and demands both a meaningful effect size AND
 *     statistical separation before labelling a result;
 *   • the labels are "likely positive / inconclusive / likely negative" — never "caused".
 * The interpretation text always names the confounders the operator should consider.
 */
export function evaluateExperiment(
  definition: ExperimentDefinition,
  baselineSeries: DailyMetricPoint[],
  measurementSeries: DailyMetricPoint[],
  now = new Date(),
): ExperimentEvaluation {
  const settling = definition.settlingDays ?? 7;
  const measurementStart = addDays(definition.measurement.start, settling);

  const baseline = baselineSeries.filter(
    (p) => p.date >= definition.baseline.start && p.date <= definition.baseline.end,
  );
  const measurement = measurementSeries.filter(
    (p) => p.date >= measurementStart && (!definition.measurement.end || p.date <= definition.measurement.end),
  );

  const metric = definition.metric;
  const baselineValues = baseline.map((p) => p[metric]);
  const measurementValues = measurement.map((p) => p[metric]);

  const baselineMean = round(mean(baselineValues), 4);
  const measurementMean = round(mean(measurementValues), 4);

  const baselineMetrics = summarise(baseline);
  const resultMetrics = summarise(measurement);

  const daysObserved = measurement.length;
  const daysRemaining = Math.max(0, definition.minDays - daysObserved);
  const elapsedSinceChange = daysBetween(definition.measurement.start, now);

  if (daysObserved < Math.min(definition.minDays, 14)) {
    return {
      outcome: 'PENDING',
      metric,
      baselineMean,
      measurementMean,
      deltaPct: null,
      pValue: null,
      baselineDays: baseline.length,
      measurementDays: daysObserved,
      baselineMetrics,
      resultMetrics,
      needsMoreData: true,
      daysRemaining,
      interpretation:
        elapsedSinceChange < settling
          ? `Still inside the ${settling}-day settling window after the change. Search engines need time to re-crawl and ` +
            're-evaluate the page before any measurement is meaningful.'
          : `Only ${daysObserved} day(s) of post-change data so far; ${definition.minDays} are needed before drawing a ` +
            'conclusion. Judging an SEO change earlier than that mostly measures noise.',
    };
  }

  // For position, lower is better — invert the direction so "positive" always means "improved".
  const higherIsBetter = metric !== 'position';
  const rawDelta = percentChange(baselineMean, measurementMean);
  const deltaPct = rawDelta === null ? null : higherIsBetter ? rawDelta : -rawDelta;

  const test = welchTTest(baselineValues, measurementValues);
  const pValue = test?.p ?? null;

  // Effect-size floor: a 5% move on a noisy metric is not worth a claim regardless of p-value.
  const effectFloor = metric === 'position' ? 3 : metric === 'ctr' ? 8 : 10;
  const meaningfulEffect = deltaPct !== null && Math.abs(deltaPct) >= effectFloor;

  // Welch's test is undefined when both windows have zero variance (a perfectly flat metric —
  // rare in real data, common in fixtures and in low-traffic pages that sit at one value).
  // A t-test we cannot compute is not evidence of no effect, so fall back to demanding twice the
  // effect-size floor before calling it, and say so in the interpretation.
  const testUncomputable = test === null && baselineValues.length >= 3 && measurementValues.length >= 3;
  const separated = pValue !== null
    ? pValue < 0.1
    : testUncomputable && deltaPct !== null && Math.abs(deltaPct) >= effectFloor * 2;

  let outcome: ExperimentOutcomeValue;
  if (!meaningfulEffect || !separated) {
    outcome = 'INCONCLUSIVE';
  } else if ((deltaPct ?? 0) > 0) {
    outcome = 'LIKELY_POSITIVE';
  } else {
    outcome = 'LIKELY_NEGATIVE';
  }

  const metricLabel = metric === 'position' ? 'average position' : metric;
  const direction = (deltaPct ?? 0) >= 0 ? 'improved' : 'worsened';
  const confidenceWord = pValue === null ? 'unknown' : pValue < 0.01 ? 'strong' : pValue < 0.05 ? 'moderate' : 'weak';

  const interpretation =
    outcome === 'INCONCLUSIVE'
      ? `${metricLabel} ${direction} ${Math.abs(deltaPct ?? 0).toFixed(1)}% over ${daysObserved} days, but the change is ` +
        `${meaningfulEffect ? 'not statistically separable from normal variation' : 'too small to distinguish from noise'}` +
        `${pValue !== null ? ` (p = ${pValue.toFixed(3)})` : ''}. Treat this as no measured effect rather than a failure.`
      : `${metricLabel} ${direction} ${Math.abs(deltaPct ?? 0).toFixed(1)}% (${baselineMean.toFixed(2)} → ` +
        `${measurementMean.toFixed(2)}) across ${daysObserved} days, ` +
        (pValue !== null
          ? `with ${confidenceWord} statistical separation (p = ${pValue.toFixed(3)}). `
          : 'judged on effect size alone — the metric was perfectly flat in both windows, so a significance test ' +
            'could not be computed. ') +
        'This is correlation, not proof: seasonality, algorithm updates, competitor ' +
        'changes and other work on the site during the same window could all contribute.';

  return {
    outcome,
    metric,
    baselineMean,
    measurementMean,
    deltaPct,
    pValue,
    baselineDays: baseline.length,
    measurementDays: daysObserved,
    baselineMetrics,
    resultMetrics,
    needsMoreData: false,
    daysRemaining: 0,
    interpretation,
  };
}

function summarise(points: DailyMetricPoint[]): Record<string, number> {
  if (points.length === 0) return { clicks: 0, impressions: 0, ctr: 0, position: 0, days: 0 };
  const clicks = points.reduce((s, p) => s + p.clicks, 0);
  const impressions = points.reduce((s, p) => s + p.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: round(impressions > 0 ? clicks / impressions : 0, 5),
    position: round(mean(points.map((p) => p.position)), 2),
    days: points.length,
    clicksPerDay: round(clicks / points.length, 2),
    impressionsPerDay: round(impressions / points.length, 2),
  };
}

export interface ActionOutcomeSummary {
  actionType: string;
  total: number;
  positive: number;
  negative: number;
  inconclusive: number;
  successRate: number | null;
  avgDeltaPct: number | null;
  /** Plain-English guidance for the manager agent's next prioritisation pass. */
  learning: string;
}

/**
 * Roll up historical experiment outcomes per action type. This is the memory that feeds back into
 * `calculatePriority` so the platform stops proposing what has not worked on this specific site.
 */
export function summariseActionOutcomes(
  experiments: Array<{ actionType: string; outcome: ExperimentOutcomeValue; deltaPct: number | null }>,
): ActionOutcomeSummary[] {
  const byType = new Map<string, Array<{ outcome: ExperimentOutcomeValue; deltaPct: number | null }>>();
  for (const experiment of experiments) {
    const list = byType.get(experiment.actionType) ?? [];
    list.push({ outcome: experiment.outcome, deltaPct: experiment.deltaPct });
    byType.set(experiment.actionType, list);
  }

  const out: ActionOutcomeSummary[] = [];
  for (const [actionType, results] of byType) {
    const evaluated = results.filter((r) => r.outcome !== 'PENDING');
    const positive = evaluated.filter((r) => r.outcome === 'LIKELY_POSITIVE').length;
    const negative = evaluated.filter((r) => r.outcome === 'LIKELY_NEGATIVE').length;
    const inconclusive = evaluated.filter((r) => r.outcome === 'INCONCLUSIVE').length;
    const deltas = evaluated.map((r) => r.deltaPct).filter((d): d is number => d !== null);
    const successRate = evaluated.length > 0 ? round(positive / evaluated.length, 3) : null;

    out.push({
      actionType,
      total: evaluated.length,
      positive,
      negative,
      inconclusive,
      successRate,
      avgDeltaPct: deltas.length ? round(mean(deltas), 2) : null,
      learning:
        evaluated.length < 3
          ? `Only ${evaluated.length} measured result(s) so far — not enough history to adjust prioritisation for ${actionType}.`
          : successRate !== null && successRate >= 0.6
            ? `${actionType} has helped in ${positive} of ${evaluated.length} measured cases on this site (average ` +
              `${deltas.length ? `${mean(deltas) >= 0 ? '+' : ''}${round(mean(deltas), 1)}%` : 'n/a'}). Prioritise it higher.`
            : negative > positive
              ? `${actionType} has more negative than positive measured outcomes on this site (${negative} vs ${positive}). ` +
                'Deprioritise it and investigate why before proposing more.'
              : `${actionType} is mostly inconclusive on this site (${inconclusive} of ${evaluated.length}). The effect, if ` +
                'any, is smaller than the noise floor — spend effort elsewhere unless the action is cheap.',
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

/** When should this experiment next be evaluated? */
export function nextEvaluationDate(measureStart: Date, minDays: number, settlingDays = 7): Date {
  return addDays(measureStart, settlingDays + minDays);
}
