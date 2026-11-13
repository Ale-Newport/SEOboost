import { z } from 'zod';
import { json, prisma } from '@seo/db';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { makeDefault, requireMailAccount, safeMailAccount } from '@/app/api/mail/_lib';

/** `PATCH /api/mail/accounts/[id]` — rename, signature, default. `DELETE` removes the account and its stored credentials. */
const patchSchema = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  signature: z.string().max(5_000).optional(),
  isDefault: z.literal(true).optional(),
});

export const PATCH = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, patchSchema);
  await assertNotReadOnly();
  const account = await requireMailAccount(user.id, params.id);
  const config = typeof account.config === 'object' && account.config !== null && !Array.isArray(account.config) ? account.config : {};
  await prisma.mailAccount.update({
    where: { id: account.id },
    data: {
      ...(body.displayName !== undefined ? { displayName: body.displayName || null } : {}),
      ...(body.signature !== undefined ? { config: json({ ...config, signature: body.signature }) } : {}),
    },
  });
  if (body.isDefault) await makeDefault(user.id, account.id);
  return { account: safeMailAccount(await prisma.mailAccount.findUniqueOrThrow({ where: { id: account.id } })) };
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const account = await requireMailAccount(user.id, params.id);
  await prisma.mailAccount.delete({ where: { id: account.id } });
  if (account.isDefault) {
    const next = await prisma.mailAccount.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
    if (next) await prisma.mailAccount.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  return { deleted: true };
});
