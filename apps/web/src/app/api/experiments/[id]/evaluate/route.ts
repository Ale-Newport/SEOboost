import { z } from 'zod';
import {
  ExperimentOutcome,
  ExperimentStatus,
  json,
  prisma,
} from '@seo/db';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  createLogger,
  formatDateKey,
  round,
  type DateRange,
} from '@seo/shared';
import { evaluateExperiment, type DailyMetricPoint } from '@seo/seo-engine';
import { readBody, route } from '@/lib/api';
import { skipped } from '@/app/api/_lib/common';

const log = createLogger('api:experiments');

/**
 * `POST /api/experiments/[id]/evaluate` — measure a change against its baseline.
 *
 * The daily series comes from stored Search Console rows: `GscQueryMetric` for a page-scoped
 * experiment, `SearchConsoleDaily` for a site-wide one. With no rows there is nothing to
 * measure and the endpoint says so — it never falls back to an estimate.
 *
 * The verdict itself comes from `evaluateExperiment`, which is deliberately conservative: it
 * discards a settling period, requires a minimum window, runs Welch's t-test on the daily
 * series and only ever says "likely positive/negative", never "caused".
 */

const bodySchema = z.object({
  /** Preview the verdict without writing it to the experiment. */
  dryRun: z.boolean().optional(),
});

const METRICS = ['clicks', 'impressions', 'ctr', 'position'] as const;
type Metric = (typeof METRICS)[number];

function toMetric(value: string): Metric {
  const match = METRICS.find((metric) => metric === value);
  if (!match) {
    throw new ValidationError(
      `Experiment metric "${value}" cannot be evaluated. Supported: ${METRICS.join(', ')}.`,
    );
  }
  return match;
}

interface DailyRow {
  date: Date;
  clicks: number;
  impressions: number;
  position: number;
}

/** Fold rows into one point per day, weighting position by impressions as Search Console does. */
function toDailyPoints(rows: DailyRow[]): DailyMetricPoint[] {
  const byDay = new Map<string, { date: Date; clicks: number; impressions: number; weighted: number }>();
  for (const row of rows) {
    const key = formatDateKey(row.date);
    const entry = byDay.get(key) ?? { date: row.date, clicks: 0, impressions: 0, weighted: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.weighted += row.position * row.impressions;
    byDay.set(key, entry);
  }

  return [...byDay.values()]
    .map((entry) => ({
      date: entry.date,
      clicks: entry.clicks,
      impressions: entry.impressions,
      ctr: entry.impressions > 0 ? round(entry.clicks / entry.impressions, 5) : 0,
      position: entry.impressions > 0 ? round(entry.weighted / entry.impressions, 2) : 0,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function loadSeries(
  experiment: { websiteId: string; pageId: string | null },
  range: DateRange,
): Promise<DailyMetricPoint[]> {
  if (experiment.pageId) {
    // Page-scoped: the query × page rows are the only source that isolates one URL.
    const rows = await prisma.gscQueryMetric.findMany({
      where: {
        websiteId: experiment.websiteId,
        pageId: experiment.pageId,
        date: { gte: range.start, lte: range.end },
      },
      select: { date: true, clicks: true, impressions: true, position: true },
    });
    return toDailyPoints(rows);
  }

  // Site-wide: the unsegmented daily totals (country/device null), matching the analytics reader.
  const rows = await prisma.searchConsoleDaily.findMany({
    where: {
      websiteId: experiment.websiteId,
      date: { gte: range.start, lte: range.end },
      source: 'gsc',
      country: null,
      device: null,
    },
    select: { date: true, clicks: true, impressions: true, position: true },
  });
  return toDailyPoints(rows);
}

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);

  const experiment = await prisma.experiment.findUnique({
    where: { id: params.id },
    include: {
      website: { select: { id: true, userId: true } },
      action: { select: { id: true, type: true, title: true } },
    },
  });
  if (!experiment) throw new NotFoundError('Experiment');
  if (experiment.website.userId !== user.id) {
    throw new ForbiddenError('You do not have access to this experiment.');
  }

  const metric = toMetric(experiment.metric);
  const baselineRange: DateRange = { start: experiment.baselineStart, end: experiment.baselineEnd };
  const measurementRange: DateRange = {
    start: experiment.measureStart,
    end: experiment.measureEnd ?? new Date(),
  };

  const [baselineSeries, measurementSeries] = await Promise.all([
    loadSeries(experiment, baselineRange),
    loadSeries(experiment, measurementRange),
  ]);

  if (baselineSeries.length === 0 && measurementSeries.length === 0) {
    return skipped(
      'No Search Console data is stored for either window, so this change cannot be measured.',
      'Connect Google Search Console for this website and run a sync; experiments are measured from those daily rows.',
    );
  }

  const evaluation = evaluateExperiment(
    {
      metric,
      baseline: baselineRange,
      measurement: measurementRange,
      minDays: experiment.minDays,
    },
    baselineSeries,
    measurementSeries,
  );

  if (body.dryRun) {
    return { experimentId: experiment.id, dryRun: true, evaluation };
  }

  const outcome = ExperimentOutcome[evaluation.outcome];
  const updated = await prisma.experiment.update({
    where: { id: experiment.id },
    data: {
      outcome,
      // An experiment that still needs data stays RUNNING: closing it would freeze a verdict
      // the evaluator explicitly declined to give.
      status: evaluation.needsMoreData ? ExperimentStatus.RUNNING : ExperimentStatus.COMPLETED,
      baselineMetrics: json(evaluation.baselineMetrics),
      resultMetrics: json(evaluation.resultMetrics),
      deltaPct: evaluation.deltaPct,
      significance: evaluation.pValue,
      interpretation: evaluation.interpretation,
      evaluatedAt: new Date(),
      ...(evaluation.needsMoreData ? {} : { measureEnd: measurementRange.end }),
    },
    select: {
      id: true,
      status: true,
      outcome: true,
      deltaPct: true,
      significance: true,
      interpretation: true,
      evaluatedAt: true,
    },
  });

  log.info('experiment evaluated', {
    experimentId: experiment.id,
    outcome,
    needsMoreData: evaluation.needsMoreData,
  });

  return { experiment: updated, evaluation };
});
