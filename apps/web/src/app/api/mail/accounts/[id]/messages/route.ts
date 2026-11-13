import { z } from 'zod';
import { readQuery, route } from '@/lib/api';
import { assertFolder, requireMailAccount, withMailAdapter } from '@/app/api/mail/_lib';

/** `GET /api/mail/accounts/[id]/messages?folder=&cursor=&q=` — one page, newest first. */
const query = z.object({
  folder: z.string().trim().min(1).max(500),
  cursor: z.string().max(500).optional(),
  q: z.string().trim().max(500).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

export const GET = route<{ id: string }>(async ({ user, request, params }) => {
  const { folder, cursor, q, pageSize } = readQuery(request, query);
  const account = await requireMailAccount(user.id, params.id);
  return withMailAdapter(account, (adapter) =>
    adapter.listMessages({ folder: assertFolder(folder), cursor: cursor ?? null, query: q ?? null, pageSize }),
  );
});
