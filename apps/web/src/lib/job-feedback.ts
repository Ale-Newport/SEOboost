'use client';

import { toast } from '@/components/ui/toast';
import { ApiError } from './api-client';

/**
 * Shared toast handling for the "enqueue a background job" buttons.
 *
 * Three outcomes matter to the operator and they are not the same thing:
 *   • the job was queued and a worker will run it,
 *   • the API refused up front because a prerequisite is missing (`skipped`),
 *   • the row was written but no broker is reachable, so nothing will run.
 *
 * Collapsing the last two into "Started!" is how a product ends up lying about work it never
 * did, so each gets its own toast with the fix attached.
 */

export interface EnqueueSummaryResponse {
  enqueued: boolean;
  message: string;
  reason?: string | null;
}

export interface JobResponse {
  status?: 'skipped';
  reason?: string;
  fix?: string;
  job?: EnqueueSummaryResponse;
}

/**
 * Announce the result of a job request. Returns true when work is actually under way, so the
 * caller knows whether refreshing the screen is worth anything.
 */
export function reportJobResult(result: JobResponse, successTitle: string): boolean {
  if (result.status === 'skipped') {
    toast.warning(result.reason ?? 'That job could not be queued.', {
      description: result.fix,
      duration: 10_000,
    });
    return false;
  }

  if (result.job && !result.job.enqueued) {
    toast.warning('Recorded, but nothing is running it', {
      description: result.job.message,
      duration: 10_000,
    });
    return false;
  }

  toast.success(successTitle, { description: result.job?.message });
  return true;
}

/** One place to turn an `ApiError` into readable copy, with a caller-supplied fallback. */
export function reportApiError(error: unknown, fallback: string): void {
  toast.error(error instanceof ApiError ? error.message : fallback);
}
