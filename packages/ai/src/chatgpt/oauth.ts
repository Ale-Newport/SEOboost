import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AGENT_NAME_HINT,
  CALLBACK_HOST,
  CALLBACK_PATH,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_RESOURCE,
  CHATGPT_TOKEN_URL,
  DYNAMIC_CLIENT_ID,
  PLAN_USAGE_SCOPE,
  REQUESTED_SCOPES,
} from './constants';
import { ChatGptError, classifyRefreshError } from './errors';

/**
 * The OAuth half of Sign in with ChatGPT: PKCE, the authorize URL, and the two token grants.
 *
 * Kept free of database access so every request it builds can be unit-tested byte for byte —
 * the spec is strict about exact values (loopback host, unchanged path, `resource` on every
 * grant), and a drift in any of them fails only at sign-in time, in front of the user.
 */

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: 32 random bytes as the verifier, its SHA-256 as the challenge, both unpadded. */
export function createPkce(): Pkce {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function randomState(): string {
  return base64Url(randomBytes(24));
}

/** Persistent per-installation identifier the spec requires on every authorize request. */
export function newHostId(): string {
  return `urn:uuid:${randomUUID()}`;
}

/**
 * The loopback redirect URI. Only the port may change between sign-ins; scheme, host
 * (`127.0.0.1`, never `localhost`) and path never do.
 */
export function loopbackRedirectUri(port: number): string {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new ChatGptError({ kind: 'upstream', message: `Invalid callback port ${port}.` });
  }
  return `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;
}

export interface AuthorizeParams {
  /** The issued `oaiapp_…` id on re-authorisation, `dynamic_agent_client` the first time. */
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  hostId: string;
  idTokenHint?: string | null;
  loginHint?: string | null;
}

export function buildAuthorizeUrl(params: AuthorizeParams): string {
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  const firstRegistration = params.clientId === DYNAMIC_CLIENT_ID;
  const query: Array<[string, string]> = [
    ['client_id', params.clientId],
    // Only on the initial dynamic registration; a re-authorisation already has a name.
    ...(firstRegistration ? ([['agent_name_hint', AGENT_NAME_HINT]] as Array<[string, string]>) : []),
    ['ext_agent_host_id', params.hostId],
    ['response_type', 'code'],
    ['redirect_uri', params.redirectUri],
    ['scope', REQUESTED_SCOPES],
    ['resource', CHATGPT_RESOURCE],
    ['state', params.state],
    ['nonce', params.nonce],
    ['code_challenge_method', 'S256'],
    ['code_challenge', params.codeChallenge],
    ...(!firstRegistration && params.idTokenHint ? ([['id_token_hint', params.idTokenHint]] as Array<[string, string]>) : []),
    ...(!firstRegistration && params.loginHint ? ([['login_hint', params.loginHint]] as Array<[string, string]>) : []),
  ];
  for (const [key, value] of query) url.searchParams.set(key, value);
  return url.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  tokenType: string;
  expiresAt: number;
  scopes: string[];
  /** Earliest moment a refresh is allowed, when the server says so. */
  earliestRefreshAt: number | null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Parse a token endpoint body. The spec documents `scope`; some examples show `scopes`. */
export function parseTokenResponse(body: unknown, now = Date.now()): TokenSet {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const accessToken = readString(record.access_token);
  if (!accessToken) {
    throw new ChatGptError({ kind: 'upstream', message: 'ChatGPT returned no access token.' });
  }
  const rawScopes = record.scope ?? record.scopes;
  const scopes = Array.isArray(rawScopes)
    ? rawScopes.filter((scope): scope is string => typeof scope === 'string')
    : typeof rawScopes === 'string'
      ? rawScopes.split(/\s+/).filter(Boolean)
      : [];
  const expiresIn = typeof record.expires_in === 'number' && record.expires_in > 0 ? record.expires_in : 3600;
  const earliest = record.earliest_refresh_at;
  const earliestRefreshAt =
    typeof earliest === 'number' ? (earliest > 10_000_000_000 ? earliest : earliest * 1000)
      : typeof earliest === 'string' && !Number.isNaN(Date.parse(earliest)) ? Date.parse(earliest)
        : null;
  return {
    accessToken,
    refreshToken: readString(record.refresh_token),
    idToken: readString(record.id_token),
    tokenType: readString(record.token_type) ?? 'Bearer',
    expiresAt: now + expiresIn * 1000,
    scopes,
    earliestRefreshAt,
  };
}

export function hasPlanUsage(scopes: readonly string[]): boolean {
  return scopes.includes(PLAN_USAGE_SCOPE);
}

async function postForm(fields: Record<string, string>): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(CHATGPT_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { status: 0, body: { error: 'network_error', error_description: err instanceof Error ? err.message : String(err) } };
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = { error: null, error_description: text.slice(0, 300) };
  }
  return { status: response.status, body };
}

function errorFields(body: unknown): { code: string | null; message: string | null } {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const nested = typeof record.error === 'object' && record.error !== null ? (record.error as Record<string, unknown>) : null;
  return {
    code: readString(nested?.code) ?? readString(record.error),
    message: readString(nested?.message) ?? readString(record.error_description) ?? readString(record.message),
  };
}

/** Authorization-code grant. `clientId` must be the issued id, never the dynamic placeholder. */
export async function exchangeAuthorizationCode(input: {
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenSet> {
  const { status, body } = await postForm({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    resource: CHATGPT_RESOURCE,
  });
  if (status !== 200) {
    const { code, message } = errorFields(body);
    throw new ChatGptError({
      kind: code === 'invalid_grant' ? 'reauth' : 'upstream',
      code,
      status,
      message:
        code === 'invalid_grant'
          ? 'The sign-in code was already used or expired. Start "Sign in with ChatGPT" again.'
          : `ChatGPT token exchange failed (HTTP ${status}${code ? `, ${code}` : ''})${message ? `: ${message}` : ''}.`,
    });
  }
  return parseTokenResponse(body);
}

/** Refresh grant. Omits `scope` so the existing grant is kept, as the spec requires. */
export async function refreshAccessToken(input: { clientId: string; refreshToken: string }): Promise<TokenSet> {
  const { status, body } = await postForm({
    grant_type: 'refresh_token',
    client_id: input.clientId,
    refresh_token: input.refreshToken,
    resource: CHATGPT_RESOURCE,
  });
  if (status !== 200) {
    const { code, message } = errorFields(body);
    throw classifyRefreshError(status, code, message);
  }
  return parseTokenResponse(body);
}
