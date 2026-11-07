import { NextResponse } from 'next/server';
import { startChatGptSignIn } from '@seo/ai';
import { createLogger } from '@seo/shared';
import { route } from '@/lib/api';
import { ADMIN_ROLES, assertNotReadOnly, requireRole } from '@/app/api/_lib/common';
import { callbackUriFor } from '../_lib';

const log = createLogger('api:ai:chatgpt');

/**
 * `GET /api/ai/chatgpt/start` — begin "Sign in with ChatGPT".
 *
 * A navigation (the Settings button is a plain link), so it answers with a redirect to OpenAI.
 * `?format=json` returns the URL instead, for clients that open it themselves. The attempt —
 * state, nonce, PKCE verifier — is stored server-side, because the callback lands on
 * `127.0.0.1`, where this browser holds none of the app's cookies.
 */
export const GET = route(async ({ user, request }) => {
  requireRole(user, ADMIN_ROLES);
  await assertNotReadOnly();
  const redirectUri = callbackUriFor(request);
  const { authorizeUrl } = await startChatGptSignIn({ userId: user.id, redirectUri });
  log.info('chatgpt sign-in started', { userId: user.id, redirectUri });
  if (new URL(request.url).searchParams.get('format') === 'json') return { authorizeUrl, redirectUri };
  return NextResponse.redirect(authorizeUrl, { status: 302 });
});
