import { loginSchema } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { login } from '@/lib/auth';
import { clearLoginRateLimit, enforceLoginRateLimit } from '@/lib/rate-limit';

/**
 * Sign in.
 *
 * `public` skips the session requirement, not CSRF: the login form still sends the
 * double-submit token (or a same-origin `Origin` header), which is what stops a third-party
 * page from silently signing a victim into an attacker-controlled account.
 */
export const POST = route(
  async ({ request }) => {
    const input = await readBody(request, loginSchema);
    await enforceLoginRateLimit(request, input.email);
    const user = await login(input);
    await clearLoginRateLimit(input.email);
    return { user };
  },
  { public: true },
);
