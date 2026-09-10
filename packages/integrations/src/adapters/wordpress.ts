import { createLogger, errorMessage } from '@seo/shared';
import {
  codeForStatus,
  failFromThrown,
  httpRequest,
  isRecord,
  providerMessage,
  readArray,
  readIsoDate,
  readNumber,
  readRecord,
  readRendered,
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
  type JsonValue,
  type ListContentOptions,
  type MetadataPatch,
  type MetadataWriteResult,
  type RedirectType,
  type RedirectWriteResult,
  type RemoteContent,
  type RemoteContentPage,
  type RemoteContentSummary,
  type StructuredDataWriteResult,
  type WebsiteAdapter,
} from './types';

/**
 * WordPress REST API v2 adapter.
 *
 * Auth is an application password (Users → Profile → Application Passwords) sent as
 * HTTP Basic. We never ask for the account's real password: application passwords are
 * revocable per-integration and are the only credential WordPress core supports for
 * machine access.
 *
 * SEO metadata has no home in WordPress core, so the adapter detects Yoast or Rank Math
 * from the REST namespace list and writes their registered post meta. Crucially, every
 * metadata write is **verified by re-reading the post**: WordPress silently discards
 * `meta` keys that are not registered with `show_in_rest`, so an unverified write would
 * look like a success and produce a false ChangeLog entry.
 */

const log = createLogger('adapters:wordpress');

export interface WordPressCredentials {
  username: string;
  /** The 24-character application password. Spaces are ignored by WordPress. */
  applicationPassword: string;
}

export type WordPressSeoPlugin = 'yoast' | 'rankmath' | 'none';

export interface WordPressConfig {
  /** Defaults to the Website's own origin. Set this for headless installs on a separate host. */
  baseUrl?: string;
  /** `auto` (default) probes `/wp-json/` for the plugin namespaces. */
  seoPlugin?: WordPressSeoPlugin | 'auto';
  /** Post type used when an externalId has no `post:`/`page:` prefix. */
  defaultType?: WordPressPostType;
  /**
   * With no SEO plugin installed there is nowhere to store a meta description.
   * `excerpt` (default) writes it to the post excerpt, which most themes render as
   * the description; `none` refuses the write instead.
   */
  metaFallback?: 'excerpt' | 'none';
  /** Group the Redirection plugin should file new redirects under. */
  redirectionGroupId?: number;
  timeoutMs?: number;
}

export type WordPressPostType = 'post' | 'page';

export const WORDPRESS_CAPABILITIES: AdapterCapabilities = {
  readContent: true,
  updateContent: true,
  createContent: true,
  publish: true,
  updateMetadata: true,
  // Both of these are real but conditional: structured data needs `unfiltered_html`,
  // redirects need the Redirection plugin. Both verify at call time and fail loudly.
  injectStructuredData: true,
  createRedirect: true,
  updateSitemap: false,
};

export const WORDPRESS_CREDENTIAL_FIELDS: AdapterFieldSpec[] = [
  { key: 'username', label: 'WordPress username', required: true, secret: false, placeholder: 'seo-os' },
  {
    key: 'applicationPassword',
    label: 'Application password',
    required: true,
    secret: true,
    help: 'Users → Profile → Application Passwords. The account needs the Editor or Administrator role.',
  },
];

export const WORDPRESS_CONFIG_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'baseUrl',
    label: 'WordPress base URL',
    required: false,
    secret: false,
    placeholder: 'https://example.com',
    help: 'Only needed when WordPress lives on a different host than the public site (headless setups).',
  },
  {
    key: 'seoPlugin',
    label: 'SEO plugin',
    required: false,
    secret: false,
    help: 'auto | yoast | rankmath | none. Auto-detected from /wp-json/ by default.',
  },
];

const YOAST_META = {
  title: '_yoast_wpseo_title',
  description: '_yoast_wpseo_metadesc',
  canonical: '_yoast_wpseo_canonical',
  noindex: '_yoast_wpseo_meta-robots-noindex',
} as const;

const RANKMATH_META = {
  title: 'rank_math_title',
  description: 'rank_math_description',
  canonical: 'rank_math_canonical_url',
  robots: 'rank_math_robots',
} as const;

const JSONLD_START = '<!-- seo-os:jsonld:start -->';
const JSONLD_END = '<!-- seo-os:jsonld:end -->';

interface WordPressTarget {
  type: WordPressPostType;
  id: number;
}

export class WordPressAdapter implements WebsiteAdapter {
  readonly name = 'wordpress';
  readonly capabilities = WORDPRESS_CAPABILITIES;

  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;
  private namespaces: string[] | null = null;
  private seoPluginCache: WordPressSeoPlugin | null = null;

  constructor(
    private readonly credentials: WordPressCredentials,
    private readonly config: WordPressConfig,
    site: AdapterSiteContext,
  ) {
    this.baseUrl = trimTrailingSlash(config.baseUrl?.trim() || site.siteUrl);
    // WordPress strips non-alphanumerics from application passwords before hashing,
    // so the grouped form copied out of wp-admin ("abcd efgh …") authenticates fine.
    const password = credentials.applicationPassword.replace(/\s+/g, '');
    this.authorization = `Basic ${Buffer.from(`${credentials.username}:${password}`, 'utf8').toString('base64')}`;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `${this.baseUrl}/wp-json${path}`;
  }

  private request(path: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
    return httpRequest(this.url(path), {
      ...opts,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      headers: { authorization: this.authorization, ...opts.headers },
    });
  }

  /** Status-specific, actionable failure text — these strings are shown directly to the operator. */
  private failFrom<T>(operation: string, res: HttpResult, meta: AdapterResultMeta = {}): AdapterResult<T> {
    const detail = providerMessage(res);
    const code = codeForStatus(res.status);
    let message: string;

    switch (res.status) {
      case 401:
        message =
          'Application password rejected — regenerate it under Users → Profile → Application Passwords and paste the full 24-character value. ' +
          'WordPress only accepts application passwords over HTTPS, and some Apache hosts drop the Authorization header (add `CGIPassAuth On` or the SetEnvIf rewrite to .htaccess).';
        break;
      case 403:
        message =
          `The WordPress user "${this.credentials.username}" is authenticated but not allowed to ${operation}. ` +
          'Give the account the Editor or Administrator role, and check that a security plugin (Wordfence, iThemes, Cloudflare WAF) is not blocking REST writes.';
        break;
      case 404:
        message =
          `WordPress returned 404 for ${operation}. Confirm ${this.baseUrl}/wp-json/ loads in a browser (Settings → Permalinks must not be "Plain"), ` +
          'and that the post or page still exists.';
        break;
      case 429:
        message = 'WordPress or its host is rate-limiting the REST API. The change was not applied; retry shortly.';
        break;
      default:
        message = `WordPress ${operation} failed with HTTP ${res.status}.`;
        break;
    }

    return adapterFail<T>(code, detail ? `${message} (${detail})` : message, meta);
  }

  private parseTarget(externalId: string): WordPressTarget | null {
    const raw = externalId.trim();
    const prefixed = /^(post|page)[:/](\d+)$/i.exec(raw);
    if (prefixed) {
      const type = prefixed[1].toLowerCase() === 'page' ? 'page' : 'post';
      return { type, id: Number(prefixed[2]) };
    }
    if (/^\d+$/.test(raw)) return { type: this.config.defaultType ?? 'post', id: Number(raw) };
    return null;
  }

  private endpoint(type: WordPressPostType): string {
    return type === 'page' ? '/wp/v2/pages' : '/wp/v2/posts';
  }

  /**
   * Cached `/wp-json/` root read — tells us which plugins expose REST namespaces.
   *
   * `null` means "could not find out", which is deliberately different from "no namespaces".
   * Only a successful read is cached: caching an empty list after a timeout would make this
   * adapter believe, for the rest of the process, that Yoast and Rank Math are not installed
   * and quietly write descriptions to the post excerpt instead.
   */
  private async getNamespaces(): Promise<string[] | null> {
    if (this.namespaces) return this.namespaces;
    try {
      const res = await this.request('/');
      if (!res.ok || !isRecord(res.body)) {
        log.debug('could not read the WordPress REST root', { status: res.status, baseUrl: this.baseUrl });
        return null;
      }
      this.namespaces = readArray(res.body.namespaces).map((n) => String(n));
      return this.namespaces;
    } catch (err) {
      log.debug('could not read the WordPress REST root', { baseUrl: this.baseUrl, error: errorMessage(err) });
      return null;
    }
  }

  /** Which SEO plugin owns the metadata on this install. */
  async detectSeoPlugin(): Promise<WordPressSeoPlugin> {
    const configured = this.config.seoPlugin;
    if (configured && configured !== 'auto') return configured;
    if (this.seoPluginCache) return this.seoPluginCache;

    const namespaces = await this.getNamespaces();
    if (namespaces === null) {
      // Unknown this time. Answer 'none' so the caller still has a usable fallback, but do
      // not cache it — the next call re-probes rather than locking in a guess.
      log.debug('seo plugin detection skipped: REST root unreadable', { baseUrl: this.baseUrl });
      return 'none';
    }
    if (namespaces.some((n) => n.startsWith('yoast/'))) this.seoPluginCache = 'yoast';
    else if (namespaces.some((n) => n.startsWith('rankmath/'))) this.seoPluginCache = 'rankmath';
    else this.seoPluginCache = 'none';

    log.debug('seo plugin detected', { plugin: this.seoPluginCache, baseUrl: this.baseUrl });
    return this.seoPluginCache;
  }

  // ── read ────────────────────────────────────────────────────────────────────

  async testConnection(): Promise<AdapterResult<ConnectionInfo>> {
    try {
      const res = await this.request('/wp/v2/users/me', { query: { context: 'edit' } });
      if (!res.ok) return this.failFrom('read the current user', res);

      const user = readRecord(res.body);
      const name = readString(user.name) ?? this.credentials.username;
      const roles = readArray(user.roles).map((r) => String(r));
      const plugin = await this.detectSeoPlugin();

      // Editing content needs at least the Editor role; Author/Contributor will 403 later.
      const canEdit = roles.some((r) => ['administrator', 'editor'].includes(r));
      const warnings = canEdit
        ? []
        : [
            `The connected user has roles [${roles.join(', ') || 'unknown'}]. Editing existing posts needs the Editor or Administrator role.`,
          ];

      return adapterOk<ConnectionInfo>(
        {
          detail: `Connected to ${this.baseUrl} as ${name}${roles.length ? ` (${roles.join(', ')})` : ''}. SEO plugin: ${plugin}.`,
          meta: { baseUrl: this.baseUrl, roles, seoPlugin: plugin },
        },
        { warnings },
      );
    } catch (err) {
      return failFromThrown('WordPress', 'REST API', err);
    }
  }

  async listContent(opts: ListContentOptions = {}): Promise<AdapterResult<RemoteContentPage>> {
    const type: WordPressPostType = opts.type === 'page' ? 'page' : 'post';
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);

    try {
      const res = await this.request(this.endpoint(type), {
        query: {
          context: 'edit',
          per_page: pageSize,
          page,
          search: opts.search,
          status: opts.status ?? 'any',
          orderby: 'modified',
          order: 'desc',
          _fields: 'id,slug,status,link,title,excerpt,modified_gmt,type',
        },
      });
      if (!res.ok) return this.failFrom(`list ${type}s`, res);

      const items: RemoteContentSummary[] = readArray(res.body)
        .filter(isRecord)
        .map((row) => this.toSummary(row, type));

      const totalPages = readNumber(res.headers.get('x-wp-totalpages'));
      const total = readNumber(res.headers.get('x-wp-total'));

      return adapterOk<RemoteContentPage>({
        items,
        total,
        hasMore: totalPages !== undefined ? page < totalPages : items.length === pageSize,
        nextCursor: totalPages !== undefined && page < totalPages ? String(page + 1) : undefined,
      });
    } catch (err) {
      return failFromThrown('WordPress', `list ${type}s`, err);
    }
  }

  async getContent(externalId: string): Promise<AdapterResult<RemoteContent>> {
    const target = this.parseTarget(externalId);
    if (!target) {
      return adapterFail<RemoteContent>(
        'VALIDATION',
        `"${externalId}" is not a WordPress content id. Use "post:123", "page:45", or a bare numeric id.`,
      );
    }
    return this.fetchContent(target);
  }

  private async fetchContent(target: WordPressTarget): Promise<AdapterResult<RemoteContent>> {
    try {
      const res = await this.request(`${this.endpoint(target.type)}/${target.id}`, {
        query: { context: 'edit' },
      });
      if (!res.ok) return this.failFrom<RemoteContent>(`read ${target.type} ${target.id}`, res);
      if (!isRecord(res.body)) {
        return adapterFail<RemoteContent>('INVALID_RESPONSE', 'WordPress returned an unexpected response shape.');
      }
      const content = this.toRemoteContent(res.body, target.type);
      return adapterOk(content, { externalId: content.externalId, url: content.url });
    } catch (err) {
      return failFromThrown<RemoteContent>('WordPress', `read ${target.type} ${target.id}`, err);
    }
  }

  private toSummary(row: Record<string, unknown>, type: WordPressPostType): RemoteContentSummary {
    const id = readNumber(row.id) ?? 0;
    return {
      externalId: `${type}:${id}`,
      type,
      title: stripTags(readRendered(row.title) ?? ''),
      slug: readString(row.slug),
      url: readString(row.link),
      status: toContentStatus(readString(row.status)),
      updatedAt: readIsoDate(appendZ(readString(row.modified_gmt))),
      excerpt: stripTags(readRendered(row.excerpt) ?? '') || undefined,
    };
  }

  private toRemoteContent(row: Record<string, unknown>, type: WordPressPostType): RemoteContent {
    const summary = this.toSummary(row, type);
    const meta = readRecord(row.meta);
    const yoastHead = readRecord(row.yoast_head_json);

    const metaTitle =
      readString(meta[YOAST_META.title]) ?? readString(meta[RANKMATH_META.title]) ?? readString(yoastHead.title);
    const metaDescription =
      readString(meta[YOAST_META.description]) ??
      readString(meta[RANKMATH_META.description]) ??
      readString(yoastHead.description);
    const canonical =
      readString(meta[YOAST_META.canonical]) ??
      readString(meta[RANKMATH_META.canonical]) ??
      readString(yoastHead.canonical);

    const bodyHtml = readRendered(row.content) ?? '';

    return {
      ...summary,
      bodyHtml,
      metaTitle,
      metaDescription,
      canonicalUrl: canonical,
      structuredData: extractJsonLd(bodyHtml),
      // `meta` and `date_gmt` are what a rollback needs to restore the row faithfully.
      raw: {
        id: readNumber(row.id) ?? 0,
        type,
        meta: toJsonObject(meta),
        status: readString(row.status) ?? '',
        dateGmt: readString(row.date_gmt) ?? '',
        modifiedGmt: readString(row.modified_gmt) ?? '',
      },
    };
  }

  // ── write ───────────────────────────────────────────────────────────────────

  async createContent(payload: ContentPayload): Promise<AdapterResult<ContentRef>> {
    const bodyCheck = resolveBodyHtml(payload);
    if (!bodyCheck.ok) return adapterFail<ContentRef>('VALIDATION', bodyCheck.error);

    const type: WordPressPostType = payload.container === 'page' ? 'page' : this.config.defaultType ?? 'post';
    const body: JsonObject = {
      title: payload.title,
      // New content is always created as a draft; publishing is a separate, auditable step.
      status: toWordPressStatus(payload.status) ?? 'draft',
    };
    if (bodyCheck.html !== undefined) body.content = bodyCheck.html;
    if (payload.slug) body.slug = payload.slug;
    if (payload.excerpt !== undefined) body.excerpt = payload.excerpt;

    try {
      const res = await this.request(this.endpoint(type), { method: 'POST', body });
      if (!res.ok) return this.failFrom<ContentRef>(`create a ${type}`, res, { beforeState: null });

      const row = readRecord(res.body);
      const id = readNumber(row.id);
      if (id === undefined) {
        return adapterFail<ContentRef>('INVALID_RESPONSE', 'WordPress accepted the create but returned no post id.');
      }
      const externalId = `${type}:${id}`;
      const url = readString(row.link);

      const warnings: string[] = [];
      if (payload.metaTitle || payload.metaDescription) {
        const metaResult = await this.updateMetadata(externalId, {
          metaTitle: payload.metaTitle,
          metaDescription: payload.metaDescription,
        });
        if (!metaResult.ok) warnings.push(`Content created, but SEO metadata was not stored: ${metaResult.error}`);
        else if (metaResult.warnings) warnings.push(...metaResult.warnings);
      }

      // beforeState is explicitly null: nothing existed before a create.
      return adapterOk<ContentRef>({ id: externalId, url }, { externalId, url, beforeState: null, warnings });
    } catch (err) {
      return failFromThrown<ContentRef>('WordPress', `create a ${type}`, err);
    }
  }

  async updateContent(externalId: string, patch: ContentPatch): Promise<AdapterResult<ContentRef>> {
    const target = this.parseTarget(externalId);
    if (!target) {
      return adapterFail<ContentRef>('VALIDATION', `"${externalId}" is not a WordPress content id (expected "post:123").`);
    }

    const bodyCheck = resolveBodyHtml(patch);
    if (!bodyCheck.ok) return adapterFail<ContentRef>('VALIDATION', bodyCheck.error);

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<ContentRef>(before.errorCode, before.error);

    const body: JsonObject = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (bodyCheck.html !== undefined) body.content = bodyCheck.html;
    if (patch.slug !== undefined) body.slug = patch.slug;
    if (patch.excerpt !== undefined) body.excerpt = patch.excerpt;
    const status = toWordPressStatus(patch.status);
    if (status) body.status = status;

    if (Object.keys(body).length === 0) {
      return adapterFail<ContentRef>('VALIDATION', 'No updatable content fields were supplied.', {
        beforeState: before.data,
      });
    }

    return this.postUpdate(target, body, before.data, `update ${target.type} ${target.id}`);
  }

  private async postUpdate(
    target: WordPressTarget,
    body: JsonObject,
    beforeState: RemoteContent,
    operation: string,
  ): Promise<AdapterResult<ContentRef>> {
    try {
      const res = await this.request(`${this.endpoint(target.type)}/${target.id}`, { method: 'POST', body });
      if (!res.ok) return this.failFrom<ContentRef>(operation, res, { beforeState });

      const row = readRecord(res.body);
      const url = readString(row.link);
      const externalId = `${target.type}:${target.id}`;
      return adapterOk<ContentRef>({ id: externalId, url }, { externalId, url, beforeState });
    } catch (err) {
      return failFromThrown<ContentRef>('WordPress', operation, err);
    }
  }

  async publishContent(externalId: string): Promise<AdapterResult<ContentRef>> {
    const target = this.parseTarget(externalId);
    if (!target) {
      return adapterFail<ContentRef>('VALIDATION', `"${externalId}" is not a WordPress content id.`);
    }
    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<ContentRef>(before.errorCode, before.error);
    return this.postUpdate(target, { status: 'publish' }, before.data, `publish ${target.type} ${target.id}`);
  }

  /**
   * Write SEO metadata through whichever plugin is installed, then read it back.
   * `fieldsWritten` lists only values WordPress confirmed it stored.
   */
  async updateMetadata(externalId: string, patch: MetadataPatch): Promise<AdapterResult<MetadataWriteResult>> {
    const target = this.parseTarget(externalId);
    if (!target) {
      return adapterFail<MetadataWriteResult>('VALIDATION', `"${externalId}" is not a WordPress content id.`);
    }

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<MetadataWriteResult>(before.errorCode, before.error);

    const plugin = await this.detectSeoPlugin();
    if (plugin === 'none') return this.updateMetadataWithoutPlugin(target, patch, before.data);

    const meta: JsonObject = {};
    const expected: Array<{ field: string; key: string; value: JsonValue }> = [];

    const map = plugin === 'yoast' ? YOAST_META : RANKMATH_META;
    if (patch.metaTitle !== undefined) expected.push({ field: 'metaTitle', key: map.title, value: patch.metaTitle });
    if (patch.metaDescription !== undefined) {
      expected.push({ field: 'metaDescription', key: map.description, value: patch.metaDescription });
    }
    if (patch.canonicalUrl !== undefined) {
      expected.push({ field: 'canonicalUrl', key: map.canonical, value: patch.canonicalUrl });
    }
    if (patch.noindex !== undefined) {
      if (plugin === 'yoast') {
        // Yoast stores the robots-noindex override as '1' (noindex) / '2' (index).
        expected.push({ field: 'noindex', key: YOAST_META.noindex, value: patch.noindex ? '1' : '2' });
      } else {
        expected.push({
          field: 'noindex',
          key: RANKMATH_META.robots,
          value: patch.noindex ? ['noindex', 'nofollow'] : ['index', 'follow'],
        });
      }
    }

    if (!expected.length) {
      return adapterFail<MetadataWriteResult>('VALIDATION', 'No metadata fields were supplied.', {
        beforeState: before.data,
      });
    }
    for (const item of expected) meta[item.key] = item.value;

    try {
      const res = await this.request(`${this.endpoint(target.type)}/${target.id}`, {
        method: 'POST',
        body: { meta },
      });
      if (!res.ok) {
        return this.failFrom<MetadataWriteResult>(`write ${plugin} metadata`, res, { beforeState: before.data });
      }

      // WordPress drops meta keys that were never registered with show_in_rest and still
      // answers 200 — the read-back is the only trustworthy confirmation.
      const stored = readRecord(readRecord(res.body).meta);
      const written: string[] = [];
      const rejected: string[] = [];
      for (const item of expected) {
        if (metaValueMatches(stored[item.key], item.value)) written.push(item.field);
        else rejected.push(item.field);
      }

      if (!written.length) {
        return adapterFail<MetadataWriteResult>(
          'UNSUPPORTED',
          `This site runs ${plugin === 'yoast' ? 'Yoast SEO' : 'Rank Math'}, but its meta fields are not writable over the REST API — ` +
            'WordPress accepted the request and discarded the values. Register the fields with `show_in_rest` ' +
            `(${expected.map((e) => e.key).join(', ')}), or update ${plugin === 'yoast' ? 'Yoast' : 'Rank Math'} to a version that exposes them.`,
          { beforeState: before.data, externalId },
        );
      }

      const warnings = rejected.length
        ? [`WordPress did not store: ${rejected.join(', ')} (field not exposed over REST by ${plugin}).`]
        : [];

      return adapterOk<MetadataWriteResult>(
        { fieldsWritten: written, via: plugin },
        { beforeState: before.data, externalId, url: before.data.url, warnings },
      );
    } catch (err) {
      return failFromThrown<MetadataWriteResult>('WordPress', 'write SEO metadata', err);
    }
  }

  /** No SEO plugin: the excerpt is the only core field a theme commonly renders as a description. */
  private async updateMetadataWithoutPlugin(
    target: WordPressTarget,
    patch: MetadataPatch,
    beforeState: RemoteContent,
  ): Promise<AdapterResult<MetadataWriteResult>> {
    const fallback = this.config.metaFallback ?? 'excerpt';
    const warnings: string[] = [];
    if (patch.metaTitle !== undefined) {
      warnings.push(
        'No SEO plugin detected — WordPress core has no meta-title field, so the SEO title was not applied. Install Yoast SEO or Rank Math.',
      );
    }
    if (patch.canonicalUrl !== undefined) {
      warnings.push('No SEO plugin detected — canonical URLs cannot be set through WordPress core.');
    }
    if (patch.noindex !== undefined) {
      warnings.push('No SEO plugin detected — the robots directive cannot be set through WordPress core.');
    }

    if (patch.metaDescription === undefined || fallback === 'none') {
      return adapterFail<MetadataWriteResult>(
        'UNSUPPORTED',
        'No SEO plugin (Yoast or Rank Math) is active on this WordPress site, so SEO metadata has nowhere to be stored. ' +
          'Install one, or set the integration config `metaFallback: "excerpt"` to write descriptions into the post excerpt.',
        { beforeState, warnings },
      );
    }

    try {
      const res = await this.request(`${this.endpoint(target.type)}/${target.id}`, {
        method: 'POST',
        body: { excerpt: patch.metaDescription },
      });
      if (!res.ok) return this.failFrom<MetadataWriteResult>('write the post excerpt', res, { beforeState });

      warnings.push('Stored the description in the post excerpt because no SEO plugin is installed.');
      return adapterOk<MetadataWriteResult>(
        { fieldsWritten: ['metaDescription'], via: 'excerpt-fallback' },
        { beforeState, externalId: beforeState.externalId, url: beforeState.url, warnings },
      );
    } catch (err) {
      return failFromThrown<MetadataWriteResult>('WordPress', 'write the post excerpt', err);
    }
  }

  /**
   * Inject JSON-LD as a delimited block at the end of the post body.
   *
   * The block is fenced with HTML comments so repeated runs replace rather than
   * duplicate it, and so a human can find and remove it. WordPress strips `<script>`
   * from users without `unfiltered_html`, so the write is verified by re-reading.
   */
  async injectStructuredData(externalId: string, jsonLd: JsonValue): Promise<AdapterResult<StructuredDataWriteResult>> {
    const target = this.parseTarget(externalId);
    if (!target) {
      return adapterFail<StructuredDataWriteResult>('VALIDATION', `"${externalId}" is not a WordPress content id.`);
    }

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<StructuredDataWriteResult>(before.errorCode, before.error);

    const serialized = JSON.stringify(jsonLd);
    if (!serialized || serialized === 'null') {
      return adapterFail<StructuredDataWriteResult>('VALIDATION', 'The JSON-LD payload is empty.', {
        beforeState: before.data,
      });
    }

    const block = `${JSONLD_START}\n<script type="application/ld+json">${serialized}</script>\n${JSONLD_END}`;
    const currentBody = before.data.bodyHtml ?? '';
    const nextBody = replaceOrAppendBlock(currentBody, block);

    try {
      const res = await this.request(`${this.endpoint(target.type)}/${target.id}`, {
        method: 'POST',
        body: { content: nextBody },
      });
      if (!res.ok) {
        return this.failFrom<StructuredDataWriteResult>('inject structured data', res, { beforeState: before.data });
      }

      const savedBody = readRendered(readRecord(res.body).content) ?? '';
      if (!savedBody.includes('application/ld+json')) {
        return adapterFail<StructuredDataWriteResult>(
          'FORBIDDEN',
          'WordPress stripped the JSON-LD <script> tag: the connected user lacks the `unfiltered_html` capability ' +
            '(always the case on WordPress multisite for non-super-admins). Use an SEO plugin\'s schema feature, or connect an Administrator account on a single-site install.',
          { beforeState: before.data, externalId },
        );
      }

      return adapterOk<StructuredDataWriteResult>(
        { applied: true, via: 'post-content-block' },
        { beforeState: before.data, externalId, url: before.data.url },
      );
    } catch (err) {
      return failFromThrown<StructuredDataWriteResult>('WordPress', 'inject structured data', err);
    }
  }

  /** Redirects require the Redirection plugin; WordPress core has no redirect store. */
  async createRedirect(from: string, to: string, type: RedirectType = 301): Promise<AdapterResult<RedirectWriteResult>> {
    const namespaces = await this.getNamespaces();
    if (namespaces === null) {
      return adapterFail<RedirectWriteResult>(
        'NETWORK',
        `Could not read ${this.baseUrl}/wp-json/ to check whether the Redirection plugin is installed, so no redirect was created. Check the site is reachable and retry.`,
        { beforeState: null },
      );
    }
    if (!namespaces.some((n) => n.startsWith('redirection/'))) {
      return adapterFail<RedirectWriteResult>(
        'UNSUPPORTED',
        'WordPress core cannot store redirects. Install the Redirection plugin (johngodley/redirection) — this adapter ' +
          'writes to its REST API — or create the redirect at the server/CDN level.',
        { beforeState: null },
      );
    }

    try {
      const res = await this.request('/redirection/v1/redirect', {
        method: 'POST',
        body: {
          url: from,
          match_type: 'url',
          action_type: 'url',
          action_code: type,
          action_data: { url: to },
          group_id: this.config.redirectionGroupId ?? 1,
          enabled: true,
        },
      });
      if (!res.ok) return this.failFrom<RedirectWriteResult>('create a redirect', res, { beforeState: null });

      return adapterOk<RedirectWriteResult>(
        { from, to, type, via: 'redirection-plugin' },
        { beforeState: null },
      );
    } catch (err) {
      return failFromThrown<RedirectWriteResult>('WordPress', 'create a redirect', err);
    }
  }

  async updateSitemap(): Promise<AdapterResult<{ submitted: boolean; via: string }>> {
    return unsupported(
      'wordpress',
      'updateSitemap',
      'WordPress and its SEO plugins generate sitemaps automatically; submit the sitemap through Search Console instead.',
    );
  }
}

export function createWordPressAdapter(input: {
  credentials: WordPressCredentials;
  config: WordPressConfig;
  site: AdapterSiteContext;
}): WordPressAdapter {
  return new WordPressAdapter(input.credentials, input.config, input.site);
}

/** Validate/normalise a credential envelope decrypted from the Integration row. */
export function parseWordPressCredentials(value: unknown): WordPressCredentials | null {
  if (!isRecord(value)) return null;
  const username = readString(value.username) ?? readString(value.user);
  const applicationPassword =
    readString(value.applicationPassword) ?? readString(value.appPassword) ?? readString(value.password);
  if (!username || !applicationPassword) return null;
  return { username, applicationPassword };
}

export function parseWordPressConfig(value: unknown): WordPressConfig {
  const record = readRecord(value);
  const plugin = readString(record.seoPlugin);
  const fallback = readString(record.metaFallback);
  const defaultType = readString(record.defaultType);
  return {
    baseUrl: readString(record.baseUrl),
    seoPlugin:
      plugin === 'yoast' || plugin === 'rankmath' || plugin === 'none' || plugin === 'auto' ? plugin : 'auto',
    defaultType: defaultType === 'page' ? 'page' : 'post',
    metaFallback: fallback === 'none' ? 'none' : 'excerpt',
    redirectionGroupId: readNumber(record.redirectionGroupId),
    timeoutMs: readNumber(record.timeoutMs),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function toContentStatus(status: string | undefined): ContentStatus {
  switch (status) {
    case 'publish':
      return 'publish';
    case 'draft':
    case 'auto-draft':
      return 'draft';
    case 'pending':
      return 'pending';
    case 'private':
      return 'private';
    case 'trash':
      return 'archived';
    default:
      return 'unknown';
  }
}

function toWordPressStatus(status: ContentStatus | undefined): string | undefined {
  switch (status) {
    case 'publish':
      return 'publish';
    case 'draft':
      return 'draft';
    case 'pending':
      return 'pending';
    case 'private':
      return 'private';
    default:
      return undefined;
  }
}

/** WordPress `*_gmt` timestamps have no zone suffix; they are UTC. */
function appendZ(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /[Zz]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;/g, '’')
    .trim();
}

interface BodyResolution {
  ok: boolean;
  html?: string;
  error: string;
}

/**
 * WordPress stores HTML. Rather than shipping a half-correct Markdown renderer that
 * would silently mangle a customer's page, we require the caller to render first.
 */
function resolveBodyHtml(payload: ContentPatch): BodyResolution {
  if (payload.bodyHtml !== undefined) return { ok: true, html: payload.bodyHtml, error: '' };
  if (payload.bodyMarkdown !== undefined) {
    return {
      ok: false,
      error: 'WordPress stores HTML — supply `bodyHtml`. Render the Markdown before deploying so the published output is reviewable.',
    };
  }
  return { ok: true, error: '' };
}

function metaValueMatches(stored: unknown, expected: JsonValue): boolean {
  if (Array.isArray(expected)) {
    const storedArray = readArray(stored).map((v) => String(v));
    return expected.length === storedArray.length && expected.every((v, i) => String(v) === storedArray[i]);
  }
  return String(stored ?? '') === String(expected ?? '');
}

function replaceOrAppendBlock(body: string, block: string): string {
  const start = body.indexOf(JSONLD_START);
  const end = body.indexOf(JSONLD_END);
  if (start !== -1 && end > start) {
    return `${body.slice(0, start)}${block}${body.slice(end + JSONLD_END.length)}`;
  }
  return body.trimEnd() ? `${body.trimEnd()}\n\n${block}` : block;
}

/** Pull any JSON-LD already embedded in the body so snapshots capture it. */
function extractJsonLd(html: string): JsonValue[] {
  const out: JsonValue[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match = re.exec(html);
  while (match) {
    try {
      out.push(JSON.parse(match[1].trim()) as JsonValue);
    } catch {
      // A malformed block on the page is data, not a crash — skip it.
    }
    match = re.exec(html);
  }
  return out;
}
