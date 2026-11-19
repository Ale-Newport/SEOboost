import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkTokenScopes,
  createComment,
  githubError,
  parseGitHubIdentity,
  parseRepoRef,
  repoAction,
  sanitizeGitHubHtml,
} from '../github';
import { buildPersonalAuthorizeUrl, parsePersonalTokens, safeReturnTo } from '../oauth';
import { parseRedditIdentity, parseRedditThing } from '../reddit';
import { SocialSourceError } from '../../social/types';

const headers = (values: Record<string, string>) => new Headers(values);

describe('parseRepoRef', () => {
  it('accepts owner/name, URLs, .git and deep links', () => {
    expect(parseRepoRef('octo-org/hello.world')).toEqual({ owner: 'octo-org', name: 'hello.world' });
    expect(parseRepoRef('https://github.com/octo-org/tool')).toEqual({ owner: 'octo-org', name: 'tool' });
    expect(parseRepoRef('github.com/octo-org/tool/')).toEqual({ owner: 'octo-org', name: 'tool' });
    expect(parseRepoRef('https://github.com/octo-org/tool.git')).toEqual({ owner: 'octo-org', name: 'tool' });
    expect(parseRepoRef('https://github.com/octo-org/tool/issues/12')).toEqual({ owner: 'octo-org', name: 'tool' });
    expect(parseRepoRef('git@github.com:octo-org/tool.git')).toEqual({ owner: 'octo-org', name: 'tool' });
  });

  it('rejects things that are not repositories', () => {
    expect(parseRepoRef('')).toBeNull();
    expect(parseRepoRef('just-a-name')).toBeNull();
    expect(parseRepoRef('https://github.com/octo-org')).toBeNull();
    expect(parseRepoRef('octo org/tool')).toBeNull();
    expect(parseRepoRef('owner/..')).toBeNull();
  });
});

describe('GitHub identity and token scopes', () => {
  it('prefers the primary verified address', () => {
    const identity = parseGitHubIdentity(
      { login: 'octocat', name: 'Mona', email: null, public_repos: 3, followers: 9, html_url: 'https://github.com/octocat' },
      [
        { email: 'old@example.com', primary: false, verified: true },
        { email: 'mona@example.com', primary: true, verified: true },
      ],
    );
    expect(identity).toMatchObject({ login: 'octocat', email: 'mona@example.com', publicRepos: 3, followers: 9 });
  });

  it('fails without a login', () => {
    expect(() => parseGitHubIdentity({}, [])).toThrow(SocialSourceError);
  });

  it('reports missing classic scopes, honours implied ones, and accepts fine-grained tokens', () => {
    expect(checkTokenScopes('public_repo, read:user, user:email, notifications')).toEqual({ kind: 'classic', missing: [] });
    expect(checkTokenScopes('repo, user, notifications')).toEqual({ kind: 'classic', missing: [] });
    expect(checkTokenScopes('read:user')).toEqual({ kind: 'classic', missing: ['public_repo', 'user:email', 'notifications'] });
    expect(checkTokenScopes(null)).toEqual({ kind: 'fine-grained', missing: [] });
  });
});

describe('githubError', () => {
  const res = (status: number, extra: Record<string, string> = {}) => ({ status, headers: headers(extra), body: { message: 'nope' }, text: '{"message":"nope"}' });

  it('maps an exhausted quota to RATE_LIMITED with the reset time', () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const error = githubError(res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }), 'GET /user');
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterSeconds).toBeGreaterThan(100);
    expect(githubError(res(429, { 'retry-after': '30' }), 'x').retryAfterSeconds).toBe(30);
  });

  it('separates permission, auth and missing errors', () => {
    expect(githubError(res(403), 'x').code).toBe('BLOCKED');
    expect(githubError(res(401), 'x').code).toBe('NEED_LOGIN');
    expect(githubError(res(404), 'x').code).toBe('NOT_FOUND');
    expect(githubError(res(422), 'x').code).toBe('BAD_INPUT');
  });
});

describe('GitHub writes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stars with an authenticated PUT and comments with the body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (init.method === 'PUT') return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ id: 7, html_url: 'https://github.com/o/r/issues/3#c7' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    await repoAction('tok', { owner: 'o', name: 'r' }, 'star');
    expect(calls[0]?.url).toBe('https://api.github.com/user/starred/o/r');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const comment = await createComment('tok', { owner: 'o', name: 'r' }, 3, 'Thanks for this!');
    expect(comment.url).toContain('#c7');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ body: 'Thanks for this!' });
  });

  it('refuses empty comments before calling GitHub', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(createComment('tok', { owner: 'o', name: 'r' }, 3, ' ')).rejects.toThrow(SocialSourceError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('sanitizeGitHubHtml', () => {
  it('removes scripts, handlers and javascript: links but keeps content', () => {
    const clean = sanitizeGitHubHtml(
      '<h1 onclick="steal()">Title</h1><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="a.png" onerror="x()"><p style="color:red">ok</p>',
    );
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:|style=/i);
    expect(clean).toContain('Title');
    expect(clean).toContain('<p>ok</p>');
  });

  it('removes tags a single pass would reassemble', () => {
    for (const html of [
      '<scr<script>ipt>alert(1)</scr<script>ipt>',
      '<scr<script></script>ipt>alert(1)</script>',
      '<ifr<iframe>ame src="https://evil.example">',
      '<img src=x o<script></script>nerror=alert(1)>',
    ]) {
      expect(sanitizeGitHubHtml(html)).not.toMatch(/<script|<iframe|onerror/i);
    }
  });

  it('strips handlers after a slash and unquoted script URLs', () => {
    expect(sanitizeGitHubHtml('<img/onerror=alert(1) src="a.png">')).not.toMatch(/onerror/i);
    const link = sanitizeGitHubHtml('<a href=javascript:alert(1)>x</a>');
    expect(link).not.toMatch(/javascript|href/i);
    expect(link).toContain('>x</a>');
  });

  it('leaves ordinary GitHub HTML untouched', () => {
    const html = '<h2><a href="#install">Install</a></h2><pre><code>npm i x</code></pre><img src="https://x/a.png" alt="logo" />';
    expect(sanitizeGitHubHtml(html)).toBe(html);
  });

  it('escapes markup that is still changing after several passes, quickly', () => {
    const depth = 5_000;
    const nested = `${'<scr'.repeat(depth)}<script>${'ipt>'.repeat(depth)}alert(1)`;
    const started = performance.now();
    const clean = sanitizeGitHubHtml(nested);
    expect(performance.now() - started).toBeLessThan(100);
    expect(clean).not.toContain('<');
    expect(sanitizeGitHubHtml(`<p${' onx=1'.repeat(8_000)}>`)).toBe('<p></p>');
  });

  it('decodes entities before checking URL schemes', () => {
    for (const html of [
      '<a href="&#106;avascript:alert(1)">x</a>',
      '<a href="&#x6A;avascript:alert(1)">x</a>',
      '<a href="java&#x09;script:alert(1)">x</a>',
      '<img src="&#106;avascript:alert(1)">',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
      '<img src="//evil.example/track.gif">',
    ]) {
      const clean = sanitizeGitHubHtml(html);
      expect(clean).not.toMatch(/javascript|data:|evil\.example|<script/i);
    }
  });

  it('opens external links safely and leaves in-page anchors alone', () => {
    expect(sanitizeGitHubHtml('<a href="https://example.com">x</a>')).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">x</a>',
    );
    expect(sanitizeGitHubHtml('<a href="#usage">x</a>')).toBe('<a href="#usage">x</a>');
  });

  it('keeps read-only task-list checkboxes and drops every other input', () => {
    expect(sanitizeGitHubHtml('<input type="checkbox" checked onclick="x()">')).toBe(
      '<input type="checkbox" disabled checked />',
    );
    expect(sanitizeGitHubHtml('<input type="checkbox">')).toBe('<input type="checkbox" disabled />');
    expect(sanitizeGitHubHtml('<input type="text" value="phish">')).not.toContain('<input');
    expect(sanitizeGitHubHtml('<form action="https://evil.example"><input type="password"></form>')).not.toMatch(/form|input|evil/);
  });

  it('namespaces ids and keeps only GitHub classes', () => {
    expect(sanitizeGitHubHtml('<h2 id="install">Install</h2>')).toBe('<h2 id="user-content-install">Install</h2>');
    expect(sanitizeGitHubHtml('<h2 id="user-content-install">Install</h2>')).toBe('<h2 id="user-content-install">Install</h2>');
    expect(sanitizeGitHubHtml('<li class="task-list-item fixed inset-0 z-50">x</li>')).toBe('<li class="task-list-item">x</li>');
  });

  it('drops dangerous elements together with their contents', () => {
    const clean = sanitizeGitHubHtml('<p>a</p><style>body{display:none}</style><svg><script>alert(1)</script></svg><iframe src="https://x"></iframe><p>b</p>');
    expect(clean).toBe('<p>a</p><p>b</p>');
  });
});

describe('personal OAuth', () => {
  it('builds the GitHub and Reddit authorize URLs with the needed scopes', () => {
    const github = new URL(buildPersonalAuthorizeUrl({ provider: 'GITHUB', clientId: 'cid', redirectUri: 'http://localhost:3000/api/accounts/github/callback', state: 's'.repeat(24) }));
    expect(github.origin + github.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(github.searchParams.get('scope')).toBe('read:user user:email public_repo notifications');
    const reddit = new URL(buildPersonalAuthorizeUrl({ provider: 'REDDIT', clientId: 'cid', redirectUri: 'http://localhost:3000/api/social/oauth/reddit/callback', state: 's'.repeat(24) }));
    expect(reddit.searchParams.get('duration')).toBe('permanent');
    expect(reddit.searchParams.get('scope')).not.toContain('vote');
  });

  it('treats a GitHub 200 with an error as a failure', () => {
    expect(() => parsePersonalTokens('GITHUB', { error: 'bad_verification_code', error_description: 'expired' })).toThrow(/expired/);
    const tokens = parsePersonalTokens('REDDIT', { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'identity' }, new Date('2026-01-01T00:00:00Z'));
    expect(tokens.expiresAt?.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  it('never redirects outside the app', () => {
    expect(safeReturnTo('/accounts/github')).toBe('/accounts/github');
    expect(safeReturnTo('https://evil.example')).toBe('/accounts');
    expect(safeReturnTo('//evil.example')).toBe('/accounts');
    expect(safeReturnTo(null)).toBe('/accounts');
  });
});

describe('Reddit parsing', () => {
  it('reads karma and inbox items', () => {
    expect(parseRedditIdentity({ name: 'someone', link_karma: 10, comment_karma: 5, total_karma: 15, inbox_count: 2 })).toMatchObject({
      handle: 'u/someone',
      totalKarma: 15,
      inboxCount: 2,
    });
    const reply = parseRedditThing({
      kind: 't1',
      data: { name: 't1_abc', author: 'other', subreddit: 'SideProject', body: 'Nice!', context: '/r/SideProject/comments/x/y/abc/', type: 'comment_reply', new: true, created_utc: 1_762_000_000 },
    });
    expect(reply).toMatchObject({ kind: 'comment', inboxType: 'comment_reply', unread: true, subreddit: 'r/SideProject' });
    expect(reply?.url).toBe('https://www.reddit.com/r/SideProject/comments/x/y/abc/');
    expect(parseRedditThing({ kind: 't4', data: { name: 't4_m', subject: 'Hello', body: 'hi', new: false } })).toMatchObject({ kind: 'message', inboxType: 'message', title: 'Hello' });
  });
});
