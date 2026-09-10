import { z } from 'zod';

/**
 * Reader for the free-form `Report.data` payload.
 *
 * The generator owns the shape of that column and it varies by report type, so nothing here
 * assumes a schema: every section is probed under a handful of aliases, parsed leniently, and
 * simply absent when the payload does not carry it. Missing sections are never filled in with
 * placeholder numbers — a report that was generated without Search Console data must read as
 * "no organic data in this report", not as a page of zeroes.
 */

// ── primitives ───────────────────────────────────────────────

const finiteNumber = z.number().finite();

/** A metric that may be a bare number or a `{ current, previous, change, changePct }` delta. */
const metricSchema = z.union([
  finiteNumber,
  z
    .object({
      current: finiteNumber.nullish(),
      value: finiteNumber.nullish(),
      previous: finiteNumber.nullish(),
      change: finiteNumber.nullish(),
      changePct: finiteNumber.nullish(),
    })
    .passthrough(),
]);

export interface ReportMetric {
  value: number | null;
  previous: number | null;
  changePct: number | null;
}

function toMetric(raw: unknown): ReportMetric | null {
  const parsed = metricSchema.safeParse(raw);
  if (!parsed.success) return null;

  if (typeof parsed.data === 'number') {
    return { value: parsed.data, previous: null, changePct: null };
  }

  const value = parsed.data.current ?? parsed.data.value ?? null;
  const previous = parsed.data.previous ?? null;
  // Derive the percentage only from two real numbers; a change against a zero baseline is
  // undefined, not "infinite growth".
  const changePct =
    parsed.data.changePct ??
    (typeof value === 'number' && typeof previous === 'number' && previous !== 0
      ? ((value - previous) / Math.abs(previous)) * 100
      : null);

  return { value, previous, changePct };
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** First key present in `source`, so a generator can rename a section without breaking this page. */
function pick(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

// ── sections ─────────────────────────────────────────────────

export interface ReportPerformance {
  clicks: ReportMetric | null;
  impressions: ReportMetric | null;
  ctr: ReportMetric | null;
  position: ReportMetric | null;
}

const PERFORMANCE_KEYS = ['performance', 'organic', 'search', 'searchConsole', 'traffic'] as const;

function readPerformance(data: Record<string, unknown>): ReportPerformance | null {
  const scope = record(pick(data, PERFORMANCE_KEYS)) ?? data;

  const performance: ReportPerformance = {
    clicks: toMetric(scope.clicks),
    impressions: toMetric(scope.impressions),
    ctr: toMetric(scope.ctr),
    position: toMetric(pick(scope, ['position', 'avgPosition', 'averagePosition'])),
  };

  const hasAny = Object.values(performance).some((metric) => metric !== null && metric.value !== null);
  return hasAny ? performance : null;
}

export interface ReportMovement {
  /** Page URL, query, or whatever the generator moved on — one of these is always present. */
  label: string;
  url: string | null;
  clicks: number | null;
  change: number | null;
  changePct: number | null;
  position: number | null;
}

const movementSchema = z
  .object({
    url: z.string().nullish(),
    page: z.string().nullish(),
    keyword: z.string().nullish(),
    query: z.string().nullish(),
    title: z.string().nullish(),
    label: z.string().nullish(),
    clicks: finiteNumber.nullish(),
    change: finiteNumber.nullish(),
    delta: finiteNumber.nullish(),
    changePct: finiteNumber.nullish(),
    changePercent: finiteNumber.nullish(),
    position: finiteNumber.nullish(),
  })
  .passthrough();

function readMovements(raw: unknown): ReportMovement[] {
  if (!Array.isArray(raw)) return [];

  const rows: ReportMovement[] = [];
  for (const entry of raw) {
    const parsed = movementSchema.safeParse(entry);
    if (!parsed.success) continue;
    const row = parsed.data;
    const label = row.label ?? row.keyword ?? row.query ?? row.title ?? row.url ?? row.page;
    if (!label) continue;
    rows.push({
      label,
      url: row.url ?? row.page ?? null,
      clicks: row.clicks ?? null,
      change: row.change ?? row.delta ?? null,
      changePct: row.changePct ?? row.changePercent ?? null,
      position: row.position ?? null,
    });
  }
  return rows;
}

export type ReportSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

const severitySchema = z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);

export interface ReportProblem {
  label: string;
  severity: ReportSeverity | null;
  count: number | null;
  detail: string | null;
}

const problemSchema = z
  .object({
    title: z.string().nullish(),
    label: z.string().nullish(),
    rule: z.string().nullish(),
    name: z.string().nullish(),
    severity: z.string().nullish(),
    count: finiteNumber.nullish(),
    pages: finiteNumber.nullish(),
    detail: z.string().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

function readProblems(raw: unknown): ReportProblem[] {
  if (!Array.isArray(raw)) return [];

  const rows: ReportProblem[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      rows.push({ label: entry, severity: null, count: null, detail: null });
      continue;
    }
    const parsed = problemSchema.safeParse(entry);
    if (!parsed.success) continue;
    const row = parsed.data;
    const label = row.title ?? row.label ?? row.rule ?? row.name;
    if (!label) continue;
    const severity = severitySchema.safeParse(String(row.severity ?? '').toUpperCase());
    rows.push({
      label,
      severity: severity.success ? severity.data : null,
      count: row.count ?? row.pages ?? null,
      detail: row.detail ?? row.description ?? null,
    });
  }
  return rows;
}

export interface ReportAiActivityItem {
  key: string;
  label: string;
  count: number;
}

/** Counts the generator writes for what the agents did during the period. */
const AI_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  briefs: 'Content briefs',
  contentBriefs: 'Content briefs',
  drafts: 'Drafts written',
  contentDrafts: 'Drafts written',
  published: 'Pages published',
  updates: 'Content updates',
  contentUpdates: 'Content updates',
  links: 'Internal links added',
  internalLinks: 'Internal links added',
  schemaChanges: 'Schema changes',
  structuredData: 'Schema changes',
  actions: 'Actions executed',
  actionsExecuted: 'Actions executed',
  approvals: 'Approvals decided',
  agentRuns: 'Agent runs',
};

function readAiActivity(raw: unknown): ReportAiActivityItem[] {
  const scope = record(raw);
  if (!scope) return [];

  const rows: ReportAiActivityItem[] = [];
  for (const [key, value] of Object.entries(scope)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    rows.push({ key, label: AI_ACTIVITY_LABELS[key] ?? humanizeKey(key), count: value });
  }
  return rows;
}

export interface ReportExperiment {
  label: string;
  status: string | null;
  outcome: string | null;
  liftPct: number | null;
  detail: string | null;
}

const experimentSchema = z
  .object({
    name: z.string().nullish(),
    title: z.string().nullish(),
    hypothesis: z.string().nullish(),
    status: z.string().nullish(),
    outcome: z.string().nullish(),
    result: z.string().nullish(),
    liftPct: finiteNumber.nullish(),
    lift: finiteNumber.nullish(),
    detail: z.string().nullish(),
    summary: z.string().nullish(),
  })
  .passthrough();

function readExperiments(raw: unknown): ReportExperiment[] {
  if (!Array.isArray(raw)) return [];

  const rows: ReportExperiment[] = [];
  for (const entry of raw) {
    const parsed = experimentSchema.safeParse(entry);
    if (!parsed.success) continue;
    const row = parsed.data;
    const label = row.name ?? row.title ?? row.hypothesis;
    if (!label) continue;
    rows.push({
      label,
      status: row.status ?? null,
      outcome: row.outcome ?? row.result ?? null,
      liftPct: row.liftPct ?? row.lift ?? null,
      detail: row.detail ?? row.summary ?? null,
    });
  }
  return rows;
}

export interface ReportRecommendation {
  label: string;
  detail: string | null;
  href: string | null;
}

const recommendationSchema = z
  .object({
    title: z.string().nullish(),
    label: z.string().nullish(),
    recommendation: z.string().nullish(),
    action: z.string().nullish(),
    detail: z.string().nullish(),
    description: z.string().nullish(),
    reason: z.string().nullish(),
    href: z.string().nullish(),
    link: z.string().nullish(),
  })
  .passthrough();

/** Only same-origin paths are linkable; a stored absolute URL is shown as text, never as a link. */
function internalHref(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : null;
}

function readRecommendations(raw: unknown): ReportRecommendation[] {
  if (!Array.isArray(raw)) return [];

  const rows: ReportRecommendation[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      rows.push({ label: entry, detail: null, href: null });
      continue;
    }
    const parsed = recommendationSchema.safeParse(entry);
    if (!parsed.success) continue;
    const row = parsed.data;
    const label = row.title ?? row.label ?? row.recommendation ?? row.action;
    if (!label) continue;
    rows.push({
      label,
      detail: row.detail ?? row.description ?? row.reason ?? null,
      href: internalHref(row.href ?? row.link),
    });
  }
  return rows;
}

export interface ReportHighlight {
  label: string;
  detail: string | null;
}

const highlightSchema = z
  .object({
    title: z.string().nullish(),
    label: z.string().nullish(),
    highlight: z.string().nullish(),
    priority: z.union([z.string(), finiteNumber]).nullish(),
    detail: z.string().nullish(),
    description: z.string().nullish(),
  })
  .passthrough();

export function readHighlights(raw: unknown): ReportHighlight[] {
  if (!Array.isArray(raw)) return [];

  const rows: ReportHighlight[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      rows.push({ label: entry, detail: null });
      continue;
    }
    const parsed = highlightSchema.safeParse(entry);
    if (!parsed.success) continue;
    const row = parsed.data;
    const label = row.title ?? row.label ?? row.highlight;
    if (!label) continue;
    const priority = row.priority === null || row.priority === undefined ? null : String(row.priority);
    rows.push({ label, detail: row.detail ?? row.description ?? priority });
  }
  return rows;
}

/** `topImprovements` → `Top improvements`. Used for sections this reader has no label for. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ── the whole payload ────────────────────────────────────────

const IMPROVEMENT_KEYS = ['topImprovements', 'improvements', 'winners', 'gains', 'topGains'] as const;
const DECLINE_KEYS = ['topDeclines', 'declines', 'losers', 'drops', 'topLosses'] as const;
const PROBLEM_KEYS = ['problems', 'problemsFound', 'issues', 'technicalIssues'] as const;
const AI_ACTIVITY_KEYS = ['aiActivity', 'ai', 'agentActivity', 'automation'] as const;
const EXPERIMENT_KEYS = ['experiments', 'experimentOutcomes', 'tests'] as const;
const RECOMMENDATION_KEYS = ['recommendations', 'nextRecommendations', 'nextSteps', 'nextActions'] as const;

export interface ParsedReport {
  performance: ReportPerformance | null;
  improvements: ReportMovement[];
  declines: ReportMovement[];
  problems: ReportProblem[];
  aiActivity: ReportAiActivityItem[];
  experiments: ReportExperiment[];
  recommendations: ReportRecommendation[];
  /** Keys the reader recognised nothing in — rendered verbatim so nothing stored is hidden. */
  extras: Array<{ key: string; label: string; value: unknown }>;
  /** False when the payload carried nothing at all this page can render. */
  hasContent: boolean;
}

const CONSUMED_KEYS = new Set<string>([
  ...PERFORMANCE_KEYS,
  ...IMPROVEMENT_KEYS,
  ...DECLINE_KEYS,
  ...PROBLEM_KEYS,
  ...AI_ACTIVITY_KEYS,
  ...EXPERIMENT_KEYS,
  ...RECOMMENDATION_KEYS,
  // Flat metric keys `readPerformance` falls back to.
  'clicks',
  'impressions',
  'ctr',
  'position',
  'avgPosition',
  'averagePosition',
]);

export function parseReportData(raw: unknown): ParsedReport {
  const data = record(raw) ?? {};

  const parsed: ParsedReport = {
    performance: readPerformance(data),
    improvements: readMovements(pick(data, IMPROVEMENT_KEYS)),
    declines: readMovements(pick(data, DECLINE_KEYS)),
    problems: readProblems(pick(data, PROBLEM_KEYS)),
    aiActivity: readAiActivity(pick(data, AI_ACTIVITY_KEYS)),
    experiments: readExperiments(pick(data, EXPERIMENT_KEYS)),
    recommendations: readRecommendations(pick(data, RECOMMENDATION_KEYS)),
    extras: Object.entries(data)
      .filter(([key, value]) => !CONSUMED_KEYS.has(key) && value !== null && value !== undefined)
      .map(([key, value]) => ({ key, label: humanizeKey(key), value })),
    hasContent: false,
  };

  parsed.hasContent =
    parsed.performance !== null ||
    parsed.improvements.length > 0 ||
    parsed.declines.length > 0 ||
    parsed.problems.length > 0 ||
    parsed.aiActivity.length > 0 ||
    parsed.experiments.length > 0 ||
    parsed.recommendations.length > 0 ||
    parsed.extras.length > 0;

  return parsed;
}

// ── export rows ──────────────────────────────────────────────

export type ExportCell = string | number | null;

/**
 * Flattens every parsed section into one long-format table (`section, item, metric, value`).
 * Long format rather than one sheet per section because a report has no single natural grain
 * and a CSV has exactly one header row.
 */
export function reportExportRows(parsed: ParsedReport): Array<Record<string, ExportCell>> {
  const rows: Array<Record<string, ExportCell>> = [];
  const push = (section: string, item: string, metric: string, value: ExportCell): void => {
    rows.push({ section, item, metric, value });
  };

  if (parsed.performance) {
    for (const [key, metric] of Object.entries(parsed.performance)) {
      if (!metric) continue;
      push('Performance', key, 'value', metric.value);
      if (metric.previous !== null) push('Performance', key, 'previous', metric.previous);
      if (metric.changePct !== null) push('Performance', key, 'changePct', metric.changePct);
    }
  }

  for (const [section, movements] of [
    ['Top improvements', parsed.improvements],
    ['Top declines', parsed.declines],
  ] as const) {
    for (const row of movements) {
      push(section, row.label, 'clicks', row.clicks);
      push(section, row.label, 'change', row.change);
      push(section, row.label, 'changePct', row.changePct);
      push(section, row.label, 'position', row.position);
      if (row.url) push(section, row.label, 'url', row.url);
    }
  }

  for (const row of parsed.problems) {
    push('Problems', row.label, 'severity', row.severity);
    push('Problems', row.label, 'count', row.count);
  }

  for (const row of parsed.aiActivity) push('AI activity', row.label, 'count', row.count);

  for (const row of parsed.experiments) {
    push('Experiments', row.label, 'status', row.status);
    push('Experiments', row.label, 'outcome', row.outcome);
    push('Experiments', row.label, 'liftPct', row.liftPct);
  }

  parsed.recommendations.forEach((row, index) => {
    push('Recommendations', String(index + 1), 'recommendation', row.label);
    if (row.detail) push('Recommendations', String(index + 1), 'detail', row.detail);
  });

  return rows;
}
