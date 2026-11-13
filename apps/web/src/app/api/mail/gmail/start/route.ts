import { NextResponse } from 'next/server';
import { z } from 'zod';
import { gmailAuthUrl, isGmailOAuthAvailable } from '@seo/integrations';
import { ValidationError } from '@seo/shared';
import { readQuery, route } from '@/lib/api';
import { GMAIL_NONCE_COOKIE } from '@/app/api/mail/_lib';

/**
 * `GET /api/mail/gmail/start?email=` — send the browser to Google's consent screen for Gmail.
 * Only offered when the installation has a Google OAuth client; otherwise IMAP with an app
 * password is the path and the UI never shows this button.
 */
const query = z.object({ email: z.string().trim().max(320).optional() });

export const GET = route(async ({ user, request }) => {
  const { email } = readQuery(request, query);
  if (!isGmailOAuthAvailable()) {
    throw new ValidationError('Google sign-in is not configured on this installation. Add the mailbox with an app password instead.');
  }
  const { url, nonce } = gmailAuthUrl({ userId: user.id, loginHint: email ?? null });
  const response = NextResponse.redirect(url, { status: 302 });
  response.cookies.set(GMAIL_NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'lax',
    secure: url.startsWith('https://') && new URL(request.url).protocol === 'https:',
    path: '/api/mail/gmail',
    maxAge: 15 * 60,
  });
  return response;
});
