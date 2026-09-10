import { signupSchema } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { signup } from '@/lib/auth';

/**
 * Create an account.
 *
 * `signup()` owns the policy: the first account becomes the OWNER, and every later one is
 * refused unless `ALLOW_SIGNUP` is set. Enforcing that there rather than here keeps the rule in
 * one place for the CLI seed path as well.
 */
export const POST = route(
  async ({ request }) => {
    const input = await readBody(request, signupSchema);
    const user = await signup(input);
    return { user };
  },
  { public: true },
);
