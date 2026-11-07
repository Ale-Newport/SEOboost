import { createLogger, env } from '@seo/shared';
import { httpRequest, providerMessage, type HttpResult } from '../adapters/http';
import { readNumber, readRecord, readString } from '../serp/http';
import { SocialSourceError } from './types';

/**
 * Reddit OAuth.
 *
 * Reddit's Data API wants a registered app and a descriptive user agent on every call. Two grants
 * are used: `client_credentials` (app-only, read) for listening and community rules, and the
 * `password` grant of a *script* app for posting as the operator's own account — the grant Reddit
 * documents for personal scripts. Tokens are cached in memory until a minute before they expire.
 */

const log = createLogger('social:reddit');

export const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
export const REDDIT_PUBLIC_BASE = 'https://www.reddit.com';

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  username?: string | null;
  password?: string | null;
}

export function readRedditCredentials(credentials: Record<string, string>): RedditCredentials | null {
  const clientId = credentials.clientId?.trim();
  const clientSecret = credentials.clientSecret?.trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    username: credentials.username?.trim() || null,
    password: credentials.password || null,
  };
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(creds: RedditCredentials, mode: 'app' | 'user'): string {
  return `${mode}:${creds.clientId}:${mode === 'user' ? creds.username ?? '' : ''}`;
}

/** Map a Reddit HTTP failure onto the shared error vocabulary. */
export function redditError(res: HttpResult, operation: string): SocialSourceError {
  const message = `Reddit ${operation} failed (HTTP ${res.status}): ${providerMessage(res)}`;
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    return new SocialSourceError('RATE_LIMITED', message, null, Number.isFinite(reset) ? Math.ceil(reset) : 60);
  }
  if (res.status === 401) {
    return new SocialSourceError('NEED_LOGIN', message, 'Check the Reddit app id/secret (and username/password for posting) on the Social → Accounts tab.');
  }
  if (res.status === 403) return new SocialSourceError('BLOCKED', message, 'Reddit refused the request — the subreddit may be private, or the account may be restricted.');
  if (res.status === 404) return new SocialSourceError('NOT_FOUND', message);
  return new SocialSourceError('UPSTREAM', message);
}

export async function redditToken(creds: RedditCredentials, mode: 'app' | 'user'): Promise<string> {
  const key = cacheKey(creds, mode);
  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  if (mode === 'user' && (!creds.username || !creds.password)) {
    throw new SocialSourceError(
      'NOT_CONFIGURED',
      'Posting to Reddit needs the account username and password of a "script" app owner.',
      'Create a script app at https://www.reddit.com/prefs/apps with the posting account, then add its username and password.',
    );
  }
  const form = new URLSearchParams(
    mode === 'user'
      ? { grant_type: 'password', username: creds.username ?? '', password: creds.password ?? '' }
      : { grant_type: 'client_credentials' },
  );
  const res = await httpRequest(`${REDDIT_PUBLIC_BASE}/api/v1/access_token`, {
    method: 'POST',
    rawBody: form.toString(),
    headers: {
      authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': env.socialUserAgent,
    },
  });
  const body = readRecord(res.body);
  const token = readString(body?.access_token);
  if (!res.ok || !token) {
    if (res.ok) {
      throw new SocialSourceError('NEED_LOGIN', `Reddit refused the credentials: ${readString(body?.error) || 'no token returned'}.`, 'Accounts with two-factor authentication must append the current code to the password as "password:123456", or use an account without 2FA for the script app.');
    }
    throw redditError(res, 'authentication');
  }
  tokens.set(key, { token, expiresAt: Date.now() + readNumber(body?.expires_in, 3600) * 1000 });
  log.debug('reddit token issued', { mode });
  return token;
}

export interface RedditRequest {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | undefined>;
  form?: Record<string, string>;
  mode: 'app' | 'user';
}

/** One authenticated call to oauth.reddit.com. HTTP failures come back as typed errors. */
export async function redditApi(creds: RedditCredentials, path: string, req: RedditRequest): Promise<unknown> {
  const token = await redditToken(creds, req.mode);
  const res = await httpRequest(`${REDDIT_OAUTH_BASE}${path}`, {
    method: req.method ?? 'GET',
    query: { raw_json: 1, ...(req.query ?? {}) },
    ...(req.form
      ? { rawBody: new URLSearchParams({ api_type: 'json', ...req.form }).toString() }
      : {}),
    headers: {
      authorization: `bearer ${token}`,
      'user-agent': env.socialUserAgent,
      ...(req.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
  });
  if (res.status === 401) tokens.delete(cacheKey(creds, req.mode));
  if (!res.ok) throw redditError(res, `${req.method ?? 'GET'} ${path}`);
  return res.body;
}

/** Unauthenticated read of reddit.com JSON. Reddit increasingly blocks these; failures are typed. */
export async function redditPublic(path: string, query: Record<string, string | number | boolean | undefined>): Promise<unknown> {
  const res = await httpRequest(`${REDDIT_PUBLIC_BASE}${path}`, {
    query: { raw_json: 1, ...query },
    headers: { 'user-agent': env.socialUserAgent },
  });
  if (res.status === 403) {
    // Anonymous API access, not a private subreddit: Reddit now refuses most unauthenticated JSON.
    throw new SocialSourceError(
      'BLOCKED',
      `Reddit refused anonymous access to ${path} (HTTP 403).`,
      'Connect a Reddit app on Social → Accounts (read-only search needs just the client id and secret), or install agent-reach and run `agent-reach add reddit`.',
    );
  }
  if (!res.ok) throw redditError(res, `GET ${path}`);
  if (res.body === null) {
    throw new SocialSourceError('BLOCKED', 'Reddit answered the anonymous request with a non-JSON page (usually a block or a login wall).', 'Connect a Reddit app on the Social → Accounts tab, or install agent-reach and run `agent-reach add reddit`.');
  }
  return res.body;
}

/** Test seam. */
export function resetRedditTokens(): void {
  tokens.clear();
}
