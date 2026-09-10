import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { prisma } from '@seo/db';
import { createLogger, env, errorMessage } from '@seo/shared';
import { constantTimeEquals } from '@seo/shared/crypto';
import {
  exchangeCode,
  saveGoogleCredentials,
  tryVerifyOAuthState,
} from '@seo/integrations/google/oauth';
import { route } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth';
import { OAUTH_NONCE_COOKIE } from '@/app/api/_lib/integrations';

const log = createLogger('api:integrations:google');

/**
 * `GET /api/integrations/google/callback` — where Google sends the browser back.
 *
 * Public and CSRF-exempt because Google cannot carry our double-submit header. What replaces
 * it is stronger for this shape of request: the `state` is signed with AUTH_SECRET and carries
 * the website id, and the nonce inside it must match the HttpOnly cookie set when the flow
 * started. Both are compared in constant time, and the website is re-checked against the
 * signed-in user when there is one.
 *
 * Every failure ends as a redirect with an `error` parameter rather than a JSON error page:
 * this endpoint is only ever reached by a browser mid-flow.
 */

function safeRedirect(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

function redirectTo(path: string, params: Record<string, string>): NextResponse {
  const url = new URL(path, env.appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url.toString(), { status: 302 });
  // The nonce is single-use; clear it whichever way the flow ended.
  response.cookies.set(OAUTH_NONCE_COOKIE, '', { path: '/api/integrations/google', maxAge: 0 });
  return response;
}

export const GET = route(
  async ({ request }) => {
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const providerError = url.searchParams.get('error');

    const payload = tryVerifyOAuthState(state);
    const target =
      safeRedirect(payload?.extra?.redirectTo) ??
      (payload ? `/sites/${payload.websiteId}/settings` : '/settings');

    if (providerError) {
      log.warn('google consent declined', { error: providerError });
      return redirectTo(target, { error: `Google returned "${providerError}".` });
    }
    if (!payload) {
      return redirectTo('/settings', {
        error: 'The Google sign-in link was invalid or expired. Start the connection again.',
      });
    }
    if (!code) {
      return redirectTo(target, { error: 'Google did not return an authorization code.' });
    }

    const cookieStore = await cookies();
    const nonce = cookieStore.get(OAUTH_NONCE_COOKIE)?.value ?? '';
    if (!nonce || !constantTimeEquals(nonce, payload.nonce)) {
      log.warn('oauth nonce mismatch', { websiteId: payload.websiteId });
      return redirectTo(target, {
        error: 'This sign-in did not start in this browser. Start the connection again.',
      });
    }

    const website = await prisma.website.findUnique({
      where: { id: payload.websiteId },
      select: { id: true, userId: true },
    });
    if (!website) {
      return redirectTo('/settings', { error: 'That website no longer exists.' });
    }

    // The signed state already proves the flow was started by someone who could read the
    // website; when a session is present we also check it is the same account.
    const currentUser = await getCurrentUser();
    if (currentUser && currentUser.id !== website.userId) {
      log.warn('oauth callback for a website the signed-in user does not own', {
        websiteId: website.id,
      });
      return redirectTo('/settings', { error: 'You do not have access to that website.' });
    }

    try {
      const exchange = await exchangeCode(code);
      await saveGoogleCredentials({
        websiteId: website.id,
        provider: payload.provider,
        tokens: exchange.tokens,
        accountEmail: exchange.accountEmail,
        config: { scopes: exchange.scopes },
      });
    } catch (err) {
      log.error('google token exchange failed', {
        websiteId: website.id,
        error: errorMessage(err),
      });
      return redirectTo(target, {
        error: `Could not complete the Google connection: ${errorMessage(err)}`,
      });
    }

    log.info('google integration connected', {
      websiteId: website.id,
      provider: payload.provider,
    });

    return redirectTo(target, { connected: payload.provider });
  },
  { public: true, skipCsrf: true },
);
