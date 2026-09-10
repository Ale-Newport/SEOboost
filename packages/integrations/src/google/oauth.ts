/**
 * Google OAuth 2.0 for Search Console + GA4.
 *
 * Design notes:
 * - Refresh tokens are the only thing that keeps a nightly sync alive, so the consent
 *   screen is always requested with `access_type=offline` + `prompt=consent`.
 * - Tokens are stored AES-GCM encrypted (`encryptJson`) in Integration.credentials and are
 *   never handed back to a caller: every public function here returns a `SafeIntegration`.
 * - The OAuth callback is a GET the browser makes, so `state` must be unforgeable. We sign
 *   it with AUTH_SECRET and verify in constant time before touching the database.
 */

import { google } from 'googleapis';
import type { Auth } from 'googleapis';
import { prisma, IntegrationProvider, IntegrationStatus, json, readJson } from '@seo/db';
import type { Integration, Prisma } from '@seo/db';
import { env, isConfigured, IntegrationNotConfiguredError, NotFoundError, ValidationError, ProviderError, createLogger, errorMessage } from '@seo/shared';
import { hashToken, randomToken, constantTimeEquals, encryptJson, tryDecryptJson } from '@seo/shared/crypto';
import { integrationFail, integrationOk } from '../types';
import type { IntegrationFailure, IntegrationResult, OAuth2Credentials } from '../types';

const log = createLogger('integrations:google');

/** Providers in this folder that authenticate with the same Google account grant. */
export type GoogleProvider =
  | typeof IntegrationProvider.GOOGLE_SEARCH_CONSOLE
  | typeof IntegrationProvider.GOOGLE_ANALYTICS_4;

export const GOOGLE_SCOPES = {
  /** Read Search Console performance data. */
  searchConsoleReadonly: 'https://www.googleapis.com/auth/webmasters.readonly',
  /** Read + write: needed for sitemap submission. */
  searchConsole: 'https://www.googleapis.com/auth/webmasters',
  /** GA4 Data API + Admin API reads. */
  analyticsReadonly: 'https://www.googleapis.com/auth/analytics.readonly',
  /** Lets us record *which* Google account was connected, shown in the settings UI. */
  email: 'https://www.googleapis.com/auth/userinfo.email',
  openid: 'openid',
} as const;

export const DEFAULT_GOOGLE_SCOPES: readonly string[] = [
  GOOGLE_SCOPES.openid,
  GOOGLE_SCOPES.email,
  GOOGLE_SCOPES.searchConsoleReadonly,
  GOOGLE_SCOPES.searchConsole,
  GOOGLE_SCOPES.analyticsReadonly,
];

export const GOOGLE_REQUIRED_ENV: readonly string[] = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];

/** Refresh this long before the access token actually expires. */
const REFRESH_MARGIN_MS = 120_000;
/** A signed state is only good for one consent round-trip. */
const STATE_TTL_MS = 15 * 60_000;

// ── Configuration ────────────────────────────────────────────

export function isGoogleOAuthConfigured(): boolean {
  return isConfigured.googleOAuth();
}

interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function requireOAuthConfig(): GoogleOAuthConfig {
  const clientId = env.googleClientId;
  const clientSecret = env.googleClientSecret;
  if (!clientId || !clientSecret) {
    throw new IntegrationNotConfiguredError(
      'google',
      `Google OAuth is not configured. Set ${GOOGLE_REQUIRED_ENV.join(' and ')} in the environment.`,
    );
  }
  return { clientId, clientSecret, redirectUri: env.googleRedirectUri };
}

export function createOAuthClient(): Auth.OAuth2Client {
  const { clientId, clientSecret, redirectUri } = requireOAuthConfig();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ── Non-secret per-integration config ────────────────────────

/** Non-secret settings stored on Integration.config (safe to return to the client). */
export interface GoogleIntegrationConfig {
  /** Search Console property, e.g. `sc-domain:example.com` or `https://example.com/`. */
  siteUrl?: string;
  /** Search Console permission level reported by the API (`siteOwner`, `siteFullUser`, …). */
  permissionLevel?: string;
  /** GA4 property resource name, e.g. `properties/123456789`. */
  propertyId?: string;
  propertyDisplayName?: string;
  /** Timezone reported by GA4; dates in GA4 reports are in this zone, not UTC. */
  timeZone?: string;
  /** Scopes actually granted at the last consent. */
  scopes?: string[];
}

export function readGoogleConfig(value: Prisma.JsonValue | null | undefined): GoogleIntegrationConfig {
  const raw = readJson<Record<string, unknown>>(value, {});
  const out: GoogleIntegrationConfig = {};
  if (typeof raw.siteUrl === 'string') out.siteUrl = raw.siteUrl;
  if (typeof raw.permissionLevel === 'string') out.permissionLevel = raw.permissionLevel;
  if (typeof raw.propertyId === 'string') out.propertyId = raw.propertyId;
  if (typeof raw.propertyDisplayName === 'string') out.propertyDisplayName = raw.propertyDisplayName;
  if (typeof raw.timeZone === 'string') out.timeZone = raw.timeZone;
  if (Array.isArray(raw.scopes)) out.scopes = raw.scopes.filter((s): s is string => typeof s === 'string');
  return out;
}

/** Merge a patch into Integration.config without dropping keys other packages wrote. */
export async function patchGoogleConfig(
  integrationId: string,
  patch: GoogleIntegrationConfig,
): Promise<GoogleIntegrationConfig> {
  const row = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { config: true },
  });
  const existing = readJson<Record<string, unknown>>(row?.config, {});
  const merged = { ...existing, ...patch };
  await prisma.integration.update({ where: { id: integrationId }, data: { config: json(merged) } });
  return readGoogleConfig(merged as Prisma.JsonValue);
}

// ── Safe integration projection ──────────────────────────────

/** An Integration row with the encrypted credential envelope removed. */
export type SafeIntegration = Omit<Integration, 'credentials'>;

export function toSafeIntegration(row: Integration): SafeIntegration {
  const { credentials: _encrypted, ...safe } = row;
  return safe;
}

// ── Signed OAuth state (CSRF) ────────────────────────────────

export interface OAuthStatePayload {
  websiteId: string;
  provider: GoogleProvider;
  /** Random value the caller should also drop in a short-lived cookie to bind the browser. */
  nonce: string;
  issuedAt: number;
  /** Anything the callback needs to round-trip, e.g. `{ redirectTo: '/settings' }`. */
  extra?: Record<string, string>;
}

/**
 * Keyed digest built from the shared hash helper. Nested (hash of a hash that already
 * contains the secret) so a length-extension attack on the outer digest cannot forge a
 * state without knowing AUTH_SECRET.
 */
function signState(body: string): string {
  const inner = hashToken(`${env.authSecret}|google-oauth-state|${body}`);
  return hashToken(`${env.authSecret}|${inner}`);
}

export function signOAuthState(payload: OAuthStatePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${signState(body)}`;
}

/** Throws ValidationError when the state was not issued by us or has expired. */
export function verifyOAuthState(state: string): OAuthStatePayload {
  const parsed = tryVerifyOAuthState(state);
  if (!parsed) throw new ValidationError('Invalid or expired OAuth state');
  return parsed;
}

/** Non-throwing variant for callback routes that prefer to redirect with an error banner. */
export function tryVerifyOAuthState(state: string | null | undefined): OAuthStatePayload | null {
  if (!state) return null;
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  if (!constantTimeEquals(signature, signState(body))) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;

  const candidate = decoded as Partial<OAuthStatePayload>;
  if (typeof candidate.websiteId !== 'string' || typeof candidate.nonce !== 'string') return null;
  if (typeof candidate.issuedAt !== 'number') return null;
  if (Date.now() - candidate.issuedAt > STATE_TTL_MS) return null;
  if (
    candidate.provider !== IntegrationProvider.GOOGLE_SEARCH_CONSOLE &&
    candidate.provider !== IntegrationProvider.GOOGLE_ANALYTICS_4
  ) {
    return null;
  }
  return {
    websiteId: candidate.websiteId,
    provider: candidate.provider,
    nonce: candidate.nonce,
    issuedAt: candidate.issuedAt,
    ...(candidate.extra ? { extra: candidate.extra } : {}),
  };
}

// ── Consent URL ──────────────────────────────────────────────

export interface AuthUrlOptions {
  websiteId: string;
  /** Defaults to DEFAULT_GOOGLE_SCOPES (Search Console read+write, GA4 read, email). */
  scopes?: readonly string[];
  /** Extra data to round-trip through the signed state. */
  state?: Record<string, string>;
  provider?: GoogleProvider;
  loginHint?: string;
}

export interface GoogleAuthUrl {
  url: string;
  /** Signed state embedded in `url`; persist nothing, it verifies itself. */
  state: string;
  /** Store this in a short-lived HttpOnly cookie and compare on callback to bind the browser. */
  nonce: string;
  expiresAt: Date;
}

/**
 * Build the consent URL. `access_type=offline` + `prompt=consent` are both required:
 * Google only returns a refresh token on the first consent unless consent is re-forced,
 * and without one every sync would die an hour after connecting.
 */
export function getAuthUrl(options: AuthUrlOptions): GoogleAuthUrl {
  const client = createOAuthClient();
  const nonce = randomToken(16);
  const payload: OAuthStatePayload = {
    websiteId: options.websiteId,
    provider: options.provider ?? IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
    nonce,
    issuedAt: Date.now(),
    ...(options.state ? { extra: options.state } : {}),
  };
  const state = signOAuthState(payload);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: [...(options.scopes ?? DEFAULT_GOOGLE_SCOPES)],
    state,
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  });
  return { url, state, nonce, expiresAt: new Date(payload.issuedAt + STATE_TTL_MS) };
}

// ── Code exchange ────────────────────────────────────────────

export interface GoogleTokenExchange {
  tokens: Auth.Credentials;
  scopes: string[];
  /** Null when the user declined the email scope — not an error, just unknown. */
  accountEmail: string | null;
}

export async function exchangeCode(code: string): Promise<GoogleTokenExchange> {
  const client = createOAuthClient();
  let tokens: Auth.Credentials;
  try {
    const res = await client.getToken(code);
    tokens = res.tokens;
  } catch (err) {
    throw new ProviderError('google', `authorization code exchange failed: ${googleErrorMessage(err)}`, false);
  }
  client.setCredentials(tokens);

  const scopes = (tokens.scope ?? '').split(' ').filter(Boolean);
  const accountEmail = scopes.includes(GOOGLE_SCOPES.email)
    ? await fetchAccountEmail(client)
    : null;

  if (!tokens.refresh_token) {
    // Not fatal for a one-off read, but the connection will stop working within the hour.
    log.warn('google returned no refresh token; unattended syncs will fail once the access token expires');
  }
  return { tokens, scopes, accountEmail };
}

/** Best effort: the connection is still usable if we cannot name the account. */
async function fetchAccountEmail(client: Auth.OAuth2Client): Promise<string | null> {
  try {
    const api = google.oauth2({ version: 'v2', auth: client });
    const res = await api.userinfo.get();
    return res.data.email ?? null;
  } catch (err) {
    log.debug('could not read Google account email', { error: errorMessage(err) });
    return null;
  }
}

// ── Persistence ──────────────────────────────────────────────

function toStoredCredentials(tokens: Auth.Credentials, previous?: OAuth2Credentials | null): OAuth2Credentials {
  const stored: OAuth2Credentials = { kind: 'oauth2' };
  const accessToken = tokens.access_token ?? previous?.accessToken;
  // Google omits refresh_token on re-consent for an already-authorised app; keeping the
  // previous one is the difference between a working and a dead integration.
  const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
  const expiresAt = tokens.expiry_date ?? previous?.expiresAt;
  const scope = tokens.scope ?? previous?.scope;
  const tokenType = tokens.token_type ?? previous?.tokenType;
  const idToken = tokens.id_token ?? previous?.idToken;
  if (accessToken) stored.accessToken = accessToken;
  if (refreshToken) stored.refreshToken = refreshToken;
  if (typeof expiresAt === 'number') stored.expiresAt = expiresAt;
  if (scope) stored.scope = scope;
  if (tokenType) stored.tokenType = tokenType;
  if (idToken) stored.idToken = idToken;
  return stored;
}

export interface SaveGoogleCredentialsInput {
  websiteId: string;
  provider: GoogleProvider;
  tokens: Auth.Credentials;
  accountEmail?: string | null;
  config?: GoogleIntegrationConfig;
}

/**
 * Encrypt and store an OAuth grant. Returns the row without the credential envelope, so a
 * server action can hand the result straight to the UI.
 */
export async function saveGoogleCredentials(
  input: SaveGoogleCredentialsInput,
): Promise<SafeIntegration> {
  const { websiteId, provider, tokens, accountEmail, config } = input;

  const existing = await prisma.integration.findUnique({
    where: { websiteId_provider: { websiteId, provider } },
  });
  const previous = tryDecryptJson<OAuth2Credentials>(existing?.credentials);
  const stored = toStoredCredentials(tokens, previous);
  const scopes = (stored.scope ?? '').split(' ').filter(Boolean);
  const mergedConfig = {
    ...readJson<Record<string, unknown>>(existing?.config, {}),
    ...(config ?? {}),
    ...(scopes.length ? { scopes } : {}),
  };
  const expiresAt = typeof stored.expiresAt === 'number' ? new Date(stored.expiresAt) : null;

  const row = await prisma.integration.upsert({
    where: { websiteId_provider: { websiteId, provider } },
    create: {
      websiteId,
      provider,
      status: IntegrationStatus.CONNECTED,
      credentials: encryptJson(stored),
      config: json(mergedConfig),
      accountEmail: accountEmail ?? null,
      expiresAt,
      lastError: null,
    },
    update: {
      status: IntegrationStatus.CONNECTED,
      credentials: encryptJson(stored),
      config: json(mergedConfig),
      ...(accountEmail === undefined ? {} : { accountEmail }),
      expiresAt,
      lastError: null,
    },
  });
  log.info('google credentials saved', { websiteId, provider, integrationId: row.id });
  return toSafeIntegration(row);
}

async function persistRefreshedTokens(integrationId: string, credentials: Auth.Credentials): Promise<void> {
  const row = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { credentials: true },
  });
  const previous = tryDecryptJson<OAuth2Credentials>(row?.credentials);
  const stored = toStoredCredentials(credentials, previous);
  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      credentials: encryptJson(stored),
      status: IntegrationStatus.CONNECTED,
      expiresAt: typeof stored.expiresAt === 'number' ? new Date(stored.expiresAt) : null,
      lastError: null,
    },
  });
}

/** Record a provider failure on the row so the settings screen can explain it. */
export async function markIntegrationStatus(
  integrationId: string,
  status: IntegrationStatus,
  message?: string,
): Promise<void> {
  await prisma.integration.update({
    where: { id: integrationId },
    data: { status, lastError: message ?? null },
  });
}

export async function recordSyncOutcome(
  integrationId: string,
  outcome: { status: string; error?: string | null },
): Promise<void> {
  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      lastSyncAt: new Date(),
      lastSyncStatus: outcome.status,
      lastError: outcome.error ?? null,
    },
  });
}

// ── Lookup ───────────────────────────────────────────────────

export async function findGoogleIntegration(
  websiteId: string,
  provider: GoogleProvider,
): Promise<SafeIntegration | null> {
  const row = await prisma.integration.findUnique({
    where: { websiteId_provider: { websiteId, provider } },
  });
  return row ? toSafeIntegration(row) : null;
}

/** True when the row exists, has credentials and is not disabled. */
export async function isGoogleConnected(websiteId: string, provider: GoogleProvider): Promise<boolean> {
  const row = await prisma.integration.findUnique({
    where: { websiteId_provider: { websiteId, provider } },
    select: { credentials: true, status: true },
  });
  return Boolean(row?.credentials) && row?.status !== IntegrationStatus.DISABLED;
}

// ── Authorized client ────────────────────────────────────────

export interface AuthorizedGoogleClient {
  client: Auth.OAuth2Client;
  integration: SafeIntegration;
  config: GoogleIntegrationConfig;
}

/**
 * Load an integration, decrypt its tokens and return a ready-to-use OAuth2 client.
 * Refreshes (and re-encrypts + persists) the access token when it is expired or about to
 * be; also listens for refreshes googleapis performs mid-request so those are stored too.
 */
export async function getAuthorizedClient(integrationId: string): Promise<AuthorizedGoogleClient> {
  const row = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new NotFoundError('Integration');
  if (row.status === IntegrationStatus.DISABLED) {
    throw new IntegrationNotConfiguredError('google', 'This Google connection is disabled. Re-enable it in settings.');
  }

  const creds = tryDecryptJson<OAuth2Credentials>(row.credentials);
  if (!creds || (!creds.accessToken && !creds.refreshToken)) {
    await markIntegrationStatus(
      integrationId,
      IntegrationStatus.ERROR,
      'Stored Google credentials are missing or could not be decrypted. Reconnect the account.',
    );
    throw new IntegrationNotConfiguredError(
      'google',
      'Google credentials are missing or unreadable (ENCRYPTION_KEY may have changed). Reconnect the account.',
    );
  }

  const client = createOAuthClient();
  client.setCredentials({
    access_token: creds.accessToken ?? null,
    refresh_token: creds.refreshToken ?? null,
    expiry_date: creds.expiresAt ?? null,
    scope: creds.scope,
    token_type: creds.tokenType ?? null,
  });

  // googleapis refreshes transparently on 401; capture those tokens or we would re-refresh
  // on every job run and eventually hit the 50-refresh-token-per-user cap.
  client.on('tokens', (tokens) => {
    void persistRefreshedTokens(integrationId, tokens).catch((err: unknown) => {
      log.warn('failed to persist refreshed Google tokens', { integrationId, error: errorMessage(err) });
    });
  });

  const expiringSoon = !creds.expiresAt || creds.expiresAt - Date.now() < REFRESH_MARGIN_MS;
  if (expiringSoon) {
    if (!creds.refreshToken) {
      await markIntegrationStatus(
        integrationId,
        IntegrationStatus.EXPIRED,
        'The Google access token expired and no refresh token is stored. Reconnect the account.',
      );
      throw new IntegrationNotConfiguredError(
        'google',
        'The Google connection expired and cannot refresh itself. Reconnect the account.',
      );
    }
    try {
      await client.getAccessToken(); // refreshes in place when needed
      await persistRefreshedTokens(integrationId, client.credentials);
    } catch (err) {
      const message = googleErrorMessage(err);
      await markIntegrationStatus(
        integrationId,
        IntegrationStatus.EXPIRED,
        `Google refused to refresh the token: ${message}`,
      );
      throw new IntegrationNotConfiguredError(
        'google',
        `The Google connection is no longer valid (${message}). Reconnect the account.`,
      );
    }
  }

  return { client, integration: toSafeIntegration(row), config: readGoogleConfig(row.config) };
}

// ── Revocation ───────────────────────────────────────────────

/**
 * Revoke the grant at Google and forget the tokens locally. Local state is always cleared,
 * even when Google rejects the revocation (already revoked, network down) — otherwise a
 * user could never disconnect a broken integration.
 */
export async function revokeGoogle(integrationId: string): Promise<IntegrationResult<{ revokedAtGoogle: boolean }>> {
  const row = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!row) throw new NotFoundError('Integration');

  const creds = tryDecryptJson<OAuth2Credentials>(row.credentials);
  const token = creds?.refreshToken ?? creds?.accessToken;
  let revokedAtGoogle = false;
  let failure: string | null = null;

  if (token && isGoogleOAuthConfigured()) {
    try {
      await createOAuthClient().revokeToken(token);
      revokedAtGoogle = true;
    } catch (err) {
      failure = googleErrorMessage(err);
      log.warn('google token revocation failed; clearing local credentials anyway', {
        integrationId,
        error: failure,
      });
    }
  }

  await prisma.integration.update({
    where: { id: integrationId },
    data: {
      credentials: null,
      status: IntegrationStatus.NOT_CONFIGURED,
      expiresAt: null,
      accountEmail: null,
      lastError: failure ? `Local credentials cleared; Google revocation failed: ${failure}` : null,
    },
  });

  return integrationOk({ revokedAtGoogle });
}

// ── Error helpers (shared with search-console.ts / analytics.ts) ──

interface HttpErrorShape {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  errors?: unknown;
  response?: { status?: unknown; data?: unknown };
}

/** Pull the HTTP status out of a gaxios/googleapis error without resorting to `any`. */
export function httpStatusOf(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as HttpErrorShape;
  const responseStatus = e.response?.status;
  if (typeof responseStatus === 'number') return responseStatus;
  if (typeof e.status === 'number') return e.status;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.code === 'string' && /^\d{3}$/.test(e.code)) return Number(e.code);
  return null;
}

/** Google nests the useful message in response.data.error.message; fall back to Error.message. */
export function googleErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const data = (err as HttpErrorShape).response?.data;
    if (typeof data === 'object' && data !== null) {
      const inner = (data as { error?: unknown }).error;
      if (typeof inner === 'string') return inner;
      if (typeof inner === 'object' && inner !== null) {
        const message = (inner as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      }
    }
  }
  return errorMessage(err);
}

/** 429 and 5xx are worth another attempt; 4xx will fail identically forever. */
export function isRetryableGoogleError(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status === null) return true; // network-level failure
  return status === 429 || status >= 500;
}

/**
 * Translate a provider failure into a typed result and flag the integration so the settings
 * screen can tell the operator what to fix.
 */
export async function classifyGoogleFailure(
  integrationId: string | null,
  err: unknown,
  context: string,
): Promise<IntegrationFailure> {
  const status = httpStatusOf(err);
  const message = googleErrorMessage(err);

  if (status === 401) {
    if (integrationId) {
      await markIntegrationStatus(
        integrationId,
        IntegrationStatus.EXPIRED,
        `${context}: Google rejected the credentials (${message}). Reconnect the account.`,
      );
    }
    return integrationFail('CREDENTIALS_EXPIRED', `${context}: ${message}`, false);
  }
  if (status === 403) {
    if (integrationId) {
      await markIntegrationStatus(
        integrationId,
        IntegrationStatus.ERROR,
        `${context}: the connected Google account is not permitted (${message}).`,
      );
    }
    return integrationFail('PERMISSION_DENIED', `${context}: ${message}`, false);
  }
  if (status === 404) return integrationFail('NOT_FOUND', `${context}: ${message}`, false);
  if (status === 429) return integrationFail('RATE_LIMITED', `${context}: ${message}`, true);
  if (status !== null && status >= 400 && status < 500) {
    return integrationFail('INVALID_REQUEST', `${context}: ${message}`, false);
  }
  return integrationFail('PROVIDER_ERROR', `${context}: ${message}`, true);
}
