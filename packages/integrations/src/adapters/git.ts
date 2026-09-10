import { createLogger, mapWithConcurrency, slugify } from '@seo/shared';
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
  trimTrailingSlash,
  type HttpRequestOptions,
  type HttpResult,
} from './http';
import {
  isRecordValue,
  parseFrontmatter,
  roundTripsCleanly,
  serializeFrontmatter,
  type FrontmatterRecord,
  type FrontmatterValue,
} from './frontmatter';
import {
  adapterFail,
  adapterOk,
  unsupported,
  type AdapterCapabilities,
  type AdapterFieldSpec,
  type AdapterResult,
  type AdapterResultMeta,
  type ConnectionInfo,
  type ContentPatch,
  type ContentPayload,
  type ContentRef,
  type JsonObject,
  type JsonValue,
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
 * Git adapter — edits Markdown/MDX content in a **separate** repository through the
 * GitHub Contents API.
 *
 * Safety model, in order of importance:
 *  - It only ever *adds* commits. There is no force-push, no ref rewrite, and no
 *    DELETE call anywhere in this file. The worst case is an unmerged branch.
 *  - The default strategy opens a pull request from `seo-os/<slug>` instead of
 *    committing to the default branch, so a human still merges the change.
 *  - Every write passes the file's frontmatter through a round-trip check first; if
 *    this parser cannot reproduce the source faithfully, the write is refused rather
 *    than committing a file that lost data.
 *  - Updates send the blob `sha` we read, so a concurrent edit fails with a conflict
 *    instead of being clobbered.
 */

const log = createLogger('adapters:git');

export interface GitCredentials {
  /** GitHub PAT (fine-grained: Contents read/write + Pull requests write) or an app token. */
  token: string;
}

export type GitFileFormat = 'md' | 'mdx';

/** Which frontmatter keys hold which SEO field. Defaults suit Astro/Next/Hugo content collections. */
export interface GitFrontmatterMapping {
  title?: string;
  description?: string;
  slug?: string;
  excerpt?: string;
  date?: string;
  updated?: string;
  draft?: string;
  canonical?: string;
  /** Separate SEO title key, when the site distinguishes it from the H1 title. */
  metaTitle?: string;
  /** Key that receives injected JSON-LD. */
  structuredData?: string;
}

export interface GitAdapterConfig {
  owner: string;
  repo: string;
  /** Base branch. Defaults to the repository's default branch. */
  branch?: string;
  /** Directory holding content files, repo-relative, e.g. `src/content/blog`. */
  contentPath: string;
  fileFormat?: GitFileFormat;
  frontmatter?: GitFrontmatterMapping;
  /** `pull-request` (default, safer) or `direct` to commit straight to the base branch. */
  strategy?: 'pull-request' | 'direct';
  branchPrefix?: string;
  authorName?: string;
  authorEmail?: string;
  /** GitHub Enterprise Server API root, e.g. `https://github.acme.com/api/v3`. */
  apiBaseUrl?: string;
  /** Directory recursion depth under contentPath. */
  maxDepth?: number;
  timeoutMs?: number;
}

const DEFAULT_MAPPING: GitFrontmatterMapping = {
  title: 'title',
  description: 'description',
  slug: 'slug',
  date: 'date',
  draft: 'draft',
  structuredData: 'jsonLd',
};

export const GIT_CAPABILITIES: AdapterCapabilities = {
  readContent: true,
  updateContent: true,
  createContent: true,
  // "Publishing" in a static site is merging the PR / flipping `draft: false`, which the
  // adapter can do as a content update but cannot deploy on its own.
  publish: true,
  updateMetadata: true,
  injectStructuredData: true,
  // Redirects live in framework config (next.config, _redirects, netlify.toml) and are
  // too repo-specific to edit blindly.
  createRedirect: false,
  updateSitemap: false,
};

export const GIT_CREDENTIAL_FIELDS: AdapterFieldSpec[] = [
  {
    key: 'token',
    label: 'GitHub token',
    required: true,
    secret: true,
    help: 'Fine-grained personal access token scoped to this repository with Contents: read & write and Pull requests: read & write.',
  },
];

export const GIT_CONFIG_FIELDS: AdapterFieldSpec[] = [
  { key: 'owner', label: 'Owner', required: true, secret: false, placeholder: 'acme' },
  { key: 'repo', label: 'Repository', required: true, secret: false, placeholder: 'marketing-site' },
  { key: 'branch', label: 'Base branch', required: false, secret: false, placeholder: 'main' },
  { key: 'contentPath', label: 'Content directory', required: true, secret: false, placeholder: 'src/content/blog' },
  { key: 'fileFormat', label: 'File format', required: false, secret: false, placeholder: 'md' },
  {
    key: 'strategy',
    label: 'Deploy strategy',
    required: false,
    secret: false,
    help: 'pull-request (default) opens a PR for review; direct commits to the base branch.',
  },
];

const GITHUB_API = 'https://api.github.com';
const MAX_LISTED_FILES = 2000;
const CONTENT_EXTENSIONS = ['.md', '.mdx', '.markdown'];

interface GitFile {
  path: string;
  sha: string;
  size: number;
}

interface LoadedFile {
  path: string;
  sha: string;
  data: FrontmatterRecord;
  body: string;
  hasFrontmatter: boolean;
  eol: '\n' | '\r\n';
  raw: string;
}

export class GitAdapter implements WebsiteAdapter {
  readonly name = 'git';
  readonly capabilities = GIT_CAPABILITIES;

  private readonly apiBase: string;
  private readonly mapping: GitFrontmatterMapping;
  private readonly timeoutMs: number;
  private defaultBranch: string | null = null;

  constructor(
    private readonly credentials: GitCredentials,
    private readonly config: GitAdapterConfig,
  ) {
    this.apiBase = trimTrailingSlash(config.apiBaseUrl?.trim() || GITHUB_API);
    this.mapping = { ...DEFAULT_MAPPING, ...config.frontmatter };
    this.timeoutMs = config.timeoutMs ?? 20_000;
  }

  // ── plumbing ────────────────────────────────────────────────────────────────

  private request(path: string, opts: HttpRequestOptions = {}): Promise<HttpResult> {
    return httpRequest(`${this.apiBase}${path}`, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      headers: {
        authorization: `Bearer ${this.credentials.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        // GitHub rejects requests without a User-Agent.
        'user-agent': 'seo-os-adapter',
        ...opts.headers,
      },
    });
  }

  private repoPath(suffix: string): string {
    return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${suffix}`;
  }

  private contentsPath(filePath: string): string {
    const encoded = filePath
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return this.repoPath(`/contents/${encoded}`);
  }

  private failFrom<T>(operation: string, res: HttpResult, meta: AdapterResultMeta = {}): AdapterResult<T> {
    const detail = providerMessage(res);
    const repo = `${this.config.owner}/${this.config.repo}`;
    let message: string;

    switch (res.status) {
      case 401:
        message =
          'GitHub rejected the token. Generate a new fine-grained personal access token with Contents: read & write ' +
          'and Pull requests: read & write for this repository, then reconnect the integration.';
        break;
      case 403:
        message =
          res.headers.get('x-ratelimit-remaining') === '0'
            ? 'GitHub API rate limit exhausted for this token. The change was not applied; it will succeed after the limit resets.'
            : `The token cannot ${operation} in ${repo}. Check the token's repository access and, for organisations with SAML, authorise the token for the org.`;
        break;
      case 404:
        message =
          `GitHub returned 404 for ${operation} in ${repo}. Either the path does not exist on this branch, or the token has no access ` +
          '(GitHub answers 404 rather than 403 for private repositories a token cannot see).';
        break;
      case 409:
        message =
          `The file changed in ${repo} since it was read, so the commit was refused to avoid overwriting someone else's edit. Retry the action to pick up the new version.`;
        break;
      case 422:
        message = `GitHub rejected the ${operation} request as invalid — usually a stale blob sha or a branch that already exists.`;
        break;
      default:
        message = `GitHub ${operation} failed with HTTP ${res.status}.`;
        break;
    }

    return adapterFail<T>(codeForStatus(res.status), detail ? `${message} (${detail})` : message, meta);
  }

  private async getDefaultBranch(): Promise<string> {
    if (this.config.branch) return this.config.branch;
    if (this.defaultBranch) return this.defaultBranch;
    const res = await this.request(this.repoPath(''));
    this.defaultBranch = (res.ok ? readString(readRecord(res.body).default_branch) : undefined) ?? 'main';
    return this.defaultBranch;
  }

  // ── read ────────────────────────────────────────────────────────────────────

  async testConnection(): Promise<AdapterResult<ConnectionInfo>> {
    try {
      const repoRes = await this.request(this.repoPath(''));
      if (!repoRes.ok) return this.failFrom('read the repository', repoRes);

      const repo = readRecord(repoRes.body);
      const permissions = readRecord(repo.permissions);
      const canPush = permissions.push === true;
      const baseBranch = this.config.branch ?? readString(repo.default_branch) ?? 'main';
      this.defaultBranch = readString(repo.default_branch) ?? null;

      const dirRes = await this.request(this.contentsPath(this.config.contentPath), {
        query: { ref: baseBranch },
      });
      if (!dirRes.ok) {
        return this.failFrom(`list the content directory "${this.config.contentPath}"`, dirRes);
      }
      const entries = readArray(dirRes.body);
      if (!Array.isArray(dirRes.body)) {
        return adapterFail<ConnectionInfo>(
          'VALIDATION',
          `"${this.config.contentPath}" is a file, not a directory. Point contentPath at the folder that holds the content files.`,
        );
      }

      const warnings = canPush
        ? []
        : ['The token has read-only access to this repository — content updates will fail until it is granted write access.'];

      const strategy = this.config.strategy ?? 'pull-request';
      return adapterOk<ConnectionInfo>(
        {
          detail:
            `Connected to ${this.config.owner}/${this.config.repo} (branch ${baseBranch}); ` +
            `${entries.length} entries under ${this.config.contentPath}; changes are delivered as ${
              strategy === 'direct' ? 'direct commits' : 'pull requests'
            }.`,
          meta: { branch: baseBranch, strategy, entries: entries.length, canPush },
        },
        { warnings },
      );
    } catch (err) {
      return failFromThrown('GitHub', 'repository', err);
    }
  }

  async listContent(opts: ListContentOptions = {}): Promise<AdapterResult<RemoteContentPage>> {
    const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);

    try {
      const branch = await this.getDefaultBranch();
      const files = await this.walk(this.config.contentPath, branch, 0);
      if (!files.ok) return adapterFail<RemoteContentPage>(files.errorCode, files.error);

      let all = files.data.sort((a, b) => a.path.localeCompare(b.path));
      if (opts.search) {
        const needle = opts.search.toLowerCase();
        all = all.filter((f) => f.path.toLowerCase().includes(needle));
      }

      const slice = all.slice((page - 1) * pageSize, page * pageSize);
      // Titles must come from the file itself, so read the page of files we are returning.
      const items = await mapWithConcurrency(slice, 4, async (file): Promise<RemoteContentSummary> => {
        const loaded = await this.loadFile(file.path, branch);
        if (!loaded.ok) {
          return { externalId: file.path, type: 'file', title: basename(file.path), slug: slugFromPath(file.path) };
        }
        return this.toSummary(loaded.data);
      });

      return adapterOk<RemoteContentPage>({
        items,
        total: all.length,
        hasMore: page * pageSize < all.length,
        nextCursor: page * pageSize < all.length ? String(page + 1) : undefined,
      });
    } catch (err) {
      return failFromThrown<RemoteContentPage>('GitHub', 'list content files', err);
    }
  }

  /** Depth-bounded directory walk over the Contents API. */
  private async walk(path: string, ref: string, depth: number): Promise<AdapterResult<GitFile[]>> {
    const maxDepth = this.config.maxDepth ?? 3;
    const res = await this.request(this.contentsPath(path), { query: { ref } });
    if (!res.ok) return this.failFrom<GitFile[]>(`list "${path}"`, res);
    if (!Array.isArray(res.body)) return adapterOk<GitFile[]>([]);

    const files: GitFile[] = [];
    const dirs: string[] = [];
    for (const entry of res.body) {
      if (!isRecord(entry)) continue;
      const entryPath = readString(entry.path);
      if (!entryPath) continue;
      const type = readString(entry.type);
      if (type === 'dir') {
        dirs.push(entryPath);
      } else if (type === 'file' && CONTENT_EXTENSIONS.some((ext) => entryPath.toLowerCase().endsWith(ext))) {
        files.push({ path: entryPath, sha: readString(entry.sha) ?? '', size: readNumber(entry.size) ?? 0 });
      }
    }

    if (depth < maxDepth) {
      for (const dir of dirs) {
        if (files.length >= MAX_LISTED_FILES) break;
        const nested = await this.walk(dir, ref, depth + 1);
        if (nested.ok) files.push(...nested.data);
      }
    }

    return adapterOk(files.slice(0, MAX_LISTED_FILES));
  }

  async getContent(externalId: string): Promise<AdapterResult<RemoteContent>> {
    try {
      const branch = await this.getDefaultBranch();
      const loaded = await this.loadFile(externalId, branch);
      if (!loaded.ok) return adapterFail<RemoteContent>(loaded.errorCode, loaded.error);
      const content = this.toRemoteContent(loaded.data);
      return adapterOk(content, { externalId: content.externalId, url: content.url });
    } catch (err) {
      return failFromThrown<RemoteContent>('GitHub', `read "${externalId}"`, err);
    }
  }

  private async loadFile(path: string, ref: string): Promise<AdapterResult<LoadedFile>> {
    const res = await this.request(this.contentsPath(path), { query: { ref } });
    if (!res.ok) return this.failFrom<LoadedFile>(`read "${path}"`, res);
    if (Array.isArray(res.body)) {
      return adapterFail<LoadedFile>('VALIDATION', `"${path}" is a directory, not a content file.`);
    }

    const record = readRecord(res.body);
    const encoding = readString(record.encoding);
    const rawContent = readString(record.content) ?? '';
    if (encoding !== 'base64') {
      return adapterFail<LoadedFile>(
        'UNSUPPORTED',
        `GitHub returned "${path}" with encoding "${encoding ?? 'none'}" — files over 1 MB cannot be read through the Contents API.`,
      );
    }

    const raw = Buffer.from(rawContent, 'base64').toString('utf8');
    const parsed = parseFrontmatter(raw);
    return adapterOk<LoadedFile>({
      path,
      sha: readString(record.sha) ?? '',
      data: parsed.data,
      body: parsed.body,
      hasFrontmatter: parsed.hasFrontmatter,
      eol: parsed.eol,
      raw,
    });
  }

  private mappedString(data: FrontmatterRecord, key: string | undefined): string | undefined {
    if (!key) return undefined;
    const value = data[key];
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
  }

  private toSummary(file: LoadedFile): RemoteContentSummary {
    const title = this.mappedString(file.data, this.mapping.title) ?? basename(file.path);
    const draft = file.data[this.mapping.draft ?? 'draft'];
    return {
      externalId: file.path,
      type: 'file',
      title,
      slug: this.mappedString(file.data, this.mapping.slug) ?? slugFromPath(file.path),
      status: draft === true ? 'draft' : 'publish',
      updatedAt: readIsoDate(this.mappedString(file.data, this.mapping.updated ?? this.mapping.date)),
      excerpt: this.mappedString(file.data, this.mapping.excerpt ?? this.mapping.description),
    };
  }

  private toRemoteContent(file: LoadedFile): RemoteContent {
    const structuredKey = this.mapping.structuredData;
    const structured = structuredKey ? file.data[structuredKey] : undefined;
    return {
      ...this.toSummary(file),
      bodyMarkdown: file.body,
      metaTitle: this.mappedString(file.data, this.mapping.metaTitle ?? this.mapping.title),
      metaDescription: this.mappedString(file.data, this.mapping.description),
      canonicalUrl: this.mappedString(file.data, this.mapping.canonical),
      structuredData: structured === undefined ? [] : [toJson(structured)],
      // The blob sha and the full frontmatter map are what a rollback commit needs.
      raw: { path: file.path, sha: file.sha, frontmatter: toJsonObject(file.data), hasFrontmatter: file.hasFrontmatter },
    };
  }

  // ── write ───────────────────────────────────────────────────────────────────

  async createContent(payload: ContentPayload): Promise<AdapterResult<ContentRef>> {
    const body = payload.bodyMarkdown ?? htmlFallbackBody(payload);
    if (body === null) {
      return adapterFail<ContentRef>(
        'VALIDATION',
        'Supply `bodyMarkdown` for a git-backed site. HTML bodies are not written into Markdown content files.',
      );
    }

    const slug = payload.slug?.trim() || slugify(payload.title);
    if (!slug) return adapterFail<ContentRef>('VALIDATION', 'A slug or a non-empty title is required.');

    const extension = this.config.fileFormat === 'mdx' ? 'mdx' : 'md';
    const directory = payload.container?.trim() || this.config.contentPath;
    const path = `${trimTrailingSlash(directory)}/${slug}.${extension}`;

    const data: FrontmatterRecord = {};
    this.applyFrontmatter(data, {
      title: payload.title,
      slug: payload.slug,
      description: payload.metaDescription,
      excerpt: payload.excerpt,
      metaTitle: payload.metaTitle,
      // New content lands as a draft so a human decides when it goes live.
      draft: payload.status !== 'publish',
      date: new Date().toISOString(),
    });

    if (!roundTripsCleanly(data)) {
      return adapterFail<ContentRef>('VALIDATION', 'The generated frontmatter could not be serialised safely.');
    }

    const file = serializeFrontmatter(data, body, '\n');
    return this.commitFile({
      path,
      contents: file,
      sha: undefined,
      slug,
      message: payload.commitMessage ?? `content: add ${slug}`,
      summary: `Add ${payload.title}`,
      beforeState: null,
    });
  }

  async updateContent(externalId: string, patch: ContentPatch): Promise<AdapterResult<ContentRef>> {
    return this.editFile(externalId, patch.commitMessage ?? `content: update ${basename(externalId)}`, (file) => {
      const data = { ...file.data };
      this.applyFrontmatter(data, {
        title: patch.title,
        slug: patch.slug,
        description: patch.metaDescription,
        excerpt: patch.excerpt,
        metaTitle: patch.metaTitle,
        draft: patch.status === undefined ? undefined : patch.status !== 'publish',
      });
      const body = patch.bodyMarkdown ?? file.body;
      return { data, body };
    });
  }

  async publishContent(externalId: string): Promise<AdapterResult<ContentRef>> {
    return this.editFile(externalId, `content: publish ${basename(externalId)}`, (file) => {
      const data = { ...file.data };
      const key = this.mapping.draft ?? 'draft';
      data[key] = false;
      return { data, body: file.body };
    });
  }

  async updateMetadata(externalId: string, patch: MetadataPatch): Promise<AdapterResult<MetadataWriteResult>> {
    const fields: string[] = [];
    const result = await this.editFile(externalId, `seo: update metadata for ${basename(externalId)}`, (file) => {
      const data = { ...file.data };
      if (patch.metaTitle !== undefined) {
        const key = this.mapping.metaTitle ?? this.mapping.title ?? 'title';
        data[key] = patch.metaTitle;
        fields.push('metaTitle');
      }
      if (patch.metaDescription !== undefined) {
        data[this.mapping.description ?? 'description'] = patch.metaDescription;
        fields.push('metaDescription');
      }
      if (patch.canonicalUrl !== undefined && this.mapping.canonical) {
        data[this.mapping.canonical] = patch.canonicalUrl;
        fields.push('canonicalUrl');
      }
      if (patch.noindex !== undefined) data.noindex = patch.noindex;
      return { data, body: file.body };
    });

    if (!result.ok) return adapterFail<MetadataWriteResult>(result.errorCode, result.error, result);
    if (!fields.length) {
      return adapterFail<MetadataWriteResult>(
        'VALIDATION',
        'No metadata fields were supplied, or the canonical key is not mapped in the integration config.',
        { beforeState: result.beforeState },
      );
    }
    return adapterOk<MetadataWriteResult>(
      { fieldsWritten: fields, via: 'frontmatter' },
      { beforeState: result.beforeState, externalId, url: result.url, warnings: result.warnings },
    );
  }

  /** JSON-LD goes into a mapped frontmatter key; the site's layout is expected to render it. */
  async injectStructuredData(externalId: string, jsonLd: JsonValue): Promise<AdapterResult<StructuredDataWriteResult>> {
    const key = this.mapping.structuredData;
    if (!key) {
      return adapterFail<StructuredDataWriteResult>(
        'UNSUPPORTED',
        'No frontmatter key is mapped for structured data. Set `frontmatter.structuredData` in the integration config to the key your layout reads.',
      );
    }
    const value = toFrontmatterValue(jsonLd);
    if (value === undefined) {
      return adapterFail<StructuredDataWriteResult>('VALIDATION', 'The JSON-LD payload is empty or not serialisable.');
    }

    const result = await this.editFile(externalId, `seo: structured data for ${basename(externalId)}`, (file) => ({
      data: { ...file.data, [key]: value },
      body: file.body,
    }));
    if (!result.ok) return adapterFail<StructuredDataWriteResult>(result.errorCode, result.error, result);
    return adapterOk<StructuredDataWriteResult>(
      { applied: true, via: `frontmatter:${key}` },
      { beforeState: result.beforeState, externalId, url: result.url, warnings: result.warnings },
    );
  }

  async createRedirect(): Promise<AdapterResult<RedirectWriteResult>> {
    return unsupported(
      'git',
      'createRedirect',
      'Redirects live in framework-specific config (next.config.js, netlify.toml, public/_redirects) that this adapter will not edit blindly. Add the rule in the repository, or use a platform adapter.',
    );
  }

  // ── commit machinery ────────────────────────────────────────────────────────

  /** Read → transform → validate → commit. Every mutating method funnels through here. */
  private async editFile(
    path: string,
    message: string,
    transform: (file: LoadedFile) => { data: FrontmatterRecord; body: string },
  ): Promise<AdapterResult<ContentRef>> {
    try {
      const baseBranch = await this.getDefaultBranch();
      const loaded = await this.loadFile(path, baseBranch);
      if (!loaded.ok) return adapterFail<ContentRef>(loaded.errorCode, loaded.error);
      const file = loaded.data;
      const beforeState = this.toRemoteContent(file);

      if (!file.hasFrontmatter) {
        return adapterFail<ContentRef>(
          'UNSUPPORTED',
          `"${path}" has no YAML frontmatter block, so there is nowhere to store SEO fields. Add a --- fenced block to the file first.`,
          { beforeState },
        );
      }
      // Refuse rather than risk dropping a YAML construct this parser does not model.
      if (!roundTripsCleanly(file.data)) {
        return adapterFail<ContentRef>(
          'UNSUPPORTED',
          `The frontmatter in "${path}" uses YAML this adapter cannot rewrite losslessly (anchors, tags or multi-document syntax). Edit the file by hand to avoid data loss.`,
          { beforeState },
        );
      }

      const next = transform(file);
      const contents = serializeFrontmatter(next.data, next.body, file.eol);
      if (contents === file.raw) {
        return adapterFail<ContentRef>('VALIDATION', `No change: "${path}" already matches the requested content.`, {
          beforeState,
        });
      }

      return this.commitFile({
        path,
        contents,
        sha: file.sha,
        slug: slugFromPath(path),
        message,
        summary: message,
        beforeState,
      });
    } catch (err) {
      return failFromThrown<ContentRef>('GitHub', `update "${path}"`, err);
    }
  }

  private async commitFile(input: {
    path: string;
    contents: string;
    sha: string | undefined;
    slug: string;
    message: string;
    summary: string;
    beforeState: RemoteContent | null;
  }): Promise<AdapterResult<ContentRef>> {
    const meta: AdapterResultMeta = { beforeState: input.beforeState, externalId: input.path };
    try {
      const baseBranch = await this.getDefaultBranch();
      const strategy = this.config.strategy ?? 'pull-request';
      const warnings: string[] = [];

      let targetBranch = baseBranch;
      if (strategy === 'pull-request') {
        const prefix = trimTrailingSlash(this.config.branchPrefix ?? 'seo-os');
        const branchName = `${prefix}/${slugify(input.slug) || 'change'}`;
        const ensured = await this.ensureBranch(branchName, baseBranch);
        if (!ensured.ok) return adapterFail<ContentRef>(ensured.errorCode, ensured.error, meta);
        targetBranch = branchName;
      }

      // When the working branch already existed from an earlier run, the blob sha on the
      // base branch is stale; re-read it on the target branch so GitHub accepts the update.
      let sha = input.sha;
      if (targetBranch !== baseBranch && sha !== undefined) {
        const onBranch = await this.loadFile(input.path, targetBranch);
        if (onBranch.ok) sha = onBranch.data.sha;
      }

      const body: JsonObject = {
        message: input.message,
        content: Buffer.from(input.contents, 'utf8').toString('base64'),
        branch: targetBranch,
      };
      if (sha) body.sha = sha;
      if (this.config.authorName && this.config.authorEmail) {
        body.committer = { name: this.config.authorName, email: this.config.authorEmail };
      }

      // PUT /contents always appends a commit — there is no force-push path here.
      const res = await this.request(this.contentsPath(input.path), { method: 'PUT', body });
      if (!res.ok) return this.failFrom<ContentRef>(`commit "${input.path}"`, res, meta);

      const commit = readRecord(readRecord(res.body).commit);
      const commitUrl = readString(commit.html_url);
      let url = commitUrl;

      if (strategy === 'pull-request') {
        const pr = await this.ensurePullRequest(targetBranch, baseBranch, input.summary);
        if (pr.ok) url = pr.data.url ?? commitUrl;
        else warnings.push(`Committed to ${targetBranch}, but the pull request could not be opened: ${pr.error}`);
      }

      log.info('committed content change', {
        repo: `${this.config.owner}/${this.config.repo}`,
        path: input.path,
        branch: targetBranch,
        strategy,
      });

      return adapterOk<ContentRef>({ id: input.path, url }, { ...meta, url, warnings });
    } catch (err) {
      return failFromThrown<ContentRef>('GitHub', `commit "${input.path}"`, err);
    }
  }

  /** Create the working branch if it is missing. Existing branches are reused, never reset. */
  private async ensureBranch(branch: string, baseBranch: string): Promise<AdapterResult<{ created: boolean }>> {
    const existing = await this.request(this.repoPath(`/git/ref/heads/${encodeURIComponent(branch)}`));
    if (existing.ok) return adapterOk({ created: false });
    if (existing.status !== 404) return this.failFrom<{ created: boolean }>(`read branch "${branch}"`, existing);

    const baseRef = await this.request(this.repoPath(`/git/ref/heads/${encodeURIComponent(baseBranch)}`));
    if (!baseRef.ok) return this.failFrom<{ created: boolean }>(`read branch "${baseBranch}"`, baseRef);

    const baseSha = readString(readRecord(readRecord(baseRef.body).object).sha);
    if (!baseSha) {
      return adapterFail<{ created: boolean }>('INVALID_RESPONSE', `Could not resolve the head commit of "${baseBranch}".`);
    }

    const created = await this.request(this.repoPath('/git/refs'), {
      method: 'POST',
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
    });
    if (!created.ok) return this.failFrom<{ created: boolean }>(`create branch "${branch}"`, created);
    return adapterOk({ created: true });
  }

  private async ensurePullRequest(head: string, base: string, title: string): Promise<AdapterResult<{ url?: string }>> {
    const open = await this.request(this.repoPath('/pulls'), {
      query: { head: `${this.config.owner}:${head}`, base, state: 'open' },
    });
    if (open.ok) {
      const first = readArray(open.body).find(isRecord);
      if (first) return adapterOk({ url: readString(first.html_url) });
    }

    const created = await this.request(this.repoPath('/pulls'), {
      method: 'POST',
      body: {
        title,
        head,
        base,
        body:
          'Opened automatically by SEO OS. Review the diff before merging — merging is what publishes the change.\n\n' +
          `Branch: \`${head}\` → \`${base}\``,
      },
    });
    if (!created.ok) return this.failFrom<{ url?: string }>('open a pull request', created);
    return adapterOk({ url: readString(readRecord(created.body).html_url) });
  }

  /** Write only the keys the caller actually supplied, using the configured mapping. */
  private applyFrontmatter(
    data: FrontmatterRecord,
    values: {
      title?: string;
      slug?: string;
      description?: string;
      excerpt?: string;
      metaTitle?: string;
      draft?: boolean;
      date?: string;
    },
  ): void {
    const set = (key: string | undefined, value: FrontmatterValue | undefined) => {
      if (!key || value === undefined) return;
      data[key] = value;
    };
    set(this.mapping.title, values.title);
    set(this.mapping.slug, values.slug);
    set(this.mapping.description, values.description);
    set(this.mapping.excerpt, values.excerpt);
    set(this.mapping.metaTitle, values.metaTitle);
    set(this.mapping.draft, values.draft);
    if (values.date !== undefined && this.mapping.date && data[this.mapping.date] === undefined) {
      data[this.mapping.date] = values.date;
    }
  }
}

export function createGitAdapter(input: { credentials: GitCredentials; config: GitAdapterConfig }): GitAdapter {
  return new GitAdapter(input.credentials, input.config);
}

export function parseGitCredentials(value: unknown): GitCredentials | null {
  if (!isRecord(value)) return null;
  const token = readString(value.token) ?? readString(value.accessToken) ?? readString(value.githubToken);
  return token ? { token } : null;
}

export function parseGitConfig(value: unknown): GitAdapterConfig | null {
  const record = readRecord(value);
  const owner = readString(record.owner);
  const repo = readString(record.repo);
  const contentPath = readString(record.contentPath);
  if (!owner || !repo || !contentPath) return null;

  const format = readString(record.fileFormat);
  const strategy = readString(record.strategy);
  const mapping = readRecord(record.frontmatter);

  return {
    owner,
    repo,
    contentPath: trimTrailingSlash(contentPath),
    branch: readString(record.branch),
    fileFormat: format === 'mdx' ? 'mdx' : 'md',
    strategy: strategy === 'direct' ? 'direct' : 'pull-request',
    branchPrefix: readString(record.branchPrefix),
    authorName: readString(record.authorName),
    authorEmail: readString(record.authorEmail),
    apiBaseUrl: readString(record.apiBaseUrl),
    maxDepth: readNumber(record.maxDepth),
    timeoutMs: readNumber(record.timeoutMs),
    frontmatter: {
      title: readString(mapping.title),
      description: readString(mapping.description),
      slug: readString(mapping.slug),
      excerpt: readString(mapping.excerpt),
      date: readString(mapping.date),
      updated: readString(mapping.updated),
      draft: readString(mapping.draft),
      canonical: readString(mapping.canonical),
      metaTitle: readString(mapping.metaTitle),
      structuredData: readString(mapping.structuredData),
    },
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

function slugFromPath(path: string): string {
  return basename(path).replace(/\.(md|mdx|markdown)$/i, '');
}

/** Markdown files never receive an HTML body — returning null makes the caller fail loudly. */
function htmlFallbackBody(payload: ContentPayload): string | null {
  return payload.bodyHtml === undefined ? '' : null;
}

function toJson(value: FrontmatterValue): JsonValue {
  return value as JsonValue;
}

function toJsonObject(data: FrontmatterRecord): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(data)) out[k] = v as JsonValue;
  return out;
}

/** JSON-LD → frontmatter value. Structurally identical types, but narrowed explicitly. */
function toFrontmatterValue(value: JsonValue): FrontmatterValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    if (!value.length) return undefined;
    return value.map((v) => toFrontmatterValue(v) ?? null);
  }
  if (typeof value === 'object') {
    const out: FrontmatterRecord = {};
    for (const [k, v] of Object.entries(value)) {
      const converted = toFrontmatterValue(v);
      out[k] = converted === undefined ? null : converted;
    }
    return isRecordValue(out) && Object.keys(out).length ? out : undefined;
  }
  return value;
}
