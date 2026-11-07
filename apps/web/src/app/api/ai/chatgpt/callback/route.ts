import { NextResponse } from 'next/server';
import { completeChatGptSignIn, consumeChatGptAttempt } from '@seo/ai';
import { createLogger, env, errorMessage } from '@seo/shared';
import { route } from '@/lib/api';
import { verifyChatGptIdToken } from '../_lib';

const log = createLogger('api:ai:chatgpt');

/**
 * `GET /api/ai/chatgpt/callback` — where OpenAI sends the browser back, on `127.0.0.1`.
 *
 * Public and CSRF-exempt: the browser arrives on the loopback host without this app's session
 * cookie (cookies set for `localhost` are not sent to `127.0.0.1`). What authenticates the
 * request is the single-use, ten-minute `state` that was stored server-side when a signed-in
 * admin started the flow, plus PKCE and the nonce inside the verified ID token.
 *
 * Every outcome is a redirect back to Settings on APP_URL: this endpoint is only ever reached by
 * a browser mid-flow.
 */

function backToSettings(params: Record<string, string>): NextResponse {
  const url = new URL('/settings', env.appUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url.toString(), { status: 302 });
}

export const GET = route(
  async ({ request }) => {
    const url = new URL(request.url);
    const state = url.searchParams.get('state') ?? '';
    const attempt = await consumeChatGptAttempt(state);
    if (!attempt) {
      return backToSettings({ ai: 'chatgpt-error', reason: 'This sign-in link expired or was already used. Start "Sign in with ChatGPT" again.' });
    }

    const providerError = url.searchParams.get('error');
    if (providerError) {
      // access_denied included: validate state (done above), stop, never exchange a code.
      log.info('chatgpt sign-in declined', { error: providerError });
      return backToSettings({
        ai: 'chatgpt-error',
        reason: providerError === 'access_denied' ? 'The ChatGPT sign-in was cancelled.' : `ChatGPT returned "${providerError}".`,
      });
    }

    const code = url.searchParams.get('code');
    if (!code) return backToSettings({ ai: 'chatgpt-error', reason: 'ChatGPT did not return an authorization code.' });

    try {
      const status = await completeChatGptSignIn({
        attempt,
        code,
        callbackClientId: url.searchParams.get('client_id'),
        verifyIdToken: verifyChatGptIdToken,
      });
      log.info('chatgpt sign-in completed', { userId: attempt.userId, planUsage: status.planUsage });
      return backToSettings(
        status.connected ? { ai: 'chatgpt-connected' } : { ai: 'chatgpt-error', reason: status.lastError ?? 'Plan usage is not available for this account.' },
      );
    } catch (err) {
      log.warn('chatgpt sign-in failed', { error: errorMessage(err) });
      return backToSettings({ ai: 'chatgpt-error', reason: errorMessage(err).replace(/^chatgpt: /, '') });
    }
  },
  { public: true, skipCsrf: true },
);
