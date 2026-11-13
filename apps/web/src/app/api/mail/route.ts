import { route } from '@/lib/api';
import { getMailOverview } from '@/server/queries/mail';

/** `GET /api/mail` — the operator's mailboxes (without credentials) and what can be connected. */
export const GET = route(async ({ user }) => getMailOverview(user.id));
