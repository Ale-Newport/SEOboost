import 'server-only';
import { z } from 'zod';
import { getAppSetting, prisma } from '@seo/db';
import { ForbiddenError, ValidationError, env } from '@seo/shared';
import type { EnqueueResult } from '@seo/queue';
import { requireWebsite } from '@/lib/api';
import type { SessionUser } from '@/lib/auth';

/**
 * Cross-cutting helpers shared by every API route in this app.
 *
 * Lives under `app/api/_lib` — the leading underscore keeps Next from treating it as a route
 * segment — so route files stay thin and every route enforces ownership the same way.
 */

export type ScopedWebsite = Awaited<ReturnType<typeof requireWebsite>>;

export const websiteScopeSchema = z.object({
  websiteId: z.string().trim().min(1).optional(),
});

export interface WebsiteScope {
  /** Every website the request may read: one when `websiteId` was given, else the whole portfolio. */
  websiteIds: string[];
  /** The single website, when the request was scoped to one. */
  website: ScopedWebsite | null;
}

/**
 * Resolve the set of websites a request may touch.
 *
 * A `websiteId` always goes through `requireWebsite` (the single ownership check); without one
 * the caller gets exactly the sites they own, so a portfolio query can never leak another
 * account's rows even though it spans many websites.
 */
export async function resolveScope(user: SessionUser, websiteId?: string): Promise<WebsiteScope> {
  if (websiteId) {
    const website = await requireWebsite(user.id, websiteId);
    return { websiteIds: [website.id], website };
  }
  const rows = await prisma.website.findMany({
    where: { userId: user.id },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return { websiteIds: rows.map((row) => row.id), website: null };
}

/** Website-scoped routes that cannot work portfolio-wide. */
export async function requireScopedWebsite(user: SessionUser, websiteId?: string): Promise<ScopedWebsite> {
  if (!websiteId) throw new ValidationError('websiteId is required for this endpoint.');
  return requireWebsite(user.id, websiteId);
}

// ── query-string helpers ─────────────────────────────────────

/** A query parameter that may be repeated (`?s=A&s=B`) or comma-separated (`?s=A,B`). */
export const multiValueParam = z.union([z.string(), z.array(z.string())]).optional();

/**
 * A boolean query parameter.
 *
 * Deliberately not `z.coerce.boolean()`: that is `Boolean(value)`, which turns the string
 * `"false"` into `true` — so `?flag=false` would silently mean the opposite of what it says.
 */
export function booleanParam(defaultValue: boolean) {
  return z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) =>
      typeof value === 'boolean'
        ? value
        : !['false', '0', 'no', 'off', ''].includes(value.trim().toLowerCase()),
    );
}

/**
 * Narrow a repeated/comma-separated parameter to members of an enum.
 * Unknown values are a 400 rather than being silently dropped — a typo in a filter that
 * quietly returns everything is worse than an error.
 */
export function parseEnumList<T extends string>(raw: unknown, allowed: readonly T[]): T[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const unknown = parts.filter((value) => !(allowed as readonly string[]).includes(value));
  if (unknown.length > 0) {
    throw new ValidationError(
      `Unsupported value${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`,
    );
  }
  return parts as T[];
}

/** Repeated/comma-separated free-form ids (no enum to validate against). */
export function parseIdList(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

// ── enqueue results ──────────────────────────────────────────

export interface EnqueueSummary {
  enqueued: boolean;
  queue: string;
  /** Durable JobRecord row — present even when Redis refused the job. */
  jobRecordId: string | null;
  jobId: string | null;
  schedulerId: string | null;
  reason: string | null;
  message: string;
}

/**
 * Flatten an `EnqueueResult` for the wire.
 *
 * A failed enqueue is reported as data, not as an error: the durable JobRecord row exists
 * either way and the UI needs to say "queued but no worker is connected" rather than
 * pretending the work is under way.
 */
export function enqueueSummary(result: EnqueueResult): EnqueueSummary {
  const base = { jobRecordId: null, jobId: null, schedulerId: null, reason: null } as const;

  if (result.enqueued && result.kind === 'job') {
    return {
      ...base,
      enqueued: true,
      queue: result.queue,
      jobRecordId: result.jobRecordId,
      jobId: result.jobId,
      message: 'Queued.',
    };
  }
  if (result.enqueued) {
    return {
      ...base,
      enqueued: true,
      queue: result.queue,
      schedulerId: result.schedulerId,
      message: 'Schedule registered.',
    };
  }
  if (result.reason === 'redis-unavailable') {
    return {
      ...base,
      enqueued: false,
      queue: result.queue,
      jobRecordId: result.jobRecordId,
      reason: result.reason,
      message:
        'Recorded in the database only: no queue broker is reachable, so no worker will pick this up. ' +
        'Set REDIS_URL and start the worker, then retry the job from the Jobs screen.',
    };
  }
  if (result.reason === 'duplicate') {
    return {
      ...base,
      enqueued: false,
      queue: result.queue,
      jobRecordId: result.jobRecordId,
      reason: result.reason,
      message: 'The same job is already queued or running; it was not queued twice.',
    };
  }
  return {
    ...base,
    enqueued: false,
    queue: result.queue,
    reason: result.reason,
    message: result.error,
  };
}

// ── typed "we did not do that" results ───────────────────────

export interface SkippedResult {
  status: 'skipped';
  reason: string;
  /** Exactly what the operator must configure for this to work. */
  fix: string;
}

/** Never invent output for a missing prerequisite — say what is missing and how to fix it. */
export function skipped(reason: string, fix: string): SkippedResult {
  return { status: 'skipped', reason, fix };
}

// ── write guards ─────────────────────────────────────────────

/** AppSetting key holding the operator-set read-only switch. */
export const READ_ONLY_SETTING_KEY = 'app.readOnly';

/**
 * Block writes that change a customer's live site or the installation's global configuration.
 * Demo installs (`DEMO_MODE`) and an operator-set read-only flag both take effect here rather
 * than only being hidden in the UI.
 */
export async function assertNotReadOnly(): Promise<void> {
  if (env.demoMode) {
    throw new ForbiddenError('This installation runs in demo mode; changes are disabled.');
  }
  const readOnly = await getAppSetting<boolean>(READ_ONLY_SETTING_KEY, false);
  if (readOnly === true) {
    throw new ForbiddenError('This installation is in read-only mode. Turn it off in Settings to make changes.');
  }
}

export const ADMIN_ROLES = ['OWNER', 'ADMIN'] as const;

export function requireRole(user: SessionUser, roles: readonly string[]): void {
  if (!roles.includes(user.role)) {
    throw new ForbiddenError(`This action requires one of these roles: ${roles.join(', ')}.`);
  }
}

/** Display name for audit trails (ChangeLog, ContentVersion authorship). */
export function actorName(user: SessionUser): string {
  return user.name?.trim() || user.email || 'user';
}
