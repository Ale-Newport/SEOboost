/**
 * The result vocabulary every processor returns.
 *
 * A job that cannot run is not a failure and is never silently "successful with zero rows":
 * it returns `skipped` with the exact prerequisite that is missing. That string lands on
 * `JobRecord.result` and is what the Jobs screen shows the operator, so it has to be
 * actionable ("connect Search Console", "set SERPER_API_KEY") rather than a shrug.
 */

export interface SkippedOutcome {
  status: 'skipped';
  reason: string;
  /** Env vars, integrations or pipeline steps the operator must complete first. */
  requires?: string[];
}

export interface CancelledOutcome {
  status: 'cancelled';
  message: string;
  /** Whatever work had already been persisted before the stop, so it is not lost silently. */
  progress?: Record<string, number>;
}

/** A prerequisite is missing. `requires` is rendered as a checklist in the UI. */
export function skip(reason: string, requires?: readonly string[]): SkippedOutcome {
  return { status: 'skipped', reason, ...(requires?.length ? { requires: [...requires] } : {}) };
}

export function cancelled(message: string, progress?: Record<string, number>): CancelledOutcome {
  return { status: 'cancelled', message, ...(progress ? { progress } : {}) };
}

export function isSkipped(value: unknown): value is SkippedOutcome {
  return typeof value === 'object' && value !== null && (value as SkippedOutcome).status === 'skipped';
}
