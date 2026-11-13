import { truncate } from '@seo/shared';
import { httpRequest, providerMessage, type HttpResult } from '../adapters/http';
import { readArray, readDate, readNumber, readOptionalNumber, readRecord, readString } from '../serp/http';
import { SocialSourceError } from '../social/types';
import { GITHUB_REQUIRED_SCOPES } from './oauth';

/**
 * The operator's own GitHub, over the REST API with plain `fetch`.
 *
 * Every write here (star, watch, fork, issue, comment) is something the operator clicked; nothing
 * in the product calls these on a schedule. Errors are typed with the same vocabulary as the
 * social readers, and a rate limit carries the reset time GitHub reported so the UI can say when
 * to try again instead of retrying.
 */

const API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export interface RepoRef {
  owner: string;
  name: string;
}

/**
 * `owner/name`, `github.com/owner/name`, full URLs (with `/tree/…`, `/issues/12`, `.git`, a
 * trailing slash) — all to one ref. Null when it is not a repository reference.
 */
export function parseRepoRef(input: string): RepoRef | null {
  let value = input.trim();
  if (!value) return null;
  value = value.replace(/^git@github\.com:/i, 'https://github.com/');
  if (/^(https?:\/\/)?(www\.)?github\.com\//i.test(value)) {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    value = url.pathname.replace(/^\//, '');
  }
  const [owner, rawName] = value.split('/');
  const name = rawName?.replace(/\.git$/i, '');
  const valid = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
  if (!owner || !name || !valid.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..') return null;
  return { owner, name };
}

export function repoPath(ref: RepoRef): string {
  return `${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
}

/** Map a GitHub failure onto the shared error vocabulary. Exported for tests. */
export function githubError(res: Pick<HttpResult, 'status' | 'headers' | 'body' | 'text'>, operation: string): SocialSourceError {
  const message = `GitHub ${operation} failed (HTTP ${res.status}): ${providerMessage(res as HttpResult)}`;
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const retryAfter = Number(res.headers.get('retry-after'));
  if (res.status === 429 || (res.status === 403 && (remaining === '0' || Number.isFinite(retryAfter) && retryAfter > 0))) {
    const seconds = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : Number.isFinite(reset) && reset > 0
        ? Math.max(1, Math.ceil(reset - Date.now() / 1000))
        : 60;
    return new SocialSourceError('RATE_LIMITED', message, `GitHub's rate limit resets in about ${Math.ceil(seconds / 60)} minute(s).`, seconds);
  }
  if (res.status === 401) return new SocialSourceError('NEED_LOGIN', message, 'The GitHub token was revoked or expired. Link GitHub again from Accounts.');
  if (res.status === 403) return new SocialSourceError('BLOCKED', message, 'The token lacks permission for this (check its scopes) or the repository blocks it.');
  if (res.status === 404) return new SocialSourceError('NOT_FOUND', message);
  if (res.status === 422 || res.status === 400) return new SocialSourceError('BAD_INPUT', message);
  return new SocialSourceError('UPSTREAM', message);
}

interface GitHubCall {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  accept?: string;
  /** Status codes that are answers rather than failures (e.g. 404 for "not starred"). */
  okStatuses?: number[];
}

export async function githubApi(token: string, path: string, call: GitHubCall = {}): Promise<HttpResult> {
  const res = await httpRequest(`${API}${path}`, {
    method: call.method ?? 'GET',
    ...(call.query ? { query: call.query } : {}),
    ...(call.body !== undefined ? { body: call.body } : {}),
    // PUT with no body must still send Content-Length: 0, which an empty JSON body does.
    ...(call.method === 'PUT' && call.body === undefined ? { body: {} } : {}),
    headers: {
      accept: call.accept ?? 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': API_VERSION,
      'user-agent': 'seo-os',
    },
  });
  if (!res.ok && !(call.okStatuses ?? []).includes(res.status)) throw githubError(res, `${call.method ?? 'GET'} ${path}`);
  return res;
}

// ── identity ──────────────────────────────────────────────

export interface GitHubIdentity {
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  htmlUrl: string;
  publicRepos: number;
  followers: number;
}

/** Normalise `GET /user` (+ the primary verified address from `/user/emails`). Exported for tests. */
export function parseGitHubIdentity(user: unknown, emails: unknown): GitHubIdentity {
  const record = readRecord(user);
  const login = readString(record?.login);
  if (!login) throw new SocialSourceError('UPSTREAM', 'GitHub returned no login for this token.');
  const primary = readArray(emails)
    .map(readRecord)
    .find((entry) => entry?.primary === true && entry?.verified === true);
  return {
    login,
    name: readString(record?.name) || null,
    email: readString(primary?.email) || readString(record?.email) || null,
    avatarUrl: readString(record?.avatar_url) || null,
    htmlUrl: readString(record?.html_url) || `https://github.com/${login}`,
    publicRepos: readNumber(record?.public_repos, 0),
    followers: readNumber(record?.followers, 0),
  };
}

/** Classic tokens list their scopes in `x-oauth-scopes`; fine-grained tokens do not. Exported for tests. */
export function checkTokenScopes(header: string | null): { kind: 'classic' | 'fine-grained'; missing: string[] } {
  if (header === null) return { kind: 'fine-grained', missing: [] };
  const granted = new Set(header.split(',').map((scope) => scope.trim()).filter(Boolean));
  // `repo` implies `public_repo`, and `user` implies both user sub-scopes.
  const implied = (scope: string): boolean =>
    granted.has(scope) ||
    (scope === 'public_repo' && granted.has('repo')) ||
    ((scope === 'read:user' || scope === 'user:email') && granted.has('user'));
  return { kind: 'classic', missing: GITHUB_REQUIRED_SCOPES.filter((scope) => !implied(scope)) };
}

export async function fetchGitHubIdentity(token: string): Promise<GitHubIdentity & { scopes: ReturnType<typeof checkTokenScopes> }> {
  const userRes = await githubApi(token, '/user');
  // `/user/emails` needs `user:email`; without it the profile email (often private) is used.
  const emailRes = await githubApi(token, '/user/emails', { okStatuses: [403, 404] });
  return {
    ...parseGitHubIdentity(userRes.body, emailRes.ok ? emailRes.body : []),
    scopes: checkTokenScopes(userRes.headers.get('x-oauth-scopes')),
  };
}

// ── reads ─────────────────────────────────────────────────

export interface GitHubRepoSummary {
  fullName: string;
  description: string | null;
  htmlUrl: string;
  stars: number;
  forks: number;
  openIssues: number;
  language: string | null;
  topics: string[];
  isPrivate: boolean;
  isFork: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  license: string | null;
  homepage: string | null;
}

function repoSummary(value: unknown): GitHubRepoSummary {
  const repo = readRecord(value);
  return {
    fullName: readString(repo?.full_name),
    description: readString(repo?.description) || null,
    htmlUrl: readString(repo?.html_url),
    stars: readNumber(repo?.stargazers_count, 0),
    forks: readNumber(repo?.forks_count, 0),
    openIssues: readNumber(repo?.open_issues_count, 0),
    language: readString(repo?.language) || null,
    topics: readArray(repo?.topics).map(String),
    isPrivate: repo?.private === true,
    isFork: repo?.fork === true,
    defaultBranch: readString(repo?.default_branch, 'main'),
    pushedAt: readDate(repo?.pushed_at)?.toISOString() ?? null,
    license: readString(readRecord(repo?.license)?.spdx_id) || null,
    homepage: readString(repo?.homepage) || null,
  };
}

export async function listMyRepos(token: string, limit = 30): Promise<GitHubRepoSummary[]> {
  const res = await githubApi(token, '/user/repos', { query: { sort: 'pushed', per_page: Math.min(limit, 100), affiliation: 'owner,collaborator' } });
  return readArray(res.body).map(repoSummary);
}

export interface GitHubNotification {
  id: string;
  reason: string;
  unread: boolean;
  updatedAt: string | null;
  title: string;
  type: string;
  repo: string;
  /** Web URL of the subject when it can be derived from the API URL. */
  url: string | null;
}

/** `https://api.github.com/repos/o/r/issues/12` → `https://github.com/o/r/issues/12`. */
function webUrlFromApi(apiUrl: string): string | null {
  const match = apiUrl.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls|commits|releases)\/(.+)$/);
  if (!match) return null;
  const kind = match[2] === 'pulls' ? 'pull' : match[2] === 'commits' ? 'commit' : match[2] === 'releases' ? 'releases' : 'issues';
  return `https://github.com/${match[1]}/${kind}/${match[3]}`;
}

export async function listNotifications(token: string, all = false): Promise<GitHubNotification[]> {
  const res = await githubApi(token, '/notifications', { query: { all, per_page: 50 } });
  return readArray(res.body).flatMap((entry) => {
    const record = readRecord(entry);
    const subject = readRecord(record?.subject);
    const id = readString(record?.id);
    if (!id) return [];
    const apiUrl = readString(subject?.url);
    return [
      {
        id,
        reason: readString(record?.reason),
        unread: record?.unread === true,
        updatedAt: readDate(record?.updated_at)?.toISOString() ?? null,
        title: readString(subject?.title),
        type: readString(subject?.type),
        repo: readString(readRecord(record?.repository)?.full_name),
        url: apiUrl ? webUrlFromApi(apiUrl) : null,
      },
    ];
  });
}

export async function markNotificationRead(token: string, threadId: string): Promise<void> {
  if (!/^\d+$/.test(threadId)) throw new SocialSourceError('BAD_INPUT', 'Not a notification id.');
  await githubApi(token, `/notifications/threads/${threadId}`, { method: 'PATCH', okStatuses: [205, 304] });
}

/**
 * Strip anything executable from GitHub-rendered HTML before it is shown.
 *
 * GitHub already sanitises what it renders; this is a second line so a README can never run
 * script in the operator's session even if that ever changes. Exported for tests.
 */
export function sanitizeGitHubHtml(html: string): string {
  const dangerous = 'script|style|iframe|object|embed|form|input|button|textarea|select|meta|link|base|frame|frameset|svg|math';
  return html
    // Paired elements go with everything inside them; any stray or self-closing tag goes too.
    .replace(new RegExp(`<(${dangerous})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<\\/?(${dangerous})\\b[^>]*>`, 'gi'), '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|xlink:href|action|formaction)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, ' $1="#"')
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '');
}

export interface GitHubRepoDetail extends GitHubRepoSummary {
  latestRelease: { tag: string; name: string | null; url: string; publishedAt: string | null } | null;
  readmeHtml: string | null;
  starred: boolean;
  watching: boolean;
}

export async function getRepoDetail(token: string, ref: RepoRef): Promise<GitHubRepoDetail> {
  const path = repoPath(ref);
  const [repo, release, readme, starred, subscription] = await Promise.all([
    githubApi(token, `/repos/${path}`),
    githubApi(token, `/repos/${path}/releases/latest`, { okStatuses: [404] }),
    githubApi(token, `/repos/${path}/readme`, { accept: 'application/vnd.github.html+json', okStatuses: [404] }),
    githubApi(token, `/user/starred/${path}`, { okStatuses: [404] }),
    githubApi(token, `/repos/${path}/subscription`, { okStatuses: [404] }),
  ]);
  const rel = release.ok ? readRecord(release.body) : null;
  return {
    ...repoSummary(repo.body),
    latestRelease: rel && readString(rel.tag_name)
      ? {
          tag: readString(rel.tag_name),
          name: readString(rel.name) || null,
          url: readString(rel.html_url),
          publishedAt: readDate(rel.published_at)?.toISOString() ?? null,
        }
      : null,
    readmeHtml: readme.ok && readme.text ? sanitizeGitHubHtml(truncate(readme.text, 400_000)) : null,
    starred: starred.status === 204,
    watching: subscription.ok && readRecord(subscription.body)?.subscribed === true,
  };
}

export interface GitHubIssueSummary {
  number: number;
  title: string;
  state: string;
  isPullRequest: boolean;
  author: string | null;
  comments: number;
  createdAt: string | null;
  updatedAt: string | null;
  labels: string[];
  url: string;
}

function issueSummary(value: unknown): GitHubIssueSummary {
  const issue = readRecord(value);
  return {
    number: readNumber(issue?.number, 0),
    title: readString(issue?.title),
    state: readString(issue?.state),
    isPullRequest: issue?.pull_request !== undefined && issue?.pull_request !== null,
    author: readString(readRecord(issue?.user)?.login) || null,
    comments: readNumber(issue?.comments, 0),
    createdAt: readDate(issue?.created_at)?.toISOString() ?? null,
    updatedAt: readDate(issue?.updated_at)?.toISOString() ?? null,
    labels: readArray(issue?.labels).map((label) => readString(readRecord(label)?.name)).filter(Boolean),
    url: readString(issue?.html_url),
  };
}

/** Open issues and PRs (the issues endpoint returns both, flagged). */
export async function listIssues(token: string, ref: RepoRef, state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubIssueSummary[]> {
  const res = await githubApi(token, `/repos/${repoPath(ref)}/issues`, { query: { state, per_page: 50, sort: 'updated' } });
  return readArray(res.body).map(issueSummary);
}

export interface GitHubComment {
  id: number;
  author: string | null;
  bodyHtml: string;
  createdAt: string | null;
  url: string;
}

export async function getIssueThread(
  token: string,
  ref: RepoRef,
  number: number,
): Promise<{ issue: GitHubIssueSummary & { bodyHtml: string }; comments: GitHubComment[] }> {
  if (!Number.isInteger(number) || number <= 0) throw new SocialSourceError('BAD_INPUT', 'Not an issue number.');
  const html = 'application/vnd.github.html+json';
  const [issue, comments] = await Promise.all([
    githubApi(token, `/repos/${repoPath(ref)}/issues/${number}`, { accept: html }),
    githubApi(token, `/repos/${repoPath(ref)}/issues/${number}/comments`, { accept: html, query: { per_page: 100 } }),
  ]);
  const record = readRecord(issue.body);
  return {
    issue: { ...issueSummary(issue.body), bodyHtml: sanitizeGitHubHtml(readString(record?.body_html)) },
    comments: readArray(comments.body).map((entry) => {
      const comment = readRecord(entry);
      return {
        id: readNumber(comment?.id, 0),
        author: readString(readRecord(comment?.user)?.login) || null,
        bodyHtml: sanitizeGitHubHtml(readString(comment?.body_html)),
        createdAt: readDate(comment?.created_at)?.toISOString() ?? null,
        url: readString(comment?.html_url),
      };
    }),
  };
}

// ── writes (always operator-initiated) ────────────────────

export type RepoAction = 'star' | 'unstar' | 'watch' | 'unwatch' | 'fork';

export async function repoAction(token: string, ref: RepoRef, action: RepoAction): Promise<{ done: RepoAction; url: string | null }> {
  const path = repoPath(ref);
  switch (action) {
    case 'star':
      await githubApi(token, `/user/starred/${path}`, { method: 'PUT' });
      return { done: action, url: null };
    case 'unstar':
      await githubApi(token, `/user/starred/${path}`, { method: 'DELETE' });
      return { done: action, url: null };
    case 'watch':
      await githubApi(token, `/repos/${path}/subscription`, { method: 'PUT', body: { subscribed: true, ignored: false } });
      return { done: action, url: null };
    case 'unwatch':
      await githubApi(token, `/repos/${path}/subscription`, { method: 'DELETE' });
      return { done: action, url: null };
    case 'fork': {
      const res = await githubApi(token, `/repos/${path}/forks`, { method: 'POST', body: {}, okStatuses: [202] });
      return { done: action, url: readString(readRecord(res.body)?.html_url) || null };
    }
  }
}

function assertText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (text.length < 2) throw new SocialSourceError('BAD_INPUT', `${label} is empty.`);
  if (text.length > max) throw new SocialSourceError('BAD_INPUT', `${label} is longer than ${max} characters.`);
  return text;
}

export async function createIssue(token: string, ref: RepoRef, title: string, body: string): Promise<{ number: number; url: string }> {
  const res = await githubApi(token, `/repos/${repoPath(ref)}/issues`, {
    method: 'POST',
    body: { title: assertText(title, 'The title', 256), body: assertText(body, 'The description', 65_000) },
  });
  const record = readRecord(res.body);
  return { number: readNumber(record?.number, 0), url: readString(record?.html_url) };
}

export async function createComment(token: string, ref: RepoRef, number: number, body: string): Promise<{ id: number; url: string }> {
  if (!Number.isInteger(number) || number <= 0) throw new SocialSourceError('BAD_INPUT', 'Not an issue number.');
  const res = await githubApi(token, `/repos/${repoPath(ref)}/issues/${number}/comments`, {
    method: 'POST',
    body: { body: assertText(body, 'The comment', 65_000) },
  });
  const record = readRecord(res.body);
  return { id: readNumber(record?.id, 0), url: readString(record?.html_url) };
}

/** Remaining REST quota from the last response, for the workspace header. */
export function rateLimitFrom(res: HttpResult): { remaining: number | null; resetAt: string | null } {
  const remaining = readOptionalNumber(Number(res.headers.get('x-ratelimit-remaining')));
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return {
    remaining: remaining !== undefined && Number.isFinite(remaining) ? remaining : null,
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
  };
}
