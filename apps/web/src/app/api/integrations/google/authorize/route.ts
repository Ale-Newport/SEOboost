import { NextResponse } from 'next/server';
import { z } from 'zod';
import { IntegrationProvider } from '@seo/db';
import { IntegrationNotConfiguredError, env } from '@seo/shared';
import { getAuthUrl, isGoogleOAuthConfigured } from '@seo/integrations/google/oauth';
import { readQuery, requireWebsite, route } from '@/lib/api';
import { OAUTH_NONCE_COOKIE } from '@/app/api/_lib/integrations';

/**
 * `GET /api/integrations/google/authorize` — start the Google consent flow.
 *
 * Two independent protections travel with the redirect: the `state` is signed with AUTH_SECRET
 * (so the callback can trust the website id it carries), and a random nonce is also written to
 * a short-lived HttpOnly cookie. The callback requires both to match, which binds the returning
 * request to the browser that started the flow.
 */

const querySchema = z.object({
  websiteId: z.string().trim().min(1),
  provider: z
    .enum([IntegrationProvider.GOOGLE_SEARCH_CONSOLE, IntegrationProvider.GOOGLE_ANALYTICS_4])
    .default(IntegrationProvider.GOOGLE_SEARCH_CONSOLE),
  /** Where to send the browser after the callback. Must be a path on this app. */
  redirectTo: z.string().trim().max(500).optional(),
});

/** Only same-app paths are accepted, so the flow cannot be used as an open redirect. */
function safeRedirect(value: string | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireWebsite(user.id, query.websiteId);

  if (!isGoogleOAuthConfigured()) {
    throw new IntegrationNotConfiguredError(
      'google',
      'Google OAuth is not configured on this installation. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
    );
  }

  const redirectTo = safeRedirect(query.redirectTo);
  const auth = getAuthUrl({
    websiteId: website.id,
    provider: query.provider,
    ...(redirectTo ? { state: { redirectTo } } : {}),
  });

  const response = NextResponse.redirect(auth.url, { status: 302 });
  response.cookies.set(OAUTH_NONCE_COOKIE, auth.nonce, {
    httpOnly: true,
    secure: env.appUrl.startsWith('https://'),
    sameSite: 'lax',
    path: '/api/integrations/google',
    expires: auth.expiresAt,
  });
  return response;
});
