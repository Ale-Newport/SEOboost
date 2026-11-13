import { z } from 'zod';
import { readBody, route } from '@/lib/api';
import { requireMailAccount, withMailAdapter } from '@/app/api/mail/_lib';

/**
 * `POST /api/mail/accounts/[id]/messages/move` — archive, trash or move to a folder.
 * Trash is the provider's own Trash (recoverable there); nothing here deletes permanently.
 */
const bodySchema = z.object({
  folder: z.string().trim().min(1).max(500),
  ids: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  to: z.union([z.enum(['archive', 'trash']), z.object({ path: z.string().trim().min(1).max(500) })]),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const account = await requireMailAccount(user.id, params.id);
  await withMailAdapter(account, (adapter) => adapter.move(body.folder, body.ids, body.to));
  return { moved: body.ids.length };
});
