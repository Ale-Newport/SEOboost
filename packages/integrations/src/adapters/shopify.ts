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
  type RedirectType,
  type RedirectWriteResult,
  type RemoteContent,
  type RemoteContentPage,
  type RemoteContentSummary,
  type StructuredDataWriteResult,
  type WebsiteAdapter,
} from './types';

/**
 * Shopify Admin API adapter (REST, 2024-10) for blog articles and pages.
 *
 * REST rather than GraphQL on purpose: articles, pages and the legacy SEO metafields are
 * fully covered by REST, and REST returns per-resource HTTP statuses the adapter error
 * taxonomy already maps. GraphQL would answer 200 with an `errors` array for a permission
 * problem, which is exactly the kind of "looks like success" we refuse to persist.
 *
 * SEO title and description live in the `global.title_tag` / `global.description_tag`
 * metafields — the values every Shopify theme reads in `<title>` and `<meta name=
 * "description">`. Products/collections are intentionally out of scope: they are the
 * merchant's commerce data, not SEO-owned content.
 *
 * Auth is a custom-app Admin API access token (`shpat_…`) with `read_content` +
 * `write_content` scopes (plus `write_online_store_navigation` for URL redirects).
 */

const log = createLogger('adapters:shopify');

export const SHOPIFY_DEFAULT_API_VERSION = '2024-10';

/** The two metafields every Shopify theme reads for the title/description tags. */
const SEO_METAFIELD_NAMESPACE = 'global';
const SEO_TITLE_KEY = 'title_tag';
const SEO_DESCRIPTION_KEY = 'description_tag';
const SEO_METAFIELD_TYPE = 'single_line_text_field';

export interface ShopifyCredentials {
  /** Admin API access token from a custom app installed on the store. */
  accessToken: string;
}

export interface ShopifyConfig {
  /** `acme.myshopify.com`. The permanent domain, not the customer-facing one. */
  shopDomain: string;
  /** Admin API version. Pin it; Shopify retires versions on a 12-month cycle. */
  apiVersion?: string;
  /** Blog to create articles in, and to resolve bare numeric article ids against. */
  blogId?: number;
  /** What a bare numeric externalId means. */
  defaultType?: 'article' | 'page';
  timeoutMs?: number;
}

export const SHOPIFY_CAPABILITIES: AdapterCapabilities = {
  readContent: true,
  updateContent: true,
  createContent: true,
  publish: true,
  updateMetadata: true,
  // JSON-LD on Shopify is rendered by the theme's Liquid templates. Injecting a <script>
  // into an article body would fight the theme (and often be stripped by the rich-text
  // editor), so this adapter refuses instead of pretending.
  injectStructuredData: false,
  createRedirect: true,
  updateSitemap: false,
};

export const SHOPIFY_CREDENTIAL_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'accessToken',
    label: 'Admin API access token',
    required: true,
    secret: true,
    placeholder: 'shpat_…',
    help: 'Settings → Apps and sales channels → Develop apps → your app → Admin API access token. Scopes: read_content, write_content (and write_online_store_navigation for redirects).',
  },
];

export const SHOPIFY_CONFIG_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'shopDomain',
    label: 'Shop domain',
    required: true,
    secret: false,
    placeholder: 'acme.myshopify.com',
    help: 'The permanent .myshopify.com domain, not your custom domain.',
  },
  {
    key: 'blogId',
    label: 'Default blog id',
    required: false,
    secret: false,
    help: 'Numeric id of the blog new articles are created in. Defaults to the store\'s first blog.',
  },
  {
    key: 'apiVersion',
    label: 'API version',
    required: false,
    secret: false,
    placeholder: SHOPIFY_DEFAULT_API_VERSION,
  },
];

type ShopifyKind = 'article' | 'page';

interface ShopifyTarget {
  kind: ShopifyKind;
  id: number;
  /** Only meaningful for articles; every article endpoint is nested under its blog. */
  blogId?: number;
}

interface ShopifyBlog {
  id: number;
  handle: string;
  title: string;
}

interface ShopifyMetafield {
  id: number;
  key: string;
  namespace: string;
  value: string;
  type: string;
}

export class ShopifyAdapter implements WebsiteAdapter {
  readonly name = 'shopify';
  readonly capabilities = SHOPIFY_CAPABILITIES;

  private readonly shopDomain: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;
  private blogs: ShopifyBlog[] | null = null;

  constructor(
    private readonly credentials: ShopifyCredentials,
    private readonly config: ShopifyConfig,
    private readonly site: AdapterSiteContext,
  ) {
    this.shopDomain = normalizeShopDomain(config.shopDomain);
    this.apiVersion = config.apiVersion?.trim() || SHOPIFY_DEFAULT_API_VERSION;
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  private url(path: string): string {
    return `https://${this.shopDomain}/admin/api/${this.apiVersion}${path}`;
  }

  private request(path: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
    return httpRequest(this.url(path), {
      ...opts,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      headers: {
        'x-shopify-access-token': this.credentials.accessToken,
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
          'Shopify rejected the Admin API access token. Reinstall the custom app or regenerate its token, then reconnect this integration.';
        break;
      case 403:
        message =
          `The app is installed but not allowed to ${operation}. Add the missing Admin API scope ` +
          '(read_content / write_content for articles and pages, write_online_store_navigation for URL redirects) and reinstall the app.';
        break;
      case 404:
        message = `Shopify returned 404 for ${operation}. The blog, article or page no longer exists, or the shop domain "${this.shopDomain}" is wrong.`;
        break;
      case 423:
        message = 'The Shopify store is locked (unpaid or frozen). Content cannot be changed until the store is reactivated.';
        break;
      case 429:
        message =
          'Shopify rate-limited the request (the Admin API leaky bucket is empty). The change was not applied; retry shortly.';
        break;
      default:
        message = `Shopify ${operation} failed with HTTP ${res.status}.`;
        break;
    }
    return adapterFail<T>(codeForStatus(res.status), detail ? `${message} (${detail})` : message, meta);
  }

  /**
   * `article:<blogId>:<id>`, `page:<id>`, or a bare numeric id resolved with `defaultType`.
   * Article ids carry their blog because every Shopify article endpoint is nested under one.
   */
  private parseTarget(externalId: string): ShopifyTarget | null {
    const raw = externalId.trim();
    const article = /^article[:/](\d+)[:/](\d+)$/i.exec(raw);
    if (article) return { kind: 'article', blogId: Number(article[1]), id: Number(article[2]) };

    const articleNoBlog = /^article[:/](\d+)$/i.exec(raw);
    if (articleNoBlog) return { kind: 'article', blogId: this.config.blogId, id: Number(articleNoBlog[1]) };

    const page = /^page[:/](\d+)$/i.exec(raw);
    if (page) return { kind: 'page', id: Number(page[1]) };

    if (/^\d+$/.test(raw)) {
      const kind: ShopifyKind = this.config.defaultType === 'page' ? 'page' : 'article';
      return kind === 'page' ? { kind, id: Number(raw) } : { kind, blogId: this.config.blogId, id: Number(raw) };
    }
    return null;
  }

  private invalidId<T>(externalId: string): AdapterResult<T> {
    return adapterFail<T>(
      'VALIDATION',
      `"${externalId}" is not a Shopify content id. Use "article:<blogId>:<articleId>" or "page:<pageId>".`,
    );
  }

  /**
   * Cached blog list — needed for article URLs and for resolving the default blog.
   *
   * Only a *successful* read is cached. Caching the empty array from a 429 or a dropped
   * connection would make every later call in this process report "this store has no blogs",
   * which is a fabricated fact about the customer's store rather than a transient failure.
   */
  private async getBlogs(): Promise<ShopifyBlog[]> {
    if (this.blogs) return this.blogs;
    try {
      const res = await this.request('/blogs.json', { query: { limit: 250, fields: 'id,handle,title' } });
      if (!res.ok) {
        log.debug('could not list Shopify blogs', { status: res.status });
        return [];
      }
      this.blogs = readArray(readRecord(res.body).blogs)
        .filter(isRecord)
        .map((row) => ({
          id: readNumber(row.id) ?? 0,
          handle: readString(row.handle) ?? '',
          title: readString(row.title) ?? '',
        }))
        .filter((b) => b.id > 0);
      return this.blogs;
    } catch (err) {
      log.debug('could not list Shopify blogs', { error: errorMessage(err) });
      return [];
    }
  }

  private async resolveBlogId(preferred?: number): Promise<number | null> {
    if (preferred && preferred > 0) return preferred;
    if (this.config.blogId && this.config.blogId > 0) return this.config.blogId;
    const blogs = await this.getBlogs();
    return blogs[0]?.id ?? null;
  }

  private resourcePath(target: ShopifyTarget): string {
    return target.kind === 'page'
      ? `/pages/${target.id}.json`
      : `/blogs/${target.blogId}/articles/${target.id}.json`;
  }

  // ── read ────────────────────────────────────────────────────────────────────

  async testConnection(): Promise<AdapterResult<ConnectionInfo>> {
    try {
      const res = await this.request('/shop.json', { query: { fields: 'id,name,domain,myshopify_domain,plan_name' } });
      if (!res.ok) return this.failFrom('read the shop', res);

      const shop = readRecord(readRecord(res.body).shop);
      const name = readString(shop.name) ?? this.shopDomain;
      const primaryDomain = readString(shop.domain);
      const blogs = await this.getBlogs();

      const warnings: string[] = [];
      if (!blogs.length) {
        warnings.push('No blogs exist on this store, so articles cannot be created or listed until one is added in Shopify.');
      }
      if (primaryDomain && !this.site.domain.endsWith(primaryDomain) && !primaryDomain.endsWith(this.site.domain)) {
        warnings.push(
          `The Shopify store's primary domain is ${primaryDomain}, which does not match the site tracked here (${this.site.domain}). Check you connected the right store.`,
        );
      }

      return adapterOk<ConnectionInfo>(
        {
          detail: `Connected to ${name} (${this.shopDomain}) on Admin API ${this.apiVersion}; ${blogs.length} blog(s).`,
          meta: {
            shopDomain: this.shopDomain,
            primaryDomain: primaryDomain ?? null,
            apiVersion: this.apiVersion,
            plan: readString(shop.plan_name) ?? null,
            blogs: blogs.map((b): JsonObject => ({ id: b.id, handle: b.handle, title: b.title })),
          },
        },
        { warnings },
      );
    } catch (err) {
      return failFromThrown('Shopify', 'Admin API', err);
    }
  }

  async listContent(opts: ListContentOptions = {}): Promise<AdapterResult<RemoteContentPage>> {
    const kind: ShopifyKind = opts.type === 'page' ? 'page' : 'article';
    const limit = Math.min(Math.max(opts.pageSize ?? 50, 1), 250);

    try {
      if (kind === 'page') return await this.listPages(limit, opts);
      return await this.listArticles(limit, opts);
    } catch (err) {
      return failFromThrown<RemoteContentPage>('Shopify', `list ${kind}s`, err);
    }
  }

  private async listPages(limit: number, opts: ListContentOptions): Promise<AdapterResult<RemoteContentPage>> {
    const res = await this.request('/pages.json', {
      query: {
        limit,
        page_info: opts.cursor,
        // Shopify rejects any other filter alongside page_info, so drop them while paging.
        ...(opts.cursor ? {} : { published_status: publishedStatusFor(opts.status) }),
        fields: 'id,title,handle,body_html,published_at,updated_at,summary_html',
      },
    });
    if (!res.ok) return this.failFrom<RemoteContentPage>('list pages', res);

    const items = readArray(readRecord(res.body).pages)
      .filter(isRecord)
      .map((row) => this.pageSummary(row))
      .filter((item) => matchesSearch(item, opts.search));

    const nextCursor = nextPageInfo(res.headers.get('link'));
    return adapterOk<RemoteContentPage>({ items, nextCursor, hasMore: Boolean(nextCursor) });
  }

  /**
   * Articles are nested under blogs, so the cursor encodes which blog we are in:
   * `<blogId>` or `<blogId>|<page_info>`. Walking blogs in order keeps paging stable.
   */
  private async listArticles(limit: number, opts: ListContentOptions): Promise<AdapterResult<RemoteContentPage>> {
    const blogs = await this.getBlogs();
    if (!blogs.length) {
      return adapterOk<RemoteContentPage>({ items: [], total: 0, hasMore: false }, {
        warnings: ['This Shopify store has no blogs, so there are no articles to list.'],
      });
    }

    const parsed = parseArticleCursor(opts.cursor);
    // A cursor naming a blog that no longer exists (deleted mid-walk) must end the walk.
    // Restarting at blog 0 would replay pages already returned, or loop forever.
    const startIndex = parsed ? blogs.findIndex((b) => b.id === parsed.blogId) : 0;
    if (startIndex < 0) {
      return adapterOk<RemoteContentPage>({ items: [], hasMore: false }, {
        warnings: [`Blog ${parsed?.blogId} no longer exists on this store, so article paging stopped here.`],
      });
    }
    const blog = blogs[startIndex];
    if (!blog) return adapterOk<RemoteContentPage>({ items: [], total: 0, hasMore: false });

    const res = await this.request(`/blogs/${blog.id}/articles.json`, {
      query: {
        limit,
        page_info: parsed?.pageInfo,
        ...(parsed?.pageInfo ? {} : { published_status: publishedStatusFor(opts.status) }),
        fields: 'id,blog_id,title,handle,body_html,summary_html,published_at,updated_at',
      },
    });
    if (!res.ok) return this.failFrom<RemoteContentPage>(`list articles in blog ${blog.id}`, res);

    const items = readArray(readRecord(res.body).articles)
      .filter(isRecord)
      .map((row) => this.articleSummary(row, blog))
      .filter((item) => matchesSearch(item, opts.search));

    const pageInfo = nextPageInfo(res.headers.get('link'));
    // Exhausted this blog: hand the caller a cursor pointing at the next one.
    const nextBlog = blogs[startIndex + 1];
    const nextCursor = pageInfo
      ? `${blog.id}|${pageInfo}`
      : nextBlog
        ? String(nextBlog.id)
        : undefined;

    return adapterOk<RemoteContentPage>({ items, nextCursor, hasMore: Boolean(nextCursor) });
  }

  async getContent(externalId: string): Promise<AdapterResult<RemoteContent>> {
    const target = this.parseTarget(externalId);
    if (!target) return this.invalidId<RemoteContent>(externalId);
    return this.fetchContent(target);
  }

  private async fetchContent(target: ShopifyTarget): Promise<AdapterResult<RemoteContent>> {
    const resolved = await this.withBlog(target);
    if (!resolved.ok) return adapterFail<RemoteContent>(resolved.errorCode, resolved.error);

    try {
      const res = await this.request(this.resourcePath(resolved.data));
      if (!res.ok) return this.failFrom<RemoteContent>(`read ${resolved.data.kind} ${resolved.data.id}`, res);

      const row = readRecord(readRecord(res.body)[resolved.data.kind]);
      if (!Object.keys(row).length) {
        return adapterFail<RemoteContent>('INVALID_RESPONSE', 'Shopify returned an unexpected response shape.');
      }

      const metafields = await this.readSeoMetafields(resolved.data);
      const blog = resolved.data.kind === 'article' ? await this.findBlog(resolved.data.blogId) : undefined;
      const summary =
        resolved.data.kind === 'article' ? this.articleSummary(row, blog) : this.pageSummary(row);

      const content: RemoteContent = {
        ...summary,
        bodyHtml: readString(row.body_html) ?? '',
        metaTitle: metafields.find((m) => m.key === SEO_TITLE_KEY)?.value,
        metaDescription: metafields.find((m) => m.key === SEO_DESCRIPTION_KEY)?.value,
        // A faithful rollback needs the metafield ids as well as the resource fields.
        raw: {
          id: resolved.data.id,
          kind: resolved.data.kind,
          blogId: resolved.data.blogId ?? null,
          resource: toJsonObject(row),
          seoMetafields: metafields.map((m): JsonObject => ({ id: m.id, key: m.key, value: m.value, type: m.type })),
        },
      };
      return adapterOk(content, { externalId: content.externalId, url: content.url });
    } catch (err) {
      return failFromThrown<RemoteContent>('Shopify', `read ${target.kind} ${target.id}`, err);
    }
  }

  /** Articles need a blog id; fill it in from config/first blog when the caller omitted it. */
  private async withBlog(target: ShopifyTarget): Promise<AdapterResult<ShopifyTarget>> {
    if (target.kind === 'page') return adapterOk(target);
    const blogId = await this.resolveBlogId(target.blogId);
    if (!blogId) {
      return adapterFail<ShopifyTarget>(
        'VALIDATION',
        'No Shopify blog is available. Create a blog in Shopify, or set `blogId` on the integration config, and reference articles as "article:<blogId>:<articleId>".',
      );
    }
    return adapterOk({ ...target, blogId });
  }

  private async findBlog(blogId: number | undefined): Promise<ShopifyBlog | undefined> {
    if (!blogId) return undefined;
    const blogs = await this.getBlogs();
    return blogs.find((b) => b.id === blogId);
  }

  private articleSummary(row: Record<string, unknown>, blog?: ShopifyBlog): RemoteContentSummary {
    const id = readNumber(row.id) ?? 0;
    const blogId = readNumber(row.blog_id) ?? blog?.id ?? 0;
    const handle = readString(row.handle);
    return {
      externalId: `article:${blogId}:${id}`,
      type: 'article',
      title: readString(row.title) ?? '',
      slug: handle,
      url: handle && blog?.handle ? `${this.site.siteUrl}/blogs/${blog.handle}/${handle}` : undefined,
      status: readString(row.published_at) ? 'publish' : 'draft',
      updatedAt: readIsoDate(row.updated_at),
      excerpt: stripHtml(readString(row.summary_html) ?? '') || undefined,
    };
  }

  private pageSummary(row: Record<string, unknown>): RemoteContentSummary {
    const id = readNumber(row.id) ?? 0;
    const handle = readString(row.handle);
    return {
      externalId: `page:${id}`,
      type: 'page',
      title: readString(row.title) ?? '',
      slug: handle,
      url: handle ? `${this.site.siteUrl}/pages/${handle}` : undefined,
      status: readString(row.published_at) ? 'publish' : 'draft',
      updatedAt: readIsoDate(row.updated_at),
    };
  }

  // ── metafields ──────────────────────────────────────────────────────────────

  private metafieldOwnerPath(target: ShopifyTarget): string {
    return target.kind === 'page' ? `/pages/${target.id}/metafields.json` : `/articles/${target.id}/metafields.json`;
  }

  private async readSeoMetafields(target: ShopifyTarget): Promise<ShopifyMetafield[]> {
    try {
      const res = await this.request(this.metafieldOwnerPath(target), {
        query: { namespace: SEO_METAFIELD_NAMESPACE, limit: 250 },
      });
      if (!res.ok) return [];
      return readArray(readRecord(res.body).metafields)
        .filter(isRecord)
        .map((row) => ({
          id: readNumber(row.id) ?? 0,
          key: readString(row.key) ?? '',
          namespace: readString(row.namespace) ?? '',
          value: readString(row.value) ?? '',
          type: readString(row.type) ?? SEO_METAFIELD_TYPE,
        }))
        .filter((m) => m.namespace === SEO_METAFIELD_NAMESPACE);
    } catch {
      // A metafield read failure must not make the whole content read fail; the caller
      // simply sees no SEO metadata, which is visibly different from a wrong value.
      return [];
    }
  }

  /**
   * Upsert one `global.*` metafield and confirm the stored value.
   * Existing metafields are updated by id (Shopify rejects a duplicate namespace/key),
   * and the existing `type` is reused so an older `string`-typed field keeps working.
   */
  private async writeSeoMetafield(
    target: ShopifyTarget,
    existing: ShopifyMetafield | undefined,
    key: string,
    value: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = existing
      ? await this.request(`/metafields/${existing.id}.json`, {
          method: 'PUT',
          body: { metafield: { id: existing.id, value, type: existing.type || SEO_METAFIELD_TYPE } },
        })
      : await this.request(this.metafieldOwnerPath(target), {
          method: 'POST',
          body: {
            metafield: { namespace: SEO_METAFIELD_NAMESPACE, key, value, type: SEO_METAFIELD_TYPE },
          },
        });

    if (!res.ok) {
      return { ok: false, error: providerMessage(res, `HTTP ${res.status}`) };
    }
    const stored = readString(readRecord(readRecord(res.body).metafield).value);
    if (stored !== value) {
      return {
        ok: false,
        error: `Shopify accepted the ${key} write but stored ${stored === undefined ? 'nothing' : `"${stored}"`}.`,
      };
    }
    return { ok: true };
  }

  // ── write ───────────────────────────────────────────────────────────────────

  async createContent(payload: ContentPayload): Promise<AdapterResult<ContentRef>> {
    if (payload.bodyHtml === undefined && payload.bodyMarkdown !== undefined) {
      return adapterFail<ContentRef>(
        'VALIDATION',
        'Shopify stores HTML — supply `bodyHtml`. Render the Markdown first so the published output is reviewable.',
      );
    }
    if (!payload.title.trim()) return adapterFail<ContentRef>('VALIDATION', 'A title is required.');

    const kind: ShopifyKind = payload.container === 'page' ? 'page' : 'article';
    const body: JsonObject = { title: payload.title };
    if (payload.bodyHtml !== undefined) body.body_html = payload.bodyHtml;
    if (payload.slug) body.handle = payload.slug;
    if (kind === 'article' && payload.excerpt !== undefined) body.summary_html = payload.excerpt;
    // Everything is created unpublished; going live is a separate, auditable action.
    body.published = payload.status === 'publish';

    try {
      let path: string;
      let target: ShopifyTarget;
      if (kind === 'page') {
        path = '/pages.json';
        target = { kind, id: 0 };
      } else {
        const blogId = await this.resolveBlogId(numericContainer(payload.container));
        if (!blogId) {
          return adapterFail<ContentRef>(
            'VALIDATION',
            'No Shopify blog is available to create the article in. Create a blog in Shopify or set `blogId` on the integration config.',
            { beforeState: null },
          );
        }
        path = `/blogs/${blogId}/articles.json`;
        target = { kind, id: 0, blogId };
      }

      const res = await this.request(path, { method: 'POST', body: { [kind]: body } });
      if (!res.ok) return this.failFrom<ContentRef>(`create a ${kind}`, res, { beforeState: null });

      const row = readRecord(readRecord(res.body)[kind]);
      const id = readNumber(row.id);
      if (id === undefined) {
        return adapterFail<ContentRef>('INVALID_RESPONSE', `Shopify accepted the create but returned no ${kind} id.`);
      }

      const created: ShopifyTarget = { ...target, id };
      const summary =
        kind === 'article' ? this.articleSummary(row, await this.findBlog(created.blogId)) : this.pageSummary(row);

      const warnings: string[] = [];
      if (payload.metaTitle !== undefined || payload.metaDescription !== undefined) {
        const meta = await this.updateMetadata(summary.externalId, {
          metaTitle: payload.metaTitle,
          metaDescription: payload.metaDescription,
        });
        if (!meta.ok) warnings.push(`Content created, but SEO metadata was not stored: ${meta.error}`);
        else if (meta.warnings) warnings.push(...meta.warnings);
      }
      if (payload.structuredData !== undefined) {
        warnings.push(
          'Structured data was ignored: Shopify renders JSON-LD from the theme, not from article or page bodies.',
        );
      }

      log.debug('shopify content created', { kind, id });
      return adapterOk<ContentRef>(
        { id: summary.externalId, url: summary.url },
        { externalId: summary.externalId, url: summary.url, beforeState: null, warnings },
      );
    } catch (err) {
      return failFromThrown<ContentRef>('Shopify', `create a ${kind}`, err);
    }
  }

  async updateContent(externalId: string, patch: ContentPatch): Promise<AdapterResult<ContentRef>> {
    const parsed = this.parseTarget(externalId);
    if (!parsed) return this.invalidId<ContentRef>(externalId);
    if (patch.bodyHtml === undefined && patch.bodyMarkdown !== undefined) {
      return adapterFail<ContentRef>(
        'VALIDATION',
        'Shopify stores HTML — supply `bodyHtml`. Render the Markdown first so the published output is reviewable.',
      );
    }

    const resolved = await this.withBlog(parsed);
    if (!resolved.ok) return adapterFail<ContentRef>(resolved.errorCode, resolved.error);
    const target = resolved.data;

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<ContentRef>(before.errorCode, before.error);

    const body: JsonObject = { id: target.id };
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.bodyHtml !== undefined) body.body_html = patch.bodyHtml;
    if (patch.slug !== undefined) body.handle = patch.slug;
    if (target.kind === 'article' && patch.excerpt !== undefined) body.summary_html = patch.excerpt;
    if (patch.status !== undefined) body.published = patch.status === 'publish';

    if (Object.keys(body).length === 1) {
      return adapterFail<ContentRef>('VALIDATION', 'No updatable content fields were supplied.', {
        beforeState: before.data,
      });
    }
    return this.putResource(target, body, before.data, `update ${target.kind} ${target.id}`);
  }

  private async putResource(
    target: ShopifyTarget,
    body: JsonObject,
    beforeState: RemoteContent,
    operation: string,
  ): Promise<AdapterResult<ContentRef>> {
    try {
      const res = await this.request(this.resourcePath(target), {
        method: 'PUT',
        body: { [target.kind]: body },
      });
      if (!res.ok) return this.failFrom<ContentRef>(operation, res, { beforeState });

      const row = readRecord(readRecord(res.body)[target.kind]);
      const summary =
        target.kind === 'article' ? this.articleSummary(row, await this.findBlog(target.blogId)) : this.pageSummary(row);
      return adapterOk<ContentRef>(
        { id: summary.externalId, url: summary.url },
        { externalId: summary.externalId, url: summary.url, beforeState },
      );
    } catch (err) {
      return failFromThrown<ContentRef>('Shopify', operation, err);
    }
  }

  async publishContent(externalId: string): Promise<AdapterResult<ContentRef>> {
    const parsed = this.parseTarget(externalId);
    if (!parsed) return this.invalidId<ContentRef>(externalId);

    const resolved = await this.withBlog(parsed);
    if (!resolved.ok) return adapterFail<ContentRef>(resolved.errorCode, resolved.error);
    const target = resolved.data;

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<ContentRef>(before.errorCode, before.error);

    return this.putResource(
      target,
      // `published: true` makes Shopify stamp published_at itself, which is what the
      // storefront and the sitemap key off.
      { id: target.id, published: true },
      before.data,
      `publish ${target.kind} ${target.id}`,
    );
  }

  async updateMetadata(externalId: string, patch: MetadataPatch): Promise<AdapterResult<MetadataWriteResult>> {
    const parsed = this.parseTarget(externalId);
    if (!parsed) return this.invalidId<MetadataWriteResult>(externalId);

    const resolved = await this.withBlog(parsed);
    if (!resolved.ok) return adapterFail<MetadataWriteResult>(resolved.errorCode, resolved.error);
    const target = resolved.data;

    const wanted: Array<{ field: string; key: string; value: string }> = [];
    if (patch.metaTitle !== undefined) wanted.push({ field: 'metaTitle', key: SEO_TITLE_KEY, value: patch.metaTitle });
    if (patch.metaDescription !== undefined) {
      wanted.push({ field: 'metaDescription', key: SEO_DESCRIPTION_KEY, value: patch.metaDescription });
    }

    const warnings: string[] = [];
    if (patch.canonicalUrl !== undefined) {
      warnings.push(
        'Shopify has no canonical-URL field on articles or pages — the canonical tag comes from the theme, so it was not changed.',
      );
    }
    if (patch.noindex !== undefined) {
      warnings.push(
        'Shopify cannot set a per-page robots directive through the Admin API; edit robots.txt.liquid or the theme template instead.',
      );
    }
    if (!wanted.length) {
      return adapterFail<MetadataWriteResult>(
        'VALIDATION',
        'No metadata fields Shopify can store were supplied (only the SEO title and description are writable).',
        { warnings },
      );
    }

    const before = await this.fetchContent(target);
    if (!before.ok) return adapterFail<MetadataWriteResult>(before.errorCode, before.error);

    try {
      // The snapshot above already read the metafields (ids included). Reusing them saves a
      // call against Shopify's leaky bucket and keys the upsert to exactly the state
      // recorded in `beforeState`, instead of a second read that may already have drifted.
      const existing = seoMetafieldsFromSnapshot(before.data);
      const written: string[] = [];
      const failures: string[] = [];
      for (const item of wanted) {
        const result = await this.writeSeoMetafield(
          target,
          existing.find((m) => m.key === item.key),
          item.key,
          item.value,
        );
        if (result.ok) written.push(item.field);
        else failures.push(`${item.field}: ${result.error}`);
      }

      if (!written.length) {
        return adapterFail<MetadataWriteResult>(
          'PROVIDER_ERROR',
          `Shopify stored none of the SEO metafields — ${failures.join('; ')}. The app needs the write_content scope.`,
          { beforeState: before.data, externalId: before.data.externalId },
        );
      }
      if (failures.length) warnings.push(`Some metadata was not stored — ${failures.join('; ')}.`);

      return adapterOk<MetadataWriteResult>(
        { fieldsWritten: written, via: `metafield:${SEO_METAFIELD_NAMESPACE}` },
        { beforeState: before.data, externalId: before.data.externalId, url: before.data.url, warnings },
      );
    } catch (err) {
      return failFromThrown<MetadataWriteResult>('Shopify', 'write SEO metafields', err);
    }
  }

  async injectStructuredData(): Promise<AdapterResult<StructuredDataWriteResult>> {
    return unsupported(
      'shopify',
      'injectStructuredData',
      'Shopify renders JSON-LD from the theme\'s Liquid templates. Add the schema to the theme (or a schema app) — writing a <script> into an article body would be duplicated or stripped by the theme.',
    );
  }

  /** Shopify URL redirects are always 301; anything else is refused rather than silently downgraded. */
  async createRedirect(from: string, to: string, type: RedirectType = 301): Promise<AdapterResult<RedirectWriteResult>> {
    if (type !== 301) {
      return adapterFail<RedirectWriteResult>(
        'UNSUPPORTED',
        `Shopify URL redirects are always 301; a ${type} was requested. Use a 301, or configure the redirect at your CDN.`,
        { beforeState: null },
      );
    }
    const path = toRelativePath(from, this.site.siteUrl);
    if (!path) {
      return adapterFail<RedirectWriteResult>(
        'VALIDATION',
        `"${from}" is not a path on ${this.site.siteUrl}; Shopify can only redirect paths within the store.`,
        { beforeState: null },
      );
    }

    // Shopify accepts an absolute URL as a target (an off-store redirect) but stores a
    // store-relative path when the target is on the store; report what was actually stored.
    const target = toRelativePath(to, this.site.siteUrl) ?? to;

    try {
      const res = await this.request('/redirects.json', {
        method: 'POST',
        body: { redirect: { path, target } },
      });
      if (!res.ok) return this.failFrom<RedirectWriteResult>('create a URL redirect', res, { beforeState: null });
      const stored = readRecord(readRecord(res.body).redirect);
      return adapterOk<RedirectWriteResult>(
        {
          from: readString(stored.path) ?? path,
          to: readString(stored.target) ?? target,
          type: 301,
          via: 'shopify-url-redirect',
        },
        { beforeState: null },
      );
    } catch (err) {
      return failFromThrown<RedirectWriteResult>('Shopify', 'create a URL redirect', err);
    }
  }

  async updateSitemap(): Promise<AdapterResult<{ submitted: boolean; via: string }>> {
    return unsupported(
      'shopify',
      'updateSitemap',
      'Shopify generates /sitemap.xml automatically and it cannot be edited. Submit it through Search Console instead.',
    );
  }
}

export function createShopifyAdapter(input: {
  credentials: ShopifyCredentials;
  config: ShopifyConfig;
  site: AdapterSiteContext;
}): ShopifyAdapter {
  return new ShopifyAdapter(input.credentials, input.config, input.site);
}

export function parseShopifyCredentials(value: unknown): ShopifyCredentials | null {
  if (!isRecord(value)) return null;
  const accessToken =
    readString(value.accessToken) ?? readString(value.adminApiAccessToken) ?? readString(value.token);
  return accessToken ? { accessToken } : null;
}

export function parseShopifyConfig(value: unknown): ShopifyConfig | null {
  if (!isRecord(value)) return null;
  const shopDomain = readString(value.shopDomain) ?? readString(value.shop) ?? readString(value.myshopifyDomain);
  if (!shopDomain) return null;
  const defaultType = readString(value.defaultType);
  return {
    shopDomain,
    apiVersion: readString(value.apiVersion),
    blogId: readNumber(value.blogId),
    defaultType: defaultType === 'page' ? 'page' : 'article',
    timeoutMs: readNumber(value.timeoutMs),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Accept `acme`, `acme.myshopify.com` or a pasted admin URL and reduce it to the API host. */
export function normalizeShopDomain(input: string): string {
  let domain = input.trim().replace(/^https?:\/\//i, '');
  domain = trimTrailingSlash(domain).split('/')[0] ?? domain;
  if (!domain.includes('.')) domain = `${domain}.myshopify.com`;
  return domain.toLowerCase();
}

/** Re-read the SEO metafields a `fetchContent` snapshot stored in `raw`, ids included. */
function seoMetafieldsFromSnapshot(content: RemoteContent): ShopifyMetafield[] {
  return readArray(readRecord(content.raw).seoMetafields)
    .filter(isRecord)
    .map((row) => ({
      id: readNumber(row.id) ?? 0,
      key: readString(row.key) ?? '',
      namespace: SEO_METAFIELD_NAMESPACE,
      value: readString(row.value) ?? '',
      type: readString(row.type) ?? SEO_METAFIELD_TYPE,
    }))
    .filter((m) => m.id > 0 && m.key !== '');
}

function numericContainer(container: string | undefined): number | undefined {
  if (!container) return undefined;
  return /^\d+$/.test(container) ? Number(container) : undefined;
}

function publishedStatusFor(status: ContentStatus | undefined): string {
  if (status === 'publish') return 'published';
  if (status === 'draft' || status === 'pending' || status === 'private') return 'unpublished';
  return 'any';
}

function matchesSearch(item: RemoteContentSummary, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return item.title.toLowerCase().includes(needle) || (item.slug ?? '').toLowerCase().includes(needle);
}

/**
 * Shopify pages its REST collections through an opaque `page_info` in the `Link` header;
 * the cursor is only valid with the same `limit`, which is why filters are dropped while paging.
 */
export function nextPageInfo(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(',')) {
    if (!/rel="?next"?/i.test(part)) continue;
    const url = /<([^>]+)>/.exec(part)?.[1];
    if (!url) continue;
    const match = /[?&]page_info=([^&]+)/.exec(url);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

function parseArticleCursor(cursor: string | undefined): { blogId: number; pageInfo?: string } | null {
  if (!cursor) return null;
  const [blogPart, pageInfo] = cursor.split('|');
  const blogId = Number(blogPart);
  if (!Number.isFinite(blogId) || blogId <= 0) return null;
  return { blogId, pageInfo: pageInfo || undefined };
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Shopify redirects are store-relative; reject anything pointing off the store. */
function toRelativePath(url: string, siteUrl: string): string | null {
  if (url.startsWith('/')) return url;
  try {
    const parsed = new URL(url);
    const base = new URL(siteUrl);
    if (parsed.hostname !== base.hostname) return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}
