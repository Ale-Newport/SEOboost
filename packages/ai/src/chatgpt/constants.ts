/**
 * "Sign in with ChatGPT" — the constants of the self-serve open-source flow.
 *
 * Everything here comes from OpenAI's published spec (developers.openai.com/siwc), not from
 * observing another client: the endpoints, the scopes and the `resource` value are part of the
 * contract, and a client that improvises them gets an identity-only grant at best.
 */

export const CHATGPT_ISSUER = 'https://auth.openai.com';
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_JWKS_URL = 'https://auth.openai.com/.well-known/jwks.json';

/** Plan usage is billed against this resource; the token's audience is the same URL. */
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const CHATGPT_MODELS_URL = 'https://api.openai.com/v1/models';

/** Where the user manages per-app caps and credits; OpenAI's UI guidelines ask apps to link it. */
export const CHATGPT_MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

/** First-time registration uses this placeholder; the callback returns the real `oaiapp_…` id. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const AGENT_NAME_HINT = 'SEO OS';

export const IDENTITY_SCOPES = ['openid', 'profile', 'email'] as const;
export const PLAN_SCOPES = ['offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'] as const;
export const REQUESTED_SCOPES = [...IDENTITY_SCOPES, ...PLAN_SCOPES].join(' ');

/** Without this scope in the grant, inference must not be attempted at all. */
export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct';

/**
 * Loopback callback. The spec requires `127.0.0.1` (never `localhost`) and lets only the port
 * vary between sign-ins, so the scheme, host and path here are fixed for good.
 */
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PATH = '/api/ai/chatgpt/callback';

/** AppSetting keys. The connection and attempts are encrypted blobs; the host id is not secret. */
export const SETTING_CONNECTION = 'ai.chatgpt.connection';
export const SETTING_ATTEMPTS = 'ai.chatgpt.attempts';
export const SETTING_HOST_ID = 'ai.chatgpt.hostId';

/** A sign-in attempt that has not come back within this window is discarded. */
export const ATTEMPT_TTL_MS = 10 * 60_000;

/** Access tokens live one hour; refresh this long before they expire. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

/** Postgres advisory-lock key that serialises refreshes across the web and worker processes. */
export const REFRESH_LOCK_KEY = 728_104_001;

/** How stale the in-memory view of the connection may get before an async path reloads it. */
export const STATE_TTL_MS = 30_000;
