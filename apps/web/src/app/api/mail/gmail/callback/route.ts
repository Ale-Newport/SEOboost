import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { json, prisma } from '@seo/db';
import { exchangeGmailCode, verifyGmailState } from '@seo/integrations';
import { createLogger, env, errorMessage } from '@seo/shared';
import { constantTimeEquals, encryptJson } from '@seo/shared/crypto';
import { route } from '@/lib/api';
import { GMAIL_NONCE_COOKIE } from '@/app/api/mail/_lib';

const log = createLogger('api:mail:gmail');

/**
 * `GET /api/mail/gmail/callback` — Google sends the browser back here after consent.
 *
 * The signed state names the user and carries a nonce that must match the HttpOnly cookie set
 * at start; the signed-in user must be the one who started the flow. Every outcome is a redirect
 * back to /mail with a readable message, because only a browser mid-flow ever lands here.
 */
function back(params: Record<string, string>): NextResponse {
  const url = new URL('/mail', env.appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = NextResponse.redirect(url.toString(), { status: 302 });
  response.cookies.set(GMAIL_NONCE_COOKIE, '', { path: '/api/mail/gmail', maxAge: 0 });
  return response;
}

export const GET = route(async ({ user, request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) return back({ error: `Google returned "${url.searchParams.get('error')}".` });

  const state = verifyGmailState(url.searchParams.get('state'));
  const nonce = (await cookies()).get(GMAIL_NONCE_COOKIE)?.value ?? '';
  if (!state || !nonce || !constantTimeEquals(state.nonce, nonce) || state.userId !== user.id) {
    return back({ error: 'That Google sign-in link was invalid or expired. Start again.' });
  }
  const code = url.searchParams.get('code');
  if (!code) return back({ error: 'Google did not return an authorization code.' });

  try {
    const { credentials, email } = await exchangeGmailCode(code);
    const address = email.toLowerCase();
    const count = await prisma.mailAccount.count({ where: { userId: user.id } });
    await prisma.mailAccount.upsert({
      where: { userId_email: { userId: user.id, email: address } },
      create: {
        userId: user.id,
        email: address,
        provider: 'GMAIL_OAUTH',
        status: 'CONNECTED',
        credentials: encryptJson(credentials),
        config: json({}),
        isDefault: count === 0,
        lastSyncAt: new Date(),
      },
      update: { provider: 'GMAIL_OAUTH', status: 'CONNECTED', credentials: encryptJson(credentials), lastError: null, lastSyncAt: new Date() },
    });
    return back({ connected: address });
  } catch (err) {
    log.warn('gmail connect failed', { error: errorMessage(err) });
    return back({ error: errorMessage(err) });
  }
});
