import { httpRequest, providerMessage, type HttpResult } from '../adapters/http';
import { readRecord, readString } from '../serp/http';
import { SocialSourceError } from './types';

/**
 * Bluesky (AT Protocol) session handling.
 *
 * Authentication is an *app password* the operator creates in Bluesky's settings — never the
 * account password — exchanged for a short-lived access JWT. Sessions are cached per identifier
 * and recreated on expiry; refresh tokens are not kept because a new session is one call.
 */

export const BSKY_DEFAULT_SERVICE = 'https://bsky.social';
export const BSKY_PUBLIC_APPVIEW = 'https://public.api.bsky.app';

export interface BlueskySession {
  did: string;
  handle: string;
  accessJwt: string;
  service: string;
}

const sessions = new Map<string, { session: BlueskySession; expiresAt: number }>();

/** Sessions last two hours server-side; re-create well before that. */
const SESSION_TTL_MS = 90 * 60_000;

export function blueskyError(res: HttpResult, operation: string): SocialSourceError {
  const message = `Bluesky ${operation} failed (HTTP ${res.status}): ${providerMessage(res)}`;
  if (res.status === 429) {
    const reset = Number(res.headers.get('ratelimit-reset'));
    const retry = Number.isFinite(reset) ? Math.max(1, Math.ceil(reset - Date.now() / 1000)) : 60;
    return new SocialSourceError('RATE_LIMITED', message, null, retry);
  }
  if (res.status === 401 || res.status === 403) {
    return new SocialSourceError('NEED_LOGIN', message, 'Connect a Bluesky account with an app password (Settings → Privacy and security → App passwords).');
  }
  if (res.status === 400 && /not found/i.test(message)) return new SocialSourceError('NOT_FOUND', message);
  return new SocialSourceError('UPSTREAM', message);
}

export async function blueskySession(
  credentials: Record<string, string>,
  config: Record<string, unknown> = {},
): Promise<BlueskySession> {
  const identifier = credentials.identifier?.trim().replace(/^@/, '');
  const password = credentials.appPassword?.trim();
  if (!identifier || !password) {
    throw new SocialSourceError('NOT_CONFIGURED', 'Bluesky needs a handle and an app password.');
  }
  const service = (typeof config.service === 'string' && config.service.trim()) || BSKY_DEFAULT_SERVICE;
  const key = `${service}|${identifier}`;
  const cached = sessions.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.session;

  const res = await httpRequest(`${service}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    body: { identifier, password },
  });
  const body = readRecord(res.body);
  if (!res.ok || !body) throw blueskyError(res, 'sign-in');
  const session: BlueskySession = {
    did: readString(body.did),
    handle: readString(body.handle),
    accessJwt: readString(body.accessJwt),
    service,
  };
  if (!session.did || !session.accessJwt) throw new SocialSourceError('UPSTREAM', 'Bluesky returned a session without a DID or token.');
  sessions.set(key, { session, expiresAt: Date.now() + SESSION_TTL_MS });
  return session;
}

/** Authenticated XRPC call against the account's PDS. */
export async function blueskyXrpc(
  session: BlueskySession,
  nsid: string,
  opts: { method?: 'GET' | 'POST'; query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
): Promise<unknown> {
  const res = await httpRequest(`${session.service}/xrpc/${nsid}`, {
    method: opts.method ?? 'GET',
    ...(opts.query ? { query: opts.query } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  if (!res.ok) throw blueskyError(res, nsid);
  return res.body;
}

/** `https://bsky.app/profile/<handle>/post/<rkey>` for an AT-URI. */
export function blueskyWebUrl(atUri: string, handle?: string | null): string | null {
  const match = atUri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!match?.[1] || !match[2]) return null;
  return `https://bsky.app/profile/${handle || match[1]}/post/${match[2]}`;
}

/** Test seam. */
export function resetBlueskySessions(): void {
  sessions.clear();
}
