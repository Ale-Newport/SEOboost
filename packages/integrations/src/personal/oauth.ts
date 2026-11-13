import { getAppSetting, prisma, setAppSetting } from '@seo/db';
import { env } from '@seo/shared';
import { encryptJson, randomToken, tryDecryptJson } from '@seo/shared/crypto';
import { httpRequest, providerMessage, type HttpResult } from '../adapters/http';
import { readNumber, readRecord, readString } from '../serp/http';
import {
  OAUTH_ATTEMPT_TTL_MS,
  OAUTH_AUTH_TYPE,
  developerAppRedirectUri,
  loadOAuthApp,
  type OAuthAppCredentials,
} from '../social/oauth';
import { SocialSourceError } from '../social/types';

/**
 * One-click linking of the operator's OWN GitHub and Reddit accounts (Accounts area).
 *
 * Same discipline as the social connections: the operator approves on the platform's own page,
 * the attempt (state, who started it) is stored server-side encrypted and single use, and the
 * browser is bound with an HttpOnly cookie. The developer apps are the installation-level ones
 * from Social → Accounts → "One-time developer apps" — Reddit's is shared with the social module,
 * and because a Reddit web app accepts a single redirect URI the personal flow returns through
 * the social Reddit callback, which hands personal attempts to the personal handler.
 */

export type PersonalProvider = 'GITHUB' | 'REDDIT';

export const PERSONAL_PROVIDERS: readonly PersonalProvider[] = ['GITHUB', 'REDDIT'];

export function isPersonalProvider(value: string): value is PersonalProvider {
  return (PERSONAL_PROVIDERS as readonly string[]).includes(value);
}

interface PersonalSpec {
  label: string;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  extraAuthorizeParams?: Record<string, string>;
}

/**
 * Scopes are the minimum the workspace features use. Reddit gets no `vote` scope on purpose: the
 * app never votes, so it never asks for the permission to.
 */
export const PERSONAL_OAUTH: Record<PersonalProvider, PersonalSpec> = {
  GITHUB: {
    label: 'GitHub',
    scopes: 'read:user user:email public_repo notifications',
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    extraAuthorizeParams: { allow_signup: 'false' },
  },
  REDDIT: {
    label: 'Reddit',
    scopes: 'identity read submit edit history privatemessages mysubreddits',
    authorizeUrl: 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: 'https://www.reddit.com/api/v1/access_token',
    extraAuthorizeParams: { duration: 'permanent' },
  },
};

/** Where the platform sends the browser back. See the module comment for why Reddit's is social. */
export function personalRedirectUri(provider: PersonalProvider, appUrl: string = env.appUrl): string {
  return developerAppRedirectUri(provider, appUrl);
}

/** Classic-token creation link with exactly the scopes the GitHub workspace needs. */
export const GITHUB_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=public_repo,read:user,user:email,notifications&description=SEO%20OS';

export const GITHUB_REQUIRED_SCOPES = ['public_repo', 'read:user', 'user:email', 'notifications'] as const;

const ATTEMPT_PREFIX = 'personal.oauth.attempt.';

export interface PersonalOAuthAttempt {
  provider: PersonalProvider;
  userId: string;
  redirectUri: string;
  /** Where to send the browser afterwards (a path inside the app). */
  returnTo: string;
  expiresAt: string;
}

type EncryptedSetting = { enc?: string };

async function resolveApp(provider: PersonalProvider): Promise<OAuthAppCredentials> {
  const loaded = await loadOAuthApp(provider);
  if (!loaded) {
    throw new SocialSourceError(
      'NOT_CONFIGURED',
      `One-click ${PERSONAL_OAUTH[provider].label} linking needs the developer app set up once.`,
      provider === 'GITHUB'
        ? 'Open Accounts → "One-time developer apps" (or Social → Accounts) and save the GitHub OAuth App, or use a personal access token instead.'
        : 'Open Social → Accounts → "One-time developer apps" and save the Reddit web app.',
    );
  }
  return loaded.app;
}

export function buildPersonalAuthorizeUrl(input: {
  provider: PersonalProvider;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const spec = PERSONAL_OAUTH[input.provider];
  const url = new URL(spec.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', spec.scopes);
  url.searchParams.set('state', input.state);
  for (const [key, value] of Object.entries(spec.extraAuthorizeParams ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export async function startPersonalOAuth(input: {
  provider: PersonalProvider;
  userId: string;
  returnTo?: string;
}): Promise<{ url: string; state: string; expiresAt: Date }> {
  const app = await resolveApp(input.provider);
  const redirectUri = personalRedirectUri(input.provider);
  const state = randomToken(24);
  const expiresAt = new Date(Date.now() + OAUTH_ATTEMPT_TTL_MS);
  await prisma.appSetting.deleteMany({
    where: { key: { startsWith: ATTEMPT_PREFIX }, updatedAt: { lt: new Date(Date.now() - 2 * OAUTH_ATTEMPT_TTL_MS) } },
  });
  const attempt: PersonalOAuthAttempt = {
    provider: input.provider,
    userId: input.userId,
    redirectUri,
    returnTo: safeReturnTo(input.returnTo),
    expiresAt: expiresAt.toISOString(),
  };
  await setAppSetting(`${ATTEMPT_PREFIX}${state}`, { enc: encryptJson(attempt) });
  return { url: buildPersonalAuthorizeUrl({ provider: input.provider, clientId: app.clientId, redirectUri, state }), state, expiresAt };
}

/** Only in-app paths: a callback must never become an open redirect. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/accounts';
  return value;
}

function validState(state: string | null): state is string {
  return Boolean(state && /^[\w-]{16,128}$/.test(state));
}

/** True when `state` names a personal attempt — lets the shared Reddit callback route it here. */
export async function isPersonalAttempt(state: string | null): Promise<boolean> {
  if (!validState(state)) return false;
  const row = await prisma.appSetting.findUnique({ where: { key: `${ATTEMPT_PREFIX}${state}` }, select: { key: true } });
  return row !== null;
}

export async function consumePersonalAttempt(state: string | null): Promise<PersonalOAuthAttempt | null> {
  if (!validState(state)) return null;
  const key = `${ATTEMPT_PREFIX}${state}`;
  const stored = await getAppSetting<EncryptedSetting | null>(key, null);
  await prisma.appSetting.deleteMany({ where: { key } });
  const attempt = stored?.enc ? tryDecryptJson<PersonalOAuthAttempt>(stored.enc) : null;
  if (!attempt || new Date(attempt.expiresAt).getTime() < Date.now()) return null;
  return attempt;
}

export interface PersonalTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

function tokenFailure(res: HttpResult, label: string, operation: string): SocialSourceError {
  const code = readString(readRecord(res.body)?.error);
  const message = `${label} ${operation} failed (HTTP ${res.status}): ${providerMessage(res)}`;
  if (code === 'invalid_grant' || code === 'bad_verification_code' || res.status === 401) {
    return new SocialSourceError('NEED_LOGIN', message, `Link ${label} again from Accounts.`);
  }
  if (code === 'invalid_client' || code === 'incorrect_client_credentials' || code === 'redirect_uri_mismatch') {
    return new SocialSourceError('NOT_CONFIGURED', message, `Check the ${label} developer app's client id, secret and redirect URI.`);
  }
  if (res.status === 429) return new SocialSourceError('RATE_LIMITED', message, null, 60);
  return new SocialSourceError('UPSTREAM', message);
}

/** Normalise a token response (GitHub answers errors with HTTP 200 and `{ error }`). Exported for tests. */
export function parsePersonalTokens(provider: PersonalProvider, body: unknown, now = new Date()): PersonalTokens {
  const record = readRecord(body);
  const error = readString(record?.error);
  if (error) {
    throw new SocialSourceError(
      error === 'bad_verification_code' ? 'NEED_LOGIN' : 'UPSTREAM',
      `${PERSONAL_OAUTH[provider].label} refused the authorization: ${readString(record?.error_description) || error}.`,
    );
  }
  const accessToken = readString(record?.access_token);
  if (!accessToken) throw new SocialSourceError('UPSTREAM', `${PERSONAL_OAUTH[provider].label} returned no access token.`);
  const expiresIn = readNumber(record?.expires_in, 0);
  return {
    accessToken,
    refreshToken: readString(record?.refresh_token) || null,
    expiresAt: expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000) : null,
    scope: readString(record?.scope) || null,
  };
}

async function personalTokenRequest(provider: PersonalProvider, fields: Record<string, string>, operation: string): Promise<PersonalTokens> {
  const app = await resolveApp(provider);
  const spec = PERSONAL_OAUTH[provider];
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  if (provider === 'REDDIT') {
    headers['user-agent'] = env.socialUserAgent;
    headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret ?? ''}`).toString('base64')}`;
  } else {
    form.set('client_id', app.clientId);
    if (app.clientSecret) form.set('client_secret', app.clientSecret);
  }
  const res = await httpRequest(spec.tokenUrl, { method: 'POST', rawBody: form.toString(), headers });
  if (!res.ok) throw tokenFailure(res, spec.label, operation);
  return parsePersonalTokens(provider, res.body);
}

export function exchangePersonalCode(provider: PersonalProvider, code: string, redirectUri: string): Promise<PersonalTokens> {
  return personalTokenRequest(provider, { grant_type: 'authorization_code', code, redirect_uri: redirectUri }, 'authorization');
}

/** Reddit only: GitHub OAuth App tokens do not expire. */
export function refreshPersonalTokens(provider: PersonalProvider, refreshToken: string): Promise<PersonalTokens> {
  return personalTokenRequest(provider, { grant_type: 'refresh_token', refresh_token: refreshToken }, 'token refresh');
}

/** The credential record stored (encrypted) — the same shape the social module's Reddit publisher reads. */
export function personalCredentials(tokens: PersonalTokens): Record<string, string> {
  return {
    authType: OAUTH_AUTH_TYPE,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt.toISOString() } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
}
