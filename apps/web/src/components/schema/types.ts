/**
 * Wire shapes for the structured-data endpoints.
 *
 * These screens read `/api/schema`, `/api/schema/declined` and `/api/schema/validate` from the
 * browser, so every response has already been through `JSON.stringify`: what the server typed
 * as `Date` is an ISO string here, and `Json` columns arrive as `unknown`. Both are typed as
 * what they actually are — a component that believes `updatedAt` is a `Date` will throw the
 * first time a real response reaches it.
 */

export type SchemaValidationStatusValue = 'VALID' | 'WARNING' | 'INVALID' | 'UNVALIDATED';

export type DeploymentStatusValue = 'NOT_DEPLOYED' | 'PENDING' | 'DEPLOYED' | 'FAILED';

export const VALIDATION_STATUS_VALUES: readonly SchemaValidationStatusValue[] = [
  'VALID',
  'WARNING',
  'INVALID',
  'UNVALIDATED',
];

export const DEPLOYMENT_STATUS_VALUES: readonly DeploymentStatusValue[] = [
  'NOT_DEPLOYED',
  'PENDING',
  'DEPLOYED',
  'FAILED',
];

export interface SchemaIssue {
  severity: 'error' | 'warning';
  /** JSON path into the block, e.g. `$.mainEntity[0].acceptedAnswer`. */
  path: string;
  message: string;
}

export interface SchemaPageRef {
  id: string;
  url: string;
  title: string | null;
  pageType: string;
}

export interface StructuredDataItemDto {
  id: string;
  schemaType: string;
  /** The stored JSON-LD block. `null` when the row holds no parseable markup. */
  jsonLd: unknown;
  /** Who produced it: `generated`, `manual`, `imported`… free-form on the server. */
  source: string;
  validationStatus: SchemaValidationStatusValue;
  /** `Json` column: validated at the edge of the UI rather than trusted. */
  validationErrors: unknown[];
  deploymentStatus: DeploymentStatusValue;
  deployedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Site-wide markup (Organization, WebSite) is not attached to any one page. */
  page: SchemaPageRef | null;
}

export interface SchemaListResponse {
  websiteId: string;
  items: StructuredDataItemDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: {
    byValidation: Partial<Record<SchemaValidationStatusValue, number>>;
    byType: Record<string, number>;
    /** Distinct pages carrying at least one block. */
    pagesWithSchema: number;
    indexablePages: number;
  };
  supportedTypes: string[];
}

export interface DeclinedFindingDto {
  url: string;
  schemaType: string;
  /** The generator's own sentence, e.g. "only 1 genuine Q&A pair is visible on the page". */
  reason: string;
}

export interface SchemaDeclinedResponse {
  websiteId: string;
  run: { id: string; startedAt: string; finishedAt: string | null; summary: string | null } | null;
  declined: DeclinedFindingDto[];
  /** The run's own count, which can exceed `declined.length` — only 30 examples are kept. */
  total: number;
  byType: Record<string, number>;
  policy: string | null;
}

export interface ValidateResponse {
  status: 'VALID' | 'WARNING' | 'INVALID';
  types: string[];
  issues: SchemaIssue[];
  /** Set when the text was not JSON at all; the issue list then holds only that. */
  parseError: string | null;
  stored: boolean;
  itemId?: string;
}

/** Every mutating endpoint in this area may answer "I did not do that, and here is why". */
export interface SkippedDto {
  status?: 'skipped';
  reason?: string;
  fix?: string;
}

export interface EnqueueSummaryDto {
  enqueued: boolean;
  queue: string;
  jobRecordId: string | null;
  jobId: string | null;
  schedulerId: string | null;
  reason: string | null;
  message: string;
}

export interface GenerateResponse extends SkippedDto {
  pagesInScope?: number;
  job?: EnqueueSummaryDto;
}

export interface DeployResponse extends SkippedDto {
  item?: { id: string; deploymentStatus: DeploymentStatusValue };
  actionId?: string;
  validation?: { status: ValidateResponse['status']; types: string[]; issues: SchemaIssue[] };
  job?: EnqueueSummaryDto;
}

export interface DeleteResponse {
  deleted: string;
  schemaType: string;
  /** Present when the block was already live — deleting the row does not retract it. */
  warning: string | null;
}

/** `validationErrors` is a `Json` column, so nothing about its contents is guaranteed. */
export function toIssues(raw: unknown): SchemaIssue[] {
  if (!Array.isArray(raw)) return [];
  const issues: SchemaIssue[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.message !== 'string') continue;
    issues.push({
      severity: row.severity === 'error' ? 'error' : 'warning',
      path: typeof row.path === 'string' ? row.path : '$',
      message: row.message,
    });
  }
  return issues;
}

export function countErrors(issues: readonly SchemaIssue[]): number {
  return issues.filter((issue) => issue.severity === 'error').length;
}

/** Pretty-printed for reading; `null` markup is rendered as such rather than as `"null"`. */
export function formatJsonLd(jsonLd: unknown): string {
  if (jsonLd === null || jsonLd === undefined) return '';
  try {
    return JSON.stringify(jsonLd, null, 2);
  } catch {
    return '';
  }
}

/** The exact tag to paste into a page template — the artefact operators actually ship. */
export function scriptTag(jsonLd: unknown): string {
  const body = formatJsonLd(jsonLd);
  if (body.length === 0) return '';
  return `<script type="application/ld+json">\n${body}\n</script>`;
}
