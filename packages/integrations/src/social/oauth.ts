import { createHash } from 'node:crypto';
import { getAppSetting, prisma, setAppSetting } from '@seo/db';
import { env } from '@seo/shared';
import { encryptJson, randomToken, tryDecryptJson } from '@seo/shared/crypto';
import { httpRequest, providerMessage, type HttpResult } from '../adapters/http';
import { readNumber, readRecord, readString } from '../serp/http';
import { SocialSourceError, type SocialPlatformValue } from './types';

/**
 * One-click account connection.
 *
 * For every platform with a real OAuth flow the operator connects an account by approving it on
 * the platform's own page — no secret is copied by hand, nothing is typed into this app, and no
 * login is ever automated. Four platforms (Reddit, X, LinkedIn, Discord) need a developer app
 * registered once per installation; Mastodon registers itself on each instance.
 *
 * Connected credentials carry `authType: 'oauth2'` so publishers and the refresh logic can tell
 * an OAuth token from a hand-pasted key without guessing from field names.
 */

export type OAuthPlatform = 'REDDIT' | 'X' | 'LINKEDIN' | 'MASTODON' | 'DISCORD';
/**
 * Platforms whose one-click connection needs a developer app registered once per installation.
 * GitHub is here for the operator's personal account (Accounts → GitHub), not as a social channel.
 */
export type DeveloperAppPlatform = Exclude<OAuthPlatform, 'MASTODON'> | 'GITHUB';

export const OAUTH_PLATFORMS: readonly OAuthPlatform[] = ['REDDIT', 'X', 'LINKEDIN', 'MASTODON', 'DISCORD'];
export const DEVELOPER_APP_PLATFORMS: readonly DeveloperAppPlatform[] = ['REDDIT', 'X', 'LINKEDIN', 'DISCORD', 'GITHUB'];

export const DEVELOPER_APP_LABELS: Record<DeveloperAppPlatform, string> = {
  REDDIT: 'Reddit',
  X: 'X',
  LINKEDIN: 'LinkedIn',
  DISCORD: 'Discord',
  GITHUB: 'GitHub',
};

export function isOAuthPlatform(platform: SocialPlatformValue): platform is OAuthPlatform {
  return (OAUTH_PLATFORMS as readonly string[]).includes(platform);
}

export function isDeveloperAppPlatform(platform: SocialPlatformValue): platform is DeveloperAppPlatform {
  return (DEVELOPER_APP_PLATFORMS as readonly string[]).includes(platform);
}

/** Marker stored with OAuth credentials. */
export const OAUTH_AUTH_TYPE = 'oauth2';

/** Refresh this long before expiry, so a publish never starts with a token that dies mid-call. */
export const REFRESH_SKEW_MS = 5 * 60_000;

/** An authorization attempt lives this long; the operator has ten minutes to approve. */
export const OAUTH_ATTEMPT_TTL_MS = 10 * 60_000;

const MASTODON_SCOPES = 'read write:statuses';

interface ProviderSpec {
  label: string;
  scopes: string;
  pkce: boolean;
  /** `basic`: client id/secret in an Authorization header. `body`: in the form. */
  clientAuth: 'basic' | 'body';
  authorizeUrl(instanceUrl: string | null): string;
  tokenUrl(instanceUrl: string | null): string;
  extraAuthorizeParams?: Record<string, string>;
}

export const OAUTH_PROVIDERS: Record<OAuthPlatform, ProviderSpec> = {
  REDDIT: {
    label: 'Reddit',
    scopes: 'identity read submit edit history',
    pkce: false,
    clientAuth: 'basic',
    authorizeUrl: () => 'https://www.reddit.com/api/v1/authorize',
    tokenUrl: () => 'https://www.reddit.com/api/v1/access_token',
    // Without `permanent` Reddit issues no refresh token and the connection dies within a day.
    extraAuthorizeParams: { duration: 'permanent' },
  },
  X: {
    label: 'X',
    scopes: 'tweet.read tweet.write users.read offline.access',
    pkce: true,
    clientAuth: 'basic',
    authorizeUrl: () => 'https://x.com/i/oauth2/authorize',
    tokenUrl: () => 'https://api.x.com/2/oauth2/token',
  },
  LINKEDIN: {
    label: 'LinkedIn',
    scopes: 'openid profile w_member_social',
    pkce: false,
    clientAuth: 'body',
    authorizeUrl: () => 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: () => 'https://www.linkedin.com/oauth/v2/accessToken',
  },
  MASTODON: {
    label: 'Mastodon',
    scopes: MASTODON_SCOPES,
    pkce: true,
    clientAuth: 'body',
    authorizeUrl: (instanceUrl) => `${requireInstance(instanceUrl)}/oauth/authorize`,
    tokenUrl: (instanceUrl) => `${requireInstance(instanceUrl)}/oauth/token`,
  },
  DISCORD: {
    label: 'Discord',
    scopes: 'webhook.incoming',
    pkce: false,
    clientAuth: 'basic',
    authorizeUrl: () => 'https://discord.com/oauth2/authorize',
    tokenUrl: () => 'https://discord.com/api/oauth2/token',
  },
};

/** Where to create each developer app, and exactly what to pick there. Rendered in the UI. */
export const DEVELOPER_APP_GUIDES: Record<DeveloperAppPlatform, { createUrl: string; steps: string[] }> = {
  REDDIT: {
    createUrl: 'https://www.reddit.com/prefs/apps',
    steps: [
      'Click "create another app…" (any Reddit account works; it does not have to be one you post with).',
      'Name it "SEO OS", choose the type "web app", and paste the redirect URI below.',
      'Copy the id shown under the app name and the "secret".',
    ],
  },
  X: {
    createUrl: 'https://developer.x.com/en/portal/projects-and-apps',
    steps: [
      'Open your app → "User authentication settings" → Set up.',
      'App permissions: "Read and write". Type of App: "Web App, Automated App or Bot".',
      'Paste the redirect URI below as the Callback URI, add your site as the Website URL, save, then copy the OAuth 2.0 Client ID and Client Secret.',
    ],
  },
  LINKEDIN: {
    createUrl: 'https://www.linkedin.com/developers/apps/new',
    steps: [
      'Create the app (it needs a LinkedIn company page to associate with).',
      'Products tab: request "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" (both are self-serve).',
      'Auth tab: add the redirect URI below, then copy the Client ID and Primary Client Secret.',
    ],
  },
  GITHUB: {
    createUrl: 'https://github.com/settings/applications/new',
    steps: [
      'Register a new OAuth App: name it "SEO OS" and use this installation\'s address as the Homepage URL.',
      'Paste the redirect URI below as the "Authorization callback URL" and register the app.',
      'Copy the Client ID, then "Generate a new client secret" and copy it.',
    ],
  },
  DISCORD: {
    createUrl: 'https://discord.com/developers/applications',
    steps: [
      'Click "New Application" and name it "SEO OS".',
      'OAuth2 page: add the redirect URI below under Redirects and save.',
      'Copy the Client ID and reset/copy the Client Secret from the same page.',
    ],
  },
};

function requireInstance(instanceUrl: string | null): string {
  if (!instanceUrl) throw new SocialSourceError('BAD_INPUT', 'Mastodon needs the instance (for example mastodon.social).');
  return instanceUrl;
}

/** `mastodon.social`, `@me@mastodon.social` or a full URL → `https://mastodon.social`. */
export function normaliseInstanceUrl(value: string | null | undefined): string {
  const raw = (value ?? '').trim().replace(/^@?[^@\s]+@/, '') || 'mastodon.social';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new SocialSourceError('BAD_INPUT', `"${value}" is not a Mastodon instance address.`);
  }
  if (url.protocol !== 'https:' || !url.hostname.includes('.')) {
    throw new SocialSourceError('BAD_INPUT', `"${value}" is not a Mastodon instance address.`);
  }
  return `https://${url.hostname.toLowerCase()}`;
}

/** The redirect URI registered with each platform: one per platform, the same for every site. */
export function oauthRedirectUri(platform: OAuthPlatform, appUrl: string = env.appUrl): string {
  return `${appUrl.replace(/\/$/, '')}/api/social/oauth/${platform.toLowerCase()}/callback`;
}

/**
 * The redirect URI to register for a developer app. Reddit web apps accept exactly one, so the
 * personal Reddit link reuses the social callback (which hands personal attempts on); GitHub's
 * personal link has its own.
 */
export function developerAppRedirectUri(platform: DeveloperAppPlatform, appUrl: string = env.appUrl): string {
  if (platform === 'GITHUB') return `${appUrl.replace(/\/$/, '')}/api/accounts/github/callback`;
  return oauthRedirectUri(platform, appUrl);
}

// ─────────────────────────────────────────────────────────────
// PKCE
// ─────────────────────────────────────────────────────────────

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** A fresh verifier (43+ unreserved characters, RFC 7636) and its S256 challenge. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: pkceChallenge(verifier) };
}

// ─────────────────────────────────────────────────────────────
// Developer apps (installation-level)
// ─────────────────────────────────────────────────────────────

export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string | null;
}

export const OAUTH_APPS_SETTING = 'social.oauthApps';
const MASTODON_APPS_SETTING = 'social.mastodonApps';
const ATTEMPT_PREFIX = 'social.oauth.attempt.';

type EncryptedSetting = { enc?: string };

async function readEncryptedSetting<T>(key: string): Promise<T | null> {
  const stored = await getAppSetting<EncryptedSetting | null>(key, null);
  return stored?.enc ? tryDecryptJson<T>(stored.enc) : null;
}

async function writeEncryptedSetting(key: string, value: unknown): Promise<void> {
  await setAppSetting(key, { enc: encryptJson(value) });
}

function envApp(platform: DeveloperAppPlatform): OAuthAppCredentials | null {
  const pairs: Record<DeveloperAppPlatform, [string | undefined, string | undefined]> = {
    REDDIT: [env.redditClientId, env.redditClientSecret],
    X: [env.xClientId, env.xClientSecret],
    LINKEDIN: [env.linkedinClientId, env.linkedinClientSecret],
    DISCORD: [env.discordClientId, env.discordClientSecret],
    GITHUB: [env.githubClientId, env.githubClientSecret],
  };
  const [clientId, clientSecret] = pairs[platform];
  return clientId ? { clientId, clientSecret: clientSecret ?? null } : null;
}

export interface DeveloperAppStatus {
  platform: DeveloperAppPlatform;
  configured: boolean;
  source: 'settings' | 'env' | null;
  /** First characters of the client id, so the operator can recognise which app is stored. */
  clientIdPreview: string | null;
  hasSecret: boolean;
}

/** Saved apps win over environment variables: the UI is where the operator expects to edit them. */
export async function loadOAuthApp(platform: DeveloperAppPlatform): Promise<{ app: OAuthAppCredentials; source: 'settings' | 'env' } | null> {
  const stored = await readEncryptedSetting<Partial<Record<DeveloperAppPlatform, OAuthAppCredentials>>>(OAUTH_APPS_SETTING);
  const saved = stored?.[platform];
  if (saved?.clientId) return { app: saved, source: 'settings' };
  const fromEnv = envApp(platform);
  return fromEnv ? { app: fromEnv, source: 'env' } : null;
}

export async function developerAppStatuses(): Promise<DeveloperAppStatus[]> {
  return Promise.all(
    DEVELOPER_APP_PLATFORMS.map(async (platform) => {
      const loaded = await loadOAuthApp(platform);
      return {
        platform,
        configured: Boolean(loaded),
        source: loaded?.source ?? null,
        clientIdPreview: loaded ? `${loaded.app.clientId.slice(0, 4)}…` : null,
        hasSecret: Boolean(loaded?.app.clientSecret),
      };
    }),
  );
}

/**
 * Save (or clear, with `null`) a developer app. A blank secret keeps the stored one, so changing
 * the client id does not force the operator to paste the secret again.
 */
export async function saveOAuthApp(platform: DeveloperAppPlatform, app: { clientId: string; clientSecret?: string | null } | null): Promise<void> {
  const stored = (await readEncryptedSetting<Partial<Record<DeveloperAppPlatform, OAuthAppCredentials>>>(OAUTH_APPS_SETTING)) ?? {};
  if (app === null) {
    delete stored[platform];
  } else {
    const clientId = app.clientId.trim();
    if (!clientId) throw new SocialSourceError('BAD_INPUT', 'The client id is required.');
    const secret = app.clientSecret?.trim() || stored[platform]?.clientSecret || null;
    // X can run as a public PKCE client; every other provider authenticates the app with a secret.
    if (!secret && platform !== 'X') throw new SocialSourceError('BAD_INPUT', `${DEVELOPER_APP_LABELS[platform]} needs the client secret too.`);
    stored[platform] = { clientId, clientSecret: secret };
  }
  await writeEncryptedSetting(OAUTH_APPS_SETTING, stored);
}

/**
 * The client for one Mastodon instance, registered on first use via the public
 * `POST /api/v1/apps` and cached (encrypted). Re-registered when the redirect URI changes, which
 * happens when the installation moves to another address.
 */
export async function mastodonAppFor(instanceUrl: string, redirectUri: string): Promise<OAuthAppCredentials> {
  const host = new URL(instanceUrl).hostname;
  const cache = (await readEncryptedSetting<Record<string, OAuthAppCredentials & { redirectUri: string }>>(MASTODON_APPS_SETTING)) ?? {};
  const cached = cache[host];
  if (cached && cached.redirectUri === redirectUri) return { clientId: cached.clientId, clientSecret: cached.clientSecret };

  const res = await httpRequest(`${instanceUrl}/api/v1/apps`, {
    method: 'POST',
    body: { client_name: 'SEO OS', redirect_uris: redirectUri, scopes: MASTODON_SCOPES, website: env.appUrl },
  });
  const body = readRecord(res.body);
  const clientId = readString(body?.client_id);
  const clientSecret = readString(body?.client_secret);
  if (!res.ok || !clientId || !clientSecret) throw tokenError(res, 'Mastodon', 'app registration');
  cache[host] = { clientId, clientSecret, redirectUri };
  await writeEncryptedSetting(MASTODON_APPS_SETTING, cache);
  return { clientId, clientSecret };
}

/** The app to use for a platform, or a NOT_CONFIGURED error that says where to set it up. */
export async function resolveOAuthApp(platform: OAuthPlatform, instanceUrl: string | null): Promise<OAuthAppCredentials> {
  if (platform === 'MASTODON') return mastodonAppFor(requireInstance(instanceUrl), oauthRedirectUri('MASTODON'));
  const loaded = await loadOAuthApp(platform);
  if (!loaded) {
    throw new SocialSourceError(
      'NOT_CONFIGURED',
      `One-click ${OAUTH_PROVIDERS[platform].label} connection needs the developer app set up once.`,
      'Open Social → Accounts → "One-time developer apps", follow the three steps and save the client id and secret.',
    );
  }
  return loaded.app;
}

// ─────────────────────────────────────────────────────────────
// Authorization
// ─────────────────────────────────────────────────────────────

export interface AuthorizeInput {
  platform: OAuthPlatform;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string | null;
  instanceUrl?: string | null;
}

export function buildAuthorizeUrl(input: AuthorizeInput): string {
  const spec = OAUTH_PROVIDERS[input.platform];
  const url = new URL(spec.authorizeUrl(input.instanceUrl ?? null));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', spec.scopes);
  url.searchParams.set('state', input.state);
  if (spec.pkce && input.codeChallenge) {
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(spec.extraAuthorizeParams ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

export interface OAuthAttempt {
  platform: OAuthPlatform;
  websiteId: string;
  userId: string;
  verifier: string | null;
  instanceUrl: string | null;
  redirectUri: string;
  expiresAt: string;
}

/**
 * Start an attempt: the state, the PKCE verifier and who started it are kept server-side
 * (encrypted, single use, ten minutes), so nothing secret rides in the URL.
 */
export async function startOAuthAttempt(input: {
  platform: OAuthPlatform;
  websiteId: string;
  userId: string;
  instanceUrl?: string | null;
}): Promise<{ url: string; state: string; expiresAt: Date }> {
  const instanceUrl = input.platform === 'MASTODON' ? normaliseInstanceUrl(input.instanceUrl) : null;
  const app = await resolveOAuthApp(input.platform, instanceUrl);
  const redirectUri = oauthRedirectUri(input.platform);
  const state = randomToken(24);
  const pkce = OAUTH_PROVIDERS[input.platform].pkce ? createPkce() : null;
  const expiresAt = new Date(Date.now() + OAUTH_ATTEMPT_TTL_MS);

  // Opportunistic cleanup: abandoned attempts must not accumulate.
  await prisma.appSetting.deleteMany({
    where: { key: { startsWith: ATTEMPT_PREFIX }, updatedAt: { lt: new Date(Date.now() - 2 * OAUTH_ATTEMPT_TTL_MS) } },
  });
  const attempt: OAuthAttempt = {
    platform: input.platform,
    websiteId: input.websiteId,
    userId: input.userId,
    verifier: pkce?.verifier ?? null,
    instanceUrl,
    redirectUri,
    expiresAt: expiresAt.toISOString(),
  };
  await writeEncryptedSetting(`${ATTEMPT_PREFIX}${state}`, attempt);
  return {
    url: buildAuthorizeUrl({
      platform: input.platform,
      clientId: app.clientId,
      redirectUri,
      state,
      codeChallenge: pkce?.challenge ?? null,
      instanceUrl,
    }),
    state,
    expiresAt,
  };
}

/** Load and delete an attempt. Null when unknown, already used or expired. */
export async function consumeOAuthAttempt(state: string | null): Promise<OAuthAttempt | null> {
  if (!state || !/^[\w-]{16,128}$/.test(state)) return null;
  const key = `${ATTEMPT_PREFIX}${state}`;
  const attempt = await readEncryptedSetting<OAuthAttempt>(key);
  await prisma.appSetting.deleteMany({ where: { key } });
  if (!attempt || new Date(attempt.expiresAt).getTime() < Date.now()) return null;
  return attempt;
}

// ─────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  /** Discord `webhook.incoming`: the webhook the operator picked on Discord's page. */
  webhook: { url: string; name: string | null; channelId: string | null } | null;
}

function tokenError(res: HttpResult, label: string, operation: string): SocialSourceError {
  const body = readRecord(res.body);
  const code = readString(body?.error);
  const message = `${label} ${operation} failed (HTTP ${res.status}): ${providerMessage(res)}`;
  // A refused grant is final: the operator revoked access or the refresh token is dead.
  if (code === 'invalid_grant' || code === 'invalid_token' || res.status === 401) {
    return new SocialSourceError('NEED_LOGIN', message, `Reconnect ${label} from Social → Accounts.`);
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return new SocialSourceError('NOT_CONFIGURED', message, `Check the ${label} developer app's client id, secret and redirect URI.`);
  }
  if (res.status === 429) return new SocialSourceError('RATE_LIMITED', message, null, 60);
  if (res.status === 400) return new SocialSourceError('BAD_INPUT', message);
  return new SocialSourceError('UPSTREAM', message);
}

/** Normalise a token response. Exported for tests. */
export function parseTokenResponse(platform: OAuthPlatform, body: unknown, now = new Date()): OAuthTokens {
  const record = readRecord(body);
  const accessToken = readString(record?.access_token);
  if (!accessToken) throw new SocialSourceError('UPSTREAM', `${OAUTH_PROVIDERS[platform].label} returned no access token.`);
  const expiresIn = readNumber(record?.expires_in, 0);
  const webhook = readRecord(record?.webhook);
  const webhookUrl = readString(webhook?.url);
  return {
    accessToken,
    refreshToken: readString(record?.refresh_token) || null,
    expiresAt: expiresIn > 0 ? new Date(now.getTime() + expiresIn * 1000) : null,
    scope: readString(record?.scope) || null,
    webhook: webhookUrl
      ? { url: webhookUrl, name: readString(webhook?.name) || null, channelId: readString(webhook?.channel_id) || null }
      : null,
  };
}

async function tokenRequest(
  platform: OAuthPlatform,
  app: OAuthAppCredentials,
  instanceUrl: string | null,
  fields: Record<string, string>,
  operation: string,
): Promise<OAuthTokens> {
  const spec = OAUTH_PROVIDERS[platform];
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (platform === 'REDDIT') headers['user-agent'] = env.socialUserAgent;
  if (spec.clientAuth === 'basic' && app.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`;
  } else {
    form.set('client_id', app.clientId);
    if (app.clientSecret) form.set('client_secret', app.clientSecret);
  }
  const res = await httpRequest(spec.tokenUrl(instanceUrl), { method: 'POST', rawBody: form.toString(), headers });
  // Reddit answers some failures with HTTP 200 and `{ error: … }`.
  if (!res.ok || readString(readRecord(res.body)?.error)) throw tokenError(res, spec.label, operation);
  return parseTokenResponse(platform, res.body);
}

export async function exchangeOAuthCode(input: {
  platform: OAuthPlatform;
  code: string;
  attempt: Pick<OAuthAttempt, 'verifier' | 'instanceUrl' | 'redirectUri'>;
}): Promise<OAuthTokens> {
  const app = await resolveOAuthApp(input.platform, input.attempt.instanceUrl);
  return tokenRequest(
    input.platform,
    app,
    input.attempt.instanceUrl,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.attempt.redirectUri,
      ...(input.attempt.verifier ? { code_verifier: input.attempt.verifier } : {}),
    },
    'authorization',
  );
}

/**
 * Exchange a refresh token. Providers that do not rotate (Reddit) return no new refresh token;
 * the old one is kept by the caller in that case.
 */
export async function refreshOAuthTokens(input: {
  platform: OAuthPlatform;
  refreshToken: string;
  instanceUrl?: string | null;
}): Promise<OAuthTokens> {
  const app = await resolveOAuthApp(input.platform, input.instanceUrl ?? null);
  return tokenRequest(
    input.platform,
    app,
    input.instanceUrl ?? null,
    { grant_type: 'refresh_token', refresh_token: input.refreshToken },
    'token refresh',
  );
}

// ─────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────

export interface OAuthIdentity {
  handle: string;
  displayName: string | null;
  /** Non-secret settings to store with the account (author URN, instance URL…). */
  config: Record<string, string>;
}

export async function fetchOAuthIdentity(platform: OAuthPlatform, tokens: OAuthTokens, instanceUrl: string | null): Promise<OAuthIdentity> {
  const bearer = { authorization: `Bearer ${tokens.accessToken}` };
  const get = async (url: string, extra: Record<string, string> = {}) => {
    const res = await httpRequest(url, { headers: { ...bearer, ...extra } });
    if (!res.ok) throw tokenError(res, OAUTH_PROVIDERS[platform].label, 'identity check');
    return readRecord(res.body);
  };

  switch (platform) {
    case 'REDDIT': {
      const me = await get('https://oauth.reddit.com/api/v1/me', { 'user-agent': env.socialUserAgent });
      const name = readString(me?.name);
      if (!name) throw new SocialSourceError('UPSTREAM', 'Reddit returned no account name.');
      return { handle: `u/${name}`, displayName: name, config: {} };
    }
    case 'X': {
      const data = readRecord((await get('https://api.x.com/2/users/me'))?.data);
      const username = readString(data?.username);
      if (!username) throw new SocialSourceError('UPSTREAM', 'X returned no username.');
      return { handle: `@${username}`, displayName: readString(data?.name) || username, config: {} };
    }
    case 'LINKEDIN': {
      const info = await get('https://api.linkedin.com/v2/userinfo');
      const sub = readString(info?.sub);
      if (!sub) throw new SocialSourceError('UPSTREAM', 'LinkedIn returned no member id.');
      const name = readString(info?.name) || null;
      return { handle: name ?? `urn:li:person:${sub}`, displayName: name, config: { authorUrn: `urn:li:person:${sub}` } };
    }
    case 'MASTODON': {
      const base = requireInstance(instanceUrl);
      const account = await get(`${base}/api/v1/accounts/verify_credentials`);
      const acct = readString(account?.acct);
      if (!acct) throw new SocialSourceError('UPSTREAM', 'Mastodon returned no account.');
      return {
        handle: `@${acct}@${new URL(base).hostname}`,
        displayName: readString(account?.display_name) || acct,
        config: { instanceUrl: base },
      };
    }
    case 'DISCORD': {
      if (!tokens.webhook) throw new SocialSourceError('UPSTREAM', 'Discord did not return the webhook you picked. Try again and choose a channel.');
      const name = tokens.webhook.name ?? 'SEO OS';
      return { handle: `#${tokens.webhook.channelId ?? 'channel'} (${name})`, displayName: name, config: {} };
    }
  }
}

/** The credential record stored (encrypted) for a freshly connected account. */
export function credentialsFromTokens(platform: OAuthPlatform, tokens: OAuthTokens): Record<string, string> {
  // A Discord webhook URL never expires and needs no token at all once issued.
  if (platform === 'DISCORD') {
    if (!tokens.webhook) throw new SocialSourceError('UPSTREAM', 'Discord did not return a webhook.');
    return { authType: OAUTH_AUTH_TYPE, webhookUrl: tokens.webhook.url };
  }
  return {
    authType: OAUTH_AUTH_TYPE,
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt.toISOString() } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
}

/** Merge a refresh result onto stored credentials, keeping a refresh token the provider did not rotate. */
export function mergeRefreshedCredentials(previous: Record<string, string>, tokens: OAuthTokens): Record<string, string> {
  const next: Record<string, string> = { ...previous, authType: OAUTH_AUTH_TYPE, accessToken: tokens.accessToken };
  if (tokens.refreshToken) next.refreshToken = tokens.refreshToken;
  if (tokens.expiresAt) next.expiresAt = tokens.expiresAt.toISOString();
  else delete next.expiresAt;
  if (tokens.scope) next.scope = tokens.scope;
  return next;
}

export type TokenState =
  | { kind: 'not-oauth' }
  | { kind: 'valid'; expiresAt: Date | null }
  | { kind: 'refresh'; expiresAt: Date }
  | { kind: 'expired'; expiresAt: Date };

/**
 * What to do with stored credentials right now: use them, refresh them, or give up.
 * A token without an expiry (Mastodon, Discord webhooks) is valid until it is revoked.
 */
export function tokenState(credentials: Record<string, string>, now = new Date()): TokenState {
  if (credentials.authType !== OAUTH_AUTH_TYPE) return { kind: 'not-oauth' };
  const expiresAt = credentials.expiresAt ? new Date(credentials.expiresAt) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) return { kind: 'valid', expiresAt: null };
  if (expiresAt.getTime() - now.getTime() > REFRESH_SKEW_MS) return { kind: 'valid', expiresAt };
  if (credentials.refreshToken) return { kind: 'refresh', expiresAt };
  return expiresAt.getTime() > now.getTime() ? { kind: 'valid', expiresAt } : { kind: 'expired', expiresAt };
}
