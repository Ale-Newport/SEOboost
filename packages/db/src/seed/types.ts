/** Result types shared by the seed steps, so the summary can be printed from data rather than prose. */

/** A step that could not run. `fix` must name the exact thing the operator has to configure. */
export interface SeedSkipped {
  status: 'skipped';
  reason: string;
  fix: string;
}

export interface SeedOk {
  status: 'ok';
  detail: string;
  /** Table name → rows written. Printed verbatim in the summary. */
  counts?: Record<string, number>;
}

export type SeedStepResult = SeedOk | SeedSkipped;

export interface DemoSiteSummary {
  name: string;
  domain: string;
  websiteId: string;
  healthScore: number;
  geoScore: number;
  counts: Record<string, number>;
}

export const skipped = (reason: string, fix: string): SeedSkipped => ({ status: 'skipped', reason, fix });

export const ok = (detail: string, counts?: Record<string, number>): SeedOk => ({ status: 'ok', detail, counts });
