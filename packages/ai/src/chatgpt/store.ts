import { type Prisma, prisma } from '@seo/db';
import { createLogger, errorMessage, truncate } from '@seo/shared';
import { encryptJson, tryDecryptJson } from '@seo/shared/crypto';
import {
  ATTEMPT_TTL_MS,
  DYNAMIC_CLIENT_ID,
  REFRESH_LOCK_KEY,
  REFRESH_MARGIN_MS,
  SETTING_ATTEMPTS,
  SETTING_CONNECTION,
  SETTING_HOST_ID,
  STATE_TTL_MS,
} from './constants';
import { ChatGptError } from './errors';
import { fetchChatGptModels, type ChatGptModel } from './models';
import {
  buildAuthorizeUrl,
  createPkce,
  exchangeAuthorizationCode,
  hasPlanUsage,
  newHostId,
  randomState,
  refreshAccessToken,
  type TokenSet,
} from './oauth';

/**
 * The installation's ChatGPT connection: persistence, the in-memory view, and token refresh.
 *
 * Credentials live in one encrypted `AppSetting` row, like every other secret in this app, and
 * never leave the server. Two processes use them (web and worker) and the refresh token
 * rotates, so refreshes are serialised with a Postgres advisory lock — two processes refreshing
 * the same rotating token at once would leave one of them holding a token the server has
 * already invalidated (`refresh_token_reused`), i.e. a forced sign-out.
 *
 * Provider availability (`isConfigured()`) must be synchronous, so a non-secret summary is
 * cached on `globalThis` (surviving duplicate module instances in Next's bundles and dev
 * reloads), primed at process start and refreshed on a short TTL.
 */

const log = createLogger('ai:chatgpt');

interface StoredConnection {
  issuedClientId: string;
  sub: string | null;
  email: string | null;
  name: string | null;
  /** Kept (even after disconnect) for `id_token_hint` on re-authorisation. */
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
  models: ChatGptModel[];
  connectedAt: string | null;
  refreshedAt: string | null;
  needsReauth: boolean;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

/** What the UI and the provider registry may know. No token ever appears here. */
export interface ChatGptStatus {
  /** Signed in with plan usage granted and no re-sign-in pending. */
  connected: boolean;
  /** An app registration exists (an issued `oaiapp_…` id), even if signed out. */
  registered: boolean;
  needsReauth: boolean;
  planUsage: boolean;
  email: string | null;
  name: string | null;
  models: ChatGptModel[];
  connectedAt: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
}

const EMPTY_STATUS: ChatGptStatus = {
  connected: false,
  registered: false,
  needsReauth: false,
  planUsage: false,
  email: null,
  name: null,
  models: [],
  connectedAt: null,
  lastError: null,
  lastErrorCode: null,
  lastErrorAt: null,
};

interface CacheState {
  status: ChatGptStatus;
  loadedAt: number;
  loading: Promise<ChatGptStatus> | null;
  timer: ReturnType<typeof setInterval> | null;
}

const CACHE_KEY = Symbol.for('seo-os.ai.chatgpt.state');
type GlobalWithCache = typeof globalThis & { [CACHE_KEY]?: CacheState };

function cache(): CacheState {
  const holder = globalThis as GlobalWithCache;
  holder[CACHE_KEY] ??= { status: EMPTY_STATUS, loadedAt: 0, loading: null, timer: null };
  return holder[CACHE_KEY];
}

type Db = Prisma.TransactionClient | typeof prisma;

function toStatus(connection: StoredConnection | null): ChatGptStatus {
  if (!connection) return EMPTY_STATUS;
  const planUsage = hasPlanUsage(connection.scopes);
  const signedIn = Boolean(connection.refreshToken || connection.accessToken);
  return {
    connected: signedIn && planUsage && !connection.needsReauth,
    registered: Boolean(connection.issuedClientId),
    needsReauth: connection.needsReauth,
    planUsage,
    email: connection.email,
    name: connection.name,
    models: connection.models,
    connectedAt: connection.connectedAt,
    lastError: connection.lastError,
    lastErrorCode: connection.lastErrorCode,
    lastErrorAt: connection.lastErrorAt,
  };
}

async function readConnection(db: Db = prisma): Promise<StoredConnection | null> {
  const row = await db.appSetting.findUnique({ where: { key: SETTING_CONNECTION } });
  const value = row?.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const blob = (value as Record<string, unknown>).data;
  if (typeof blob !== 'string') return null;
  const decrypted = tryDecryptJson<StoredConnection>(blob);
  if (!decrypted) {
    log.warn('the stored ChatGPT connection could not be decrypted (was ENCRYPTION_KEY changed?)');
    return null;
  }
  return decrypted;
}

async function writeConnection(connection: StoredConnection, db: Db = prisma): Promise<void> {
  const value = { v: 1, data: encryptJson(connection) };
  await db.appSetting.upsert({
    where: { key: SETTING_CONNECTION },
    create: { key: SETTING_CONNECTION, value },
    update: { value },
  });
}

function remember(connection: StoredConnection | null): ChatGptStatus {
  const state = cache();
  state.status = toStatus(connection);
  state.loadedAt = Date.now();
  return state.status;
}

// ─────────────────────────────────────────────────────────────
// The in-memory view
// ─────────────────────────────────────────────────────────────

/** Reload the connection summary from the database when stale (or always, with `force`). */
export async function refreshChatGptState(force = false): Promise<ChatGptStatus> {
  const state = cache();
  if (!force && Date.now() - state.loadedAt < STATE_TTL_MS) return state.status;
  if (state.loading) return state.loading;
  state.loading = readConnection()
    .then((connection) => remember(connection))
    .catch((err: unknown) => {
      // A database hiccup must not flip a working provider off; keep the last known view.
      log.warn('could not reload the ChatGPT connection state', { error: errorMessage(err) });
      return state.status;
    })
    .finally(() => {
      state.loading = null;
    });
  return state.loading;
}

/**
 * Load the state now and keep it fresh in the background. Called once at process start (the
 * worker entry and Next's `instrumentation.ts`); the interval is `unref`'d so it never keeps a
 * process alive on its own.
 */
export async function primeChatGptConnection(): Promise<ChatGptStatus> {
  const state = cache();
  if (!state.timer) {
    state.timer = setInterval(() => {
      void refreshChatGptState(true);
    }, STATE_TTL_MS);
    state.timer.unref?.();
  }
  return refreshChatGptState(true);
}

/** Synchronous view for `isConfigured()`. Kicks off a load if nothing was ever loaded. */
export function chatGptStatusSync(): ChatGptStatus {
  const state = cache();
  if (state.loadedAt === 0 && !state.loading) void refreshChatGptState(true);
  return state.status;
}

export function isChatGptReady(): boolean {
  return chatGptStatusSync().connected;
}

export async function getChatGptStatus(): Promise<ChatGptStatus> {
  return refreshChatGptState(true);
}

// ─────────────────────────────────────────────────────────────
// Sign-in attempts
// ─────────────────────────────────────────────────────────────

interface StoredAttempt {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  /** The client id the authorize request used: the issued id, or the dynamic placeholder. */
  clientId: string;
  userId: string;
  createdAt: number;
}

async function readAttempts(db: Db = prisma): Promise<StoredAttempt[]> {
  const row = await db.appSetting.findUnique({ where: { key: SETTING_ATTEMPTS } });
  const value = row?.value;
  const blob = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).data : null;
  if (typeof blob !== 'string') return [];
  const decrypted = tryDecryptJson<StoredAttempt[]>(blob);
  const now = Date.now();
  return (decrypted ?? []).filter((attempt) => now - attempt.createdAt < ATTEMPT_TTL_MS);
}

async function writeAttempts(attempts: StoredAttempt[], db: Db = prisma): Promise<void> {
  const value = { v: 1, data: encryptJson(attempts.slice(-10)) };
  await db.appSetting.upsert({
    where: { key: SETTING_ATTEMPTS },
    create: { key: SETTING_ATTEMPTS, value },
    update: { value },
  });
}

/** The persistent `ext_agent_host_id` of this installation; created on first use. */
export async function getChatGptHostId(): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTING_HOST_ID } });
  if (typeof row?.value === 'string' && row.value.startsWith('urn:uuid:')) return row.value;
  const hostId = newHostId();
  await prisma.appSetting.upsert({
    where: { key: SETTING_HOST_ID },
    create: { key: SETTING_HOST_ID, value: hostId },
    // Never overwrite an existing id: OpenAI ties the registration to it.
    update: {},
  });
  const stored = await prisma.appSetting.findUnique({ where: { key: SETTING_HOST_ID } });
  return typeof stored?.value === 'string' ? stored.value : hostId;
}

/**
 * Start a sign-in. The attempt (state, nonce, PKCE verifier) is kept server-side because the
 * callback arrives on `127.0.0.1`, where the browser holds none of this app's cookies.
 */
export async function startChatGptSignIn(input: { userId: string; redirectUri: string }): Promise<{ authorizeUrl: string }> {
  const [hostId, connection] = await Promise.all([getChatGptHostId(), readConnection()]);
  const pkce = createPkce();
  const attempt: StoredAttempt = {
    state: randomState(),
    nonce: randomState(),
    codeVerifier: pkce.verifier,
    redirectUri: input.redirectUri,
    clientId: connection?.issuedClientId || DYNAMIC_CLIENT_ID,
    userId: input.userId,
    createdAt: Date.now(),
  };
  const attempts = await readAttempts();
  await writeAttempts([...attempts, attempt]);
  return {
    authorizeUrl: buildAuthorizeUrl({
      clientId: attempt.clientId,
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      nonce: attempt.nonce,
      codeChallenge: pkce.challenge,
      hostId,
      idTokenHint: connection?.idToken ?? null,
      loginHint: connection?.email ?? null,
    }),
  };
}

/** Single use: the attempt is removed whether or not the rest of the callback succeeds. */
export async function consumeChatGptAttempt(state: string): Promise<StoredAttempt | null> {
  if (!state) return null;
  const attempts = await readAttempts();
  const match = attempts.find((attempt) => attempt.state === state) ?? null;
  await writeAttempts(attempts.filter((attempt) => attempt.state !== state));
  return match;
}

export interface VerifiedIdentity {
  sub: string;
  email: string | null;
  name: string | null;
}

/** ID-token verification is injected so this package does not carry a JOSE dependency. */
export type IdTokenVerifier = (idToken: string, expected: { clientId: string; nonce: string }) => Promise<VerifiedIdentity>;

export type CompleteSignInAttempt = Pick<StoredAttempt, 'clientId' | 'nonce' | 'codeVerifier' | 'redirectUri'>;

/**
 * Finish a sign-in from the callback: resolve the issued client id, exchange the code, verify
 * the identity, require the plan-usage scope, load the model list, and store it all.
 */
export async function completeChatGptSignIn(input: {
  attempt: CompleteSignInAttempt;
  code: string;
  /** `client_id` from the callback query, if present. */
  callbackClientId: string | null;
  verifyIdToken: IdTokenVerifier;
}): Promise<ChatGptStatus> {
  const { attempt } = input;
  const firstRegistration = attempt.clientId === DYNAMIC_CLIENT_ID;
  let issuedClientId: string;
  if (firstRegistration) {
    if (!input.callbackClientId || input.callbackClientId === DYNAMIC_CLIENT_ID) {
      throw new ChatGptError({ kind: 'upstream', message: 'ChatGPT did not return an app registration, so the sign-in is incomplete. Try again.' });
    }
    issuedClientId = input.callbackClientId;
  } else {
    if (input.callbackClientId && input.callbackClientId !== attempt.clientId) {
      throw new ChatGptError({ kind: 'upstream', message: 'ChatGPT returned a different app registration than the one this sign-in started with; the result was rejected.' });
    }
    issuedClientId = attempt.clientId;
  }

  const tokens = await exchangeAuthorizationCode({
    clientId: issuedClientId,
    code: input.code,
    codeVerifier: attempt.codeVerifier,
    redirectUri: attempt.redirectUri,
  });
  if (!tokens.idToken) {
    throw new ChatGptError({ kind: 'upstream', message: 'ChatGPT did not return a verifiable identity. Please try signing in again.' });
  }
  const identity = await input.verifyIdToken(tokens.idToken, { clientId: issuedClientId, nonce: attempt.nonce });

  const previous = await readConnection();
  if (previous?.sub && previous.sub !== identity.sub) {
    log.info('ChatGPT connection switched to a different account', { email: identity.email });
  }

  let models: ChatGptModel[] = [];
  let lastError: string | null = null;
  if (hasPlanUsage(tokens.scopes)) {
    try {
      models = await fetchChatGptModels(tokens.accessToken);
    } catch (err) {
      lastError = `Signed in, but the model list could not be loaded: ${errorMessage(err)}`;
    }
  } else {
    lastError = 'Signed in, but plan usage was not granted. Sign in again and allow this app to use your ChatGPT plan, or use an API key instead.';
  }

  const now = new Date().toISOString();
  const connection: StoredConnection = {
    issuedClientId,
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    idToken: tokens.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    models,
    connectedAt: now,
    refreshedAt: now,
    needsReauth: false,
    lastError,
    lastErrorCode: lastError ? (hasPlanUsage(tokens.scopes) ? 'models_unavailable' : 'plan_usage_not_granted') : null,
    lastErrorAt: lastError ? now : null,
  };
  await writeConnection(connection);
  log.info('ChatGPT connected', { email: identity.email, planUsage: hasPlanUsage(tokens.scopes), models: models.length });
  return remember(connection);
}

// ─────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────

function applyTokens(connection: StoredConnection, tokens: TokenSet): StoredConnection {
  return {
    ...connection,
    accessToken: tokens.accessToken,
    // Rotating refresh tokens: the new one replaces the old, together with the access token.
    refreshToken: tokens.refreshToken ?? connection.refreshToken,
    idToken: tokens.idToken ?? connection.idToken,
    expiresAt: tokens.expiresAt,
    scopes: tokens.scopes.length ? tokens.scopes : connection.scopes,
    refreshedAt: new Date().toISOString(),
    needsReauth: false,
  };
}

function notConnected(): ChatGptError {
  return new ChatGptError({
    kind: 'not-connected',
    message: 'ChatGPT is not connected. Use "Sign in with ChatGPT" in Settings → AI providers.',
  });
}

/**
 * A usable access token, refreshing it when it is close to expiry (or when `force` is set after
 * a 401). Refreshes are serialised across processes; a process that waited on the lock re-reads
 * the row and uses the token the winner just stored instead of refreshing a second time.
 */
export async function getChatGptAccessToken(options: { force?: boolean } = {}): Promise<string> {
  const current = await readConnection();
  if (!current?.issuedClientId || current.needsReauth) throw notConnected();
  if (!hasPlanUsage(current.scopes)) {
    throw new ChatGptError({ kind: 'plan-not-granted', message: 'This ChatGPT sign-in did not grant plan usage. Sign in again and allow it, or use an API key.' });
  }
  const fresh = current.accessToken && current.expiresAt && current.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh && !options.force && current.accessToken) return current.accessToken;
  if (!current.refreshToken) {
    if (current.accessToken && current.expiresAt && current.expiresAt > Date.now()) return current.accessToken;
    throw notConnected();
  }

  const staleToken = current.accessToken;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1)', REFRESH_LOCK_KEY);
        const locked = await readConnection(tx);
        if (!locked?.refreshToken || locked.needsReauth) throw notConnected();
        // Another process refreshed while this one waited: use its result.
        if (locked.accessToken && locked.accessToken !== staleToken && locked.expiresAt && locked.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
          return locked.accessToken;
        }
        const tokens = await refreshAccessToken({ clientId: locked.issuedClientId, refreshToken: locked.refreshToken });
        const next = applyTokens(locked, tokens);
        await writeConnection(next, tx);
        remember(next);
        return tokens.accessToken;
      },
      { maxWait: 45_000, timeout: 45_000 },
    );
  } catch (err) {
    if (err instanceof ChatGptError && err.needsReauth) await markChatGptNeedsReauth(err);
    throw err;
  }
}

/** Record a terminal failure: tokens stop being used, the UI asks for a fresh sign-in. */
export async function markChatGptNeedsReauth(error: ChatGptError): Promise<void> {
  const connection = await readConnection();
  if (!connection) return;
  const next: StoredConnection = {
    ...connection,
    needsReauth: true,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    lastError: truncate(error.message, 500),
    lastErrorCode: error.errorCode,
    lastErrorAt: new Date().toISOString(),
  };
  await writeConnection(next);
  remember(next);
}

/**
 * Remember the last plan-usage failure (a cap hit, an eligibility block) so Settings can show
 * it. Credentials are untouched: none of these errors means the grant is gone.
 */
export async function recordChatGptError(error: ChatGptError): Promise<void> {
  try {
    const connection = await readConnection();
    if (!connection) return;
    const next: StoredConnection = {
      ...connection,
      lastError: truncate(error.message, 500),
      lastErrorCode: error.errorCode ?? error.kind,
      lastErrorAt: new Date().toISOString(),
    };
    await writeConnection(next);
    remember(next);
  } catch (err) {
    log.warn('could not record the ChatGPT error', { error: errorMessage(err) });
  }
}

/** Clear a stale error after a successful call, without a write when there is nothing to clear. */
export async function clearChatGptError(): Promise<void> {
  if (!chatGptStatusSync().lastError) return;
  try {
    const connection = await readConnection();
    if (!connection?.lastError) return;
    const next = { ...connection, lastError: null, lastErrorCode: null, lastErrorAt: null };
    await writeConnection(next);
    remember(next);
  } catch (err) {
    log.debug('could not clear the ChatGPT error', { error: errorMessage(err) });
  }
}

/** Reload the plan's model list with a valid token. */
export async function refreshChatGptModels(): Promise<ChatGptStatus> {
  const token = await getChatGptAccessToken();
  const models = await fetchChatGptModels(token);
  const connection = await readConnection();
  if (!connection) throw notConnected();
  const next = { ...connection, models };
  await writeConnection(next);
  return remember(next);
}

/**
 * Sign out of ChatGPT in this app. The issued client id, the last ID token and the email are
 * kept so the next sign-in re-authorises the same registration (`id_token_hint`, `login_hint`)
 * instead of creating a new one.
 */
export async function disconnectChatGpt(): Promise<ChatGptStatus> {
  const connection = await readConnection();
  if (!connection) return remember(null);
  const next: StoredConnection = {
    ...connection,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
    scopes: [],
    models: [],
    needsReauth: false,
    connectedAt: null,
    lastError: null,
    lastErrorCode: null,
    lastErrorAt: null,
  };
  await writeConnection(next);
  log.info('ChatGPT disconnected');
  return remember(next);
}
