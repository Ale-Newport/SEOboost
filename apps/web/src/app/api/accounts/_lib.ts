import 'server-only';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { type PersonalAccount, prisma } from '@seo/db';
import {
  PERSONAL_OAUTH,
  SocialSourceError,
  consumePersonalAttempt,
  exchangePersonalCode,
  fetchGitHubIdentity,
  fetchRedditIdentity,
  personalCredentials,
  safeReturnTo,
  type PersonalProvider,
} from '@seo/integrations';
import { upsertPersonalAccount } from '@seo/agents';
import { AppError, RateLimitError, ValidationError, createLogger, env, errorMessage, truncate } from '@seo/shared';
import { constantTimeEquals } from '@seo/shared/crypto';
import { getCurrentUser } from '@/lib/auth';

const log = createLogger('api:accounts');

/**
 * Shared plumbing for the personal-accounts API (Accounts → GitHub / Reddit).
 *
 * The OAuth callback mirrors the social one: a live single-use attempt, an HttpOnly cookie that
 * proves the same browser came back (compared in constant time), and the signed-in operator must
 * be the one who started it. The cookie lives on `/` because Reddit's single redirect URI brings
 * the personal flow back through `/api/social/oauth/reddit/callback`.
 */

export const PERSONAL_OAUTH_COOKIE = 'seo_os_personal_oauth';

export function secureCookies(): boolean {
  return env.appUrl.startsWith('https://');
}

export function setAttemptCookie(response: NextResponse, state: string, expiresAt: Date): void {
  response.cookies.set(PERSONAL_OAUTH_COOKIE, state, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export function accountsPageRedirect(base: string, path: string, params: Record<string, string>): NextResponse {
  const url = new URL(safeReturnTo(path), base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url.toString(), { status: 302 });
  response.cookies.set(PERSONAL_OAUTH_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}

/** Translate a platform error into the API's typed errors so the client gets a readable 4xx. */
export function asApiError(err: unknown): unknown {
  if (!(err instanceof SocialSourceError)) return err;
  const message = `${err.message}${err.hint ? ` ${err.hint}` : ''}`;
  if (err.code === 'RATE_LIMITED') return new RateLimitError(message, err.retryAfterSeconds ?? 60);
  if (err.code === 'NOT_FOUND') return new AppError(message, { code: 'NOT_FOUND', status: 404 });
  if (err.code === 'UPSTREAM' || err.code === 'TIMEOUT') return new AppError(message, { code: 'UPSTREAM', status: 502, retryable: true });
  return new ValidationError(message, { code: err.code });
}

/** Run a platform call, re-throwing its failures as API errors. */
export async function platformCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw asApiError(err);
  }
}

/** What the browser may know about a linked account — never credentials. */
export function personalAccountWire(account: PersonalAccount) {
  const config = typeof account.config === 'object' && account.config !== null && !Array.isArray(account.config) ? account.config : {};
  const via = (config as Record<string, unknown>).linkedVia;
  return {
    id: account.id,
    provider: account.provider,
    handle: account.handle,
    displayName: account.displayName,
    email: account.email,
    status: account.status,
    linkedVia: typeof via === 'string' ? via : null,
    lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
    lastError: account.lastError,
    updatedAt: account.updatedAt.toISOString(),
  };
}

export type PersonalAccountWire = ReturnType<typeof personalAccountWire>;

/**
 * Finish a personal OAuth link. Used by `/api/accounts/github/callback` and handed Reddit
 * attempts by the social Reddit callback.
 */
export async function handlePersonalCallback(request: Request, provider: PersonalProvider): Promise<NextResponse> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const providerError = url.searchParams.get('error');
  const label = PERSONAL_OAUTH[provider].label;

  const attempt = await consumePersonalAttempt(state);
  if (!attempt) {
    return accountsPageRedirect(env.appUrl, '/accounts', {
      error: 'That link was invalid, already used or older than ten minutes. Start linking again.',
    });
  }
  const back = attempt.returnTo;
  if (attempt.provider !== provider) {
    return accountsPageRedirect(env.appUrl, back, { error: 'The callback does not match the link that was started.' });
  }
  const bound = (await cookies()).get(PERSONAL_OAUTH_COOKIE)?.value ?? '';
  if (!state || !bound || !constantTimeEquals(bound, state)) {
    return accountsPageRedirect(env.appUrl, back, { error: `This ${label} approval did not start in this browser. Start again from the same browser.` });
  }
  const user = await getCurrentUser();
  if (!user || user.id !== attempt.userId) {
    return accountsPageRedirect(env.appUrl, '/accounts', { error: 'Sign in to the app as the account that started the link, then try again.' });
  }
  if (providerError) {
    return accountsPageRedirect(env.appUrl, back, {
      error: providerError === 'access_denied' ? `${label} access was not granted, so nothing was linked.` : `${label} returned "${providerError}".`,
    });
  }
  if (!code) return accountsPageRedirect(env.appUrl, back, { error: `${label} did not return an authorization code.` });

  try {
    const tokens = await exchangePersonalCode(provider, code, attempt.redirectUri);
    const credentials = personalCredentials(tokens);
    if (provider === 'GITHUB') {
      const identity = await fetchGitHubIdentity(tokens.accessToken);
      await upsertPersonalAccount({
        userId: user.id,
        provider,
        handle: identity.login,
        displayName: identity.name,
        email: identity.email,
        credentials,
        config: { linkedVia: 'oauth', avatarUrl: identity.avatarUrl, profileUrl: identity.htmlUrl },
      });
      log.info('github linked', { userId: user.id });
      return accountsPageRedirect(env.appUrl, back, { linked: 'github', handle: truncate(identity.login, 80) });
    }
    const identity = await fetchRedditIdentity(tokens.accessToken);
    await upsertPersonalAccount({
      userId: user.id,
      provider,
      handle: identity.handle,
      displayName: identity.name,
      email: null,
      credentials,
      config: { linkedVia: 'oauth', iconUrl: identity.iconUrl },
    });
    log.info('reddit linked', { userId: user.id });
    return accountsPageRedirect(env.appUrl, back, { linked: 'reddit', handle: truncate(identity.handle, 80) });
  } catch (err) {
    log.warn('personal link failed', { provider, error: errorMessage(err) });
    const message = err instanceof SocialSourceError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : `Could not finish linking ${label}: ${errorMessage(err)}`;
    return accountsPageRedirect(env.appUrl, back, { error: message });
  }
}

/** Ownership check for a linked account id. */
export async function requireOwnedAccount(userId: string, id: string): Promise<PersonalAccount> {
  const account = await prisma.personalAccount.findFirst({ where: { id, userId } });
  if (!account) throw new AppError('Linked account not found', { code: 'NOT_FOUND', status: 404 });
  return account;
}
