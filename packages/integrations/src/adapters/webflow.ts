import { createLogger } from '@seo/shared';
import {
  codeForStatus,
  failFromThrown,
  httpRequest,
  isRecord,
  providerMessage,
  readArray,
  readBoolean,
  readIsoDate,
  readNumber,
  readRecord,
  readString,
  toJsonObject,
  trimTrailingSlash,
  type HttpRequestOptions,
  type HttpResult,
} from './http';
import {
  adapterFail,
  adapterOk,
  unsupported,
  type AdapterCapabilities,
  type AdapterFieldSpec,
  type AdapterResult,
  type AdapterResultMeta,
  type AdapterSiteContext,
  type ConnectionInfo,
  type ContentPatch,
  type ContentPayload,
  type ContentRef,
  type ContentStatus,
  type JsonObject,
  type ListContentOptions,
  type MetadataPatch,
  type MetadataWriteResult,
  type RedirectWriteResult,
  type RemoteContent,
  type RemoteContentPage,
  type RemoteContentSummary,
  type StructuredDataWriteResult,
  type WebsiteAdapter,
} from './types';

/**
 * Webflow Data API v2 adapter for CMS collection items.
 *
 * Webflow has no universal SEO fields: a collection's page SEO is whatever field the
 * Designer was told to bind the title/description to. So the adapter reads the collection
 * schema first and only writes fields that actually exist, mapped either explicitly
 * through the integration config or by matching the conventional slugs below. When no
 * field matches, `updateMetadata` fails with `UNSUPPORTED` and names the fields the
 * collection does have — writing an unknown key would be silently dropped by Webflow and
 * would look like a success.
 *
 * Writes are **staged** by default: a PATCH updates the item, and going live is a separate
 * publish step (`publishContent`). That mirrors how Webflow teams work and keeps an
 * unreviewed change off the production site.
 *
 * Auth is a site API token (Site settings → Apps & integrations → API access) or an OAuth
 * access token with the `cms:read` / `cms:write` scopes.
 */

const log = createLogger('adapters:webflow');

const WEBFLOW_API = 'https://api.webflow.com/v2';

/** Conventional field slugs, in priority order, used when the config has no explicit mapping. */
const FIELD_CANDIDATES = {
  metaTitle: ['seo-title', 'meta-title', 'seo-meta-title', 'title-tag', 'meta-title-tag'],
  metaDescription: ['seo-description', 'meta-description', 'seo-meta-description', 'meta-desc', 'description-tag'],
  canonicalUrl: ['canonical-url', 'canonical'],
  body: ['post-body', 'article-body', 'body', 'content', 'post-content', 'rich-text'],
  excerpt: ['summary', 'excerpt', 'post-summary', 'intro'],
} as const;

export type WebflowFieldRole = keyof typeof FIELD_CANDIDATES;

export interface WebflowCredentials {
  /** Site API token or OAuth access token with cms:read + cms:write. */
  token: string;
}

export interface WebflowFieldMapping {
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
  body?: string;
  excerpt?: string;
}

export interface WebflowConfig {
  /** Webflow site id (Site settings → General → Site ID). */
  siteId: string;
  /** Collections SEO OS may touch. Empty = every collection on the site. */
  collectionIds?: string[];
  /** Collection used when an externalId carries only an item id. */
  defaultCollectionId?: string;
  /** Explicit field-slug mapping, keyed by collection id then role; wins over the conventions. */
  fields?: Record<string, WebflowFieldMapping>;
  /**
   * Path prefix per collection id (`{ "6510…": "/blog" }`) so item URLs can be built.
   * Webflow's API does not expose which page renders a collection, so without this the
   * adapter reports no URL rather than guessing one.
   */
  pathPrefixes?: Record<string, string>;
  /** `true` writes straight to the live item (`/live`) instead of staging it. */
  publishImmediately?: boolean;
  timeoutMs?: number;
}

export const WEBFLOW_CAPABILITIES: AdapterCapabilities = {
  readContent: true,
  updateContent: true,
  // A new CMS item must satisfy every required field of a collection SEO OS did not design.
  // Creating items is left to the humans who own the collection schema.
  createContent: false,
  publish: true,
  updateMetadata: true,
  // Webflow renders JSON-LD from custom code in page/site settings, which the Data API
  // does not expose.
  injectStructuredData: false,
  // Webflow 301 redirects live in site settings and have no Data API v2 endpoint.
  createRedirect: false,
  updateSitemap: false,
};

export const WEBFLOW_CREDENTIAL_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'token',
    label: 'Webflow API token',
    required: true,
    secret: true,
    help: 'Site settings → Apps & integrations → API access → Generate token, with CMS read and write permissions.',
  },
];

export const WEBFLOW_CONFIG_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'siteId',
    label: 'Site ID',
    required: true,
    secret: false,
    help: 'Site settings → General → Site ID.',
  },
  {
    key: 'defaultCollectionId',
    label: 'Default collection ID',
    required: false,
    secret: false,
    help: 'Collection used when a content id has no collection prefix (e.g. your blog posts collection).',
  },
];

interface WebflowCollection {
  id: string;
  displayName: string;
  slug: string;
  fieldSlugs: string[];
}

interface WebflowTarget {
  collectionId: string;
  itemId: string;
}

export class WebflowAdapter implements WebsiteAdapter {
  readonly name = 'webflow';
  readonly capabilities = WEBFLOW_CAPABILITIES;

  private readonly timeoutMs: number;
  private collectionIndex: WebflowCollection[] | null = null;
  private readonly schemaCache = new Map<string, WebflowCollection>();

  constructor(
    private readonly credentials: WebflowCredentials,
    private readonly config: WebflowConfig,
    private readonly site: AdapterSiteContext,
  ) {
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  private request(path: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
    return httpRequest(`${WEBFLOW_API}${path}`, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      headers: {
        authorization: `Bearer ${this.credentials.token}`,
        'content-type': 'application/json',
        ...opts.headers,
      },
    });
  }

  private failFrom<T>(operation: string, res: HttpResult, meta: AdapterResultMeta = {}): AdapterResult<T> {
    const detail = providerMessage(res);
    let message: string;
    switch (res.status) {
      case 401:
        message =
          'Webflow rejected the API token. Generate a new token under Site settings → Apps & integrations → API access and reconnect the integration.';
        break;
      case 403:
        message =
          `The Webflow token is valid but not allowed to ${operation}. It needs the CMS read and write permissions ` +
          '(or the cms:read / cms:write OAuth scopes) for this site.';
        break;
      case 404:
        message = `Webflow returned 404 for ${operation}. The site, collection or item id no longer exists, or the token belongs to a different workspace.`;
        break;
      case 409:
        message = `Webflow reported a conflict for ${operation} — usually a slug that another item already uses.`;
        break;
      case 429:
        message = 'Webflow rate-limited the request (60 requests/minute per token). The change was not applied; retry shortly.';
        break;
      default:
        message = `Webflow ${operation} failed with HTTP ${res.status}.`;
        break;
    }
    return adapterFail<T>(codeForStatus(res.status), detail ? `${message} (${detail})` : message, meta);
  }

  /** `<collectionId>/<itemId>`, `<collectionId>:<itemId>`, or a bare item id + defaultCollectionId. */
  private parseTarget(externalId: string): WebflowTarget | null {
    const raw = externalId.trim();
    const split = /^([0-9a-f]{24}|[A-Za-z0-9_-]{6,})[:/]([A-Za-z0-9_-]{6,})$/.exec(raw);
    if (split?.[1] && split[2]) return { collectionId: split[1], itemId: split[2] };
    if (raw && !raw.includes('/') && !raw.includes(':') && this.config.defaultCollectionId) {
      return { collectionId: this.config.defaultCollectionId, itemId: raw };
    }
    return null;
  }

  private invalidId<T>(externalId: string): AdapterResult<T> {
    return adapterFail<T>(
      'VALIDATION',
      `"${externalId}" is not a Webflow item id. Use "<collectionId>/<itemId>", or set a default collection on the integration.`,
    );
  }

  /** Collections this integration may touch, in a stable order so cursor paging is deterministic. */
  private async getCollections(): Promise<AdapterResult<WebflowCollection[]>> {
    if (this.collectionIndex) return adapterOk(this.collectionIndex);

    const res = await this.request(`/sites/${encodeURIComponent(this.config.siteId)}/collections`);
    if (!res.ok) return this.failFrom<WebflowCollection[]>('list the site collections', res);

    const allowed = new Set(this.config.collectionIds ?? []);
    const collections = readArray(readRecord(res.body).collections)
      .filter(isRecord)
      .map((row) => ({
        id: readString(row.id) ?? '',
        displayName: readString(row.displayName) ?? '',
        slug: readString(row.slug) ?? '',
        // The list endpoint does not include fields; they are fetched per collection on demand.
        fieldSlugs: [],
      }))
      .filter((c) => c.id && (allowed.size === 0 || allowed.has(c.id)))
      .sort((a, b) => a.id.localeCompare(b.id));

    this.collectionIndex = collections;
    return adapterOk(collections);
  }

  /** Collection schema (field slugs), cached — every metadata decision depends on it. */
  private async getSchema(collectionId: string): Promise<AdapterResult<WebflowCollection>> {
    const cached = this.schemaCache.get(collectionId);
    if (cached) return adapterOk(cached);

    const res = await this.request(`/collections/${encodeURIComponent(collectionId)}`);
    if (!res.ok) return this.failFrom<WebflowCollection>(`read collection ${collectionId}`, res);

    const row = readRecord(res.body);
    const schema: WebflowCollection = {
      id: readString(row.id) ?? collectionId,
      displayName: readString(row.displayName) ?? '',
      slug: readString(row.slug) ?? '',
      fieldSlugs: readArray(row.fields)
        .filter(isRecord)
        .map((f) => readString(f.slug) ?? '')
        .filter(Boolean),
    };
    this.schemaCache.set(collectionId, schema);
    return adapterOk(schema);
  }

  /**
   * Resolve which field slug holds a given SEO role in this collection.
   * Explicit config wins; otherwise the first conventional slug the collection actually has.
   * Returns null when the collection has nowhere to put the value.
   */
  private resolveField(schema: WebflowCollection, role: WebflowFieldRole): string | null {
    const configured = this.config.fields?.[schema.id]?.[role];
    if (configured) return schema.fieldSlugs.includes(configured) ? configured : null;
    return FIELD_CANDIDATES[role].find((slug) => schema.fieldSlugs.includes(slug)) ?? null;
  }

  // ── read ────────────────────────────────────────────────────────────────────

  async testConnection(): Promise<AdapterResult<ConnectionInfo>> {
    try {
      const siteRes = await this.request(`/sites/${encodeURIComponent(this.config.siteId)}`);
      if (!siteRes.ok) return this.failFrom('read the site', siteRes);

      const site = readRecord(siteRes.body);
      const displayName = readString(site.displayName) ?? this.config.siteId;
      const domains = readArray(site.customDomains)
        .filter(isRecord)
        .map((d) => readString(d.url) ?? '')
        .filter(Boolean);

      const collections = await this.getCollections();
      if (!collections.ok) return adapterFail<ConnectionInfo>(collections.errorCode, collections.error);

      const warnings: string[] = [];
      if (!collections.data.length) {
        warnings.push(
          this.config.collectionIds?.length
            ? 'None of the configured collection ids exist on this Webflow site.'
            : 'This Webflow site has no CMS collections, so there is no content for SEO OS to edit.',
        );
      }
      if (domains.length && !domains.some((d) => d.includes(this.site.domain))) {
        warnings.push(
          `The Webflow site publishes to ${domains.join(', ')}, which does not include ${this.site.domain}. Check you connected the right site.`,
        );
      }

      return adapterOk<ConnectionInfo>(
        {
          detail: `Connected to Webflow site "${displayName}" with ${collections.data.length} collection(s) in scope.`,
          meta: {
            siteId: this.config.siteId,
            domains,
            collections: collections.data.map((c): JsonObject => ({ id: c.id, name: c.displayName, slug: c.slug })),
            writesLive: this.config.publishImmediately === true,
          },
        },
        { warnings },
      );
    } catch (err) {
      return failFromThrown('Webflow', 'Data API', err);
    }
  }

  /**
   * Items across the in-scope collections. The cursor is `<collectionIndex>:<offset>` so a
   * caller can walk every collection without the adapter holding state between calls.
   */
  async listContent(opts: ListContentOptions = {}): Promise<AdapterResult<RemoteContentPage>> {
    const limit = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);

    try {
      const collections = await this.getCollections();
      if (!collections.ok) return adapterFail<RemoteContentPage>(collections.errorCode, collections.error);
      if (!collections.data.length) return adapterOk<RemoteContentPage>({ items: [], total: 0, hasMore: false });

      const cursor = parseCursor(opts.cursor);
      const index = Math.min(Math.max(cursor?.index ?? 0, 0), collections.data.length - 1);
      const offset = Math.max(cursor?.offset ?? 0, 0);
      const collection = collections.data[index];
      if (!collection) return adapterOk<RemoteContentPage>({ items: [], total: 0, hasMore: false });

      const res = await this.request(`/collections/${encodeURIComponent(collection.id)}/items`, {
        query: { limit, offset },
      });
      if (!res.ok) return this.failFrom<RemoteContentPage>(`list items in collection ${collection.id}`, res);

      const body = readRecord(res.body);
      const rows = readArray(body.items).filter(isRecord);
      const total = readNumber(readRecord(body.pagination).total);

      const items = rows
        .map((row) => this.toSummary(row, collection.id))
        .filter((item) => matchesSearch(item, opts.search))
        .filter((item) => matchesStatus(item, opts.status));

      // `rows.length > 0` is the loop guard: an empty page whose reported `total` still
      // claims more items would otherwise hand back the cursor it was called with, and the
      // caller would page forever.
      const moreInCollection =
        rows.length > 0 && (total !== undefined ? offset + rows.length < total : rows.length === limit);
      const nextCursor = moreInCollection
        ? `${index}:${offset + rows.length}`
        : index + 1 < collections.data.length
          ? `${index + 1}:0`
          : undefined;

      return adapterOk<RemoteContentPage>({
        items,
        // `total` is per collection; reporting it as the whole-site total would be wrong.
        total: collections.data.length === 1 ? total : undefined,
        nextCursor,
        hasMore: Boolean(nextCursor),
      });
    } catch (err) {
      return failFromThrown<RemoteContentPage>('Webflow', 'list collection items', err);
    }
  }

  async getContent(externalId: string): Promise<AdapterResult<RemoteContent>> {
    const target = this.parseTarget(externalId);
    if (!target) return this.invalidId<RemoteContent>(externalId);
    return this.fetchContent(target);
  }

  private async fetchContent(target: WebflowTarget): Promise<AdapterResult<RemoteContent>> {
    try {
      const res = await this.request(
        `/collections/${encodeURIComponent(target.collectionId)}/items/${encodeURIComponent(target.itemId)}`,
      );
      if (!res.ok) return this.failFrom<RemoteContent>(`read item ${target.itemId}`, res);
      if (!isRecord(res.body)) {
        return adapterFail<RemoteContent>('INVALID_RESPONSE', 'Webflow returned an unexpected response shape.');
      }

      const schema = await this.getSchema(target.collectionId);
      if (!schema.ok) return adapterFail<RemoteContent>(schema.errorCode, schema.error);

      const summary = this.toSummary(res.body, target.collectionId);
      const fieldData = readRecord(readRecord(res.body).fieldData);
      const bodyField = this.resolveField(schema.data, 'body');
      const metaTitleField = this.resolveField(schema.data, 'metaTitle');
      const metaDescriptionField = this.resolveField(schema.data, 'metaDescription');
      const canonicalField = this.resolveField(schema.data, 'canonicalUrl');

      const content: RemoteContent = {
        ...summary,
        bodyHtml: bodyField ? readString(fieldData[bodyField]) : undefined,
        metaTitle: metaTitleField ? readString(fieldData[metaTitleField]) : undefined,
        metaDescription: metaDescriptionField ? readString(fieldData[metaDescriptionField]) : undefined,
        canonicalUrl: canonicalField ? readString(fieldData[canonicalField]) : undefined,
        // The whole fieldData map is the rollback payload: a PATCH restores it verbatim.
        raw: {
          collectionId: target.collectionId,
          itemId: target.itemId,
          cmsLocaleId: readString(readRecord(res.body).cmsLocaleId) ?? null,
          isDraft: readBoolean(readRecord(res.body).isDraft) ?? false,
          isArchived: readBoolean(readRecord(res.body).isArchived) ?? false,
          fieldData: toJsonObject(fieldData),
          mappedFields: {
            body: bodyField,
            metaTitle: metaTitleField,
            metaDescription: metaDescriptionField,
            canonicalUrl: canonicalField,
          },
        },
      };
      return adapterOk(content, { externalId: content.externalId, url: content.url });
    } catch (err) {
      return failFromThrown<RemoteContent>('Webflow', `read item ${target.itemId}`, err);
    }
  }

  private toSummary(row: Record<string, unknown>, collectionId: string): RemoteContentSummary {
    const itemId = readString(row.id) ?? '';
    const fieldData = readRecord(row.fieldData);
    const slug = readString(fieldData.slug);
    const prefix = this.config.pathPrefixes?.[collectionId];

    return {
      externalId: `${collectionId}/${itemId}`,
      type: 'collectionItem',
      title: readString(fieldData.name) ?? '',
      slug,
      url: prefix && slug ? `${this.site.siteUrl}/${trimSlashes(prefix)}/${slug}` : undefined,
      status: itemStatus(row),
      updatedAt: readIsoDate(row.lastUpdated),
    };
  }

  // ── write ───────────────────────────────────────────────────────────────────

  async createContent(_payload: ContentPayload): Promise<AdapterResult<ContentRef>> {
    return unsupported(
      'webflow',
      'createContent',
      'A Webflow collection defines its own required fields, so SEO OS will not invent an item. Create the item in the Webflow CMS and SEO OS will update and optimise it.',
    );
  }

  async updateContent(externalId: string, patch: ContentPatch): Promise<AdapterResult<ContentRef>> {
    const target = this.parseTarget(externalId);
    if (!target) return this.invalidId<ContentRef>(externalId);
    if (patch.bodyHtml === undefined && patch.bodyMarkdown !== undefined) {
      return adapterFail<ContentRef>(
        'VALIDATION',
        'Webflow rich-text fields store HTML — supply `bodyHtml`. Render the Markdown first so the published output is reviewable.',
      );
    }

    const schema = await this.getSchema(target.collectionId);
    if (!schema.ok) return adapterFail<ContentRef>(schema.errorCode, schema.error);

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<ContentRef>(before.errorCode, before.error);

    const fieldData: JsonObject = {};
    const warnings: string[] = [];
    if (patch.title !== undefined) fieldData.name = patch.title;
    if (patch.slug !== undefined) fieldData.slug = patch.slug;
    if (patch.bodyHtml !== undefined) {
      const bodyField = this.resolveField(schema.data, 'body');
      if (!bodyField) {
        return adapterFail<ContentRef>(
          'UNSUPPORTED',
          `Collection "${schema.data.displayName || schema.data.id}" has no rich-text body field this adapter recognises. ` +
            `Map one with the integration config (fields.${schema.data.id}.body); available fields: ${schema.data.fieldSlugs.join(', ') || 'none'}.`,
          { beforeState: before.data },
        );
      }
      fieldData[bodyField] = patch.bodyHtml;
    }
    if (patch.excerpt !== undefined) {
      const excerptField = this.resolveField(schema.data, 'excerpt');
      if (excerptField) fieldData[excerptField] = patch.excerpt;
      else warnings.push('This collection has no summary/excerpt field, so the excerpt was not written.');
    }
    if (patch.metaTitle !== undefined || patch.metaDescription !== undefined) {
      warnings.push('SEO title and description are written by updateMetadata, not by a content update, and were ignored here.');
    }

    if (!Object.keys(fieldData).length) {
      return adapterFail<ContentRef>('VALIDATION', 'No updatable content fields were supplied.', {
        beforeState: before.data,
        warnings,
      });
    }

    const body: JsonObject = { fieldData };
    if (patch.status !== undefined) body.isDraft = patch.status !== 'publish';

    return this.patchItem(target, body, before.data, `update item ${target.itemId}`, warnings);
  }

  private async patchItem(
    target: WebflowTarget,
    body: JsonObject,
    beforeState: RemoteContent,
    operation: string,
    warnings: string[] = [],
  ): Promise<AdapterResult<ContentRef>> {
    // `/live` writes straight to the published site; the default staged write needs a
    // separate publish, which is the safer default for a review workflow.
    const suffix = this.config.publishImmediately ? '/live' : '';
    try {
      const res = await this.request(
        `/collections/${encodeURIComponent(target.collectionId)}/items/${encodeURIComponent(target.itemId)}${suffix}`,
        { method: 'PATCH', body },
      );
      if (!res.ok) return this.failFrom<ContentRef>(operation, res, { beforeState, warnings });

      const externalId = `${target.collectionId}/${target.itemId}`;
      const url = this.toSummary(readRecord(res.body), target.collectionId).url ?? beforeState.url;
      const allWarnings = [...warnings];
      if (!this.config.publishImmediately) {
        allWarnings.push('The item was updated in Webflow but not published — publish the site (or run a publish action) to make it live.');
      }
      log.debug('webflow item patched', { collectionId: target.collectionId, itemId: target.itemId });
      return adapterOk<ContentRef>({ id: externalId, url }, { externalId, url, beforeState, warnings: allWarnings });
    } catch (err) {
      return failFromThrown<ContentRef>('Webflow', operation, err);
    }
  }

  /** Clear the draft flag, then publish the single item and confirm Webflow listed it as published. */
  async publishContent(externalId: string): Promise<AdapterResult<ContentRef>> {
    const target = this.parseTarget(externalId);
    if (!target) return this.invalidId<ContentRef>(externalId);

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<ContentRef>(before.errorCode, before.error);

    try {
      const staged = await this.request(
        `/collections/${encodeURIComponent(target.collectionId)}/items/${encodeURIComponent(target.itemId)}`,
        { method: 'PATCH', body: { isDraft: false, isArchived: false } },
      );
      if (!staged.ok) return this.failFrom<ContentRef>(`take item ${target.itemId} out of draft`, staged, {
        beforeState: before.data,
      });

      const res = await this.request(`/collections/${encodeURIComponent(target.collectionId)}/items/publish`, {
        method: 'POST',
        body: { itemIds: [target.itemId] },
      });
      if (!res.ok) return this.failFrom<ContentRef>(`publish item ${target.itemId}`, res, { beforeState: before.data });

      const published = readArray(readRecord(res.body).publishedItemIds).map((id) => String(id));
      if (published.length && !published.includes(target.itemId)) {
        return adapterFail<ContentRef>(
          'PROVIDER_ERROR',
          `Webflow accepted the publish request but did not publish item ${target.itemId}. This usually means the site has no published domain yet.`,
          { beforeState: before.data },
        );
      }

      const id = `${target.collectionId}/${target.itemId}`;
      return adapterOk<ContentRef>({ id, url: before.data.url }, {
        externalId: id,
        url: before.data.url,
        beforeState: before.data,
      });
    } catch (err) {
      return failFromThrown<ContentRef>('Webflow', `publish item ${target.itemId}`, err);
    }
  }

  /**
   * Write SEO metadata into whichever collection fields hold it, then re-read the item to
   * confirm — Webflow ignores unknown `fieldData` keys without complaining.
   */
  async updateMetadata(externalId: string, patch: MetadataPatch): Promise<AdapterResult<MetadataWriteResult>> {
    const target = this.parseTarget(externalId);
    if (!target) return this.invalidId<MetadataWriteResult>(externalId);

    const schema = await this.getSchema(target.collectionId);
    if (!schema.ok) return adapterFail<MetadataWriteResult>(schema.errorCode, schema.error);

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<MetadataWriteResult>(before.errorCode, before.error);

    const fieldData: JsonObject = {};
    const expected: Array<{ field: string; slug: string; value: string }> = [];
    const warnings: string[] = [];
    const missing: string[] = [];

    const plan = (role: WebflowFieldRole, field: string, value: string | undefined): void => {
      if (value === undefined) return;
      const slug = this.resolveField(schema.data, role);
      if (!slug) {
        missing.push(field);
        return;
      }
      fieldData[slug] = value;
      expected.push({ field, slug, value });
    };

    plan('metaTitle', 'metaTitle', patch.metaTitle);
    plan('metaDescription', 'metaDescription', patch.metaDescription);
    plan('canonicalUrl', 'canonicalUrl', patch.canonicalUrl);
    if (patch.noindex !== undefined) {
      warnings.push(
        'Webflow has no CMS field for a robots directive — set the collection page to noindex in the Designer\'s page settings instead.',
      );
    }

    if (!expected.length) {
      return adapterFail<MetadataWriteResult>(
        'UNSUPPORTED',
        `Collection "${schema.data.displayName || schema.data.id}" has no field for ${missing.join(', ') || 'the requested metadata'}. ` +
          'Add a plain-text field (conventionally `seo-title` / `seo-description`), bind it in the Designer\'s page SEO settings, ' +
          `then map it with fields.${schema.data.id} on this integration. Available fields: ${schema.data.fieldSlugs.join(', ') || 'none'}.`,
        { beforeState: before.data, warnings },
      );
    }
    if (missing.length) warnings.push(`This collection has no field for: ${missing.join(', ')}.`);

    const written = await this.patchItem(target, { fieldData }, before.data, 'write SEO metadata', warnings);
    if (!written.ok) return adapterFail<MetadataWriteResult>(written.errorCode, written.error, { beforeState: before.data });

    const after = await this.fetchContent(target);
    if (!after.ok) {
      return adapterFail<MetadataWriteResult>(
        after.errorCode,
        `The metadata write was sent but could not be verified: ${after.error}`,
        { beforeState: before.data },
      );
    }
    const stored = readRecord(readRecord(toJsonObject(after.data.raw)).fieldData);
    const confirmed = expected.filter((e) => readString(stored[e.slug]) === e.value).map((e) => e.field);
    const rejected = expected.filter((e) => !confirmed.includes(e.field)).map((e) => e.field);

    if (!confirmed.length) {
      return adapterFail<MetadataWriteResult>(
        'PROVIDER_ERROR',
        `Webflow accepted the update but stored none of ${expected.map((e) => e.slug).join(', ')}. Check the field types are plain text.`,
        { beforeState: before.data, externalId: before.data.externalId },
      );
    }
    if (rejected.length) warnings.push(`Webflow did not store: ${rejected.join(', ')}.`);

    return adapterOk<MetadataWriteResult>(
      { fieldsWritten: confirmed, via: `collection-field:${expected.map((e) => e.slug).join(',')}` },
      {
        beforeState: before.data,
        externalId: before.data.externalId,
        url: before.data.url,
        warnings: [...warnings, ...(written.warnings ?? [])],
      },
    );
  }

  async injectStructuredData(): Promise<AdapterResult<StructuredDataWriteResult>> {
    return unsupported(
      'webflow',
      'injectStructuredData',
      'Webflow renders JSON-LD from custom code in page or site settings, which the Data API v2 does not expose. Add the schema block in the Designer.',
    );
  }

  async createRedirect(): Promise<AdapterResult<RedirectWriteResult>> {
    return unsupported(
      'webflow',
      'createRedirect',
      'Webflow 301 redirects are configured under Site settings → Publishing and have no Data API endpoint. Add the rule there or at your CDN.',
    );
  }

  async updateSitemap(): Promise<AdapterResult<{ submitted: boolean; via: string }>> {
    return unsupported(
      'webflow',
      'updateSitemap',
      'Webflow generates the sitemap on publish. Submit it through Search Console instead.',
    );
  }
}

export function createWebflowAdapter(input: {
  credentials: WebflowCredentials;
  config: WebflowConfig;
  site: AdapterSiteContext;
}): WebflowAdapter {
  return new WebflowAdapter(input.credentials, input.config, input.site);
}

export function parseWebflowCredentials(value: unknown): WebflowCredentials | null {
  if (!isRecord(value)) return null;
  const token = readString(value.token) ?? readString(value.apiToken) ?? readString(value.accessToken);
  return token ? { token } : null;
}

export function parseWebflowConfig(value: unknown): WebflowConfig | null {
  if (!isRecord(value)) return null;
  const siteId = readString(value.siteId) ?? readString(value.site);
  if (!siteId) return null;

  const fields: Record<string, WebflowFieldMapping> = {};
  if (isRecord(value.fields)) {
    for (const [collectionId, raw] of Object.entries(value.fields)) {
      const mapping = readRecord(raw);
      fields[collectionId] = {
        metaTitle: readString(mapping.metaTitle),
        metaDescription: readString(mapping.metaDescription),
        canonicalUrl: readString(mapping.canonicalUrl),
        body: readString(mapping.body),
        excerpt: readString(mapping.excerpt),
      };
    }
  }

  const pathPrefixes: Record<string, string> = {};
  if (isRecord(value.pathPrefixes)) {
    for (const [collectionId, raw] of Object.entries(value.pathPrefixes)) {
      const prefix = readString(raw);
      if (prefix) pathPrefixes[collectionId] = prefix;
    }
  }

  return {
    siteId,
    collectionIds: readArray(value.collectionIds)
      .map((id) => readString(id) ?? '')
      .filter(Boolean),
    defaultCollectionId: readString(value.defaultCollectionId),
    fields: Object.keys(fields).length ? fields : undefined,
    pathPrefixes: Object.keys(pathPrefixes).length ? pathPrefixes : undefined,
    publishImmediately: readBoolean(value.publishImmediately) ?? false,
    timeoutMs: readNumber(value.timeoutMs),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function parseCursor(cursor: string | undefined): { index: number; offset: number } | null {
  if (!cursor) return null;
  const [rawIndex, rawOffset] = cursor.split(':');
  const index = Number(rawIndex);
  const offset = Number(rawOffset ?? 0);
  if (!Number.isFinite(index) || !Number.isFinite(offset)) return null;
  // A hand-edited or truncated cursor must not index the collection array fractionally.
  return { index: Math.floor(index), offset: Math.floor(offset) };
}

/** Webflow reports three orthogonal flags; this collapses them into the shared status vocabulary. */
function itemStatus(row: Record<string, unknown>): ContentStatus {
  if (readBoolean(row.isArchived)) return 'archived';
  if (readBoolean(row.isDraft)) return 'draft';
  return readString(row.lastPublished) ? 'publish' : 'draft';
}

function matchesSearch(item: RemoteContentSummary, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return item.title.toLowerCase().includes(needle) || (item.slug ?? '').toLowerCase().includes(needle);
}

function matchesStatus(item: RemoteContentSummary, status: ContentStatus | undefined): boolean {
  return status === undefined || item.status === status;
}

function trimSlashes(value: string): string {
  return trimTrailingSlash(value).replace(/^\/+/, '');
}

/** Exported for the registry's field-mapping preview; never used for a write on its own. */
export function webflowFieldCandidates(role: WebflowFieldRole): readonly string[] {
  return FIELD_CANDIDATES[role];
}
