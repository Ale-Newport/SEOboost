import { prisma } from '@seo/db';
import { route } from '@/lib/api';
import { requireMailAccount, safeMailAccount, withMailAdapter } from '@/app/api/mail/_lib';

/** `POST /api/mail/accounts/[id]/test` — log in to read and to send, and record the outcome. */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  const account = await requireMailAccount(user.id, params.id);
  const result = await withMailAdapter(account, (adapter) => adapter.test());
  return { ...result, account: safeMailAccount(await prisma.mailAccount.findUniqueOrThrow({ where: { id: account.id } })) };
});
