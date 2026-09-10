/**
 * Shared contracts for every integration provider (Google, Bing, SERP, backlinks, CMS).
 *
 * Deliberately small and provider-agnostic: every provider module in this package imports
 * from here, so anything added becomes part of the cross-provider surface.
 */

import type { IntegrationHealth } from '@seo/shared';

export type { IntegrationHealth };

/** What a provider can actually do, so the UI can hide features an account cannot use. */
export type ProviderCapability =
  | 'search-analytics'
  | 'sitemap-submit'
  | 'url-inspection'
  | 'traffic-analytics'
  | 'keyword-metrics'
  | 'serp-results'
  | 'backlinks'
  | 'content-publish'
  | 'index-submission';

// ── Credentials ──────────────────────────────────────────────
// These are the *decrypted* shapes. They only ever exist in memory on the server:
// what lands in Integration.credentials is `encryptJson(...)` of one of these, and no
// API route or server action may return one to a client.

export interface OAuth2Credentials {
  kind: 'oauth2';
  accessToken?: string;
  refreshToken?: string;
  /** Epoch ms at which `accessToken` stops working. */
  expiresAt?: number;
  /** Space-delimited scope string exactly as the provider returned it. */
  scope?: string;
  tokenType?: string;
  idToken?: string;
}

export interface ApiKeyCredentials {
  kind: 'api-key';
  apiKey: string;
  /** Some providers pair the key with an account/customer id. */
  accountId?: string;
}

export interface BasicAuthCredentials {
  kind: 'basic';
  login: string;
  password: string;
}

export type IntegrationCredentials = OAuth2Credentials | ApiKeyCredentials | BasicAuthCredentials;

// ── Sync results ─────────────────────────────────────────────

/**
 * Why a sync imported nothing. Present instead of an exception so a nightly job over
 * many sites keeps going when one site is not connected.
 */
export type SyncSkipReason =
  | 'NOT_CONFIGURED'
  | 'NOT_CONNECTED'
  | 'PERMISSION_DENIED'
  | 'CREDENTIALS_EXPIRED'
  | 'NO_DATA';

export interface SyncResult {
  rowsImported: number;
  /** Rows that already existed for the window and were replaced by fresher provider data. */
  rowsUpdated: number;
  /** Inclusive first day of the imported window, `YYYY-MM-DD` (UTC). */
  from: string;
  /** Inclusive last day of the imported window, `YYYY-MM-DD` (UTC). */
  to: string;
  warnings: string[];
  skipped?: SyncSkipReason;
}

export function emptySyncResult(
  from: string,
  to: string,
  skipped?: SyncSkipReason,
  warning?: string,
): SyncResult {
  return {
    rowsImported: 0,
    rowsUpdated: 0,
    from,
    to,
    warnings: warning ? [warning] : [],
    ...(skipped ? { skipped } : {}),
  };
}

/** Fold per-window results (month-by-month backfills) into one. */
export function mergeSyncResults(results: readonly SyncResult[]): SyncResult {
  if (results.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return emptySyncResult(today, today, 'NO_DATA');
  }
  const sorted = [...results].sort((a, b) => (a.from < b.from ? -1 : 1));
  const first = sorted[0] as SyncResult;
  const last = sorted.reduce((acc, r) => (r.to > acc.to ? r : acc), first);
  // A merged run is only "skipped" when every window skipped for the same reason.
  const reasons = new Set(results.map((r) => r.skipped));
  const skipped = reasons.size === 1 ? results[0]?.skipped : undefined;
  return {
    rowsImported: results.reduce((n, r) => n + r.rowsImported, 0),
    rowsUpdated: results.reduce((n, r) => n + r.rowsUpdated, 0),
    from: first.from,
    to: last.to,
    warnings: [...new Set(results.flatMap((r) => r.warnings))],
    ...(skipped ? { skipped } : {}),
  };
}

// ── Non-throwing operation results ───────────────────────────

export type IntegrationErrorCode =
  | 'NOT_CONFIGURED'
  | 'CREDENTIALS_EXPIRED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'INVALID_REQUEST'
  | 'UNSUPPORTED'
  | 'PROVIDER_ERROR';

export interface IntegrationSuccess<T> {
  ok: true;
  data: T;
}

export interface IntegrationFailure {
  ok: false;
  code: IntegrationErrorCode;
  error: string;
  /** True when the same call may succeed later (quota, transient 5xx). */
  retryable: boolean;
}

/**
 * For provider calls the caller is expected to *handle* rather than crash on — sitemap
 * submission, URL inspection, per-page lookups. Hard misconfiguration still throws.
 */
export type IntegrationResult<T> = IntegrationSuccess<T> | IntegrationFailure;

export function integrationOk<T>(data: T): IntegrationSuccess<T> {
  return { ok: true, data };
}

export function integrationFail(
  code: IntegrationErrorCode,
  error: string,
  retryable = false,
): IntegrationFailure {
  return { ok: false, code, error, retryable };
}

// ── Provider registry ────────────────────────────────────────

/** Static description of a provider; the package barrel turns these into IntegrationHealth. */
export interface ProviderDescriptor {
  /** Matches the Prisma IntegrationProvider enum value where one exists. */
  provider: string;
  label: string;
  capabilities: ProviderCapability[];
  /** Env vars the operator must set before this provider can be connected at all. */
  requiredEnv: string[];
  /** Server-side env check; must never touch the database or the network. */
  isConfigured: () => boolean;
}

/**
 * Implemented by the package barrel (`src/index.ts`): a synchronous, env-only snapshot of
 * every provider for the settings screen and the health endpoint.
 */
export type DescribeIntegrations = () => IntegrationHealth[];
