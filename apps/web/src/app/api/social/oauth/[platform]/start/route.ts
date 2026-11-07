import { NextResponse } from 'next/server';
import { z } from 'zod';
import { OAUTH_PROVIDERS, SocialSourceError, isOAuthPlatform, startOAuthAttempt } from '@seo/integrations';
import { createLogger, errorMessage } from '@seo/shared';
import { readQuery, requireWebsite, route } from '@/lib/api';
import { resolvePlatform } from '@/app/api/_lib/social';
import {
  SOCIAL_OAUTH_COOKIE,
  SOCIAL_OAUTH_COOKIE_PATH,
  accountsRedirect,
  secureCookies,
} from '@/app/api/_lib/social-oauth';

const log = createLogger('api:social-oauth');

/**
 * `GET /api/social/oauth/[platform]/start?websiteId=` — the "Connect" button.
 *
 * Sends the browser to the platform's own consent page. The operator signs in and approves
 * there; nothing about their login passes through this app. Every failure comes back to the
 * Accounts tab as a readable message rather than a JSON error page, because this endpoint is
 * only ever reached by a browser navigation.
 */

const querySchema = z.object({
  websiteId: z.string().trim().min(1),
  /** Mastodon only: the instance, e.g. `mastodon.social`. */
  instance: z.string().trim().max(200).optional(),
});

export const GET = route<{ platform: string }>(async ({ user, request, params }) => {
  const query = readQuery(request, querySchema);
  const website = await requireWebsite(user.id, query.websiteId);
  // Errors before the redirect return to wherever the operator actually is (which may not be
  // APP_URL during development); the platform itself always calls back on APP_URL.
  const here = new URL(request.url).origin;

  const platform = resolvePlatform(params.platform);
  if (!isOAuthPlatform(platform)) {
    return accountsRedirect(here, website.id, { error: `${platform} has no one-click connection; use the form on its card.` });
  }

  try {
    const attempt = await startOAuthAttempt({
      platform,
      websiteId: website.id,
      userId: user.id,
      instanceUrl: query.instance ?? null,
    });
    const response = NextResponse.redirect(attempt.url, { status: 302 });
    response.cookies.set(SOCIAL_OAUTH_COOKIE, attempt.state, {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: 'lax',
      path: SOCIAL_OAUTH_COOKIE_PATH,
      expires: attempt.expiresAt,
    });
    log.info('social oauth started', { websiteId: website.id, platform });
    return response;
  } catch (err) {
    const label = OAUTH_PROVIDERS[platform].label;
    const message =
      err instanceof SocialSourceError
        ? `${err.message}${err.hint ? ` ${err.hint}` : ''}`
        : `Could not start the ${label} connection: ${errorMessage(err)}`;
    log.warn('social oauth could not start', { websiteId: website.id, platform, error: errorMessage(err) });
    return accountsRedirect(here, website.id, { error: message });
  }
});
