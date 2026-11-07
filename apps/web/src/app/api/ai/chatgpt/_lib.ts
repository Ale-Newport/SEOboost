import 'server-only';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  CHATGPT_ISSUER,
  CHATGPT_JWKS_URL,
  ChatGptError,
  loopbackRedirectUri,
  type ChatGptStatus,
  type IdTokenVerifier,
} from '@seo/ai';
import { env } from '@seo/shared';

/**
 * Web-side helpers for "Sign in with ChatGPT".
 *
 * The ID token is verified here, with `jose`, rather than in `@seo/ai`: verification needs a
 * JOSE implementation and only the web process ever completes a sign-in.
 */

const jwks = createRemoteJWKSet(new URL(CHATGPT_JWKS_URL));

export const verifyChatGptIdToken: IdTokenVerifier = async (idToken, expected) => {
  let payload: Awaited<ReturnType<typeof jwtVerify>>['payload'];
  try {
    ({ payload } = await jwtVerify(idToken, jwks, { issuer: CHATGPT_ISSUER, audience: expected.clientId }));
  } catch (err) {
    throw new ChatGptError({
      kind: 'upstream',
      code: 'invalid_id_token',
      message: `ChatGPT did not return a verifiable identity (${err instanceof Error ? err.message : 'verification failed'}). Please try signing in again.`,
    });
  }
  if (payload.nonce !== expected.nonce) {
    throw new ChatGptError({ kind: 'upstream', code: 'invalid_id_token', message: 'The ChatGPT identity did not match this sign-in (nonce mismatch).' });
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new ChatGptError({ kind: 'upstream', code: 'invalid_id_token', message: 'The ChatGPT identity carried no subject.' });
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : null,
    name: typeof payload.name === 'string' ? payload.name : null,
  };
};

/**
 * The loopback callback for this request. Only the port may vary between sign-ins, so it is
 * taken from the port the browser is actually using, falling back to APP_URL's.
 */
export function callbackUriFor(request: Request): string {
  const requested = Number(new URL(request.url).port || request.headers.get('x-forwarded-port') || '');
  const appUrl = new URL(env.appUrl);
  const fallback = Number(appUrl.port || (appUrl.protocol === 'https:' ? 443 : 80));
  return loopbackRedirectUri(Number.isInteger(requested) && requested > 0 ? requested : fallback);
}

/** The JSON the Settings screen renders. Never contains a token. */
export function publicStatus(status: ChatGptStatus) {
  return {
    connected: status.connected,
    registered: status.registered,
    needsReauth: status.needsReauth,
    planUsage: status.planUsage,
    email: status.email,
    name: status.name,
    models: status.models,
    connectedAt: status.connectedAt,
    lastError: status.lastError,
    lastErrorCode: status.lastErrorCode,
    lastErrorAt: status.lastErrorAt,
  };
}
