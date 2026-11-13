import { route } from '@/lib/api';
import { handlePersonalCallback } from '../../_lib';

/**
 * `GET /api/accounts/github/callback` — public and CSRF-exempt because GitHub cannot carry our
 * header; the single-use state, the binding cookie and the signed-in operator replace it.
 */
export const GET = route(async ({ request }) => handlePersonalCallback(request, 'GITHUB'), { public: true, skipCsrf: true });
