import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SocialSourceError, startPersonalOAuth } from '@seo/integrations';
import { errorMessage } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import { accountsPageRedirect, setAttemptCookie } from '../../_lib';

/**
 * `GET /api/accounts/reddit/start` — the "Link Reddit" button. Sends the browser to Reddit's own
 * consent page; the operator signs in and approves there, and nothing about that login passes
 * through this app.
 */
const querySchema = z.object({ returnTo: z.string().max(300).optional() });

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const here = new URL(request.url).origin;
  try {
    const attempt = await startPersonalOAuth({ provider: 'REDDIT', userId: user.id, returnTo: query.returnTo ?? '/accounts' });
    const response = NextResponse.redirect(attempt.url, { status: 302 });
    setAttemptCookie(response, attempt.state, attempt.expiresAt);
    return response;
  } catch (err) {
    const message = err instanceof SocialSourceError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : errorMessage(err);
    return accountsPageRedirect(here, query.returnTo ?? '/accounts', { error: message });
  }
});
