import { z } from 'zod';
import { readBody, route } from '@/lib/api';
import { requireMailAccount, withMailAdapter } from '@/app/api/mail/_lib';

/** `POST /api/mail/accounts/[id]/messages/flags` — read/unread and starred, for one or more messages. */
const bodySchema = z.object({
  folder: z.string().trim().min(1).max(500),
  ids: z.array(z.string().trim().min(1).max(200)).min(1).max(200),
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
});

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const account = await requireMailAccount(user.id, params.id);
  await withMailAdapter(account, (adapter) =>
    adapter.setFlags(body.folder, body.ids, {
      ...(body.seen !== undefined ? { seen: body.seen } : {}),
      ...(body.flagged !== undefined ? { flagged: body.flagged } : {}),
    }),
  );
  return { updated: body.ids.length };
});
