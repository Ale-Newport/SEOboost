import type { ExplainableScore, ScoreFactor } from '@seo/shared';

/**
 * Normalisers for the stored priority breakdown.
 *
 * Agents have written the breakdown in three different shapes over time — a whole
 * `ExplainableScore`, a `{ factors, summary }` pair, and a bare `ScoreFactor[]` — and content
 * opportunities keep theirs under `evidence.priorityFactors`. Rather than migrate historic rows,
 * every screen reads them through here so a score is explainable regardless of which agent
 * produced it. Nothing is recomputed: if a row has no factors we say so instead of inventing a
 * breakdown that the engine never produced.
 */

function isScoreFactor(value: unknown): value is ScoreFactor {
  if (typeof value !== 'object' || value === null) return false;
  const factor = value as Record<string, unknown>;
  return (
    typeof factor.key === 'string' &&
    typeof factor.label === 'string' &&
    typeof factor.value === 'number' &&
    typeof factor.weight === 'number' &&
    typeof factor.contribution === 'number' &&
    typeof factor.explanation === 'string'
  );
}

const FACTOR_KEYS = ['factors', 'priorityFactors'] as const;
const SUMMARY_KEYS = ['summary', 'priorityExplanation'] as const;

/** Pull a `ScoreFactor[]` out of any of the shapes above; `[]` when there is none. */
export function readFactors(raw: unknown): ScoreFactor[] {
  if (Array.isArray(raw)) return raw.filter(isScoreFactor);
  if (typeof raw !== 'object' || raw === null) return [];

  const record = raw as Record<string, unknown>;
  for (const key of FACTOR_KEYS) {
    const candidate = record[key];
    if (!Array.isArray(candidate)) continue;
    const factors = candidate.filter(isScoreFactor);
    if (factors.length > 0) return factors;
  }
  return [];
}

/** The engine's own explanation sentence, when the row kept one. */
export function readSummary(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return null;
}

function percent(value: number): string {
  return `${Math.round((Number.isFinite(value) ? value : 0) * 100)}%`;
}

function round1(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return Number.isInteger(safe) ? String(safe) : safe.toFixed(1);
}

export interface ActionPriorityInputs {
  priorityScore: number;
  impactScore: number;
  confidenceScore: number;
  businessValue: number;
  effortScore: number;
  riskScore: number;
  priorityFactors: unknown;
}

/**
 * The formula, spelled out from the values actually stored on the row.
 * Used as the summary when the agent did not persist one.
 */
export function actionPriorityFormula(action: ActionPriorityInputs): string {
  return (
    `Impact ${percent(action.impactScore)} × confidence ${percent(action.confidenceScore)} × ` +
    `business value ${percent(action.businessValue)} ÷ (effort ${round1(action.effortScore)} × ` +
    `risk ${round1(action.riskScore)}), normalised onto 0-100.`
  );
}

/** An action's priority as an `ExplainableScore` the `ScoreBreakdown` component can render. */
export function actionPriority(action: ActionPriorityInputs): ExplainableScore {
  const factors = readFactors(action.priorityFactors);
  const stored = readSummary(action.priorityFactors);
  return {
    score: action.priorityScore,
    factors,
    summary:
      stored ??
      (factors.length > 0
        ? actionPriorityFormula(action)
        : `${actionPriorityFormula(action)} The agent that proposed this did not record a factor ` +
          'breakdown, so only the inputs above are available.'),
  };
}

export interface OpportunityPriorityInputs {
  priorityScore: number;
  impactScore: number;
  confidenceScore: number;
  effortScore: number;
  /** The opportunity's `evidence` JSON — where the content agent stores its breakdown. */
  evidence: unknown;
}

/**
 * A content opportunity's priority.
 *
 * Opportunities persist only impact, confidence and effort, so when the evidence carries no
 * factor list the summary names those three inputs rather than reciting a formula whose other
 * terms were never saved.
 */
export function opportunityPriority(opportunity: OpportunityPriorityInputs): ExplainableScore {
  const factors = readFactors(opportunity.evidence);
  const stored = readSummary(opportunity.evidence);
  return {
    score: opportunity.priorityScore,
    factors,
    summary:
      stored ??
      `Ranked from expected impact ${percent(opportunity.impactScore)}, confidence ` +
        `${percent(opportunity.confidenceScore)} and effort ${round1(opportunity.effortScore)}/5. ` +
        'No weighted factor breakdown was recorded for this opportunity.',
  };
}
