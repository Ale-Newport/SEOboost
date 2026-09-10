import { route } from '@/lib/api';
import { destroySession } from '@/lib/auth';

/**
 * Sign out.
 *
 * Public because an expired or already-deleted session must still be able to clear its cookies;
 * returning 401 here would leave a stale cookie in the browser and a user stuck on a redirect
 * loop. `destroySession()` deletes the session row too, so the JWT is dead immediately.
 */
export const POST = route(
  async () => {
    await destroySession();
    return { ok: true };
  },
  { public: true },
);
