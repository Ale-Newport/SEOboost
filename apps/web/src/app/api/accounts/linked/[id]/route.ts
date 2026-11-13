import { prisma } from '@seo/db';
import { createLogger } from '@seo/shared';
import { route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { requireOwnedAccount } from '../../_lib';

const log = createLogger('api:accounts');

/**
 * `DELETE /api/accounts/linked/[id]` — unlink. The row is deleted with its encrypted token; a
 * site that copied the account keeps its own copy until it is disconnected there.
 */
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const account = await requireOwnedAccount(user.id, params.id);
  await prisma.personalAccount.delete({ where: { id: account.id } });
  log.info('personal account unlinked', { provider: account.provider });
  return { removed: account.id };
});
