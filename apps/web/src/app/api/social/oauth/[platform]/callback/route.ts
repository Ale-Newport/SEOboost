import { cookies } from 'next/headers';
import { json, prisma } from '@seo/db';
import {
  OAUTH_PROVIDERS,
  SocialSourceError,
  consumeOAuthAttempt,
  credentialsFromTokens,
  exchangeOAuthCode,
  fetchOAuthIdentity,
  isOAuthPlatform,
} from '@seo/integrations';
import { createLogger, env, errorMessage, truncate } from '@seo/shared';
import { constantTimeEquals, encryptJson } from '@seo/shared/crypto';
import { route } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth';
import { resolvePlatform } from '@/app/api/_lib/social';
import { SOCIAL_OAUTH_COOKIE, accountsRedirect } from '@/app/api/_lib/social-oauth';

const log = createLogger('api:social-oauth');

/**
 * `GET /api/social/oauth/[platform]/callback` — where the platform sends the browser back.
 *
 * Public and CSRF-exempt because the platform cannot carry our double-submit header. What
 * replaces it: the `state` must name a live, single-use attempt stored server-side, the
 * HttpOnly cookie set when the flow started must carry the same state (compared in constant
 * time), and a signed-in operator must be the one who started it. Only then is the code
 * exchanged and the account written — one account per platform per site, replacing any
 * earlier credentials for that slot.
 */

function attemptPlatform(value: string): ReturnType<typeof resolvePlatform> | null {
  try {
    return resolvePlatform(value);
  } catch {
    return null;
  }
}

function readableError(err: unknown, label: string): string {
  if (err instanceof SocialSourceError) return `${err.message}${err.hint ? ` ${err.hint}` : ''}`;
  return `Could not finish connecting ${label}: ${errorMessage(err)}`;
}

export const GET = route<{ platform: string }>(
  async ({ request, params }) => {
    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const providerError = url.searchParams.get('error');

    const attempt = await consumeOAuthAttempt(state);
    if (!attempt) {
      return accountsRedirect(env.appUrl, null, {
        error: 'That connection link was invalid, already used or older than ten minutes. Start the connection again.',
      });
    }

    const platform = attemptPlatform(params.platform);
    if (!platform || !isOAuthPlatform(platform) || platform !== attempt.platform) {
      return accountsRedirect(env.appUrl, attempt.websiteId, { error: 'The callback does not match the connection that was started.' });
    }
    const label = OAUTH_PROVIDERS[platform].label;

    const cookieStore = await cookies();
    const bound = cookieStore.get(SOCIAL_OAUTH_COOKIE)?.value ?? '';
    if (!state || !bound || !constantTimeEquals(bound, state)) {
      log.warn('social oauth browser mismatch', { websiteId: attempt.websiteId, platform });
      return accountsRedirect(env.appUrl, attempt.websiteId, {
        error: `This ${label} approval did not start in this browser. Start the connection again from the same browser.`,
      });
    }

    const currentUser = await getCurrentUser();
    if (currentUser && currentUser.id !== attempt.userId) {
      return accountsRedirect(env.appUrl, null, { error: 'This connection was started by another account.' });
    }

    if (providerError) {
      const declined = providerError === 'access_denied';
      return accountsRedirect(env.appUrl, attempt.websiteId, {
        error: declined ? `${label} access was not granted, so nothing was connected.` : `${label} returned "${providerError}".`,
      });
    }
    if (!code) {
      return accountsRedirect(env.appUrl, attempt.websiteId, { error: `${label} did not return an authorization code.` });
    }

    const website = await prisma.website.findUnique({ where: { id: attempt.websiteId }, select: { id: true, userId: true } });
    if (!website || website.userId !== attempt.userId) {
      return accountsRedirect(env.appUrl, null, { error: 'That website no longer exists or is not yours.' });
    }

    try {
      const tokens = await exchangeOAuthCode({ platform, code, attempt });
      const identity = await fetchOAuthIdentity(platform, tokens, attempt.instanceUrl);
      const credentials = credentialsFromTokens(platform, tokens);

      const existing = await prisma.socialAccount.findUnique({
        where: { websiteId_platform: { websiteId: website.id, platform } },
        select: { config: true },
      });
      // Keep operator settings (owned communities, default subreddit…) across reconnections.
      const previousConfig =
        existing && typeof existing.config === 'object' && existing.config !== null && !Array.isArray(existing.config)
          ? (existing.config as Record<string, unknown>)
          : {};
      const data = {
        status: 'CONNECTED' as const,
        credentials: encryptJson(credentials),
        config: json({ ...previousConfig, ...identity.config }),
        handle: identity.handle,
        displayName: identity.displayName,
        lastError: null,
        lastTestedAt: new Date(),
      };
      await prisma.socialAccount.upsert({
        where: { websiteId_platform: { websiteId: website.id, platform } },
        create: { websiteId: website.id, platform, ...data },
        update: data,
      });
      log.info('social account connected via oauth', { websiteId: website.id, platform });
      return accountsRedirect(env.appUrl, website.id, { connected: platform.toLowerCase(), handle: truncate(identity.handle, 80) });
    } catch (err) {
      log.warn('social oauth exchange failed', { websiteId: website.id, platform, error: errorMessage(err) });
      return accountsRedirect(env.appUrl, website.id, { error: readableError(err, label) });
    }
  },
  { public: true, skipCsrf: true },
);
