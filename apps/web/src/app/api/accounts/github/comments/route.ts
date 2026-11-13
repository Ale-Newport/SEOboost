import { z } from 'zod';
import { createComment, parseRepoRef } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { ValidationError } from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { platformCall } from '../../_lib';

/** `POST /api/accounts/github/comments` — comment on an issue or pull request, as the linked account. */
const bodySchema = z.object({
  ref: z.string().trim().min(3).max(300),
  number: z.number().int().positive(),
  body: z.string().trim().min(2).max(65_000),
  accountId: z.string().optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const ref = parseRepoRef(body.ref);
  if (!ref) throw new ValidationError(`"${body.ref}" is not a GitHub repository.`);
  const { secrets } = await loadPersonalAccount(user.id, 'GITHUB', body.accountId ?? null);
  return platformCall(() => createComment(secrets.credentials.accessToken ?? '', ref, body.number, body.body));
});
