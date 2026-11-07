import 'server-only';
import { NextResponse } from 'next/server';
import { env } from '@seo/shared';

/**
 * Browser-binding cookie for one-click social connections.
 *
 * The attempt itself (state, PKCE verifier, who started it) lives server-side; this cookie only
 * proves the browser that comes back from the platform is the one that left, so a stolen
 * callback URL cannot attach someone else's account to this installation.
 */
export const SOCIAL_OAUTH_COOKIE = 'seo_os_social_oauth';
export const SOCIAL_OAUTH_COOKIE_PATH = '/api/social/oauth';

/** Back to a site's Accounts tab with a flash parameter (`connected` or `error`). */
export function accountsRedirect(
  base: string,
  websiteId: string | null,
  params: Record<string, string>,
): NextResponse {
  const url = new URL(websiteId ? `/sites/${websiteId}/social` : '/social', base);
  if (websiteId) url.searchParams.set('tab', 'accounts');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url.toString(), { status: 302 });
  response.cookies.set(SOCIAL_OAUTH_COOKIE, '', { path: SOCIAL_OAUTH_COOKIE_PATH, maxAge: 0 });
  return response;
}

export function secureCookies(): boolean {
  return env.appUrl.startsWith('https://');
}
