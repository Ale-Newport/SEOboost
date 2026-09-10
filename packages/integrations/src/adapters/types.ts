/**
 * The adapter contract — the layer that actually deploys approved changes to a
 * customer's website.
 *
 * Two invariants shape every type in this file:
 *
 * 1. **Nothing is ever faked.** An adapter that cannot do something says so
 *    (`capabilities` + an `UNSUPPORTED` failure), it never returns a fabricated
 *    success. Callers persist these results verbatim into ChangeLog rows, so a lie
 *    here becomes a permanent lie in the audit trail.
 * 2. **Every mutation is reversible-by-record.** Mutating methods carry a
 *    `beforeState` snapshot in their result, captured immediately before the write.
 *    Adapters that cannot read (webhook) return `beforeState: null` plus a warning,
 *    which is honest and lets the UI disable "roll back" for that change.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** What an adapter can actually do against the live site. Declared honestly, never aspirationally. */
export interface AdapterCapabilities {
  readContent: boolean;
  updateContent: boolean;
  createContent: boolean;
  publish: boolean;
  updateMetadata: boolean;
  injectStructuredData: boolean;
  createRedirect: boolean;
  updateSitemap: boolean;
}

export const NO_CAPABILITIES: AdapterCapabilities = {
  readContent: false,
  updateContent: false,
  createContent: false,
  publish: false,
  updateMetadata: false,
  injectStructuredData: false,
  createRedirect: false,
  updateSitemap: false,
};

/**
 * Why a call failed, in a form the executor can branch on.
 * `UNSUPPORTED` is deliberately distinct from `PROVIDER_ERROR`: the first means
 * "this platform will never do this", the second means "it failed this time".
 */
export type AdapterErrorCode =
  | 'NOT_CONFIGURED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'UNSUPPORTED'
  | 'NETWORK'
  | 'INVALID_RESPONSE'
  | 'PROVIDER_ERROR';

/** Retrying only helps for transient classes; the executor uses this to decide. */
const RETRYABLE_CODES: ReadonlySet<AdapterErrorCode> = new Set<AdapterErrorCode>([
  'RATE_LIMITED',
  'NETWORK',
  'PROVIDER_ERROR',
]);

export function isRetryableAdapterError(code: AdapterErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export type ContentStatus = 'draft' | 'publish' | 'pending' | 'private' | 'archived' | 'unknown';

export type RemoteContentType = 'post' | 'page' | 'article' | 'product' | 'collectionItem' | 'file' | 'other';

/** Enough to render a picker and to decide whether a page needs re-reading. */
export interface RemoteContentSummary {
  externalId: string;
  type: RemoteContentType;
  title: string;
  slug?: string;
  url?: string;
  status?: ContentStatus;
  /** ISO-8601. Absent when the platform does not report it. */
  updatedAt?: string;
  excerpt?: string;
}

/** The full remote document. Doubles as the before/after snapshot stored for rollback. */
export interface RemoteContent extends RemoteContentSummary {
  bodyHtml?: string;
  bodyMarkdown?: string;
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  structuredData?: JsonValue[];
  /**
   * Provider-specific handles a faithful rollback needs (WordPress revision id,
   * GitHub blob sha, Webflow field data, frontmatter map…). Opaque to the executor.
   */
  raw?: JsonObject;
}

/** Create input. `updateContent` takes a `ContentPatch` so partial edits stay expressible. */
export interface ContentPayload {
  title: string;
  slug?: string;
  bodyHtml?: string;
  bodyMarkdown?: string;
  excerpt?: string;
  metaTitle?: string;
  metaDescription?: string;
  status?: ContentStatus;
  structuredData?: JsonValue;
  /** Blog id (Shopify article), collection id (Webflow item), directory (git) — platform dependent. */
  container?: string;
  /** Git/PR adapters use this; ignored elsewhere. */
  commitMessage?: string;
}

export type ContentPatch = Partial<ContentPayload>;

export interface MetadataPatch {
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  /** `true` asks the platform to mark the URL noindex where that is expressible. */
  noindex?: boolean;
}

export interface ListContentOptions {
  type?: RemoteContentType;
  /** 1-based. Ignored by cursor-paginated platforms, which use `cursor`. */
  page?: number;
  pageSize?: number;
  search?: string;
  status?: ContentStatus;
  cursor?: string;
}

export interface RemoteContentPage {
  items: RemoteContentSummary[];
  /** Absent when the platform does not report a total (cursor pagination). */
  total?: number;
  nextCursor?: string;
  hasMore: boolean;
}

/** A reference to the thing that was created or changed. */
export interface ContentRef {
  id: string;
  url?: string;
}

export interface MetadataWriteResult {
  /** Exactly the fields the platform confirmed it stored. Never optimistic. */
  fieldsWritten: string[];
  /** Which mechanism carried the write ('yoast', 'rankmath', 'excerpt-fallback', 'metafield'…). */
  via: string;
}

export interface StructuredDataWriteResult {
  applied: boolean;
  via: string;
}

export interface RedirectWriteResult {
  from: string;
  to: string;
  type: RedirectType;
  via: string;
}

export type RedirectType = 301 | 302 | 307 | 308;

export interface AdapterResultMeta {
  /** Snapshot taken immediately before the mutation. `null` = this adapter cannot read. */
  beforeState?: RemoteContent | null;
  externalId?: string;
  url?: string;
  warnings?: string[];
}

export type AdapterResult<T> =
  | ({ ok: true; data: T; error?: undefined; errorCode?: undefined } & AdapterResultMeta)
  | ({ ok: false; data?: undefined; error: string; errorCode: AdapterErrorCode } & AdapterResultMeta);

export function adapterOk<T>(data: T, meta: AdapterResultMeta = {}): AdapterResult<T> {
  return { ok: true, data, ...meta };
}

export function adapterFail<T>(
  errorCode: AdapterErrorCode,
  error: string,
  meta: AdapterResultMeta = {},
): AdapterResult<T> {
  return { ok: false, errorCode, error, ...meta };
}

/** Standard refusal for a method a platform genuinely cannot perform. */
export function unsupported<T>(adapter: string, operation: string, detail?: string): AdapterResult<T> {
  const suffix = detail ? ` ${detail}` : '';
  return adapterFail<T>('UNSUPPORTED', `Not supported by this adapter (${adapter}.${operation}).${suffix}`);
}

export interface ConnectionInfo {
  detail: string;
  /** Free-form, non-secret facts worth showing on the integration card. */
  meta?: JsonObject;
}

/**
 * Every website adapter. Optional methods correspond 1:1 to optional capabilities —
 * if `capabilities.createRedirect` is true the method must exist.
 */
export interface WebsiteAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;

  /** Cheap authenticated round-trip. Must never mutate. */
  testConnection(): Promise<AdapterResult<ConnectionInfo>>;

  listContent(opts?: ListContentOptions): Promise<AdapterResult<RemoteContentPage>>;
  getContent(externalId: string): Promise<AdapterResult<RemoteContent>>;
  createContent(payload: ContentPayload): Promise<AdapterResult<ContentRef>>;
  updateContent(externalId: string, patch: ContentPatch): Promise<AdapterResult<ContentRef>>;
  updateMetadata(externalId: string, meta: MetadataPatch): Promise<AdapterResult<MetadataWriteResult>>;

  publishContent?(externalId: string): Promise<AdapterResult<ContentRef>>;
  injectStructuredData?(externalId: string, jsonLd: JsonValue): Promise<AdapterResult<StructuredDataWriteResult>>;
  createRedirect?(from: string, to: string, type?: RedirectType): Promise<AdapterResult<RedirectWriteResult>>;
  updateSitemap?(sitemapUrl: string): Promise<AdapterResult<{ submitted: boolean; via: string }>>;
}

/** Describes one credential/config field so the UI can render a connect form generically. */
export interface AdapterFieldSpec {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

/** Non-secret context every adapter gets from the Website row. */
export interface AdapterSiteContext {
  websiteId: string;
  /** Bare hostname, e.g. `example.com`. */
  domain: string;
  protocol: string;
  /** `https://example.com` — convenience for adapters that default their base URL to the site. */
  siteUrl: string;
}

export function siteUrlFor(domain: string, protocol: string): string {
  return `${protocol || 'https'}://${domain.replace(/\/+$/, '')}`;
}
