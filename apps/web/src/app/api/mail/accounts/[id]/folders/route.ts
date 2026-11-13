import { route } from '@/lib/api';
import { requireMailAccount, withMailAdapter } from '@/app/api/mail/_lib';

/** `GET /api/mail/accounts/[id]/folders` — folders (or Gmail labels) with unread counts. */
export const GET = route<{ id: string }>(async ({ user, params }) => {
  const account = await requireMailAccount(user.id, params.id);
  return { folders: await withMailAdapter(account, (adapter) => adapter.listFolders()) };
});
