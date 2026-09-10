import { prisma } from '@seo/db';
import { env, isConfigured } from '@seo/shared';
import { route } from '@/lib/api';
import { getCurrentUser } from '@/lib/auth';

/**
 * The current session.
 *
 * Public and null-tolerant on purpose: this is the endpoint the client bootstraps from, and
 * "nobody is signed in" is an answer, not an error. It also reports whether signup is still
 * open so the login screen can offer the right call to action on a fresh installation.
 */
export const GET = route(
  async () => {
    const user = await getCurrentUser();
    if (user) return { user, authenticated: true as const };

    const userCount = await prisma.user.count();
    return {
      user: null,
      authenticated: false as const,
      /** True on a brand-new install: the first account claims ownership. */
      needsFirstUser: userCount === 0,
      signupAllowed: userCount === 0 || env.allowSignup,
      demoMode: env.demoMode,
      aiConfigured: isConfigured.anyAi(),
    };
  },
  { public: true },
);
