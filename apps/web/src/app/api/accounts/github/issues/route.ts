import { z } from 'zod';
import { createIssue, getIssueThread, parseRepoRef } from '@seo/integrations';
import { loadPersonalAccount } from '@seo/agents';
import { ValidationError } from '@seo/shared';
import { readBody, readQuery, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { platformCall } from '../../_lib';

/** `/api/accounts/github/issues` — read one issue/PR thread (GET) or open an issue (POST). */

function refOf(value: string) {
  const ref = parseRepoRef(value);
  if (!ref) throw new ValidationError(`"${value}" is not a GitHub repository.`);
  return ref;
}

const getSchema = z.object({ ref: z.string().trim().min(3).max(300), number: z.coerce.number().int().positive(), accountId: z.string().optional() });

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, getSchema);
  const { secrets } = await loadPersonalAccount(user.id, 'GITHUB', query.accountId ?? null);
  return platformCall(() => getIssueThread(secrets.credentials.accessToken ?? '', refOf(query.ref), query.number));
});

const postSchema = z.object({
  ref: z.string().trim().min(3).max(300),
  title: z.string().trim().min(2).max(256),
  body: z.string().trim().min(2).max(65_000),
  accountId: z.string().optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, postSchema);
  await assertNotReadOnly();
  const { secrets } = await loadPersonalAccount(user.id, 'GITHUB', body.accountId ?? null);
  return platformCall(() => createIssue(secrets.credentials.accessToken ?? '', refOf(body.ref), body.title, body.body));
});
