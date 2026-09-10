import { loginSchema } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { login } from '@/lib/auth';

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
    const user = await login(input);
    return { user };
  },
  { public: true },
);
