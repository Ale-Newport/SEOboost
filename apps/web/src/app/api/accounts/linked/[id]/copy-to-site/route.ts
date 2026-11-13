import { z } from 'zod';
import { copyPersonalAccountToSite } from '@seo/agents';
import { ValidationError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { platformCall, requireOwnedAccount } from '../../../_lib';

/**
 * `POST /api/accounts/linked/[id]/copy-to-site` — use a linked Reddit account as a site's Reddit
 * account, so that site's listening, reply drafts and daily posts run through it with the site's
 * own caps and approvals.
 */
const bodySchema = z.object({ websiteId: z.string().trim().min(1) });

export const POST = route<{ id: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const account = await requireOwnedAccount(user.id, params.id);
  if (account.provider !== 'REDDIT') throw new ValidationError('Only a Reddit account can be used as a site\'s social account.');
  return platformCall(() => copyPersonalAccountToSite({ userId: user.id, accountId: account.id, websiteId: body.websiteId }));
});
